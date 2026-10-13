import { dumpCpuProfile, mark as startupMark, stallNote, stallOp, startupMarks, finishTrace } from './startupTrace'; // 必须是第一个 import：记录 main:module-start
import type { AuditKind, PluginProcessInfo } from '../shared/pluginIpc';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, protocol, screen, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import v8 from 'node:v8';
import { pathToFileURL } from 'node:url';
import { WebPanelManager, type WebAccessSnap } from './webPanels';
import { WebAccessMirror } from './webAccessMirror';
import { WebSiteGrantStore } from './webSiteGrantStore';
import { runWebSiteApply, WEB_SITE_GRANT_FILE, type WebSiteApplyRequest } from '../shared/webSiteGrant';
import { migrateUserData, planUserDataDir } from './userDataDir';
import { APP_DISPLAY_NAME, buildAppMenu } from './appMenu';
import { applyWindowChromeColors, windowChromeOptions } from './windowChrome';
import { registerWorkspaceSnapshot } from './workspaceSnapshot';
import { attachAutoUpdate, type UpdateRuntime } from './update/attach';
import { acquireInstance, finishInstance, markInstanceExiting, restartSkipsDiskCache, waitIfHolderExits } from './instanceLock';
import { markContentIndexDone, noteLongTask, runtimeSnapshot } from './runtimeStats';
import type { UpdateApplyRequest, UpdateSettings } from '../shared/update/types';
import { openMigrationWindow, registerMigration } from './migration/electron';
import type { WebBounds } from '../shared/webPanel';
import { startDataPlane, type DataPlane, type DataReady, type HarnessSnap } from './data/client';
import { errorText, isRendererDataMethod, MAIN_METHOD_SET } from '../shared/dataMethods';

// 数据目录（元数据永远不写进根目录）：KB_USER_DATA 优先；Windows 用 %LOCALAPPDATA%\LocalKnowledgeWorkbench，并从旧的 Roaming 目录一次性迁移（docs/07 §2）
{
  const plan = planUserDataDir({ platform: process.platform, env: process.env, electronDefault: app.getPath('userData') });
  const migrated = migrateUserData(plan.migrateFrom, plan.dir);
  if (migrated !== 'none') console.log(`[userData] 从 ${plan.migrateFrom} 迁移到 ${plan.dir}：${typeof migrated === 'string' ? migrated : '失败 ' + migrated.error}`);
  if (plan.dir !== app.getPath('userData')) {
    app.setPath('userData', plan.dir);
    app.setPath('sessionData', plan.dir);
  }
  // 旧实例正在退出时先短等它死掉，再决定要不要跳过磁盘缓存。缓存开关本身不改。
  waitIfHolderExits(plan.dir);
  // 必须在 app ready 之前。死锁说明上次是被杀掉的，磁盘缓存还被占着；这次改走内存缓存，避免渲染进程几十秒不出帧。
  if (restartSkipsDiskCache(app.getPath('userData'))) {
    app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
    app.commandLine.appendSwitch('disable-http-cache');
    // 单独的 GPU 进程在上次被杀掉后会卡住导航，页面几十秒不执行。这次把 GPU 放进浏览器进程。
    app.commandLine.appendSwitch('in-process-gpu');
  }
  stallNote(`restart-cache skip=${restartSkipsDiskCache(app.getPath('userData'))}`);
}

startupMark('main:imports-done');

protocol.registerSchemesAsPrivileged([
  { scheme: 'kbfile', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  { scheme: 'kbplugin', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

/** 沙箱 iframe 的 CSP（SDK 规范 §12.1；img-src 进一步收窄到 kbfile://plugin/<令牌>） */
const PLUGIN_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  'img-src kbfile://plugin data:',
  "font-src 'self' data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');
const FRAME_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>kb-plugin</title><script type="module" src="/__kb/runtime.js"></script></head><body></body></html>';

let win: BrowserWindow | null = null;
let plane: DataPlane | null = null;
let webPanels: WebPanelManager | null = null;
let siteGrants: WebSiteGrantStore | null = null;
const mirror = new WebAccessMirror();
let boundShortcutKeys = new Set<string>();
let updater: UpdateRuntime | null = null;
let quitStarted = false;
let userDataPath = '';
let interactiveSent = false;
let visibleTimeoutArmed = false;
const lastStats = { watch: -1, heapUsed: 0, rss: 0 };
const layoutKv = new Map<string, unknown>();
const kv = {
  get(key: string) { return layoutKv.get(key); },
  set(key: string, value: unknown) {
    layoutKv.set(key, value);
    void plane?.call('setLayout', [key, value]).catch((err) => console.error('[web] 记录最近使用失败', err));
  },
};
const harnessState: HarnessSnap = { launches: [], confirmPrompts: [], confirmAnswer: false };

/** 主窗口中属于某个插件的 iframe（kbplugin://<id>/__kb/frame.html） */
function pluginFrames(pluginId?: string) {
  if (!win) return [];
  const main = win.webContents.mainFrame;
  return main.framesInSubtree
    .filter((f) => f !== main)
    .map((f) => ({ f, id: /^kbplugin:\/\/([a-z0-9.-]+)\//.exec(f.url)?.[1] }))
    .filter((x): x is { f: Electron.WebFrameMain; id: string } => !!x.id && (!pluginId || x.id === pluginId));
}

/**
 * 看门狗终止插件（T13）：插件 iframe 是独立的渲染进程（跨站 iframe 进程隔离，见 docs/06 §5.2），
 * 杀掉这些进程不影响主窗口与其他插件。只杀“确实是本应用渲染进程、且不是主窗口进程”的 pid。
 */
function killPluginFrames(pluginId: string): { killed: number[]; isolated: boolean; alsoAffected: string[] } {
  if (!win) return { killed: [], isolated: false, alsoAffected: [] };
  const mainPid = win.webContents.mainFrame.osProcessId;
  const tabPids = () => new Set(app.getAppMetrics().filter((m) => m.type === 'Tab').map((m) => m.pid));
  const renderers = tabPids();
  const frames = pluginFrames(pluginId);
  const pids = [...new Set(frames.map((x) => x.f.osProcessId))].filter((pid) => pid > 0 && pid !== mainPid && pid !== process.pid && renderers.has(pid));
  const alsoAffected = [...new Set(pluginFrames().filter((x) => x.id !== pluginId && pids.includes(x.f.osProcessId)).map((x) => x.id))];
  setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    const alive = tabPids();
    const busy = new Set(win.webContents.mainFrame.framesInSubtree.filter((f) => !/^kbplugin:\/\/[a-z0-9.-]+\//.test(f.url) || /^kbplugin:\/\/([a-z0-9.-]+)\//.exec(f.url)?.[1] !== pluginId).map((f) => f.osProcessId));
    for (const pid of pids) {
      if (!alive.has(pid) || pid === win.webContents.mainFrame.osProcessId || busy.has(pid)) continue;
      try {
        console.log(`[watchdog] kill plugin ${pluginId} pid ${pid}`);
        process.kill(pid, 'SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
  }, 250);
  return { killed: pids, isolated: frames.length > 0 && frames.every((x) => x.f.osProcessId !== mainPid), alsoAffected };
}

function pluginProcesses(): PluginProcessInfo[] {
  if (!win) return [];
  const mainPid = win.webContents.mainFrame.osProcessId;
  const mem = new Map(app.getAppMetrics().map((m) => [m.pid, m.memory.workingSetSize]));
  const by = new Map<string, { frames: number; pids: Set<number> }>();
  for (const { f, id } of pluginFrames()) {
    const entry = by.get(id) ?? { frames: 0, pids: new Set<number>() };
    entry.frames++;
    entry.pids.add(f.osProcessId);
    by.set(id, entry);
  }
  return [...by].map(([pluginId, entry]) => ({
    pluginId,
    frames: entry.frames,
    pids: [...entry.pids],
    isolated: !entry.pids.has(mainPid),
    workingSetKB: [...entry.pids].reduce((n, pid) => n + (pid === mainPid ? 0 : (mem.get(pid) ?? 0)), 0),
  }));
}

/** 性能环境的廉价采样。不写堆快照：writeHeapSnapshot 会再复制一整份堆。 */
function perfMemSample() {
  const heap = v8.getHeapStatistics();
  const mem = process.memoryUsage();
  const procs: { type: string; kb: number }[] = [];
  try {
    const by = new Map<string, number>();
    for (const row of app.getAppMetrics()) {
      const type = row.type || 'unknown';
      by.set(type, (by.get(type) ?? 0) + (row.memory?.workingSetSize ?? 0));
    }
    for (const [type, kb] of by) procs.push({ type, kb });
  } catch {
    /* 指标读失败时仍返回堆 */
  }
  return {
    heapUsed: heap.used_heap_size,
    heapTotal: heap.total_heap_size,
    arrayBuffers: mem.arrayBuffers,
    external: mem.external,
    rss: mem.rss,
    watch: lastStats.watch,
    dataHeap: lastStats.heapUsed,
    dataRss: lastStats.rss,
    closable: win ? win.isClosable() : null,
    procs,
  };
}

function perfMemLine(): string {
  const sample = perfMemSample();
  const mb = (n: number) => Math.round(n / 1048576);
  const procs = sample.procs.map((row) => `${row.type}:${Math.round(row.kb / 1024)}`).join(',');
  return `mem heapUsed=${mb(sample.heapUsed)}MB heapTotal=${mb(sample.heapTotal)}MB buffer=${mb(sample.arrayBuffers)}MB external=${mb(sample.external)}MB rss=${mb(sample.rss)}MB watch=${sample.watch} dataHeap=${mb(sample.dataHeap)}MB dataRss=${mb(sample.dataRss)}MB procs=${procs}`;
}

function updateRoamingDir(userData: string): string {
  if (process.env.KB_UPDATE_ROAMING) return path.resolve(process.env.KB_UPDATE_ROAMING);
  if (process.env.KB_USER_DATA) return path.join(path.dirname(userData), `${path.basename(userData)}-roaming`);
  if (process.env.APPDATA) return path.join(process.env.APPDATA, 'LocalKnowledgeWorkbench');
  return path.join(userData, 'roaming');
}

async function stopBackground(): Promise<'closed' | 'timeout'> {
  webPanels?.destroyAll();
  if (!plane) return 'closed';
  return plane.stop();
}

function currentInstallDir(): string | null {
  if (process.env.KB_UPDATE_INSTALL_DIR) return path.resolve(process.env.KB_UPDATE_INSTALL_DIR);
  if (app.isPackaged) return path.dirname(process.execPath);
  return null;
}

async function bootUpdater(dataDir: string, startup: { dbOpened: boolean; migrationOk: boolean; windowLoaded: boolean; dbError?: string; migrationError?: string }) {
  const installDir = currentInstallDir();
  updater = await attachAutoUpdate({
    currentVersion: process.env.KB_UPDATE_CURRENT_VERSION || app.getVersion(),
    userDataDir: dataDir,
    roamingDir: updateRoamingDir(dataDir),
    installDir,
    workerFile: path.join(__dirname, 'updateBackupWorker.js'),
    startup,
    prepareShutdown: () => stopBackground(),
    closeDatabase: async () => { if (plane) await plane.stop(); },
    requestExit: () => app.exit(0),
    send: (snapshot) => send('kb:update', snapshot),
    relaunchPath: installDir ? path.join(installDir, 'LocalKnowledgeWorkbench.exe') : process.execPath,
  });
}

function send(channel: string, payload: unknown) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function applyReady(info: DataReady) {
  mirror.setPlugins(info.webPlugins);
  for (const row of info.access) mirror.put(row.pluginId, row.adapterId, row.snap);
  for (const [pluginId, value] of Object.entries(info.lastUsed)) layoutKv.set(`web.lastUsed.${pluginId}`, value);
}

function readBoundsFile(dir: string): { width: number; height: number; x?: number; y?: number } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'window-bounds.json'), 'utf8')) as { width?: number; height?: number; x?: number; y?: number };
    if (parsed && typeof parsed.width === 'number' && typeof parsed.height === 'number') return { width: parsed.width, height: parsed.height, x: parsed.x, y: parsed.y };
  } catch {
    /* 还没有窗口记录 */
  }
  return null;
}

function writeBoundsFile(dir: string, bounds: { width: number; height: number; x: number; y: number }) {
  try {
    fs.writeFileSync(path.join(dir, 'window-bounds.json'), JSON.stringify(bounds));
  } catch (err) {
    console.error('[window] 窗口位置没写上', err);
  }
}

async function answerAsk(method: string, args: unknown[]): Promise<unknown> {
  if (method === 'pickDirectory' || method === 'pickFile') {
    const spec = (args[0] ?? {}) as { title?: string; filters?: Electron.FileFilter[] };
    const title = String(spec.title ?? (method === 'pickDirectory' ? '选择文件夹' : '选择文件'));
    const filters = Array.isArray(spec.filters) ? spec.filters : undefined;
    const properties: Array<'openDirectory' | 'openFile'> = method === 'pickDirectory' ? ['openDirectory'] : ['openFile'];
    const options = { title, properties, filters };
    const picked = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return picked.canceled ? null : picked.filePaths[0] ?? null;
  }
  if (method === 'saveFile') {
    const spec = (args[0] ?? {}) as { title?: string; defaultPath?: string; filters?: Electron.FileFilter[] };
    const options = { title: String(spec.title ?? '保存'), defaultPath: spec.defaultPath, filters: spec.filters };
    const picked = win && !win.isDestroyed() ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    return picked.canceled ? null : picked.filePath ?? null;
  }
  if (method === 'showItem') {
    shell.showItemInFolder(String(args[0] ?? ''));
    return true;
  }
  if (method === 'confirmUnprotected') {
    const info = (args[0] ?? {}) as { programName?: string; detail?: string; pluginName?: string };
    const opts = {
      type: 'warning' as const,
      title: '启动前无法备份',
      message: `${info.programName ?? ''}：这次启动不会备份目标文件`,
      detail: `${info.detail ?? ''}。\n不备份也启动的话，外部程序对这个文件的修改无法在操作记录中撤销。\n（插件：${info.pluginName ?? ''}）`,
      buttons: ['不启动', '不备份也启动'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const picked = win && !win.isDestroyed() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    return picked.response === 1;
  }
  if (!webPanels) throw new Error('网页面板还没准备好');
  if (method === 'web.fetchForCache') {
    const result = await webPanels.fetchForCache(String(args[0]), String(args[1]), String(args[2]), (args[3] ?? {}) as { timeoutMs?: number; maxBytes?: number });
    if (result.ok) return { ...result, bytes: Uint8Array.from(result.bytes) };
    return result;
  }
  if (method === 'web.pageInfo') return webPanels.pageInfo(String(args[0]));
  if (method === 'web.savePage') {
    await webPanels.savePage(String(args[0]), String(args[1]));
    return true;
  }
  if (method === 'web.destroyPlugin') {
    webPanels.destroyPlugin(String(args[0]));
    return true;
  }
  if (method === 'web.destroyRevoked') {
    webPanels.destroyRevoked(String(args[0]), String(args[1]));
    return true;
  }
  if (method === 'web.siteDataBytes') return webPanels.siteDataBytes(String(args[0]));
  if (method === 'web.clearSessionData') {
    const kinds = Array.isArray(args[1]) ? args[1].filter((k): k is 'cookies' | 'storage' | 'cache' => k === 'cookies' || k === 'storage' || k === 'cache') : undefined;
    await webPanels.clearSessionData(String(args[0]), kinds);
    return true;
  }
  throw new Error(`主进程没有这个请求: ${method}`);
}

function isWindowChromeColor(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && !value.includes('var(') && !/[\n;{}]/.test(value);
}

function registerIpc() {
  const api: Record<string, (...a: any[]) => unknown> = {
    pickFolder: async () => {
      const picked = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], title: '选择要注册为根的文件夹' });
      return picked.canceled ? null : picked.filePaths[0];
    },
    pickFile: async () => {
      const picked = await dialog.showOpenDialog(win!, { properties: ['openFile'], title: '选择要注册为来源的单个文件' });
      return picked.canceled ? null : picked.filePaths[0];
    },
    agentLiveStartDrag: (files: unknown) => {
      const list = (Array.isArray(files) ? files : []).map((item) => String(item)).filter(Boolean);
      if (!list.length || !win || win.isDestroyed()) return false;
      const icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
      win.webContents.startDrag({ file: list[0]!, files: list, icon });
      return true;
    },
    getStartupTrace: () => startupMarks(),
    setBoundShortcuts: (keys: string[]) => {
      boundShortcutKeys = new Set((Array.isArray(keys) ? keys : []).map(String).filter(Boolean));
      webPanels?.setBoundShortcuts([...boundShortcutKeys]);
    },
    webCreate: async (viewId: string, pluginId: string, adapterId: string) => {
      if (!plane || !webPanels) throw new Error('数据进程还没就绪');
      const snap = await plane.call('plugin.webAccess', [pluginId, adapterId]) as WebAccessSnap;
      mirror.put(String(pluginId), String(adapterId), snap);
      return webPanels.create(viewId, pluginId, adapterId);
    },
    webDestroy: (viewId: string) => webPanels?.destroy(viewId),
    webNavigate: (viewId: string, url: string) => webPanels?.navigate(viewId, url),
    webBack: (viewId: string) => webPanels?.back(viewId),
    webForward: (viewId: string) => webPanels?.forward(viewId),
    webReload: (viewId: string) => webPanels?.reload(viewId),
    webGetScroll: (viewId: string) => webPanels?.getScroll(viewId),
    webSetScroll: (viewId: string, pos: { x: number; y: number }) => webPanels?.setScroll(viewId, pos),
    webGetZoom: (viewId: string) => webPanels?.getZoom(viewId),
    webSetZoom: (viewId: string, scale: number) => webPanels?.setZoom(viewId, scale),
    webSnapshot: (viewId: string) => webPanels?.snapshot(viewId),
    webClearSessionData: (viewId: string, kinds?: Array<'cookies' | 'storage' | 'cache'>) => webPanels?.clearSessionData(webPanels.partitionOfView(viewId), Array.isArray(kinds) ? kinds.filter((k) => k === 'cookies' || k === 'storage' || k === 'cache') : undefined),
    webOpenExternal: (url: string, from: { viewId?: string; pluginId?: string; adapterId?: string }) => webPanels?.openExternal(url, from ?? {}),
    webSiteApply: async (req: WebSiteApplyRequest) => {
      if (!siteGrants || !webPanels) throw new Error('网页面板还没准备好');
      const result = await runWebSiteApply(siteGrants, req, true);
      if (result.status !== 'success') return result;
      if (result.reload !== 'none') webPanels.forgetExternal(result.reload === 'view' ? req?.viewId : undefined);
      webPanels.refreshExternal(req?.viewId);
      if (result.reload === 'all' || (result.reload === 'view' && !req?.viewId)) webPanels.reloadAllFresh();
      else if (result.reload === 'view' && req?.viewId) webPanels.reloadFresh(req.viewId);
      return result;
    },
    webSiteList: () => siteGrants?.list() ?? [],
    killPluginFrames: (pluginId: string) => killPluginFrames(pluginId),
    pluginProcesses: () => pluginProcesses(),
    openMigration: (tab: string) => void openMigrationWindow((['export', 'import', 'repair', 'backups'] as const).find((item) => item === tab) ?? 'repair'),
    updateState: () => updater?.snapshot() ?? null,
    aboutInfo: () => ({
      version: process.env.KB_UPDATE_CURRENT_VERSION || app.getVersion(),
      electron: process.versions.electron ?? '',
      dataDir: app.getPath('userData'),
      installDir: currentInstallDir(),
    }),
    updateCheck: () => updater?.check() ?? Promise.reject(new Error('更新服务还没启动')),
    updateSaveSettings: (patch: Partial<UpdateSettings>) => updater?.saveSettings(patch) ?? Promise.reject(new Error('更新服务还没启动')),
    updateApply: async (req: UpdateApplyRequest) => {
      if (!updater) throw new Error('更新服务还没启动');
      if (!req || typeof req !== 'object') throw new Error('更新请求不合法');
      if (req.actionId === 'app.checkUpdate') return updater.check();
      if (req.actionId === 'app.installUpdate') {
        if (req.when === 'quit') return updater.installOnQuit();
        await updater.installNow();
        return updater.snapshot();
      }
      if (req.actionId === 'app.rollbackUpdate') {
        await updater.rollback();
        return updater.snapshot();
      }
      throw new Error('未知更新操作');
    },
  };
  ipcMain.on('kb:web-bounds', (event, viewId: string, bounds: WebBounds | null) => {
    if (!win || event.sender !== win.webContents) return;
    webPanels?.setBounds(String(viewId), bounds && typeof bounds === 'object' && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ? bounds : null);
  });
  ipcMain.on('kb:startup-mark', (event, name: unknown, wall: unknown) => {
    if (!win || event.sender !== win.webContents || typeof name !== 'string' || !/^[a-z0-9:-]{1,48}$/.test(name)) return;
    startupMark(`renderer:${name}`, 'renderer', typeof wall === 'number' && Number.isFinite(wall) ? wall : Date.now());
    if (name === 'interactive') tellInteractive('interactive');
    if (name === 'visible-content-loaded' || name === 'visible-content-timeout') {
      traceGates.visible = true;
      maybeFinishTrace();
    }
  });
  ipcMain.on('kb:long-task', (event, ms: unknown) => {
    if (!win || event.sender !== win.webContents || typeof ms !== 'number' || !Number.isFinite(ms)) return;
    if (ms < 50 || ms > 60000) return;
    noteLongTask(ms);
  });
  if (process.env.KB_PERF_BOUNDS === '1') {
    ipcMain.handle('kb:perf-bounds', () => {
      if (!win) return null;
      const before = win.getBounds();
      const started = Date.now();
      win.setBounds({ x: before.x + 24, y: before.y + 16, width: before.width, height: before.height });
      return { before, after: win.getBounds(), ms: Date.now() - started };
    });
    ipcMain.handle('kb:perf-sample', () => perfMemSample());
    ipcMain.handle('kb:perf-gc', () => {
      const gc = (globalThis as { gc?: () => void }).gc;
      if (typeof gc === 'function') gc();
      return { gc: typeof gc === 'function', ...perfMemSample() };
    });
  }
  ipcMain.handle('kb:set-window-chrome', (event, payload: unknown) => {
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
    const body = payload && typeof payload === 'object' ? (payload as { color?: unknown; symbolColor?: unknown }) : null;
    const color = body?.color;
    const symbolColor = body?.symbolColor;
    if (!isWindowChromeColor(color) || !isWindowChromeColor(symbolColor)) return;
    applyWindowChromeColors(win, { color, symbolColor });
  });
  // registerWorkspaceSnapshot({ getWindow: () => win })
  registerWorkspaceSnapshot({
    getWindow: () => win,
    getSnapshotDir: () => path.join(app.getPath('userData'), 'workspace-snapshots'),
  });
  ipcMain.handle('kb', async (_event, method: string, ...args: unknown[]) => {
    const started = Date.now();
    try {
      if (typeof method !== 'string' || !method) throw new Error('未知方法');
      if (MAIN_METHOD_SET.has(method)) {
        const fn = api[method];
        if (!fn) throw new Error(`未知方法: ${method}`);
        return await fn(...args);
      }
      if (!isRendererDataMethod(method)) throw new Error(`未知方法: ${method}`);
      if (!plane) throw new Error('数据进程还没就绪');
      return await plane.call(method, args);
    } finally {
      stallOp(`ipc:${method}`, Date.now() - started);
    }
  });
}

function deniedMessage(error: unknown): { status: number; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const status = /PathEscapeError|permission-denied|out-of-scope|plugin-unavailable/.test(message) ? 403 : 404;
  return { status, message };
}

function registerProtocol() {
  protocol.handle('kbfile', async (req) => {
    try {
      if (!plane) return new Response('数据进程还没就绪', { status: 503 });
      const host = new URL(req.url).host;
      const abs = String(await plane.call(host === 'plugin' ? 'resolvePluginFile' : 'resolveKbfile', [req.url]));
      if (!fs.statSync(abs).isFile()) return new Response('not a file', { status: 404 });
      return net.fetch(pathToFileURL(abs).toString());
    } catch (error) {
      const denied = deniedMessage(error);
      return new Response(denied.message, { status: denied.status });
    }
  });
  protocol.handle('kbplugin', async (req) => {
    const url = new URL(req.url);
    const headers = { 'Content-Security-Policy': PLUGIN_CSP, 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
    try {
      if (!plane) return new Response('数据进程还没就绪', { status: 503, headers });
      const pluginId = url.host;
      const rel = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      if (rel === '__kb/frame.html') {
        await plane.call('resolvePluginAsset', [pluginId, 'manifest.json']);
        return new Response(FRAME_HTML, { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
      }
      if (rel === '__kb/runtime.js') return new Response(fs.readFileSync(path.join(__dirname, '../plugin-runtime/runtime.js')), { headers: { ...headers, 'Content-Type': 'text/javascript; charset=utf-8' } });
      const abs = String(await plane.call('resolvePluginAsset', [pluginId, rel]));
      const type = /\.m?js$/.test(abs) ? 'text/javascript; charset=utf-8' : /\.css$/.test(abs) ? 'text/css; charset=utf-8' : /\.json$/.test(abs) ? 'application/json' : 'application/octet-stream';
      return new Response(fs.readFileSync(abs), { headers: { ...headers, 'Content-Type': type } });
    } catch (error) {
      return new Response(error instanceof Error ? error.message : String(error), { status: 404, headers });
    }
  });
}

function pushPort() {
  if (!win || win.isDestroyed() || !plane) return;
  const port = plane.claimRendererPort();
  win.webContents.postMessage('kb:data-port', {}, [port]);
}

function createWindow(saved: { width?: number; height?: number; x?: number; y?: number } | null) {
  const wa = (saved?.x !== undefined ? screen.getDisplayMatching({ x: saved.x, y: saved.y ?? 0, width: 100, height: 100 }) : screen.getPrimaryDisplay()).workArea;
  const width = Math.min(saved?.width ?? 1400, wa.width);
  const height = Math.min(saved?.height ?? 900, wa.height);
  const inside = saved?.x !== undefined && saved.x >= wa.x && saved.x + width <= wa.x + wa.width && (saved.y ?? 0) >= wa.y && (saved.y ?? 0) + height <= wa.y + wa.height;
  win = new BrowserWindow({
    width,
    height,
    x: inside ? saved!.x : undefined,
    y: inside ? saved!.y : undefined,
    title: APP_DISPLAY_NAME,
    icon: fs.existsSync(path.join(__dirname, '../../build/icon.png')) ? path.join(__dirname, '../../build/icon.png') : undefined,
    autoHideMenuBar: true,
    backgroundColor: '#1e1e1e',
    ...windowChromeOptions(),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // Main window: zoomMode='manual' (not 'disabled').
  // 'disabled' swallows Ctrl+wheel so renderer content-zoom never runs.
  // 'manual' keeps page scale; wheel still reaches renderer for anchored zoom.
  win.webContents.setVisualZoomLevelLimits(1, 1);
  win.webContents.setZoomMode('manual');
  win.webContents.on('zoom-changed', () => undefined);
  let flushed = false;
  win.on('close', (event) => {
    const crashed = Boolean(win && !win.isDestroyed() && win.webContents.isCrashed());
    stallNote(`close-request crashed=${crashed} pass=${flushed ? 'after-flush' : 'first'} quitStarted=${quitStarted}`);
    if (!win) return;
    if (!flushed && !win.webContents.isCrashed()) {
      event.preventDefault();
      const current = win;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        ipcMain.removeListener('kb:flush-done', onDone);
        flushed = true;
        if (!current.isDestroyed()) current.close();
      };
      const onDone = (ev: Electron.IpcMainEvent) => ev.sender === current.webContents && finish();
      ipcMain.on('kb:flush-done', onDone);
      current.webContents.send('kb:before-quit');
      setTimeout(finish, 3000);
      return;
    }
    const bounds = win.getBounds();
    const savedBounds = { width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y };
    if (userDataPath) writeBoundsFile(userDataPath, savedBounds);
    void plane?.call('setLayout', ['window', savedBounds]).catch(() => undefined);
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[main] 主窗口渲染进程退出：${details.reason}（exitCode ${details.exitCode}）`);
    stallNote(`render-gone ${details.reason} ${details.exitCode}`);
    webPanels?.destroyAll();
    if (details.reason !== 'clean-exit' && win && !win.isDestroyed()) setTimeout(() => win?.webContents.reload(), 500);
  });
  win.webContents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return;
    const matched = /^kbplugin:\/\/([a-z0-9.-]+)\/__kb\/frame\.html$/.exec(event.url);
    const current = event.frame?.url ?? '';
    const currentHost = /^kbplugin:\/\/([a-z0-9.-]+)\//.exec(current)?.[1];
    if (!matched || (current && current !== 'about:blank' && currentHost !== matched[1])) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) webPanels?.destroyAll();
  });
  win.on('closed', () => { webPanels?.destroyAll(); stallNote('window-closed'); win = null; });
  stallNote('createWindow:constructed');
  startupMark('window:created');
  win.once('ready-to-show', () => startupMark('window:ready-to-show'));
  win.webContents.on('did-start-loading', () => stallNote('did-start-loading'));
  win.webContents.on('did-fail-load', (_event, code, desc, url, isMainFrame) => {
    if (isMainFrame) stallNote(`did-fail-load ${code} ${desc} ${url}`);
  });
  win.webContents.on('did-finish-load', () => pushPort());
  win.webContents.once('did-finish-load', () => startupMark('window:did-finish-load'));
  win.webContents.once('did-finish-load', () => {
    updater?.noteWindowLoaded();
    if (process.env.KB_TEST_FREEZE_RENDERER === '1') {
      (globalThis as { __kbRendererFreezeStarted?: boolean }).__kbRendererFreezeStarted = true;
      console.log('[update] renderer freeze');
      void win?.webContents.executeJavaScript('while(true){}').catch(() => undefined);
    }
  });
  if (win.isVisible()) startupMark('window:shown');
  else win.once('show', () => startupMark('window:shown'));
  if (!app.isPackaged && process.env.VITE_DEV_SERVER_URL) void win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

function tellInteractive(reason: 'interactive' | 'timeout') {
  if (interactiveSent || !plane) return;
  interactiveSent = true;
  plane.interactive(reason);
}

const traceGates = { scans: false, visible: false, content: false };
function maybeFinishTrace() {
  if (!traceGates.scans || !traceGates.visible) return;
  finishTrace(app.getPath('userData'), !app.isPackaged || process.env.KB_STARTUP_TRACE === '1', {
    runtime: runtimeSnapshot(),
    final: traceGates.content,
  });
}

if (process.platform === 'win32') app.setAppUserModelId('local.kb.workbench');
app.setAboutPanelOptions({ applicationName: APP_DISPLAY_NAME, applicationVersion: app.getVersion() });

app.whenReady().then(async () => {
  startupMark('app:ready');
  Menu.setApplicationMenu(buildAppMenu(() => win, { dev: !app.isPackaged, dataDir: () => app.getPath('userData'), migration: openMigrationWindow }));
  const dataDir = app.getPath('userData');
  userDataPath = dataDir;
  const lock = await acquireInstance(dataDir);
  if (!lock.ok) {
    console.error('[app] 这个数据目录已有实例在运行，本次不打开数据库');
    app.exit(0);
    return;
  }
  if (lock.reaped.length) console.log(`[app] 已结束上次留下的子进程 ${lock.reaped.join(',')}`);
  startupMark('main:service-before');
  plane = startDataPlane({
    dataDir,
    packaged: app.isPackaged,
    version: app.getVersion(),
    e2e: process.env.KB_E2E === '1',
    ask: answerAsk,
  });
  plane.onEvent((channel, payload) => send(channel, payload));
  plane.onStats((stats) => {
    lastStats.watch = stats.watch;
    lastStats.heapUsed = stats.heapUsed;
    lastStats.rss = stats.rss;
    if (process.env.KB_PERF_BOUNDS === '1') {
      try { stallNote(perfMemLine()); } catch (err) { stallNote(`mem-error ${errorText(err)}`); }
    }
  });
  plane.onMark((name, side, wall) => {
    startupMark(name, side, wall);
    if (name === 'deferred:scans-done') {
      traceGates.scans = true;
      maybeFinishTrace();
      if (!visibleTimeoutArmed) {
        visibleTimeoutArmed = true;
        setTimeout(() => { traceGates.visible = true; maybeFinishTrace(); }, 20000).unref?.();
      }
    }
    if (name === 'deferred:content-index-done') {
      // 标记写在数据进程。主进程的轨迹快照看不到，门禁会一直等到窗口超时。
      markContentIndexDone();
      traceGates.content = true;
      maybeFinishTrace();
      dumpCpuProfile();
    }
    if (name === 'deferred:queued') {
      void webPanels?.purgeExpired().then((ids) => ids.length && console.log(`[web] 已清除超过保留期的网站数据：${ids.join(', ')}`));
    }
  });
  plane.onGrants((pluginId, plugins, access) => {
    mirror.setPlugins(plugins);
    for (const row of access) mirror.put(row.pluginId, row.adapterId, row.snap);
    webPanels?.refreshAccess(pluginId);
  });
  plane.onPlugins((plugins) => mirror.setPlugins(plugins));
  plane.onHarness((snap) => {
    harnessState.launches = snap.launches;
    harnessState.confirmPrompts = snap.confirmPrompts;
    harnessState.confirmAnswer = snap.confirmAnswer;
  });
  plane.onReset(() => send('kb:data-reset', {}));
  plane.onRestarted((info) => {
    applyReady(info);
    pushPort();
    send('kb:data-reset', {});
  });
  if (!app.isPackaged && process.env.KB_E2E_APP_HARNESS === '1') {
    const current = plane;
    (globalThis as { __kbAppHarness?: unknown }).__kbAppHarness = {
      get launches() { return harnessState.launches; },
      get confirmPrompts() { return harnessState.confirmPrompts; },
      get confirmAnswer() { return harnessState.confirmAnswer; },
      set confirmAnswer(value: boolean) {
        harnessState.confirmAnswer = value === true;
        void current.call('harness.setConfirm', [value === true]);
      },
      realPath: (winPath: string) => current.call('harness.realPath', [winPath]),
      exit: (pid: number, code?: number) => current.call('harness.exit', [pid, code]),
      expireAfterDays: (days: number) => current.call('harness.expireAfterDays', [days]),
    };
  }
  (globalThis as { __kbWebResources?: unknown }).__kbWebResources = {
    store: { cacheFile: (resourceId: string) => plane?.call('web.cacheFile', [resourceId]) ?? null },
  };
  let info: DataReady;
  try {
    info = await plane.ready;
  } catch (err) {
    const message = errorText(err);
    console.error('[data] 数据库或迁移失败', err);
    await bootUpdater(dataDir, { dbOpened: false, migrationOk: false, windowLoaded: false, dbError: message, migrationError: message });
    return;
  }
  startupMark('main:workbench-ready');
  applyReady(info);
  startupMark('main:service-open');
  if (process.env.KB_PERF_BOUNDS === '1') {
    const heapBeat = setInterval(() => {
      try { stallNote(perfMemLine()); } catch (err) { stallNote(`mem-error ${errorText(err)}`); }
    }, 2000);
    heapBeat.unref?.();
  }
  siteGrants = new WebSiteGrantStore(path.join(dataDir, WEB_SITE_GRANT_FILE));
  await siteGrants.load();
  webPanels = new WebPanelManager(() => win, {
    webAccess: (pluginId, adapterId) => mirror.webAccess(pluginId, adapterId),
    webPlugins: () => mirror.webPlugins(),
    onGrantsChanged: (cb) => mirror.onGrantsChanged(cb),
    audit: (pluginId, adapterId, kind: AuditKind, detail, code) => {
      void plane?.call('plugin.audit', [pluginId, adapterId, kind, detail, code ?? null]).catch((err) => console.error('[web] 审计写入失败', err));
    },
  }, (ev) => send('kb:web-event', ev), kv, siteGrants);
  (globalThis as { __kbWeb?: WebPanelManager }).__kbWeb = webPanels;
  webPanels.setBoundShortcuts([...boundShortcutKeys]);
  registerIpc();
  registerMigration({ call: (method, ...args) => plane!.call(method, args), getMainWindow: () => win });
  registerProtocol();
  await bootUpdater(dataDir, { dbOpened: true, migrationOk: true, windowLoaded: false });
  const saved = info.window && typeof info.window.width === 'number' ? info.window : readBoundsFile(dataDir);
  createWindow(saved);
  setTimeout(() => tellInteractive('timeout'), 5000);
});

app.on('before-quit', (event) => {
  if (userDataPath) markInstanceExiting(userDataPath);
  stallNote(`before-quit quitStarted=${quitStarted}`);
  event.preventDefault();
  if (quitStarted) return;
  quitStarted = true;
  void (async () => {
    console.log('[shutdown] begin');
    await Promise.all(BrowserWindow.getAllWindows().map((current) => new Promise<void>((resolve) => {
      if (current.isDestroyed()) return resolve();
      const deadline = setTimeout(() => { if (!current.isDestroyed()) current.destroy(); resolve(); }, 3500);
      current.once('closed', () => { clearTimeout(deadline); resolve(); });
      current.close();
    })));
    const install = updater ? await updater.prepareQuitInstall().catch((err) => {
      console.error('[update] quit install failed', err);
      return false;
    }) : false;
    webPanels?.destroyAll();
    if (plane) await plane.stop();
    if (userDataPath) await finishInstance(userDataPath);
    if (install) await updater?.spawnQuitInstall();
    console.log('[shutdown] databases closed; exiting');
    app.exit(0);
  })().catch((error) => console.error('[shutdown] failed', error));
});
app.on('window-all-closed', () => app.quit());
