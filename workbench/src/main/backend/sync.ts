/**
 * 同步（对账扫描）适配层（第 9/10 轮 E）。
 * 磐石 createSync({ db, dbPath, resolveLocalPath }).startSync(rootId) → SyncHandle
 * KbSync 包装真实 createSync；LocalSync 保留作无 modules 栈时的兜底。
 */
import type { WorkbenchService } from '../service/WorkbenchService';
import type { IndexStatus } from '../../shared/types';

export interface SyncProgress {
  rootId: string;
  phase: 'scanning' | 'indexing' | 'idle' | 'cancelled' | 'error' | 'reconcile' | 'catchup';
  processed: number;
  total?: number;
  error?: string;
}
export interface SyncHandle {
  onProgress(cb: (p: SyncProgress) => void): () => void;
  cancel(): void;
  whenIdle(): Promise<void>;
  done: Promise<{ ok: boolean; cancelled: boolean; error?: string }>;
}
export interface SyncBackend {
  startSync(rootId: string): SyncHandle;
}
export type CreateSyncFn = (o: { db: unknown; dbPath: string; resolveLocalPath: (rootId: string, relPath?: string) => string }) => SyncBackend;

/** 包装对方 SyncHandle：保证 done 只结算一次、cancel 幂等、onProgress 取消订阅后不再回调 */
export function guardHandle(h: SyncHandle): SyncHandle {
  let cancelled = false;
  return {
    onProgress(cb) {
      let on = true;
      const off = h.onProgress((p) => on && cb(p));
      return () => {
        on = false;
        off();
      };
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      h.cancel();
    },
    whenIdle: () => h.whenIdle(),
    done: h.done.then(
      (r) => ({ ok: !!r?.ok, cancelled: !!r?.cancelled || cancelled, ...(r?.error ? { error: String(r.error) } : {}) }),
      (e) => ({ ok: false, cancelled, error: String((e as Error)?.message ?? e) }),
    ),
  };
}

/** 包装 @kb/sync 的 SyncController */
export class KbSync implements SyncBackend {
  constructor(
    private ctrl: { startSync(rootId: string): { onProgress(cb: (p: { phase: string; seen: number; total: number | null; currentFile: string | null; pending: number; dirty: boolean }) => void): () => void; cancel(): void; whenIdle(): Promise<void>; done: Promise<{ status: 'cancelled' | 'error'; message?: string }> } },
  ) {}
  startSync(rootId: string): SyncHandle {
    const h = this.ctrl.startSync(rootId);
    return guardHandle({
      onProgress: (cb) =>
        h.onProgress((p) => {
          const phase =
            p.phase === 'index' || p.phase === 'indexing'
              ? 'indexing'
              : p.phase === 'reconcile' || p.phase === 'catchup'
                ? 'scanning'
                : p.phase === 'idle'
                  ? 'idle'
                  : p.phase === 'cancelled'
                    ? 'cancelled'
                    : p.phase === 'error'
                      ? 'error'
                      : 'scanning';
          cb({
            rootId,
            phase,
            processed: p.seen,
            ...(p.total != null ? { total: p.total } : {}),
          });
        }),
      cancel: () => h.cancel(),
      whenIdle: () => h.whenIdle(),
      // @kb/sync 的 done 只在 cancel/error 时结束；正常监视不结束。契约要 {ok,cancelled}
      done: h.done.then(
        (r) => ({ ok: false, cancelled: r.status === 'cancelled', error: r.status === 'error' ? 'sync error' : undefined }),
        (e) => ({ ok: false, cancelled: false, error: String((e as Error)?.message ?? e) }),
      ),
    });
  }
}

export class LocalSync implements SyncBackend {
  constructor(private svc: WorkbenchService) {}
  startSync(rootId: string): SyncHandle {
    const listeners = new Set<(p: SyncProgress) => void>();
    const onStatus = (all: IndexStatus[]) => {
      const s = all.find((x) => x.rootId === rootId);
      if (!s) return;
      const p: SyncProgress = { rootId, phase: s.state === 'scanning' ? 'scanning' : s.state === 'error' ? 'error' : 'idle', processed: s.progress, ...(s.lastError ? { error: s.lastError } : {}) };
      listeners.forEach((l) => l(p));
    };
    this.svc.on('index-status', onStatus);
    let cancelled = false;
    const run = this.svc.scanRoot(rootId);
    const done = Promise.resolve(run).then(
      () => ({ ok: !cancelled, cancelled }),
      (e) => ({ ok: false, cancelled, error: String((e as Error)?.message ?? e) }),
    );
    void done.finally(() => this.svc.off('index-status', onStatus));
    return guardHandle({
      onProgress: (cb) => (listeners.add(cb), () => listeners.delete(cb)),
      cancel: () => {
        cancelled = true;
        this.svc.cancelScan(rootId);
      },
      whenIdle: () => done.then(() => undefined),
      done,
    });
  }
}
