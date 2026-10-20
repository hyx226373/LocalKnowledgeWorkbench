import path from 'node:path';
import { disk as fs } from '../service/disk';
import type Database from 'better-sqlite3';
import type { WorkbenchService } from '../service/WorkbenchService';
import type { ContentScope, indexOne, removeOne } from '@kb/indexer';
import { CONTENT_INDEX_FULL_NOTICE, getIndexHealth, setIndexHealth } from './indexHealth';
import { classifyLiveIndexError, type LiveIndexErrorKind } from './liveIndexError';
import { WorkbenchContentScope } from './contentScope';

/** 实时写入一批最多这么多条，和 indexer 的 indexMany 上限一致。 */
export const LIVE_INDEX_BATCH = 200;

const ALWAYS_INDEX_EXT = new Set(['txt', 'md', 'pdf']);

export type LiveIndexMany = (
  db: import('better-sqlite3').Database,
  items: Array<{ resourceId: string; rootId: string; relPath: string; absPath: string; localPath?: string }>,
  opts?: { contentScope?: ContentScope; maxBytes?: number },
) => Promise<unknown>;

type LiveWrite = { id: string; rel: string; indexRel: string; abs: string; localPath: string };

function fileExt(rel: string): string {
  const base = rel.split('/').pop() ?? rel;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

/** 批量扫描会登记的文件：txt/md/pdf、范围内扩展名、点名路径。图片没有 indexer 行时不在这里。 */
function fileShouldHaveIndexRow(rel: string, scope: ContentScope): boolean {
  const base = rel.split('/').pop() ?? rel;
  if (base.startsWith('.')) return false;
  const ext = fileExt(rel);
  if (ALWAYS_INDEX_EXT.has(ext)) return true;
  if (scope.includeExts.some((item) => item.toLowerCase() === ext)) return true;
  return (scope.includeRelPaths ?? []).includes(rel);
}

type Change = { rootId: string; relPath: string; type: string };
type Row = { id: string; root_id: string; rel_path: string; kind: string; size: number; mtime_ms: number; missing_since: number | null; out_of_scope: number };
type Indexed = { resource_id: string; rel_path: string; size: number; mtime_ms: number; body_indexed?: number | null };

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
  private appliedScopeKey = '';
  private scopes = new Map<string, ContentScope>();
  private scopeSource: WorkbenchContentScope;
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
    scopeSource?: WorkbenchContentScope,
    private indexMany?: LiveIndexMany,
  ) {
    this.debounceMs = debounceMs ?? 150;
    this.scopeSource = scopeSource ?? new WorkbenchContentScope(svc);
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
  /** Reindex changed membership with indexOne: it replaces body with a name-only row. */
  dropOutOfScope = (): void => {
    if (this.closing) return;
    const scopes = this.scopeSource.snapshot();
    const key = JSON.stringify([...scopes]);
    if (key === this.appliedScopeKey) return;
    const previous = this.scopes;
    this.scopes = scopes;
    this.appliedScopeKey = key;
    for (const [rootId, scope] of scopes) {
      if (JSON.stringify(previous.get(rootId)) === JSON.stringify(scope)) continue;
      const before = previous.get(rootId);
      const policy = (value: ContentScope) => JSON.stringify({ ...value, includeRelPaths: [] });
      if (before && policy(before) === policy(scope)) {
        const oldPaths = new Set(before.includeRelPaths ?? []);
        const newPaths = new Set(scope.includeRelPaths ?? []);
        const root = this.svc.listRoots().find((item) => item.id === rootId);
        for (const rel of new Set([...oldPaths, ...newPaths])) {
          if (oldPaths.has(rel) !== newPaths.has(rel)) this.queuePath(rootId, root?.kind === 'file' ? '' : rel);
        }
      } else {
        const rows = this.db.prepare("SELECT rel_path FROM resources WHERE root_id=? AND kind='file'").all(rootId) as { rel_path: string }[];
        for (const row of rows) this.queuePath(rootId, row.rel_path);
      }
    }
    if (this.pending.size && !this.gates.length) this.schedule();
  };
  /**
   * 用当前范围比对这一根的正文标记。不一致的排队重写，该有 indexer 行但没有的也排队。
   * 范围键已经更新过时，dropOutOfScope 不会再排队，所以批量写完后要走这里。
   */
  reconcileRoot = (rootId: string): void => {
    if (this.closing) return;
    const scopes = this.scopeSource.snapshot();
    const scope = scopes.get(rootId);
    // 只把这一根记为已应用。别的根若范围有变化，留给下一次 dropOutOfScope 比对排队，
    // 不能整份覆盖 scopes / appliedScopeKey，否则会吞掉别的根尚未处理的变化。
    const next = new Map(this.scopes);
    if (scope) next.set(rootId, scope); else next.delete(rootId);
    this.scopes = next;
    this.appliedScopeKey = JSON.stringify([...next]);
    const root = this.svc.listRoots().find((item) => item.id === rootId);
    if (!scope || !root) return;
    const include = new Set(scope.includeRelPaths ?? []);
    const indexed = this.loadIndexed(rootId);
    let resources: Array<{ id: string; rel_path: string; missing_since: number | null; out_of_scope: number | null }> = [];
    try {
      resources = this.db.prepare(
        `SELECT id, rel_path, missing_since, out_of_scope FROM resources WHERE root_id=? AND kind='file'`,
      ).all(rootId) as typeof resources;
    } catch {
      return;
    }
    for (const row of resources) {
      if (row.missing_since !== null || row.out_of_scope) continue;
      const indexRel = root.kind === 'file' ? path.basename(root.path) : row.rel_path;
      const wantBody = include.has(indexRel);
      const prior = indexed.get(row.id);
      if (!prior) {
        if (wantBody || fileShouldHaveIndexRow(indexRel, scope)) {
          this.queuePath(rootId, root.kind === 'file' ? '' : row.rel_path);
        }
        continue;
      }
      const hadBody = typeof prior.body_indexed === 'number' ? prior.body_indexed !== 0 : undefined;
      if (hadBody === undefined || hadBody !== wantBody) {
        this.queuePath(rootId, root.kind === 'file' ? '' : row.rel_path);
      }
    }
    if (this.pending.size && !this.gates.length) this.schedule();
  };
  private loadIndexed(rootId: string): Map<string, { body_indexed: number | null }> {
    try {
      const sql = this.hasBodyColumn()
        ? 'SELECT resource_id, body_indexed FROM indexer_files WHERE root_id=?'
        : 'SELECT resource_id, NULL AS body_indexed FROM indexer_files WHERE root_id=?';
      const rows = this.db.prepare(sql).all(rootId) as Array<{ resource_id: string; body_indexed: number | null }>;
      return new Map(rows.map((row) => [row.resource_id, row]));
    } catch {
      return new Map();
    }
  }
  private restoreBusy(prevTimeout: number) {
    this.db.pragma(`busy_timeout = ${Number.isFinite(prevTimeout) && prevTimeout > 0 ? prevTimeout : 5000}`);
  }
  private async writeOne(rootId: string, scope: ContentScope, job: LiveWrite): Promise<void> {
    const prevTimeout = Number(this.db.pragma('busy_timeout', { simple: true }));
    this.db.pragma('busy_timeout = 0');
    try {
      await this.index(this.db, job.id, {
        lookupPath: () => ({ rootId, relPath: job.indexRel, absPath: job.abs, localPath: job.localPath }),
        contentScope: scope,
        maxBytes: scope.maxBytes,
      });
      this.forget(rootId, job.rel);
    } catch (error) {
      this.onIndexError(rootId, job.rel, error);
    } finally {
      this.restoreBusy(prevTimeout);
    }
  }
  private async writeLive(rootId: string, scope: ContentScope, jobs: LiveWrite[]): Promise<void> {
    if (!jobs.length) return;
    const many = this.indexMany;
    if (!many) {
      for (const job of jobs) await this.writeOne(rootId, scope, job);
      return;
    }
    for (let i = 0; i < jobs.length; i += LIVE_INDEX_BATCH) {
      const slice = jobs.slice(i, i + LIVE_INDEX_BATCH);
      const prevTimeout = Number(this.db.pragma('busy_timeout', { simple: true }));
      this.db.pragma('busy_timeout = 0');
      try {
        await many(this.db, slice.map((job) => ({
          resourceId: job.id,
          rootId,
          relPath: job.indexRel,
          absPath: job.abs,
          localPath: job.localPath,
        })), { contentScope: scope, maxBytes: scope.maxBytes });
        for (const job of slice) this.forget(rootId, job.rel);
      } catch (error) {
        if (classifyLiveIndexError(error) === 'full') {
          for (const job of slice) this.onIndexError(rootId, job.rel, error);
        } else {
          for (const job of slice) await this.writeOne(rootId, scope, job);
        }
      } finally {
        this.restoreBusy(prevTimeout);
      }
    }
  }
  private bodyColumn: boolean | undefined;
  private hasBodyColumn(): boolean {
    if (this.bodyColumn === undefined) {
      try {
        const cols = this.db.prepare('PRAGMA table_info(indexer_files)').all() as { name: string }[];
        this.bodyColumn = cols.some((col) => col.name === 'body_indexed');
      } catch { return false; }
    }
    return this.bodyColumn;
  }
  private async drain() {
    if (this.gates.length) await Promise.allSettled(this.gates);
    if (this.gates.length) return;
    await Promise.allSettled([...this.scans]);
    this.dropOutOfScope();
    while (this.pending.size) {
      this.dropOutOfScope();
      const batch = this.pending;
      this.pending = new Map();
      for (const [rootId, paths] of batch) {
        const root = this.svc.listRoots().find(r => r.id === rootId);
        const scope = this.scopes.get(rootId);
        if (!scope) continue;
        const specific = paths.has('') ? (this.db.prepare("SELECT rel_path FROM resources WHERE root_id=? AND kind='file'").all(rootId) as { rel_path: string }[]).map((row) => row.rel_path) : [...paths];
        if (!specific.length) continue;
        const writes: LiveWrite[] = [];
        for (const rel of specific) {
          const like = rel.replace(/[\\%_]/g, (ch) => '\\' + ch) + '/%';
          const rows = this.db.prepare(
            `SELECT * FROM resources WHERE root_id=? AND (rel_path=? OR rel_path LIKE ? ESCAPE '\\')`,
          ).all(rootId, rel, like) as Row[];
          const tracked = this.db.prepare(
            `SELECT resource_id, rel_path, size, mtime_ms${this.hasBodyColumn() ? ', body_indexed' : ''} FROM indexer_files WHERE root_id=? AND (rel_path=? OR rel_path LIKE ? ESCAPE '\\')`,
          ).all(rootId, rel, like) as Indexed[];
          const old = new Map(tracked.map(r => [r.resource_id, r]));
          for (const row of rows) {
            await new Promise((resolve) => setImmediate(resolve));
            const id = row.id;
            try {
              if (!root || row.missing_since !== null || row.out_of_scope || row.kind !== 'file') {
                if (old.has(id)) this.remove(this.db, id);
                this.forget(rootId, row.rel_path);
                continue;
              }
              const abs = root.kind === 'file' ? root.path : path.join(root.path, ...row.rel_path.split('/'));
              if (!fs.existsSync(abs)) { if (old.has(id)) this.remove(this.db, id); this.forget(rootId, row.rel_path); continue; }
              // 文件没变且正文状态已与范围一致时跳过，避免启动/范围变化时整根重写。
              const prior = old.get(id);
              const indexRel = root.kind === 'file' ? path.basename(abs) : row.rel_path;
              if (prior && prior.rel_path === row.rel_path && typeof prior.body_indexed === 'number') {
                const stat = fs.statSync(abs);
                const wantBody = (scope.includeRelPaths ?? []).includes(indexRel);
                if (prior.size === stat.size && Math.abs(prior.mtime_ms - stat.mtimeMs) < 1 && (prior.body_indexed !== 0) === wantBody) {
                  this.forget(rootId, row.rel_path);
                  continue;
                }
              }
              writes.push({
                id,
                rel: row.rel_path,
                indexRel,
                abs,
                localPath: root.kind === 'file' ? path.dirname(abs) : root.path,
              });
            } catch (error) {
              this.onIndexError(rootId, row.rel_path, error);
            }
          }
        }
        await this.writeLive(rootId, scope, writes);
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
