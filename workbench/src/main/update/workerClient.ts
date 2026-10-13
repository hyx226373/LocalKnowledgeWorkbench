import { Worker } from 'node:worker_threads';

export interface WorkerReply {
  id: number;
  ok: boolean;
  error?: string;
  json?: string | null;
}

export function callBackupWorker(workerFile: string, body: Record<string, unknown>, timeoutMs = 120000): Promise<WorkerReply> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerFile);
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error('备份工作线程超时'));
    }, timeoutMs);
    worker.once('message', (msg: WorkerReply) => {
      clearTimeout(timer);
      void worker.terminate();
      if (!msg.ok) reject(new Error(msg.error || '备份失败'));
      else resolve(msg);
    });
    worker.once('error', (err) => {
      clearTimeout(timer);
      void worker.terminate();
      reject(err);
    });
    worker.postMessage({ id: 1, ...body });
  });
}
