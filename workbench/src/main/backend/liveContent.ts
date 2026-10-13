import path from 'node:path';
import { disk as fs } from '../service/disk';
import type Database from 'better-sqlite3';
import type { WorkbenchService } from '../service/WorkbenchService';
import type { indexOne, removeOne } from '@kb/indexer';
import { CONTENT_INDEX_FULL_NOTICE, getIndexHealth, setIndexHealth } from './indexHealth';
import { classifyLiveIndexError, type LiveIndexErrorKind } from './liveIndexError';

type Change = { rootId: string; relPath: string; type: string };
type Row = { id: string; root_id: string; rel_path: string; kind: string; size: number; mtime_ms: number; missing_since: number | null; out_of_scope: number };
type Indexed = { resource_id: string; rel_path: string; size: number; mtime_ms: number };

export const LIVE_INDEX_RETRY = { baseMs: 200, capMs: 30_000, maxAttempts: 8 } as const;

export type CompactTextIndexFn = (
  db: import('better-sqlite3').Database,
) => { ok: boolean; steps: number } | Promise<{ ok: boolean; steps: number }>;

/** 第 n 次失败后的等待。n 从 1 起，第 1 次是 200ms。 */
export function liveIndexRetryDelay(failedAttempts: number): number {
  const exp = Math.max(0, failedAttempts - 1);
  const factor = exp >= 31 ? Number.POSITIVE_INFINITY : 2 ** exp;
  return Math.min(LIVE_INDEX_RETRY.capMs, LIVE_INDEX_RETRY.baseMs * factor);
}

type FailureRec = {
  rootId: string;
  relPath: string;
  kind: LiveIndexErrorKind;
  attempts: number;
  postCompact: boolean;
};

type CompactResult = { ok: boolean; steps: number };

let processCompactTask: Promise<CompactResult> | null = null;

/** 压实是进程级一次。测试用例之间要清掉，生产路径不会调用。 */
export function resetLiveIndexCompactForTests(): void {
  processCompactTask = null;
}

/** Directory events are already committed by WorkbenchService before fs-change.
 * Use that same database and resource IDs for the live body index. */
export class LiveContentIndex {
  private pending = new Map<string, Set<string>>();
  private timer?: ReturnType<typeof setTimeout>;
  private running: Promise<void> | null = null;
  private closing = false;
  private scans = new Set<Promise<unknown>>();
  private gates: Array<Promise<unknown>> = [];
  private readonly failures = new Map<string, FailureRec>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private debounceMs: number;
  private compactJoined = false;
  private compactSeen = false;
  private compactWasOk = false;
  private fullStopped = false;

  constructor(
    private svc: WorkbenchService,
    private db: Database.Database,
    private index: typeof indexOne,
    private remove: typeof removeOne,
    debounceMs = 150,
    private compact?: CompactTextIndexFn,
  ) {
    this.debounceMs = debounceMs ?? 150;
  }

  track(done: Promise<unknown>) {
    this.scans.add(done);
    void done.finally(() => {
      this.scans.delete(done);
      if (!this.closing) this.replayFailures();
    });
  }
  /** 扫描和正文索引结束前不在主进程写全文。事件先攒着。 */
  hold(done: Promise<unknown>) {
    this.gates.push(done);
    void done.finally(() => {
      this.gates = this.gates.filter((item) => item !== done);
      if (!this.gates.length && this.pending.size && !this.closing) this.schedule();
    });
  }
  enqueue = (events: Change[]) => {
    if (this.closing) return;
    for (const event of events) {
      const rel = event.relPath.replace(/\\/g, '/');
      this.queuePath(event.rootId, rel);
      this.clearRetry(event.rootId, rel);
    }
    if (this.gates.length) return;
    this.schedule();
  };
  /** 把还没写进去的路径放回 pending。压实成功和手动重建结束时调用。 */
  replayFailures(): void {
    if (this.closing || !this.failures.size) return;
    for (const rec of this.failures.values()) {
      this.clearRetry(rec.rootId, rec.relPath);
      this.queuePath(rec.rootId, rec.relPath);
    }
    if (!this.gates.length) this.schedule();
  }
  private schedule() {
    if (this.closing) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, this.debounceMs);
  }
  async flush(): Promise<void> {
    if (this.running) { await this.running; if (this.pending.size) await this.flush(); return; }
    this.running = this.drain().finally(() => { this.running = null; });
    await this.running;
  }
  private failKey(rootId: string, relPath: string) {
    return `${rootId}\0${relPath}`;
  }
  private queuePath(rootId: string, relPath: string) {
    const paths = this.pending.get(rootId) ?? new Set<string>();
    paths.add(relPath);
    this.pending.set(rootId, paths);
  }
  private clearRetry(rootId: string, relPath: string) {
    const key = this.failKey(rootId, relPath);
    const timer = this.retryTimers.get(key);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(key);
  }
  private remember(rootId: string, relPath: string, kind: LiveIndexErrorKind): FailureRec {
    const key = this.failKey(rootId, relPath);
    const prev = this.failures.get(key);
    if (prev) {
      prev.kind = kind;
      return prev;
    }
    const rec: FailureRec = { rootId, relPath, kind, attempts: 0, postCompact: false };
    this.failures.set(key, rec);
    return rec;
  }
  private forget(rootId: string, relPath: string) {
    this.clearRetry(rootId, relPath);
    this.failures.delete(this.failKey(rootId, relPath));
    this.publishExhausted();
    if (this.fullStopped && ![...this.failures.values()].some((item) => item.kind === 'full')) {
      this.fullStopped = false;
      setIndexHealth({ contentIndexNotice: undefined });
    }
  }
  /** 重试次数用完的路径留在 failures 里，同时写进索引状态。 */
  private publishExhausted() {
    const contentIndexFailed = [...this.failures.values()]
      .filter((rec) => (rec.kind === 'locked' || rec.kind === 'busy') && rec.attempts >= LIVE_INDEX_RETRY.maxAttempts)
      .map((rec) => ({ rootId: rec.rootId, relPath: rec.relPath, kind: rec.kind as 'locked' | 'busy' }));
    const prev = getIndexHealth().contentIndexFailed ?? [];
    const same = prev.length === contentIndexFailed.length && prev.every((item, index) => {
      const next = contentIndexFailed[index];
      return !!next && item.rootId === next.rootId && item.relPath === next.relPath && item.kind === next.kind;
    });
    if (!same) setIndexHealth({ contentIndexFailed });
  }
  private armRetry(rootId: string, relPath: string, delay: number) {
    if (this.closing) return;
    this.clearRetry(rootId, relPath);
    const key = this.failKey(rootId, relPath);
    const timer = setTimeout(() => {
      this.retryTimers.delete(key);
      if (this.closing) return;
      this.queuePath(rootId, relPath);
      if (this.gates.length) return;
      void this.flush();
    }, delay);
    this.retryTimers.set(key, timer);
  }
  private noteFullGiveUp() {
    if (this.closing) return;
    this.fullStopped = true;
    setIndexHealth({ contentIndexNotice: CONTENT_INDEX_FULL_NOTICE });
  }
  private executeCompact(): Promise<CompactResult> {
    const compact = this.compact ?? (() => ({ ok: false, steps: 0 }));
    return Promise.resolve()
      .then(() => compact(this.db))
      .then((got) => {
        const steps = got && Number.isFinite(got.steps) ? got.steps : 0;
        return { ok: !!(got && got.ok === true), steps };
      })
      .catch((error: unknown) => {
        console.error('[backend] live content 压实失败', error);
        return { ok: false, steps: 0 };
      });
  }
  /** 整个进程只压实一次。full 不回到 200ms 重试。 */
  private requestCompact() {
    if (this.compactJoined || this.closing) return;
    this.compactJoined = true;
    if (!processCompactTask) processCompactTask = this.executeCompact();
    void processCompactTask.then((result) => {
      if (this.closing) return;
      this.compactSeen = true;
      this.compactWasOk = result.ok;
      if (result.ok) {
        for (const rec of this.failures.values()) {
          if (rec.kind === 'full') rec.postCompact = true;
        }
        this.replayFailures();
        return;
      }
      this.noteFullGiveUp();
    });
  }
  private onFull(rootId: string, relPath: string) {
    const rec = this.remember(rootId, relPath, 'full');
    if (!this.compactJoined) {
      this.requestCompact();
      return;
    }
    if (!this.compactSeen) return;
    if (this.compactWasOk && !rec.postCompact) {
      rec.postCompact = true;
      this.queuePath(rootId, relPath);
      if (!this.gates.length) this.schedule();
      return;
    }
    this.noteFullGiveUp();
  }
  private onIndexError(rootId: string, relPath: string, error: unknown) {
    const kind = classifyLiveIndexError(error);
    if (kind === 'locked' || kind === 'busy') {
      const rec = this.remember(rootId, relPath, kind);
      rec.attempts += 1;
      if (rec.attempts >= LIVE_INDEX_RETRY.maxAttempts) {
        this.publishExhausted();
        return;
      }
      this.armRetry(rootId, relPath, liveIndexRetryDelay(rec.attempts));
      return;
    }
    if (kind === 'full') {
      this.onFull(rootId, relPath);
      return;
    }
    console.error('[backend] live content', rootId, relPath, error);
  }
  private async drain() {
    if (this.gates.length) await Promise.allSettled(this.gates);
    if (this.gates.length) return;
    await Promise.allSettled([...this.scans]);
    while (this.pending.size) {
      const batch = this.pending;
      this.pending = new Map();
      for (const [rootId, paths] of batch) {
        const root = this.svc.listRoots().find(r => r.id === rootId);
        const specific = [...paths].filter((rel) => rel !== '');
        if (!specific.length) continue;
        for (const rel of specific) {
          const like = rel.replace(/[\\%_]/g, (ch) => '\\' + ch) + '/%';
          const rows = this.db.prepare(
            `SELECT * FROM resources WHERE root_id=? AND (rel_path=? OR rel_path LIKE ? ESCAPE '\\')`,
          ).all(rootId, rel, like) as Row[];
          const tracked = this.db.prepare(
            `SELECT resource_id, rel_path, size, mtime_ms FROM indexer_files WHERE root_id=? AND (rel_path=? OR rel_path LIKE ? ESCAPE '\\')`,
          ).all(rootId, rel, like) as Indexed[];
          const old = new Map(tracked.map(r => [r.resource_id, r]));
          for (const row of rows) {
            await new Promise((resolve) => setImmediate(resolve));
            const id = row.id;
            try {
              if (!root || row.missing_since !== null || row.out_of_scope || row.kind !== 'file' || !/\.(md|txt|pdf)$/i.test(row.rel_path)) {
                if (old.has(id)) this.remove(this.db, id);
                this.forget(rootId, row.rel_path);
                continue;
              }
              const prior = old.get(id);
              if (prior && prior.rel_path === row.rel_path && prior.size === row.size && Math.abs(prior.mtime_ms - row.mtime_ms) < 1) {
                this.forget(rootId, row.rel_path);
                continue;
              }
              const abs = root.kind === 'file' ? root.path : path.join(root.path, ...row.rel_path.split('/'));
              if (!fs.existsSync(abs)) { if (old.has(id)) this.remove(this.db, id); this.forget(rootId, row.rel_path); continue; }
              const stat = fs.statSync(abs);
              if (prior && prior.rel_path === row.rel_path && prior.size === stat.size && Math.abs(prior.mtime_ms - stat.mtimeMs) < 1) {
                this.forget(rootId, row.rel_path);
                continue;
              }
              const prevTimeout = Number(this.db.pragma('busy_timeout', { simple: true }));
              this.db.pragma('busy_timeout = 0');
              try {
                await this.index(this.db, id, { lookupPath: () => ({ rootId, relPath: row.rel_path, absPath: abs, localPath: root.kind === 'file' ? path.dirname(abs) : root.path }) });
                this.forget(rootId, row.rel_path);
              } finally {
                this.db.pragma(`busy_timeout = ${Number.isFinite(prevTimeout) && prevTimeout > 0 ? prevTimeout : 5000}`);
              }
            } catch (error) {
              this.onIndexError(rootId, row.rel_path, error);
            }
          }
        }
      }
      const row = this.db.prepare('SELECT COUNT(*) AS n FROM indexer_files').get() as { n: number };
      setIndexHealth({ contentIndexedFiles: row.n });
    }
  }
  async close() {
    this.closing = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    if (this.gates.length) {
      this.gates = [];
      this.pending.clear();
      return;
    }
    await this.flush();
  }
}
