import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { ReconcileCancelledError } from './errors.ts';
import { runJob } from './engine.ts';
import type { FsCapabilities, ReconcileProgress, ReconcileResult } from './types.ts';

interface WorkerIn {
  dbPath: string;
  rootId: string;
  delayMs: number;
  sab: SharedArrayBuffer;
  caps: FsCapabilities;
  lock: Int32Array;
}

const data = workerData as WorkerIn;
const flag = new Int32Array(data.sab);
const db = new Database(data.dbPath);
db.pragma('busy_timeout = 5000');

function cancelled(): boolean {
  return Atomics.load(flag, 0) === 1;
}

function isCancel(error: unknown): boolean {
  return error instanceof ReconcileCancelledError || (error instanceof Error && error.name === 'ReconcileCancelledError');
}

try {
  const result: ReconcileResult = runJob(db, data.rootId, {
    caps: data.caps,
    delayMs: data.delayMs,
    lock: data.lock,
    cancel: cancelled,
    onProgress: (progress: ReconcileProgress) => {
      parentPort?.postMessage({ type: 'progress', progress });
    },
  });
  parentPort?.postMessage({ type: 'done', result });
} catch (error) {
  if (isCancel(error) || cancelled()) {
    parentPort?.postMessage({ type: 'cancelled' });
  } else {
    const err = error instanceof Error ? error : new Error(String(error));
    parentPort?.postMessage({ type: 'error', message: err.message, stack: err.stack });
  }
} finally {
  try {
    db.close();
  } catch {
    /* 连接可能已关闭 */
  }
}
