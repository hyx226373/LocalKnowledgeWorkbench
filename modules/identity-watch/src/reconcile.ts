import { Worker } from 'node:worker_threads';
import { databasePath, getMount, type Db } from './db.ts';
import { ReconcileCancelledError } from './errors.ts';
import { detectFileSystem } from './fsinfo.ts';
import { jobLock } from './job-lock.ts';
import type { FsCapabilities, ReconcileOptions, ReconcileProgress, ReconcileResult } from './types.ts';

interface WorkerMsg {
  type: 'progress' | 'done' | 'cancelled' | 'error';
  progress?: ReconcileProgress;
  result?: ReconcileResult;
  message?: string;
  stack?: string;
}

function workerUrl(): URL {
  // tsc 产物旁边是 .js。vitest 直接跑 src 时 import.meta.url 仍指向 .ts。
  if (import.meta.url.endsWith('.ts') || import.meta.url.includes('.ts?')) {
    return new URL('./reconcile-worker.ts', import.meta.url);
  }
  return new URL('./reconcile-worker.js', import.meta.url);
}

function capsFor(absPath: string, options: ReconcileOptions): FsCapabilities {
  const detected = detectFileSystem(absPath);
  if (options.forceFileIdReliable == null && options.forceFileSystemName == null) return detected;
  return {
    name: options.forceFileSystemName ?? detected.name,
    fileIdReliable: options.forceFileIdReliable ?? detected.fileIdReliable,
  };
}

/** 在 worker_threads 里跑。better-sqlite3 连接不传给 worker，由它按 dbPath 自己打开。 */
export function reconcile(db: Db, rootId: string, options: ReconcileOptions = {}): Promise<ReconcileResult> {
  const dbPath = databasePath(db);
  const caps = capsFor(getMount(db, rootId), options);
  const sab = new SharedArrayBuffer(4);
  const flag = new Int32Array(sab);
  if (options.signal?.aborted) Atomics.store(flag, 0, 1);

  const worker = new Worker(workerUrl(), {
    execArgv: [],
    workerData: {
      dbPath,
      rootId,
      delayMs: options.interFileDelayMs ?? 0,
      sab,
      caps,
      lock: jobLock(db),
    },
  });

  let killTimer: NodeJS.Timeout | undefined;
  const onAbort = () => {
    Atomics.store(flag, 0, 1);
    killTimer = setTimeout(() => {
      void worker.terminate();
    }, 700);
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  const finished = new Promise<ReconcileResult>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    worker.on('message', (msg: WorkerMsg) => {
      if (msg.type === 'progress') {
        try {
          if (msg.progress) options.onProgress?.(msg.progress);
        } catch {
          /* 进度回调失败不影响对账 */
        }
        return;
      }
      if (msg.type === 'done' && msg.result) finish(() => resolve(msg.result as ReconcileResult));
      else if (msg.type === 'cancelled') finish(() => reject(new ReconcileCancelledError()));
      else if (msg.type === 'error') {
        const error = new Error(msg.stack ? `${msg.message}\n${msg.stack}` : msg.message);
        finish(() => reject(error));
      }
    });
    worker.on('error', (error) => finish(() => reject(error)));
    worker.on('exit', (code) => {
      if (settled) return;
      if (Atomics.load(flag, 0) === 1) finish(() => reject(new ReconcileCancelledError()));
      else finish(() => reject(new Error(`reconcile worker exited with code ${code}`)));
    });
  });

  return finished.finally(() => {
    if (killTimer) clearTimeout(killTimer);
    options.signal?.removeEventListener('abort', onAbort);
    try {
      db.pragma('wal_checkpoint(PASSIVE)');
    } catch {
      /* 主连接可能已关闭 */
    }
    return worker.terminate().catch(() => undefined);
  });
}
