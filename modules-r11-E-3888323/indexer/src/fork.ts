/**
 * 可注入的 indexer 子进程拉起方式。
 * 默认 child_process.fork；Electron 打包态（runAsNode=false）由宿主注入 utilityProcess.fork 适配器。
 */
import { fork as nodeFork, type ChildProcess } from 'node:child_process';

export interface IndexerForkOptions {
  execArgv?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** child_process 用；utilityProcess 适配器可忽略 */
  stdio?: Array<'ignore' | 'inherit' | 'pipe' | 'ipc'> | 'pipe' | 'ignore' | 'inherit';
  windowsHide?: boolean;
}

/** 与 child_process.ChildProcess 对齐的最小子集，供 index.ts 使用 */
export interface IndexerChild {
  send?(message: unknown): boolean;
  postMessage?(message: unknown): void;
  // 监听器签名与 Node ChildProcess 一致（宽松），避免与 index.ts 现有回调不兼容
  on(event: string, listener: (...args: any[]) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
  stderr?: NodeJS.ReadableStream | null;
  stdout?: NodeJS.ReadableStream | null;
  pid?: number;
  unref(): void;
  ref(): void;
  kill?(signal?: string): boolean;
}

export type IndexerForkFn = (modulePath: string, args: string[], options: IndexerForkOptions) => IndexerChild;

function defaultFork(modulePath: string, args: string[], options: IndexerForkOptions): IndexerChild {
  const child: ChildProcess = nodeFork(modulePath, args, {
    execArgv: options.execArgv,
    env: options.env,
    cwd: options.cwd,
    stdio: options.stdio ?? ['ignore', 'inherit', 'inherit', 'ipc'],
    windowsHide: options.windowsHide ?? true,
  });
  return child as unknown as IndexerChild;
}

let forkImpl: IndexerForkFn = defaultFork;

/** 宿主在 import @kb/indexer 主入口之前调用，替换 fork 实现（例如 Electron utilityProcess） */
export function setIndexerFork(fn: IndexerForkFn | null): void {
  forkImpl = fn ?? defaultFork;
}

export function getIndexerFork(): IndexerForkFn {
  return forkImpl;
}

export function indexerFork(modulePath: string, args: string[], options: IndexerForkOptions): IndexerChild {
  return forkImpl(modulePath, args, options);
}

/** 统一发送：兼容 child_process.send 与 utilityProcess.postMessage */
export function childSend(child: IndexerChild, message: unknown): void {
  if (typeof child.send === 'function') {
    child.send(message);
    return;
  }
  if (typeof child.postMessage === 'function') {
    child.postMessage(message);
    return;
  }
  throw new Error('indexer child 无 send/postMessage');
}
