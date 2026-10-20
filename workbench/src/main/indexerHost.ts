import path from 'node:path';
/**
 * r11-E：为 @kb/indexer 注入 Electron 兼容的子进程拉起方式。
 * 打包态（runAsNode fuse = false）禁止 child_process.fork，改用 utilityProcess.fork。
 * 开发态默认仍用 child_process.fork，可用 KB_FORCE_UTILITY_INDEXER=1 强制走 utilityProcess。
 *
 * asar 路径：utilityProcess.fork 可直接加载 asar 内的 .js；worker 再 require 的
 * better-sqlite3 原生模块已在 build.asarUnpack 中解包。
 */
import { app, utilityProcess, type UtilityProcess } from 'electron';
import { disownPid, ownPid } from './ownedPids';
import type { IndexerChild, IndexerForkFn, IndexerForkOptions } from '@kb/indexer/fork';
import { getIndexerFork, setIndexerFork } from '@kb/indexer/fork';
export { getIndexerFork };

function adaptUtilityProcess(child: UtilityProcess, readOnly: boolean): IndexerChild {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();

  const emit = (event: string, ...args: any[]) => {
    for (const fn of listeners.get(event) ?? []) {
      try {
        fn(...args);
      } catch (err) {
        console.error('[indexerHost] listener error', event, err);
      }
    }
  };

  child.on('spawn', () => ownPid(child.pid));
  child.on('exit', () => disownPid(child.pid));
  child.on('message', (message) => {
    if (message?.type === 'shutdown-complete') { child.kill(); return; }
    emit('message', message);
  });
  child.on('exit', (code) => emit('exit', code));
  // UtilityProcess 的 'error' 不一定总有；防御性挂载
  (child as NodeJS.EventEmitter).on?.('error', (err: Error) => emit('error', err));

  const api: IndexerChild = {
    send(message: unknown) {
      child.postMessage(message);
      if (readOnly && (message as { type?: string })?.type === 'shutdown') child.kill();
      return true;
    },
    postMessage(message: unknown) {
      child.postMessage(message);
    },
    on(event: string, listener: (...args: any[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
      return api;
    },
    off(event: string, listener: (...args: any[]) => void) {
      listeners.get(event)?.delete(listener);
      return api;
    },
    once(event: string, listener: (...args: any[]) => void) {
      const wrap = (...args: any[]) => {
        api.off(event, wrap);
        listener(...args);
      };
      return api.on(event, wrap);
    },
    get stderr() {
      return child.stderr ?? null;
    },
    get stdout() {
      return child.stdout ?? null;
    },
    get pid() {
      return child.pid;
    },
    unref() {
      /* utilityProcess 无 unref；保持存活直到 shutdown */
    },
    ref() {
      /* no-op */
    },
    kill(signal?: string) {
      try {
        child.kill();
        return true;
      } catch {
        return false;
      }
    },
  };
  return api;
}

function createUtilityFork(): IndexerForkFn {
  return (modulePath: string, _args: string[], options: IndexerForkOptions): IndexerChild => {
    // utilityProcess.fork 不接受 ipc 槽位的 stdio 数组；用 pipe 拿 stderr 便于诊断
    // 索引脚本按 child_process 写，经 indexerShim 把 process.send 接到 parentPort。
    const child = utilityProcess.fork(path.join(__dirname, 'indexerShim.js'), [], {
      env: { ...(options.env ?? process.env), KB_INDEXER_TARGET: modulePath },
      execArgv: options.execArgv,
      cwd: options.cwd,
      stdio: 'pipe',
      serviceName: 'kb-indexer',
    });
    return adaptUtilityProcess(child, /[\\/]read-helper\.[cm]?js$/.test(modulePath));
  };
}

export function shouldUseUtilityIndexer(): boolean {
  if (process.env.KB_FORCE_CHILD_INDEXER === '1') return false;
  if (process.env.KB_FORCE_UTILITY_INDEXER === '1') return true;
  // 数据进程里 app 可能不存在。打包态由主进程写入 KB_PACKAGED，索引子进程改由主进程拉起。
  if ((process as { parentPort?: unknown }).parentPort) return process.env.KB_PACKAGED === '1';
  try {
    return !!app?.isPackaged;
  } catch {
    return false;
  }
}

let parentRelay: IndexerForkFn | null = null;

/**
 * 数据进程本身是 utilityProcess，不能再 fork。
 * 打包态的索引子进程由主进程拉起，消息从这条回调转过去。
 */
export function setIndexerParentRelay(fn: IndexerForkFn | null) {
  parentRelay = fn;
}

function inUtilityProcess(): boolean {
  return !!(process as { parentPort?: unknown }).parentPort;
}

/** 必须在动态 import('@kb/indexer') 之前调用 */
export function installIndexerHost(): { mode: 'utilityProcess' | 'child_process' } {
  if (!shouldUseUtilityIndexer()) {
    return { mode: 'child_process' };
  }
  if (inUtilityProcess()) {
    if (!parentRelay) throw new Error('数据进程不能直接拉起索引子进程');
    setIndexerFork(parentRelay);
    console.log('[indexerHost] 索引子进程由主进程拉起');
    return { mode: 'utilityProcess' };
  }
  setIndexerFork(createUtilityFork());
  console.log('[indexerHost] 已注入 utilityProcess.fork（打包态 / 强制）');
  return { mode: 'utilityProcess' };
}

/** asar 内 worker 路径说明（写进 REPORT / docs） */
export function indexerAsarNotes(): string {
  return [
    'utilityProcess.fork 可加载 app.asar 内 @kb/indexer/dist/worker.js、read-helper.js。',
    'better-sqlite3 原生 .node 已 asarUnpack；pdfjs 随 indexer dist 走 asar。',
    '开发态默认 child_process.fork；KB_FORCE_UTILITY_INDEXER=1 可在未打包时演练。',
  ].join(' ');
}
