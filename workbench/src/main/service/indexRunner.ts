/**
 * 索引执行器：主进程只通过它下发任务，重活在 worker_threads 中完成。
 * WorkerIndexRunner —— 应用实际使用；InProcessIndexRunner —— 仅供单元测试/调试。
 */
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { openDb, type DB } from './db';
import { applyEvents, reconcileScan, type FsEvent, type ScanChange, type ScanResult } from './indexer';
import { stallNote, stallOp } from '../startupTrace';

export interface IndexRunnerEvents {
  onProgress?: (rootId: string, processed: number) => void;
}

export interface IndexRunner {
  scan(rootId: string, rootPath: string): Promise<ScanResult>;
  cancel(rootId: string): void;
  applyEvents(rootId: string, rootPath: string, events: FsEvent[]): Promise<{ renamed: number; changed: ScanChange[] }>;
  close(): Promise<void>;
}

export type WorkerRequest =
  | { kind: 'scan'; jobId: number; rootId: string; rootPath: string }
  | { kind: 'cancel'; rootId: string }
  | { kind: 'shutdown'; jobId: number }
  | { kind: 'events'; jobId: number; rootId: string; rootPath: string; events: FsEvent[] };

export type WorkerResponse =
  | { kind: 'progress'; jobId: number; rootId: string; processed: number }
  | { kind: 'done'; jobId: number; result: unknown }
  | { kind: 'error'; jobId: number; message: string };

type DistOmitJob<T> = T extends unknown ? Omit<T, 'jobId'> : never;

export class WorkerIndexRunner implements IndexRunner {
  private worker: Worker;
  private nextId = 1;
  private requests = new Set<Promise<unknown>>();
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  constructor(workerScript: string, dbFile: string, private ev: IndexRunnerEvents = {}) {
    this.worker = new Worker(workerScript, { workerData: { dbFile } });
    this.worker.on('message', (m: WorkerResponse) => {
      const started = Date.now();
      if (m.kind === 'progress') {
        this.ev.onProgress?.(m.rootId, m.processed);
        stallOp('scan-progress', Date.now() - started, m.rootId);
        return;
      }
      const p = this.pending.get(m.jobId);
      if (!p) return;
      this.pending.delete(m.jobId);
      if (m.kind === 'done') {
        const changed = (m.result as { changed?: unknown[] } | null)?.changed;
        stallNote(`recv-done job=${m.jobId} changed=${Array.isArray(changed) ? changed.length : -1} ms=${Date.now() - started}`);
        p.resolve(m.result);
      } else p.reject(new Error(m.message));
    });
    this.worker.on('error', (e) => {
      for (const p of this.pending.values()) p.reject(e as Error);
      this.pending.clear();
    });
  }

  private call<T>(req: DistOmitJob<Extract<WorkerRequest, { jobId: number }>>): Promise<T> {
    const jobId = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(jobId, { resolve, reject });
      this.worker.postMessage({ ...req, jobId });
    });
    this.requests.add(promise);
    void promise.finally(() => this.requests.delete(promise)).catch(() => {});
    return promise;
  }

  scan(rootId: string, rootPath: string) {
    return this.call<ScanResult>({ kind: 'scan', rootId, rootPath });
  }
  cancel(rootId: string) {
    this.worker.postMessage({ kind: 'cancel', rootId } satisfies WorkerRequest);
  }
  applyEvents(rootId: string, rootPath: string, events: FsEvent[]) {
    return this.call<{ renamed: number; changed: ScanChange[] }>({ kind: 'events', rootId, rootPath, events });
  }
  async close() {
    await Promise.allSettled([...this.requests]);
    const exited = once(this.worker, 'exit');
    await this.call({ kind: 'shutdown' });
    await exited;
  }
}

export class InProcessIndexRunner implements IndexRunner {
  private db: DB;
  private cancelled = new Set<string>();
  constructor(dbFile: string, private ev: IndexRunnerEvents = {}) {
    this.db = openDb(dbFile);
  }
  async scan(rootId: string, rootPath: string) {
    this.cancelled.delete(rootId);
    return reconcileScan(this.db, rootId, rootPath, {
      isCancelled: () => this.cancelled.has(rootId),
      onProgress: (n) => this.ev.onProgress?.(rootId, n),
    });
  }
  cancel(rootId: string) {
    this.cancelled.add(rootId);
  }
  async applyEvents(rootId: string, rootPath: string, events: FsEvent[]) {
    return applyEvents(this.db, rootId, rootPath, events);
  }
  async close() {
    this.db.close();
  }
}
