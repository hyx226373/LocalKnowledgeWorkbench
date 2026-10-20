/**
 * r15：utilityProcess 里跑 @kb/indexer 的 worker.js / read-helper.js。
 * 这两个脚本按 child_process.fork 写：用 process.send / process.on('message')。
 * utilityProcess 没有这两个，只有 process.parentPort。这里先接上，再加载真正的脚本。
 */
import { pathToFileURL } from 'node:url';

type ParentPort = { postMessage(m: unknown): void; on(ev: 'message', cb: (e: { data: unknown }) => void): void };

export function installChildIpcShim(proc: NodeJS.Process & { parentPort?: ParentPort }): boolean {
  const pp = proc.parentPort;
  if (!pp || typeof proc.send === 'function') return false;
  (proc as any).send = (message: unknown) => {
    pp.postMessage(message);
    return true;
  };
  (proc as any).connected = true;
  (proc as any).disconnect = () => {
    (proc as any).connected = false;
    setTimeout(() => proc.exit(0), 0);
  };
  pp.on('message', (event) => proc.emit('message' as any, event?.data as any));
  return true;
}

const target = process.env.KB_INDEXER_TARGET;
if (target && (process as any).parentPort) {
  installChildIpcShim(process as any);
  void import(pathToFileURL(target).href).catch((err) => {
    console.error('[indexerShim] 加载失败', target, err);
    process.exit(1);
  });
}
