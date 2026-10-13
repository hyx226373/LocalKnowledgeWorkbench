import { fork, type ChildProcess } from 'node:child_process';

/** 主进程看到的索引子进程。child_process.fork 和 utilityProcess.fork 都收成这一层。 */
export interface IndexerChild {
  send(message: unknown): void;
  on(event: string, listener: (...args: any[]) => void): void;
  off(event: string, listener: (...args: any[]) => void): void;
  once(event: string, listener: (...args: any[]) => void): void;
  ref(): void;
  unref(): void;
  stderr?: NodeJS.ReadableStream | null;
}

export interface IndexerHost {
  /** 打包态由应用注入。开发态和单元测试不注入，仍走 child_process.fork。 */
  fork(scriptPath: string, env: NodeJS.ProcessEnv): IndexerChild;
}

let injected: IndexerHost | null = null;
let childCount = 0;

export function setIndexerHost(host: IndexerHost | null): void {
  if (childCount > 0) throw new Error('索引进程已经启动，不能再更换宿主');
  injected = host;
}

export function indexerUsesInjectedHost(): boolean {
  return injected != null;
}

export function noteIndexerChild(delta: 1 | -1): void {
  childCount = Math.max(0, childCount + delta);
}

export function forkIndexerScript(scriptPath: string, env: NodeJS.ProcessEnv, execArgv: string[]): IndexerChild {
  if (injected) return injected.fork(scriptPath, env);
  const child = fork(scriptPath, [], {
    execArgv,
    env,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    windowsHide: true,
  });
  child.unref();
  return wrapNodeChild(child);
}

export function wrapNodeChild(child: ChildProcess): IndexerChild {
  return {
    send(message) {
      child.send(message as never);
    },
    on(event, listener) {
      child.on(event as 'message', listener);
    },
    off(event, listener) {
      child.off(event as 'message', listener);
    },
    once(event, listener) {
      child.once(event as 'exit', listener);
    },
    ref() {
      child.ref();
    },
    unref() {
      child.unref();
    },
    stderr: child.stderr,
  };
}
