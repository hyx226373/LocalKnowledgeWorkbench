import { setIndexerHost, type IndexerChild } from './host.ts';

/** Electron utilityProcess.fork 的最小形状。不在这里 import electron，避免单元测试拉起 Electron。 */
export interface UtilityProcessLike {
  fork(
    modulePath: string,
    args?: string[],
    options?: { serviceName?: string; env?: NodeJS.ProcessEnv; stdio?: 'inherit' | 'pipe' | 'ignore' },
  ): UtilityChildLike;
}

export interface UtilityChildLike {
  postMessage(message: unknown): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  off?(event: string, listener: (...args: unknown[]) => void): void;
  once?(event: string, listener: (...args: unknown[]) => void): void;
  kill?(): void;
}

const listeners = new WeakMap<UtilityChildLike, Map<string, Set<(...args: unknown[]) => void>>>();

function bucket(proc: UtilityChildLike, event: string): Set<(...args: unknown[]) => void> {
  let byEvent = listeners.get(proc);
  if (!byEvent) {
    byEvent = new Map();
    listeners.set(proc, byEvent);
  }
  let set = byEvent.get(event);
  if (!set) {
    set = new Set();
    byEvent.set(event, set);
    proc.on(event, (...args: unknown[]) => {
      for (const fn of set!) fn(...args);
    });
  }
  return set;
}

export function childFromUtility(proc: UtilityChildLike): IndexerChild {
  return {
    send(message) {
      proc.postMessage(message);
    },
    on(event, listener) {
      bucket(proc, event).add(listener as (...args: unknown[]) => void);
    },
    off(event, listener) {
      bucket(proc, event).delete(listener as (...args: unknown[]) => void);
    },
    once(event, listener) {
      const wrapped = (...args: unknown[]) => {
        bucket(proc, event).delete(wrapped);
        (listener as (...args: unknown[]) => void)(...args);
      };
      bucket(proc, event).add(wrapped);
    },
    ref() {},
    unref() {},
    stderr: null,
  };
}

/** 打包态调用。runAsNode 保持 false，这里不碰 fuse。 */
export function useUtilityProcessHost(utilityProcess: UtilityProcessLike): void {
  setIndexerHost({
    fork(scriptPath, env) {
      const proc = utilityProcess.fork(scriptPath, [], {
        serviceName: 'kb-indexer',
        env,
        stdio: 'inherit',
      });
      return childFromUtility(proc);
    },
  });
}
