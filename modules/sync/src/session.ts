import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { MessagePort } from 'node:worker_threads';
import {
  ReconcileCancelledError,
  ensureResource,
  getResource,
  reconcile,
  resolveInsideRoot,
  watchRoot,
  type ResourceChange,
  type WatchHandle,
} from '@kb/identity-watch';
import { closeIndexer, indexOne, removeOne, startIndex, type IndexJob } from '@kb/indexer';
import { openDatabase } from './open-db.ts';
import type { MainToWorker } from './protocol.ts';
import { relocateResource } from './relocate.ts';
import type { SqliteDb, SyncPhase, SyncProgress } from './types.ts';

const COALESCE_MS = 150;
const QUEUE_LIMIT = 256;
const INDEXABLE = new Set(['.txt', '.md', '.pdf']);

type Op = 'upsert' | 'delete' | 'relocate';

interface Queued {
  resourceId: string;
  op: Op;
  relPath: string | null;
}

interface StartOpts {
  rootId: string;
  dbPath: string;
  localPath: string;
}

export function attachSession(port: MessagePort): void {
  let control: SessionControl | null = null;
  port.on('message', (msg: MainToWorker) => {
    if (msg.type === 'start') {
      if (control) return;
      try {
        control = createSession(port, msg);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        port.postMessage({ type: 'finished', status: 'error', message });
      }
      return;
    }
    if (msg.type === 'cancel') {
      control?.cancel();
      return;
    }
    if (msg.type === 'when-idle') {
      if (!control) {
        port.postMessage({ type: 'idle-ack', id: msg.id, error: '同步还没启动' });
        return;
      }
      control.whenIdle(msg.id);
    }
  });
}

interface SessionControl {
  cancel(): void;
  whenIdle(id: number): void;
}

function createSession(port: MessagePort, start: StartOpts): SessionControl {
  const rootId = start.rootId;
  const dbPath = path.resolve(start.dbPath);
  const localPath = path.resolve(start.localPath);
  const db = openDatabase(dbPath);
  const abort = new AbortController();
  const queue = new Map<string, Queued>();
  const idCache = new Map<string, string>();
  let dirty = false;
  let watch: WatchHandle | null = null;
  let indexJob: IndexJob | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pumping = false;
  let pumpPromise: Promise<void> | null = null;
  let shut = false;
  let finishing = false;
  let cancelled = false;
  let failed = false;
  let endStatus: 'cancelled' | 'error' = 'cancelled';
  let endMessage: string | undefined;
  let readyPromise: Promise<void> = Promise.resolve();
  let markReady: () => void = () => {};
  let failReady: (err: Error) => void = () => {};
  readyPromise = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    failReady = reject;
  });
  // 调用方可能不观察 ready 的失败。
  readyPromise.catch(() => {});

  let latest: SyncProgress = {
    phase: 'reconcile',
    seen: 0,
    total: null,
    currentFile: null,
    pending: 0,
    dirty: false,
  };

  function emit(progress: SyncProgress): void {
    latest = progress;
    try {
      port.postMessage({ type: 'progress', progress });
    } catch {
      // 主线程已经走了
    }
  }

  function snapshot(phase: SyncPhase, seen: number, total: number | null, currentFile: string | null): void {
    emit({
      phase,
      seen,
      total,
      currentFile,
      pending: queue.size,
      dirty,
    });
  }

  function noteIdle(): void {
    if (shut) return;
    snapshot('idle', latest.seen, latest.total, null);
  }

  function messageOf(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
  }

  function isCancel(err: unknown): boolean {
    return (
      cancelled ||
      err instanceof ReconcileCancelledError ||
      (err instanceof Error && err.name === 'ReconcileCancelledError')
    );
  }

  async function shutdown(status: 'cancelled' | 'error', message?: string): Promise<void> {
    if (!shut) {
      shut = true;
      endStatus = status;
      endMessage = message;
      if (status === 'cancelled') cancelled = true;
      else failed = true;
      abort.abort();
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        indexJob?.cancel();
      } catch {
        // 任务可能已经结束
      }
    } else if (status === 'error' && !failed) {
      failed = true;
      endStatus = 'error';
      endMessage = message ?? endMessage;
    }
    // 对账或索引还占着这条连接时先不关，等那一轮退出再关。
    if (pumping || finishing) return;
    finishing = true;
    const job = indexJob;
    if (job) {
      try {
        await Promise.race([job.done.catch(() => undefined), sleep(2000)]);
      } catch {
        // 取消路径上的拒绝不算失败
      }
    }
    try {
      await watch?.close();
    } catch {
      // 监视可能已经停了
    }
    watch = null;
    // 先等 indexer 关掉自己的连接并退出，再关本会话的库。
    try {
      await closeIndexer();
    } catch {
      // 索引线程可能没开过
    }
    try {
      db.close();
    } catch {
      // 连接可能已关
    }
    const finalStatus = failed ? 'error' : endStatus;
    if (finalStatus === 'error') failReady(new Error(endMessage ?? 'sync error'));
    else markReady();
    snapshot(finalStatus === 'cancelled' ? 'cancelled' : 'error', latest.seen, latest.total, null);
    try {
      port.postMessage({ type: 'finished', status: finalStatus, message: endMessage });
    } catch {
      // 主线程已经走了
    }
  }

  function resolveResourceId(idRoot: string, relPath: string): string {
    const key = `${idRoot}\n${relPath.replace(/\\/g, '/').normalize('NFC').toLowerCase()}`;
    const cached = idCache.get(key);
    if (cached) return cached;
    const resolved = resolveInsideRoot(db, idRoot, relPath);
    if (resolved.resourceId) {
      idCache.set(key, resolved.resourceId);
      return resolved.resourceId;
    }
    const id = ensureResource(db, idRoot, relPath);
    idCache.set(key, id);
    return id;
  }

  async function runReconcile(phase: 'reconcile' | 'catchup'): Promise<void> {
    if (shut) return;
    snapshot(phase, 0, null, null);
    await reconcile(db, rootId, {
      signal: abort.signal,
      onProgress: (progress) => {
        snapshot(phase, progress.seen, progress.total, null);
      },
    });
  }

  async function runIndex(phase: 'index' | 'catchup'): Promise<void> {
    if (shut) return;
    idCache.clear();
    const job = startIndex({
      rootId,
      localPath,
      dbPath,
      mode: 'incremental',
      resolveResourceId,
    });
    indexJob = job;
    const off = job.onProgress((progress) => {
      snapshot(phase, progress.processed, progress.total, progress.currentFile);
    });
    try {
      const result = await job.done;
      if (result.errors.length > 0 || result.processed > 0) {
        console.error(
          `sync index ${phase} status=${result.status} processed=${result.processed} total=${result.total} errors=${result.errors.length}`,
        );
      }
      if (result.errors.length > 0) {
        console.error(`sync index errors ${JSON.stringify(result.errors.slice(0, 8))}`);
      }
      if (result.status === 'cancelled' && !cancelled && !shut) {
        throw new Error('增量索引意外取消');
      }
    } finally {
      off();
      if (indexJob === job) indexJob = null;
    }
  }

  function locate(resourceId: string): { rootId: string; relPath: string; absPath: string; localPath: string } | null {
    const snap = getResource(db, resourceId);
    if (!snap || snap.missing !== 0 || snap.kind !== 'file') return null;
    if (!indexable(snap.relPath)) return null;
    const absPath = path.join(localPath, ...snap.relPath.split('/'));
    if (!existsSync(absPath)) return null;
    return { rootId: snap.rootId, relPath: snap.relPath, absPath, localPath };
  }

  async function applyOne(item: Queued): Promise<void> {
    if (shut) return;
    snapshot('catchup', 0, null, item.relPath);
    if (item.op === 'delete') {
      removeOne(db, item.resourceId);
      return;
    }
    if (item.op === 'relocate') {
      const relPath = item.relPath;
      if (!relPath) return;
      const absPath = path.join(localPath, ...relPath.split('/'));
      try {
        if (!statSync(absPath).isFile()) return;
        relocateResource(db, { resourceId: item.resourceId, absPath, relPath });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          removeOne(db, item.resourceId);
          return;
        }
        throw err;
      }
      return;
    }
    const found = locate(item.resourceId);
    if (!found) {
      removeOne(db, item.resourceId);
      return;
    }
    await indexOne(db, item.resourceId, {
      lookupPath: () => locate(item.resourceId),
    });
  }

  async function applyBatch(batch: Queued[]): Promise<void> {
    let seen = 0;
    for (const item of batch) {
      if (shut) return;
      snapshot('catchup', seen, batch.length, item.relPath);
      try {
        await applyOne(item);
      } catch (err) {
        if (isCancel(err) || shut) return;
        console.error(`sync item ${item.resourceId} ${messageOf(err)}`);
      }
      seen += 1;
      snapshot('catchup', seen, batch.length, item.relPath);
    }
  }

  async function doPump(): Promise<void> {
    if (pumping || shut) return;
    pumping = true;
    try {
      while (!shut && (dirty || queue.size > 0)) {
        if (dirty) {
          queue.clear();
          dirty = false;
          await runReconcile('catchup');
          if (shut) return;
          await runIndex('catchup');
        } else {
          const batch = [...queue.values()];
          queue.clear();
          await applyBatch(batch);
        }
      }
    } finally {
      pumping = false;
    }
    if (shut) {
      await shutdown(failed ? 'error' : 'cancelled');
      return;
    }
    if (dirty || queue.size > 0) schedule();
    else noteIdle();
  }

  function requestPump(): Promise<void> {
    if (pumpPromise) return pumpPromise;
    pumpPromise = doPump()
      .catch(async (err: unknown) => {
        if (shut || isCancel(err)) {
          await shutdown('cancelled');
          return;
        }
        await shutdown('error', messageOf(err));
      })
      .finally(() => {
        pumpPromise = null;
      });
    return pumpPromise;
  }

  function schedule(): void {
    if (shut || pumping) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void requestPump();
    }, COALESCE_MS);
  }

  function enqueue(event: ResourceChange): void {
    if (shut || cancelled) return;
    try {
      const next = mergeQueued(queue.get(event.resourceId), event);
      if (!next) return;
      if (dirty) {
        if (!pumping) schedule();
        return;
      }
      const isNew = !queue.has(next.resourceId);
      if (isNew && queue.size >= QUEUE_LIMIT) {
        queue.clear();
        dirty = true;
        snapshot('catchup', latest.seen, latest.total, null);
        if (!pumping) schedule();
        return;
      }
      queue.set(next.resourceId, next);
      snapshot(latest.phase === 'idle' ? 'catchup' : latest.phase, latest.seen, latest.total, next.relPath);
      if (!pumping) schedule();
    } catch (err) {
      console.error(messageOf(err));
    }
  }

  async function initial(): Promise<void> {
    pumping = true;
    try {
      await runReconcile('reconcile');
      if (shut) return;
      await runIndex('index');
      if (shut) return;
      watch = await watchRoot(db, rootId, (event) => enqueue(event));
      if (shut) return;
      // 监视挂上之前落盘的文件不会产生事件，这里补一次增量。
      await runIndex('catchup');
    } finally {
      pumping = false;
      if (shut) await shutdown(failed ? 'error' : 'cancelled');
    }
  }

  async function drainForIdle(): Promise<void> {
    for (let i = 0; i < 12; i += 1) {
      if (shut) return;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await requestPump();
      if (shut) return;
      if (watch) await watch.whenIdle();
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (dirty || queue.size > 0) {
        await requestPump();
      }
      if (!timer && !dirty && queue.size === 0 && !pumping && !pumpPromise && !indexJob) return;
    }
    if (!shut) throw new Error('同步没有进入空闲');
  }

  let idleChain: Promise<void> = Promise.resolve();

  function whenIdle(id: number): void {
    idleChain = idleChain.then(async () => {
      try {
        await readyPromise;
        if (!shut) await drainForIdle();
        port.postMessage({ type: 'idle-ack', id });
      } catch (err) {
        const message = messageOf(err);
        if (!shut && !isCancel(err)) {
          await shutdown('error', message);
        }
        try {
          port.postMessage({ type: 'idle-ack', id, error: shut && cancelled ? undefined : message });
        } catch {
          // 主线程已经走了
        }
      }
    });
  }

  function cancel(): void {
    cancelled = true;
    abort.abort();
    try {
      indexJob?.cancel();
    } catch {
      // 已经结束
    }
    void shutdown('cancelled');
  }

  void (async () => {
    try {
      await initial();
      if (cancelled || shut) {
        await shutdown('cancelled');
        return;
      }
      markReady();
      if (dirty || queue.size > 0) schedule();
      else noteIdle();
    } catch (err) {
      if (cancelled || isCancel(err)) await shutdown('cancelled');
      else await shutdown('error', messageOf(err));
    }
  })();

  return { cancel, whenIdle };
}

function indexable(relPath: string | null | undefined): boolean {
  if (!relPath) return false;
  const base = relPath.split('/').pop() ?? relPath;
  if (!base || base.startsWith('.')) return false;
  return INDEXABLE.has(path.extname(base).toLowerCase());
}

/** delete 压过还没执行的 modify。纯改名不升级成 upsert。 */
export function mergeQueued(prev: Queued | undefined, event: ResourceChange): Queued | undefined {
  const kind = event.after?.kind ?? event.before?.kind;
  if (kind !== 'file') return prev;
  const resourceId = event.resourceId;
  if (event.type === 'delete') {
    const rel = event.before?.relPath ?? prev?.relPath ?? null;
    if (!prev && !indexable(rel)) return prev;
    return { resourceId, op: 'delete', relPath: rel };
  }
  const rel = event.after?.relPath ?? null;
  if (!indexable(rel)) return prev;
  if (event.type === 'modify') {
    if (prev?.op === 'delete') return prev;
    return { resourceId, op: 'upsert', relPath: rel };
  }
  if (event.type === 'create') {
    return { resourceId, op: 'upsert', relPath: rel };
  }
  if (prev?.op === 'upsert') return { resourceId, op: 'upsert', relPath: rel ?? prev.relPath };
  if (prev?.op === 'delete') return { resourceId, op: 'upsert', relPath: rel };
  return { resourceId, op: 'relocate', relPath: rel };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
