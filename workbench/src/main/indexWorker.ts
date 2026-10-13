// worker_threads 入口：独立的 SQLite 连接（WAL），执行扫描/对账/事件应用，向主进程报告进度。
import { parentPort, workerData } from 'node:worker_threads';
import { openDb } from './service/db';
import { applyEvents, reconcileScan } from './service/indexer';
import type { WorkerRequest, WorkerResponse } from './service/indexRunner';
import { stallNote } from './startupTrace';

const db = openDb((workerData as { dbFile: string }).dbFile);
// 扫描提交很密。默认自动 checkpoint 会让主连接上的查询等满 busy_timeout。
db.pragma('wal_autocheckpoint = 0');
const cancelled = new Set<string>();
const post = (m: WorkerResponse) => parentPort!.postMessage(m);

parentPort!.on('message', async (m: WorkerRequest) => {
  if (m.kind === 'cancel') {
    cancelled.add(m.rootId);
    return;
  }
  try {
    if (m.kind === 'shutdown') {
      try {
        db.pragma('wal_checkpoint(PASSIVE)');
      } catch {
        /* 还有读者时不截断，避免把主进程定时器拖住 */
      }
      db.close();
      post({ kind: 'done', jobId: m.jobId, result: null });
      parentPort!.close();
      return;
    }
    if (m.kind === 'scan') {
      cancelled.delete(m.rootId);
      const started = Date.now();
      const result = await reconcileScan(db, m.rootId, m.rootPath, {
        isCancelled: () => cancelled.has(m.rootId),
        // 每批（默认 500 条）报告一次进度
        onProgress: (n) => post({ kind: 'progress', jobId: m.jobId, rootId: m.rootId, processed: n }),
      });
      stallNote(`scan-finished root=${m.rootId} changed=${result.changed.length} missing=${result.missing} ms=${Date.now() - started}`);
      post({ kind: 'done', jobId: m.jobId, result });
    } else if (m.kind === 'events') {
      post({ kind: 'done', jobId: m.jobId, result: applyEvents(db, m.rootId, m.rootPath, m.events) });
    }
  } catch (e) {
    post({ kind: 'error', jobId: (m as { jobId: number }).jobId, message: (e as Error).message });
  }
});
