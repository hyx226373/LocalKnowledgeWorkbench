/**
 * host.* 调用串行队列（D-L3 / D-L3a）
 * - 全局串行
 * - 同 panelId + 同 op 的 pending：latest-wins（合并丢弃过期）
 * - 被合并掉的 waiter 立即以 executed:false 结束（不得再发 layout.*）
 * - 实际执行的 run 完成后以 executed:true 结束
 */
export type HostQueueOp = 'setBounds' | 'setVisible' | 'activate';

export interface HostEnqueueResult {
  /** true = 本 run 实际执行；false = 被更新的 latest-wins 合并掉 */
  executed: boolean;
  seq: number;
}

interface QueueItem {
  op: HostQueueOp;
  panelId: string;
  run: () => Promise<unknown>;
  resolve: (r: HostEnqueueResult) => void;
  reject: (e: unknown) => void;
  seq: number;
}

export class HostCallQueue {
  private chain: Promise<void> = Promise.resolve();
  private pending = new Map<string, QueueItem>();
  private seq = 0;
  /** 已完成（实际执行）调用记录（测试） */
  readonly completed: { op: HostQueueOp; panelId: string; seq: number }[] = [];
  /** 被合并丢弃的 seq（测试） */
  readonly coalescedAway: { op: HostQueueOp; panelId: string; seq: number }[] = [];

  private key(op: HostQueueOp, panelId: string) {
    return `${op}::${panelId}`;
  }

  /**
   * 入队。同 op+panelId 若仍 pending（未开始执行），用最新 run 替换（coalesce）。
   * 被替换的 waiter 立即 resolve({ executed: false })。
   */
  enqueue(op: HostQueueOp, panelId: string, run: () => Promise<unknown>): Promise<HostEnqueueResult> {
    const k = this.key(op, panelId);
    const seq = ++this.seq;
    return new Promise<HostEnqueueResult>((resolve, reject) => {
      const existing = this.pending.get(k);
      if (existing) {
        // D-L3a：被合并掉的一侧立即结束，不得再发 layout.*
        this.coalescedAway.push({ op, panelId, seq: existing.seq });
        existing.resolve({ executed: false, seq: existing.seq });
        existing.run = run;
        existing.seq = seq;
        existing.resolve = resolve;
        existing.reject = reject;
        return;
      }
      const item: QueueItem = { op, panelId, run, resolve, reject, seq };
      this.pending.set(k, item);
      this.pump();
    });
  }

  private pump() {
    this.chain = this.chain.then(async () => {
      while (this.pending.size > 0) {
        const k = this.pending.keys().next().value as string;
        const item = this.pending.get(k);
        if (!item) continue;
        this.pending.delete(k);
        try {
          await item.run();
          this.completed.push({ op: item.op, panelId: item.panelId, seq: item.seq });
          item.resolve({ executed: true, seq: item.seq });
        } catch (e) {
          item.reject(e);
        }
      }
    });
  }

  async flush(): Promise<void> {
    await this.chain;
    while (this.pending.size > 0) {
      await this.chain;
      await Promise.resolve();
    }
    await this.chain;
  }

  clearCompleted() {
    this.completed.length = 0;
    this.coalescedAway.length = 0;
  }
}
