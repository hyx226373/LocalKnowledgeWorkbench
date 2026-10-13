import { ROOT_JOB_LIMIT, type RootTaskPriority } from '../../shared/rootTask';
import type { DB } from './db';
import { acceptRootResult } from './rootGeneration';

const RANK: Record<RootTaskPriority, number> = { remove: 0, user: 1, background: 2 };

export interface RootScheduledJob {
  priority: RootTaskPriority;
  rootId: string;
  taskId: string;
  run: () => Promise<void>;
}

/**
 * 根任务槽。同时跑 ROOT_JOB_LIMIT 个，多的按 remove > user > background 排队。
 * 不 fork utilityProcess，也不再起 Electron。
 */
export class RootJobScheduler {
  private running = 0;
  private queue: RootScheduledJob[] = [];
  private inflight = new Set<Promise<void>>();
  private stopped = false;

  enqueue(job: RootScheduledJob): void {
    if (this.stopped) return;
    this.queue.push(job);
    this.pump();
  }

  /** 丢掉还没开始的任务。已经在跑的要自己看到关闭标记后停。 */
  close(): void {
    this.stopped = true;
    this.queue = [];
  }

  whenIdle(): Promise<void> {
    return Promise.allSettled([...this.inflight]).then(() => undefined);
  }

  private pump(): void {
    if (this.stopped) return;
    while (this.running < ROOT_JOB_LIMIT && this.queue.length > 0) {
      const job = this.takeNext();
      if (!job) return;
      this.running += 1;
      const task = Promise.resolve()
        .then(() => job.run())
        .catch((err) => {
          console.error('[root-scheduler] 任务失败', job.rootId, err instanceof Error ? err.message : err);
        })
        .finally(() => {
          this.running -= 1;
          this.inflight.delete(task);
          this.pump();
        });
      this.inflight.add(task);
    }
  }

  /** 同优先级保持先来先走。 */
  private takeNext(): RootScheduledJob | undefined {
    let best = 0;
    for (let i = 1; i < this.queue.length; i += 1) {
      if (RANK[this.queue[i].priority] < RANK[this.queue[best].priority]) best = i;
    }
    return this.queue.splice(best, 1)[0];
  }
}

/** 只给扫描、监听、正文索引的发布路径用。未设置或不是正数就不等。 */
export function waitRootResultDelay(): Promise<void> {
  const raw = process.env.KB_ROOT_RESULT_DELAY_MS;
  if (raw == null || raw === '') return Promise.resolve();
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 先等测试延迟，再按提交时的工作区核对代次。
 * workspaceId 可以是函数，延迟结束后才取值，避免切走之后写进新工作区。
 * dropped 时不调用 apply。
 */
export async function publishRootResult(
  db: unknown,
  rootId: string,
  workspaceId: string | (() => string),
  capturedGeneration: number,
  apply: () => void,
): Promise<'applied' | 'dropped'> {
  await waitRootResultDelay();
  const ws = typeof workspaceId === 'function' ? workspaceId() : workspaceId;
  return acceptRootResult(db as DB, rootId, ws, capturedGeneration, apply);
}
