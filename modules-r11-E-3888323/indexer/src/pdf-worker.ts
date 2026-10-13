import { parentPort } from 'node:worker_threads';
import { extractFile } from './extract.ts';

// vitest 的 fork 里再开 worker_threads 时，pdfjs 的动态 import 会被拖到十几秒。
// 这个进程不打开 sqlite。由索引线程 fork 出来，关掉 IPC 后自己结束。
const port = parentPort
  ? {
      postMessage(msg: unknown): void {
        parentPort?.postMessage(msg);
      },
      on(event: 'message', cb: (msg: unknown) => void): void {
        parentPort?.on(event, cb);
      },
      close(): void {
        parentPort?.close();
      },
    }
  : {
      postMessage(msg: unknown): void {
        if (typeof process.send === 'function') process.send(msg);
      },
      on(event: 'message', cb: (msg: unknown) => void): void {
        process.on(event, cb);
      },
      close(): void {
        process.disconnect?.();
      },
    };

void import('pdfjs-dist/legacy/build/pdf.mjs')
  .then(() => import('pdfjs-dist/legacy/build/pdf.worker.mjs'))
  .then(() => {
    try {
      port.postMessage({ reqId: -1 });
    } catch {
      // 父线程已经停了
    }
  })
  .catch(() => {
    // 预热失败时，第一次抽 PDF 会再加载
  });

port.on('message', (msg: unknown) => {
  if (!msg || typeof msg !== 'object') return;
  const packet = msg as { type?: string; reqId?: number; absPath?: string; relPath?: string };
  if (packet.type === 'warmup') return;
  if (packet.type === 'shutdown') {
    try {
      port.close();
    } catch {
      // 端口已经关了
    }
    return;
  }
  if (packet.type !== 'extract' || !packet.absPath || !packet.relPath || packet.reqId === undefined) return;
  const reqId = packet.reqId;
  const absPath = packet.absPath;
  const relPath = packet.relPath;
  void extractFile(absPath, relPath)
    .then((pages) => {
      try {
        port.postMessage({ reqId, pages });
      } catch {
        // 父线程已经停了
      }
    })
    .catch((err: unknown) => {
      const error = err instanceof Error ? err.message : String(err);
      try {
        port.postMessage({ reqId, error });
      } catch {
        // 父线程已经停了
      }
    });
});
