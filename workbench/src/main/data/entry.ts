/**
 * 数据进程入口。只由主进程 utilityProcess.fork('dataEntry.js') 拉起。
 * 打开数据库、监听和索引；窗口、对话框和网页面板仍在主进程。
 */
import path from 'node:path';
import { mark as startupMark, setMarkSink } from '../startupTrace';
import { ownPid, setOwnedPidSink } from '../ownedPids';
import { setIndexerParentRelay } from '../indexerHost';
import { WorkbenchService } from '../service/WorkbenchService';
import { WorkerIndexRunner } from '../service/indexRunner';
import { wireBackend, type BackendBundle } from '../backend/wire';
import { getIndexHealth, onIndexHealth } from '../backend/indexHealth';
import { RootWatchers } from '../service/watcher';
import { createWebResourcesMain } from '../webResourcesMain';
import type { Fetcher } from '../webResources';
import { AppHost, type PlatformDeps } from '../adapters/appHost';
import { defaultFindExe, defaultIsAlive } from '../adapters/appLauncher';
import { verifyExeWindows } from '../adapters/winVerify';
import { createAppHarness, type AppHarness } from '../adapters/appHarness';
import { READ_METHODS, errorText, isRendererDataMethod } from '../../shared/dataMethods';
import { allowListFromCatalog } from '../../shared/nativeDragPolicy';
import type { AgentMaterial } from '../../shared/agentLive/types';
import { accessSnapshots, createDataApi, lastUsedOf, type AskMain } from './api';
import { startAgentLive } from '../agentLive/wire';
import { resolveAgentDataRoot } from '../agentPanel/paths';
import { createWriteBatcher } from './writeBatch';
import type { IndexerChild, IndexerForkOptions } from '@kb/indexer/fork';

interface Boot {
  t: 'boot';
  dataDir: string;
  packaged: boolean;
  e2e: boolean;
  version: string;
}

const parentPort = (process as NodeJS.Process & { parentPort: Electron.ParentPort | null }).parentPort;
if (!parentPort) {
  console.error('[data] 只能由主进程拉起');
  process.exit(1);
}

parentPort.on('message', (event) => {
  const data = event.data as Boot;
  const ports = event.ports ?? [];
  if (data?.t === 'boot' && ports[0] && ports[1]) void boot(data, ports[0], ports[1]).catch((err) => {
    console.error('[data] 启动失败', err);
    try {
      parentPort?.postMessage({ t: 'boot-failed', error: err instanceof Error ? err.message : String(err) });
    } catch { /* port closed */ }
    process.exit(1);
  });
});

async function boot(bootMsg: Boot, control: Electron.MessagePortMain, renderer: Electron.MessagePortMain) {
  let controlPort: Electron.MessagePortMain | null = control;
  let rendererPort: Electron.MessagePortMain | null = renderer;
  const early: Array<{ data: unknown; ports: Electron.MessagePortMain[] }> = [];
  let onControl: ((data: unknown, ports: Electron.MessagePortMain[]) => void) | null = null;
  control.on('message', (event) => {
    const ports = event.ports ?? [];
    if (onControl) onControl(event.data, ports);
    else early.push({ data: event.data, ports });
  });
  control.start();
  const batcher = createWriteBatcher(32);
  const asks = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let askSeq = 1;
  let shutting = false;
  let deferredStarted = false;
  let svc: WorkbenchService;
  let backend: BackendBundle;
  let watchers: RootWatchers;
  let appHost: AppHost;
  let harness: AppHarness | null = null;
  const indexerKids = new Map<number, { emit: (event: string, ...args: any[]) => void }>();
  let indexerSeq = 0;

  function post(message: unknown) {
    try {
      controlPort?.postMessage(message);
    } catch (err) {
      console.error('[data] 消息发不出去', errorText(err));
    }
  }

  const ask: AskMain = (method, args) => new Promise((resolve, reject) => {
    const id = askSeq++;
    asks.set(id, { resolve, reject });
    post({ t: 'ask', id, method, args });
  });

  setMarkSink((name, side, wall) => post({ t: 'mark', name, side, wall }));
  setOwnedPidSink((pid) => {
    ownPid(pid);
    post({ t: 'own', pid });
  });
  setIndexerParentRelay((modulePath, _args, options) => relayIndexer(modulePath, options));

  function relayIndexer(modulePath: string, options: IndexerForkOptions): IndexerChild {
    const childId = ++indexerSeq;
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(options.env ?? {})) {
      if (typeof value === 'string') env[key] = value;
    }
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.VITE_DEV_SERVER_URL;
    post({ t: 'indexer-fork', childId, modulePath, env, cwd: options.cwd, execArgv: options.execArgv ?? [] });
    const listeners = new Map<string, Set<(...args: any[]) => void>>();
    const emit = (event: string, ...emitArgs: any[]) => {
      for (const fn of listeners.get(event) ?? []) {
        try { fn(...emitArgs); } catch (err) { console.error('[data] 索引监听失败', err); }
      }
    };
    indexerKids.set(childId, { emit });
    const api: IndexerChild = {
      send(message: unknown) {
        post({ t: 'indexer-send', childId, message });
        return true;
      },
      postMessage(message: unknown) {
        post({ t: 'indexer-send', childId, message });
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
        const wrap = (...wrapArgs: any[]) => {
          api.off(event, wrap);
          listener(...wrapArgs);
        };
        return api.on(event, wrap);
      },
      get stderr() { return null; },
      get stdout() { return null; },
      get pid() { return undefined; },
      unref() { /* 索引子进程由主进程持有 */ },
      ref() { /* 同上 */ },
      kill() {
        post({ t: 'indexer-kill', childId });
        return true;
      },
    };
    return api;
  }

  function publishHarness() {
    if (!harness) return;
    post({
      t: 'harness',
      launches: harness.launches.map((row) => ({ ...row, argv: [...row.argv] })),
      confirmPrompts: [...harness.confirmPrompts],
      confirmAnswer: harness.confirmAnswer,
    });
  }

  function appPlatformDeps(): PlatformDeps {
    if (!bootMsg.packaged && process.env.KB_E2E_APP_HARNESS === '1') {
      const created = createAppHarness({ aliveFile: path.join(bootMsg.dataDir, 'e2e-harness-alive.json') });
      harness = created.harness;
      const pushLaunch = harness.launches.push.bind(harness.launches);
      harness.launches.push = (...items) => {
        const n = pushLaunch(...items);
        publishHarness();
        return n;
      };
      const pushPrompt = harness.confirmPrompts.push.bind(harness.confirmPrompts);
      harness.confirmPrompts.push = (...items) => {
        const n = pushPrompt(...items);
        publishHarness();
        return n;
      };
      return created.deps;
    }
    return {
      isAlive: (pid) => defaultIsAlive(pid),
      findExe: (spec) => defaultFindExe(spec),
      verifyExe: (exe, spec) => verifyExeWindows(exe, spec),
      confirmUnprotected: async (info) => Boolean(await ask('confirmUnprotected', [info])),
    };
  }

  svc = new WorkbenchService({
    dataDir: bootMsg.dataDir,
    createRunner: (dbFile, ev) => new WorkerIndexRunner(path.join(__dirname, 'indexWorker.js'), dbFile, ev),
  });
  backend = await wireBackend(svc, bootMsg.dataDir);
  watchers = new RootWatchers(svc, 300);
  watchers.setSelfPaths([bootMsg.dataDir, process.env.KB_STALL_LOG || '']);
  svc.setBeforeMutate((abs) => { void watchers.release(abs); });
  svc.setBeforeRootDelete((abs) => watchers.release(abs));
  svc.setTrashItem(async (abs) => {
    await ask('trashItem', [abs]);
  });
  svc.setAfterMutate(() => { watchers.sync(); });
  const webMain = createWebResourcesMain({
    svc,
    send: (channel, payload) => post({ t: 'event', channel, payload }),
    webPanels: {
      fetchForCache: async (pluginId, adapterId, url, opts) => {
        const row = await ask('web.fetchForCache', [pluginId, adapterId, url, opts ?? {}]) as Awaited<ReturnType<Fetcher>>;
        if (row.ok && row.bytes && !Buffer.isBuffer(row.bytes)) return { ...row, bytes: Buffer.from(row.bytes) };
        return row;
      },
      pageInfo: (viewId) => ask('web.pageInfo', [viewId]) as Promise<{ url: string; title?: string }>,
      savePage: async (viewId, abs) => { await ask('web.savePage', [viewId, abs]); },
    },
  });
  appHost = new AppHost(svc, appPlatformDeps(), { pollMs: 3000 });
  const publishPlugins = () => post({ t: 'plugins', webPlugins: svc.plugins.webPlugins() });
  const api = createDataApi({
    svc,
    backend,
    watchers,
    appHost,
    ask,
    packaged: bootMsg.packaged,
    e2e: bootMsg.e2e,
    version: bootMsg.version,
    onRootsReplaced: async () => {
      await watchers.closeAll();
      watchers.sync();
    },
    webApi: webMain.api,
    store: webMain.store,
    harness,
    publishPlugins,
    publishHarness,
  });
  webMain.wrap(api);
  const agentData = resolveAgentDataRoot();
  const agentLive = startAgentLive({
    svc,
    watchers,
    dataDir: bootMsg.dataDir,
    version: bootMsg.version,
    notify: (workspaceId) => post({ t: 'event', channel: 'kb:agent-live', payload: { workspaceId } }),
    ...(agentData ? { agentDataDir: agentData.root, agentAnchorDir: agentData.anchor } : {}),
    trashItem: async (abs) => {
      await ask('trashItem', [abs]);
    },
  });
  Object.assign(api, agentLive.methods);
  api.nativeDragAllow = () => allowListFromCatalog({
    rootsToWatch: () => svc.rootsToWatch().map((root) => ({ path: root.path, kind: root.kind })),
    currentWorkspaceId: () => {
      const cur = svc.getLayout('workspace.current');
      if (typeof cur !== 'string' || !cur) return null;
      try {
        svc.getWorkspace(cur);
        return cur;
      } catch {
        return null;
      }
    },
    openFileResourceIds: (workspaceId) => {
      try {
        return svc.getWorkspace(workspaceId).items.filter((item) => item.sourceKind === 'file' && item.ref).map((item) => item.ref);
      } catch {
        return [];
      }
    },
    workspaceFileResourceIds: (workspaceId) => {
      try {
        return svc.listWorkspaceRefs(workspaceId)
          .filter((ref) => !ref.missing && ref.sourceKind !== 'web' && ref.kind !== 'dir')
          .map((ref) => ref.resourceId);
      } catch {
        return [];
      }
    },
    resourceAbsPath: (resourceId) => {
      try {
        return svc.resolveResourcePath(resourceId);
      } catch {
        return null;
      }
    },
    agentFilePaths: (workspaceId) => {
      try {
        const rows = agentLive.methods.agentLiveList(workspaceId) as AgentMaterial[];
        return rows.map((row) => row.absPath).filter((abs) => typeof abs === 'string' && abs.trim());
      } catch {
        return [];
      }
    },
  });
  const setWorkspace = api.setCurrentWorkspace;
  api.setCurrentWorkspace = (id: string) => {
    const result = setWorkspace(id);
    void Promise.resolve(result).then(() => agentLive.activate(String(id))).catch((err) => {
      console.error('[agent-live] 切换工作区后刷新入口失败', err);
    });
    return result;
  };
  const approvePlan = api.opsApprove;
  api.opsApprove = (planId: string, opIds: string[], contentHash: string) => {
    agentLive.assertBoundPlan(String(planId));
    return approvePlan(planId, opIds, contentHash);
  };

  svc.on('agent-bridge', (msg: { channel: string; payload: unknown }) => post({ t: 'event', channel: msg.channel, payload: msg.payload }));
  svc.on('index-status', (status) => post({ t: 'event', channel: 'kb:index-status', payload: status }));
  svc.on('fs-change', (ev) => post({ t: 'event', channel: 'kb:fs-change', payload: ev }));
  svc.on('root-tasks', (payload) => post({ t: 'event', channel: 'kb:root-tasks', payload }));
  try { svc.resumeRootJobs(); } catch (err) { console.error('[data] 恢复根任务失败', err); }
  svc.on('vfolders-change', () => post({ t: 'event', channel: 'kb:vfolders-change', payload: {} }));
  svc.on('refs-change', (ev) => post({ t: 'event', channel: 'kb:refs-change', payload: ev }));
  onIndexHealth((health) => post({ t: 'event', channel: 'kb:index-health', payload: health }));
  post({ t: 'event', channel: 'kb:index-health', payload: getIndexHealth() });
  svc.plugins.onGrantsChanged((pluginId) => {
    post({ t: 'grants', pluginId, webPlugins: svc.plugins.webPlugins(), access: accessSnapshots(svc, pluginId) });
  });
  appHost.onStatus((pluginId, handle) => post({
    t: 'event',
    channel: 'kb:app-event',
    payload: { type: 'status', pluginId, itemId: appHost.launcher.owner(handle.launchId)?.itemId ?? '', handle },
  }));
  appHost.onChanges((ev) => post({ t: 'event', channel: 'kb:app-event', payload: { type: 'changes', ...ev } }));

  async function handleCall(port: Electron.MessagePortMain, id: number, method: string, args: unknown[], fromRenderer: boolean) {
    const reply = (ok: boolean, value?: unknown, error?: string) => {
      try {
        port.postMessage({ t: 'result', id, ok, value, error });
      } catch (err) {
        try { port.postMessage({ t: 'result', id, ok: false, error: errorText(err) }); } catch { /* 端口已关 */ }
      }
    };
    try {
      if (fromRenderer && !isRendererDataMethod(method)) throw new Error(`未知方法: ${method}`);
      const fn = api[method];
      if (!fn) throw new Error(`未知方法: ${method}`);
      const run = () => fn(...args);
      const value = READ_METHODS.has(method) ? await run() : await batcher.enqueue(run);
      reply(true, value);
    } catch (err) {
      reply(false, undefined, errorText(err));
    }
  }

  function listenCalls(port: Electron.MessagePortMain, fromRenderer: boolean) {
    port.on('message', (event) => {
      const msg = event.data as { t?: string; id?: number; method?: string; args?: unknown[] };
      if (msg?.t !== 'call' || typeof msg.id !== 'number' || typeof msg.method !== 'string') return;
      void handleCall(port, msg.id, msg.method, Array.isArray(msg.args) ? msg.args : [], fromRenderer);
    });
    port.start();
  }

  function useRenderer(port: Electron.MessagePortMain) {
    if (rendererPort && rendererPort !== port) rendererPort.close();
    rendererPort = port;
    listenCalls(port, true);
  }

  onControl = (data, ports) => {
    const msg = data as {
      t?: string;
      id?: number;
      method?: string;
      args?: unknown[];
      ok?: boolean;
      value?: unknown;
      error?: string;
      reason?: string;
      childId?: number;
      message?: unknown;
      code?: number | null;
    };
    if (msg?.t === 'call' && typeof msg.id === 'number' && typeof msg.method === 'string') {
      void handleCall(control, msg.id, msg.method, Array.isArray(msg.args) ? msg.args : [], false);
      return;
    }
    if (msg?.t === 'ask-result' && typeof msg.id === 'number') {
      const pending = asks.get(msg.id);
      if (!pending) return;
      asks.delete(msg.id);
      if (msg.ok) pending.resolve(msg.value);
      else pending.reject(new Error(msg.error || '主进程没有完成请求'));
      return;
    }
    if (msg?.t === 'shutdown') {
      void shutdown();
      return;
    }
    if (msg?.t === 'interactive') {
      startDeferred(String(msg.reason || 'interactive'));
      return;
    }
    if (msg?.t === 'renderer-port') {
      const port = ports[0];
      if (port) useRenderer(port);
      return;
    }
    if (msg?.t === 'indexer-message' && typeof msg.childId === 'number') {
      indexerKids.get(msg.childId)?.emit('message', msg.message);
      return;
    }
    if (msg?.t === 'indexer-exit' && typeof msg.childId === 'number') {
      indexerKids.get(msg.childId)?.emit('exit', msg.code ?? 0);
      indexerKids.delete(msg.childId);
    }
  };
  for (const item of early.splice(0)) onControl(item.data, item.ports);
  useRenderer(renderer);

  function startDeferred(reason: string) {
    if (deferredStarted || shutting) return;
    deferredStarted = true;
    startupMark(`deferred:start-${reason}`);
    let releaseLive = () => {};
    const liveGate = new Promise<void>((resolve) => { releaseLive = resolve; });
    backend.holdLiveIndex(liveGate);
    watchers.sync();
    const scans = svc.rootsToWatch().map((root) => svc.scanRoot(root.id));
    svc.purgeStaging();
    const purgeExternal = () => {
      try {
        const removed = svc.purgeExternalBackups();
        if (removed.expired.length) console.log(`[app] 外部改动备份已过期：${removed.expired.length} 条记录，清理 ${removed.blobsRemoved} 份备份`);
      } catch (err) {
        console.error('[app] 清理过期的外部改动备份失败', err);
      }
    };
    purgeExternal();
    const daily = setInterval(purgeExternal, 24 * 3600 * 1000);
    daily.unref?.();
    try {
      const events = appHost.reconcileStartup();
      if (events.length) console.log(`[app] 启动时补做比较：${events.map((row) => `${row.programName} ${row.files.length} 个文件`).join('；')}`);
      appHost.store.prune();
    } catch (err) {
      console.error('[app] 启动时比较外部程序备份失败', err);
    }
    startupMark('deferred:queued');
    void Promise.allSettled(scans).then(() => {
      startupMark('deferred:scans-done');
      for (const root of svc.rootsToWatch()) {
        try { backend.reconcileContentRoot(root.id); } catch (err) { console.error('[data] 启动对账正文索引', err); }
        if (root.kind === 'file') continue;
        backend.indexContent(root.id, root.path);
      }
      void backend.whenContentSettled().then(() => {
        startupMark('deferred:content-index-done');
        releaseLive();
      });
    });
  }

  const statsTimer = setInterval(() => {
    const mem = process.memoryUsage();
    post({ t: 'stats', watch: watchers.queued(), heapUsed: mem.heapUsed, rss: mem.rss });
  }, 5000);
  statsTimer.unref?.();

  async function shutdown() {
    if (shutting) return;
    shutting = true;
    clearInterval(statsTimer);
    try { await batcher.drain(); } catch (err) { console.error('[data] 写队列排空失败', err); }
    try { await agentLive.close(); } catch (err) { console.error('[data] 工作资料关闭失败', err); }
    try { appHost.dispose(); } catch (err) { console.error('[data] 外部程序宿主关闭失败', err); }
    try { await watchers.closeAll(); } catch (err) { console.error('[data] 监听关闭失败', err); }
    try { await backend.close(); } catch (err) { console.error('[data] 索引关闭失败', err); }
    try { await svc.close(); } catch (err) { console.error('[data] 数据库关闭失败', err); }
    post({ t: 'closed' });
    setTimeout(() => process.exit(0), 50);
  }

  try {
    post({
      t: 'ready',
      window: svc.getLayout('window'),
      webPlugins: svc.plugins.webPlugins(),
      lastUsed: lastUsedOf(svc),
      access: accessSnapshots(svc),
    });
  } catch (err) {
    post({ t: 'boot-failed', error: errorText(err) });
    process.exit(1);
  }
}
