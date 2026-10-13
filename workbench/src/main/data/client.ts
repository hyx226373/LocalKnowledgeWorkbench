/**
 * 主进程侧的数据进程。这里 fork dataEntry.js，不静态导入数据层，避免把 sqlite 打进窗口进程。
 */
import { app, MessageChannelMain, utilityProcess, type UtilityProcess, type MessagePortMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { disownPid, ownPid } from '../ownedPids';
import { errorText } from '../../shared/dataMethods';
import type { WebAccessSnap, WebPluginSnap } from '../webPanels';

export interface AccessRow {
  pluginId: string;
  adapterId: string;
  snap: WebAccessSnap;
}

export interface DataReady {
  window: { width?: number; height?: number; x?: number; y?: number } | null;
  webPlugins: WebPluginSnap[];
  lastUsed: Record<string, unknown>;
  access: AccessRow[];
}

export interface DataStats {
  watch: number;
  heapUsed: number;
  rss: number;
}

export interface HarnessSnap {
  launches: Array<{ pid: number; exe: string; argv: string[]; exited: boolean }>;
  confirmPrompts: string[];
  confirmAnswer: boolean;
}

export interface DataPlane {
  ready: Promise<DataReady>;
  call(method: string, args?: unknown[]): Promise<unknown>;
  stop(): Promise<'closed' | 'timeout'>;
  interactive(reason: string): void;
  claimRendererPort(): MessagePortMain;
  onEvent(fn: (channel: string, payload: unknown) => void): void;
  onMark(fn: (name: string, side: 'main' | 'renderer', wall: number) => void): void;
  onGrants(fn: (pluginId: string, webPlugins: WebPluginSnap[], access: AccessRow[]) => void): void;
  onPlugins(fn: (webPlugins: WebPluginSnap[]) => void): void;
  onReset(fn: () => void): void;
  onRestarted(fn: (ready: DataReady) => void): void;
  onStats(fn: (stats: DataStats) => void): void;
  onHarness(fn: (snap: HarnessSnap) => void): void;
  pid(): number | undefined;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface IndexerRec {
  child: UtilityProcess;
  queue: unknown[];
  spawned: boolean;
}

function plainEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) if (typeof value === 'string') out[key] = value;
  delete out.ELECTRON_RUN_AS_NODE;
  delete out.VITE_DEV_SERVER_URL;
  return out;
}

function builtinAdaptersEnv(): string {
  if (process.env.KB_BUILTIN_ADAPTERS_DIR) return process.env.KB_BUILTIN_ADAPTERS_DIR;
  if (app.isPackaged) {
    const packed = path.join(process.resourcesPath, 'builtin-adapters');
    return fs.existsSync(packed) ? packed : 'none';
  }
  let dir = app.getAppPath();
  for (let i = 0; i < 4; i += 1) {
    const candidate = path.join(dir, 'resources', 'builtin-adapters');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return 'none';
}

export function startDataPlane(opts: {
  dataDir: string;
  packaged: boolean;
  version: string;
  e2e: boolean;
  ask: (method: string, args: unknown[]) => Promise<unknown>;
}): DataPlane {
  let child: UtilityProcess | null = null;
  let control: MessagePortMain | null = null;
  let rendererHold: MessagePortMain | null = null;
  let rendererArmed = false;
  let generation = 0;
  let seq = 1;
  let everReady = false;
  let quitting = false;
  let stopped = false;
  let failStreak = 0;
  let firstSettled = false;
  const pending = new Map<number, Pending>();
  const reported = new Set<number>();
  const indexers = new Map<number, IndexerRec>();
  let eventCb: (channel: string, payload: unknown) => void = () => undefined;
  let markCb: (name: string, side: 'main' | 'renderer', wall: number) => void = () => undefined;
  let grantsCb: (pluginId: string, webPlugins: WebPluginSnap[], access: AccessRow[]) => void = () => undefined;
  let pluginsCb: (webPlugins: WebPluginSnap[]) => void = () => undefined;
  let resetCb: () => void = () => undefined;
  let restartedCb: (ready: DataReady) => void = () => undefined;
  let statsCb: (stats: DataStats) => void = () => undefined;
  let harnessCb: (snap: HarnessSnap) => void = () => undefined;
  let closedWait: (() => void) | null = null;
  let readyResolve: (ready: DataReady) => void = () => undefined;
  let readyReject: (error: Error) => void = () => undefined;
  const ready = new Promise<DataReady>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  function rejectPending(error: Error) {
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  }

  function killReported() {
    for (const pid of reported) {
      try { process.kill(pid); } catch { /* 已经退出 */ }
      disownPid(pid);
    }
    reported.clear();
  }

  function killIndexers() {
    for (const rec of indexers.values()) {
      try { rec.child.kill(); } catch { /* 已经退出 */ }
      disownPid(rec.child.pid);
    }
    indexers.clear();
  }

  function settleFail(error: Error) {
    if (firstSettled) return;
    firstSettled = true;
    readyReject(error);
  }

  function settleReady(payload: DataReady) {
    everReady = true;
    failStreak = 0;
    if (!firstSettled) {
      firstSettled = true;
      readyResolve(payload);
      return;
    }
    restartedCb(payload);
  }

  function postControl(message: unknown, transfer: MessagePortMain[] = []) {
    control?.postMessage(message, transfer);
  }

  function onIndexerFork(msg: { childId: number; modulePath: string; env: Record<string, string>; cwd?: string; execArgv?: string[] }) {
    const env = { ...msg.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.VITE_DEV_SERVER_URL;
    const forked = utilityProcess.fork(msg.modulePath, [], {
      env,
      cwd: msg.cwd,
      execArgv: msg.execArgv,
      stdio: 'pipe',
      serviceName: 'kb-indexer',
    });
    const rec: IndexerRec = { child: forked, queue: [], spawned: false };
    indexers.set(msg.childId, rec);
    forked.on('spawn', () => {
      ownPid(forked.pid);
      rec.spawned = true;
      for (const queued of rec.queue) forked.postMessage(queued);
      rec.queue = [];
    });
    forked.stderr?.on('data', (buf: Buffer) => {
      const line = buf.toString('utf8').trim();
      if (line) console.error(`[indexer] ${line}`);
    });
    forked.on('message', (message) => {
      const typed = message as { type?: string } | null;
      if (typed?.type === 'shutdown-complete') {
        forked.kill();
        return;
      }
      postControl({ t: 'indexer-message', childId: msg.childId, message });
    });
    forked.on('exit', (code) => {
      disownPid(forked.pid);
      indexers.delete(msg.childId);
      postControl({ t: 'indexer-exit', childId: msg.childId, code: code ?? null });
    });
  }

  function handleControl(msg: {
    t?: string;
    id?: number;
    ok?: boolean;
    value?: unknown;
    error?: string;
    method?: string;
    args?: unknown[];
    channel?: string;
    payload?: unknown;
    name?: string;
    side?: 'main' | 'renderer';
    wall?: number;
    pluginId?: string;
    webPlugins?: WebPluginSnap[];
    access?: AccessRow[];
    pid?: number;
    watch?: number;
    heapUsed?: number;
    rss?: number;
    launches?: HarnessSnap['launches'];
    confirmPrompts?: string[];
    confirmAnswer?: boolean;
    window?: DataReady['window'];
    lastUsed?: Record<string, unknown>;
    childId?: number;
    modulePath?: string;
    env?: Record<string, string>;
    cwd?: string;
    execArgv?: string[];
    message?: unknown;
  }) {
    if (!msg || typeof msg.t !== 'string') return;
    if (msg.t === 'result' && typeof msg.id === 'number') {
      const item = pending.get(msg.id);
      if (!item) return;
      pending.delete(msg.id);
      if (msg.ok) item.resolve(msg.value);
      else item.reject(new Error(msg.error || '数据进程调用失败'));
      return;
    }
    if (msg.t === 'ask' && typeof msg.id === 'number' && typeof msg.method === 'string') {
      const id = msg.id;
      const method = msg.method;
      const args = Array.isArray(msg.args) ? msg.args : [];
      void opts.ask(method, args).then(
        (value) => postControl({ t: 'ask-result', id, ok: true, value }),
        (err) => postControl({ t: 'ask-result', id, ok: false, error: errorText(err) }),
      );
      return;
    }
    if (msg.t === 'ready') {
      settleReady({
        window: msg.window ?? null,
        webPlugins: Array.isArray(msg.webPlugins) ? msg.webPlugins : [],
        lastUsed: msg.lastUsed ?? {},
        access: Array.isArray(msg.access) ? msg.access : [],
      });
      return;
    }
    if (msg.t === 'boot-failed') {
      quitting = true;
      settleFail(new Error(msg.error || '数据进程启动失败'));
      child?.kill();
      return;
    }
    if (msg.t === 'event' && typeof msg.channel === 'string') {
      eventCb(msg.channel, msg.payload);
      return;
    }
    if (msg.t === 'mark' && typeof msg.name === 'string') {
      markCb(msg.name, msg.side === 'renderer' ? 'renderer' : 'main', typeof msg.wall === 'number' ? msg.wall : Date.now());
      return;
    }
    if (msg.t === 'grants' && typeof msg.pluginId === 'string') {
      grantsCb(msg.pluginId, Array.isArray(msg.webPlugins) ? msg.webPlugins : [], Array.isArray(msg.access) ? msg.access : []);
      return;
    }
    if (msg.t === 'plugins') {
      pluginsCb(Array.isArray(msg.webPlugins) ? msg.webPlugins : []);
      return;
    }
    if (msg.t === 'own' && typeof msg.pid === 'number') {
      reported.add(msg.pid);
      ownPid(msg.pid);
      return;
    }
    if (msg.t === 'stats') {
      statsCb({ watch: Number(msg.watch) || 0, heapUsed: Number(msg.heapUsed) || 0, rss: Number(msg.rss) || 0 });
      return;
    }
    if (msg.t === 'harness') {
      harnessCb({
        launches: Array.isArray(msg.launches) ? msg.launches : [],
        confirmPrompts: Array.isArray(msg.confirmPrompts) ? msg.confirmPrompts : [],
        confirmAnswer: msg.confirmAnswer === true,
      });
      return;
    }
    if (msg.t === 'closed') {
      closedWait?.();
      closedWait = null;
      return;
    }
    if (msg.t === 'indexer-fork' && typeof msg.childId === 'number' && typeof msg.modulePath === 'string') {
      onIndexerFork({ childId: msg.childId, modulePath: msg.modulePath, env: msg.env ?? {}, cwd: msg.cwd, execArgv: msg.execArgv });
      return;
    }
    if (msg.t === 'indexer-send' && typeof msg.childId === 'number') {
      const rec = indexers.get(msg.childId);
      if (!rec) return;
      if (!rec.spawned) rec.queue.push(msg.message);
      else rec.child.postMessage(msg.message);
      return;
    }
    if (msg.t === 'indexer-kill' && typeof msg.childId === 'number') {
      indexers.get(msg.childId)?.child.kill();
    }
  }

  function spawn() {
    const gen = ++generation;
    const channel = new MessageChannelMain();
    const rendererChannel = new MessageChannelMain();
    control = channel.port2;
    rendererHold = rendererChannel.port2;
    rendererArmed = true;
    control.start();
    control.on('message', (event) => {
      if (gen !== generation) return;
      handleControl(event.data as Parameters<typeof handleControl>[0]);
    });
    const env = plainEnv(process.env);
    if (!env.KB_BUILTIN_ADAPTERS_DIR) env.KB_BUILTIN_ADAPTERS_DIR = builtinAdaptersEnv();
    if (opts.packaged) env.KB_PACKAGED = '1';
    env.KB_APP_VERSION = opts.version;
    // 打包后 getAppPath() 是 app.asar 文件。把它当成 cwd，utilityProcess 会立刻以 1 退出。
    const forked = utilityProcess.fork(path.join(__dirname, 'dataEntry.js'), [], {
      env,
      cwd: app.isPackaged ? path.dirname(app.getAppPath()) : app.getAppPath(),
      stdio: 'inherit',
      serviceName: 'kb-data',
    });
    child = forked;
    forked.on('spawn', () => ownPid(forked.pid));
    forked.postMessage(
      { t: 'boot', dataDir: opts.dataDir, packaged: opts.packaged, e2e: opts.e2e, version: opts.version },
      [channel.port1, rendererChannel.port1],
    );
    forked.on('exit', (code) => {
      if (gen !== generation) return;
      const pid = forked.pid;
      if (pid) disownPid(pid);
      control = null;
      rendererArmed = false;
      rejectPending(new Error('数据进程已退出'));
      killReported();
      killIndexers();
      if (quitting) {
        closedWait?.();
        closedWait = null;
        return;
      }
      if (!everReady) {
        settleFail(new Error(`数据进程启动失败 (${code ?? 1})`));
        return;
      }
      failStreak += 1;
      resetCb();
      if (failStreak >= 5) {
        console.error('[data] 数据进程连续退出，不再重启');
        return;
      }
      spawn();
    });
    if (!everReady) {
      const timer = setTimeout(() => {
        if (!firstSettled && gen === generation) {
          quitting = true;
          settleFail(new Error('数据进程启动超时'));
          forked.kill();
        }
      }, 120000);
      timer.unref?.();
    }
  }

  spawn();

  return {
    ready,
    call(method, args = []) {
      return new Promise((resolve, reject) => {
        if (!control) {
          reject(new Error('数据进程还没连上'));
          return;
        }
        const id = seq++;
        pending.set(id, { resolve, reject });
        try {
          control.postMessage({ t: 'call', id, method, args });
        } catch (err) {
          pending.delete(id);
          reject(err instanceof Error ? err : new Error(errorText(err)));
        }
      });
    },
    stop() {
      if (stopped) return Promise.resolve('closed');
      stopped = true;
      quitting = true;
      if (!control) {
        try { child?.kill(); } catch { /* 已经退出 */ }
        killIndexers();
        return Promise.resolve('closed');
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          try { child?.kill(); } catch { /* 已经退出 */ }
          killIndexers();
          resolve('timeout');
        }, 8000);
        closedWait = () => {
          clearTimeout(timer);
          killIndexers();
          resolve('closed');
        };
        try {
          postControl({ t: 'shutdown' });
        } catch {
          clearTimeout(timer);
          resolve('closed');
        }
      });
    },
    interactive(reason) {
      try { postControl({ t: 'interactive', reason }); } catch { /* 端口已关 */ }
    },
    claimRendererPort() {
      if (rendererArmed && rendererHold) {
        rendererArmed = false;
        const port = rendererHold;
        rendererHold = null;
        return port;
      }
      const channel = new MessageChannelMain();
      postControl({ t: 'renderer-port' }, [channel.port1]);
      return channel.port2;
    },
    onEvent(fn) { eventCb = fn; },
    onMark(fn) { markCb = fn; },
    onGrants(fn) { grantsCb = fn; },
    onPlugins(fn) { pluginsCb = fn; },
    onReset(fn) { resetCb = fn; },
    onRestarted(fn) { restartedCb = fn; },
    onStats(fn) { statsCb = fn; },
    onHarness(fn) { harnessCb = fn; },
    pid: () => child?.pid,
  };
}
