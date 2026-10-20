import { registerSidebarWindow } from './sidebarWindow';
import { AiWriteChannel } from './aiWrite/service';
import { bindAiWriteMethods } from './aiWrite/ipc';
import { REBIRTH_METHODS } from '../shared/rebirth';
import type { BlankFileCreated } from '../shared/blankFile';
import { RebirthRepository } from './rebirth/repository';
import { bindRebirthMethods } from './rebirth/ipc';
import { resolveAgentDataRoot, writeLocationDir } from './agentPanel/paths';
import { dumpCpuProfile, mark as startupMark, stallNote, stallOp, startupMarks, finishTrace } from './startupTrace'; // 必须是第一个 import：记录 main:module-start
import type { AuditKind, PluginProcessInfo } from '../shared/pluginIpc';
import { app, BrowserWindow, dialog, ipcMain, Menu, clipboard, nativeImage, net, protocol, screen, shell } from 'electron';
import { installEditContextMenu } from './editContextMenu';
import { handleNativeDragIpc, nativeDragWantsSyncReply, rethrowStartDrag } from './nativeDrag/dispatch';
import { nativeDragIcon } from './nativeDrag/icon';
import { nodeNativeDragFs } from './nativeDrag/nodeFs';
import { NATIVE_DRAG_ENDED_CHANNEL, NATIVE_DRAG_START_CHANNEL, createNativeDragController, type NativeDragAllow } from '../shared/nativeDragPolicy';
import path from 'node:path';
import fs from 'node:fs';
import v8 from 'node:v8';
import { pathToFileURL } from 'node:url';
import { WebPanelManager, type WebAccessSnap } from './webPanels';
import { ExternalBrowseHost } from './externalBrowseHost';
import { WebAccessMirror } from './webAccessMirror';
import { WebSiteGrantStore } from './webSiteGrantStore';
import { runWebSiteApply, WEB_SITE_GRANT_FILE, type WebSiteApplyRequest } from '../shared/webSiteGrant';
import { isFormalInstallPath, migrateUserData, planUserDataDir } from './userDataDir';
import { APP_DISPLAY_NAME, buildAppMenu } from './appMenu';
import { applyWindowChromeColors, windowChromeOptions } from './windowChrome';
import { presentPlan, presentSwitches } from './windowPresent';
import {
  NativeHostService,
  nativeHostMethodTable,
  createWin32Helper,
  createResolveParentHwnd,
} from './nativeAppHost';
import { registerWorkspaceSnapshot } from './workspaceSnapshot';
import { attachAutoUpdate, type UpdateRuntime } from './update/attach';
import { acquireInstance, finishInstance, markInstanceExiting, restartSkipsDiskCache, waitIfHolderExits } from './instanceLock';
import { markContentIndexDone, noteLongTask, runtimeSnapshot } from './runtimeStats';
import type { UpdateApplyRequest, UpdateSettings } from '../shared/update/types';
import { openMigrationWindow, registerMigration } from './migration/electron';
import { openAgentPickerWindow, registerAgentPicker } from './agentPicker/electron';
import { askDialogKey, DIALOG_LAST_DIR, openDialogWithMemory, saveDialogWithMemory } from './dialogLastDir';
import type { WebBounds } from '../shared/webPanel';
import { startDataPlane, type DataPlane, type DataReady, type HarnessSnap } from './data/client';
import { ObsidianBridge } from './obsidianBridge/service';
import { errorText, isRendererDataMethod, MAIN_METHOD_SET } from '../shared/dataMethods';
import { grabMethodTable } from './grab/grabMethods'; // host-r1 L2: grab.open / grab.pickSource
import { enumerateSources as enumerateGrabSources } from './desktopSession/captureService';
import { registerDesktopCaptureIpc, registerDesktopSourceEnumerateIpc, registerDesktopCaptureUiIpc, registerDesktopInputIpc, onHostPresentationEvent } from './desktopSession'; // desk-r1 A capture + B enumerate + UI session + desk-input

// 数据目录（元数据永远不写进根目录）：KB_USER_DATA 优先；Windows 用 %LOCALAPPDATA%\LocalKnowledgeWorkbench，并从旧的 Roaming 目录一次性迁移（docs/07 §2）
{
  const plan = planUserDataDir({ platform: process.platform, env: process.env, electronDefault: app.getPath('userData'), execPath: process.execPath });
  if (process.platform === 'win32' && !process.env.KB_USER_DATA) {
    const isolated = !isFormalInstallPath(process.execPath);
    console.log(`[userData] exec=${process.execPath} formal=${!isolated} dir=${plan.dir}`);
  }
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
    // 不能加进程内 GPU 开关：Windows 上进程内 GPU 画不出合成帧，窗口会整屏停在 #F3F3F3。
  }
  stallNote(`restart-cache skip=${restartSkipsDiskCache(app.getPath('userData'))}`);
  // 必须在 app ready 前关闭 Windows 遮挡节流；禁用 GPU 仅作为环境变量兼容回退。
  const presentation = presentSwitches(process.platform, process.env, process.argv);
  for (const [name, value] of presentation.appendSwitch) {
    const existing = name === 'disable-features' ? app.commandLine.getSwitchValue(name) : '';
    app.commandLine.appendSwitch(name, existing ? `${existing},${value}` : value);
  }
  if (presentation.disableHardwareAcceleration) app.disableHardwareAcceleration();
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
let extBrowse: ExternalBrowseHost | null = null;
let siteGrants: WebSiteGrantStore | null = null;
const mirror = new WebAccessMirror();
let boundShortcutKeys = new Set<string>();
let updater: UpdateRuntime | null = null;
let quitStarted = false;
let userDataPath = '';
let obsidianBridge: ObsidianBridge | null = null;
function obsidian(): ObsidianBridge {
  if (!obsidianBridge) {
    obsidianBridge = new ObsidianBridge({
      userDataDir: userDataPath || app.getPath('userData'),
      listRoots: async () => {
        if (!plane) return null;
        const roots = await plane.call('listRoots', []) as { path?: string; kind?: string }[];
        return (Array.isArray(roots) ? roots : []).map((row) => ({
          path: String(row?.path ?? ''),
          kind: row?.kind === 'file' ? 'file' as const : 'folder' as const,
        }));
      },
      openExternal: (uri) => shell.openExternal(uri),
    });
  }
  return obsidianBridge;
}
let interactiveSent = false;
let visibleTimeoutArmed = false;
/** startup-ready-race: renderer-facing readiness (kb IPC handlers + protocols registered). Queried via kb:plane-ready-state, pushed via kb:plane-ready. */
let rendererReady = false;
/** startup-ready-race: one data port per page load; a 2nd push used to reject the first-screen calls in flight. */
let portPushedForLoad = false;
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
  extBrowse?.destroyAll();
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
    const spec = (args[0] ?? {}) as { title?: string; filters?: Electron.FileFilter[]; dialogKey?: string };
    const title = String(spec.title ?? (method === 'pickDirectory' ? '选择文件夹' : '选择文件'));
    const filters = Array.isArray(spec.filters) ? spec.filters : undefined;
    const properties: Array<'openDirectory' | 'openFile'> = method === 'pickDirectory' ? ['openDirectory'] : ['openFile'];
    const key = askDialogKey(method, title, spec.dialogKey);
    const picked = await openDialogWithMemory(key, win, { title, properties, filters });
    return picked.canceled ? null : picked.filePaths[0] ?? null;
  }
  if (method === 'saveFile') {
    const spec = (args[0] ?? {}) as { title?: string; defaultPath?: string; filters?: Electron.FileFilter[]; dialogKey?: string };
    const title = String(spec.title ?? '保存');
    const key = askDialogKey('saveFile', title, spec.dialogKey);
    const picked = await saveDialogWithMemory(key, win, { title, defaultPath: spec.defaultPath, filters: spec.filters });
    return picked.canceled ? null : picked.filePath ?? null;
  }
  if (method === 'showItem') {
    shell.showItemInFolder(String(args[0] ?? ''));
    return true;
  }
  if (method === 'openPath') {
    const result = await shell.openPath(String(args[0] ?? ''));
    if (result) throw new Error(result);
    return true;
  }
  if (method === 'trashItem') {
    const target = String(args[0] ?? '').trim();
    if (!target) throw new Error('没有要移到回收站的路径');
    await shell.trashItem(target);
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

function asPathList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
}

let nativeDragAllowRefresh: Promise<void> | null = null;
function refreshNativeDragAllow(): Promise<void> {
  if (nativeDragAllowRefresh) return nativeDragAllowRefresh;
  nativeDragAllowRefresh = (async () => {
    if (!plane) return;
    const snap = await plane.call('nativeDragAllow') as { roots?: unknown; files?: unknown } | null;
    const next: NativeDragAllow = { roots: asPathList(snap?.roots), files: asPathList(snap?.files) };
    nativeDrag.setAllow(next);
  })().catch((err) => {
    console.error('[native-drag] 允许列表刷新失败', err);
  }).finally(() => {
    nativeDragAllowRefresh = null;
  });
  return nativeDragAllowRefresh;
}

let dragIconCache: Electron.NativeImage | null = null;
function dragIcon(): Electron.NativeImage {
  if (dragIconCache && !dragIconCache.isEmpty()) return dragIconCache;
  dragIconCache = nativeDragIcon(nativeImage, [
    path.join(__dirname, '../../build/icon.png'),
    path.join(app.getAppPath(), 'build', 'icon.png'),
    path.join(process.resourcesPath, 'icon.png'),
  ]);
  return dragIconCache;
}

const nativeDrag = createNativeDragController({
  fs: nodeNativeDragFs(),
  pathLib: path,
  caseInsensitive: process.platform === 'win32',
  startDrag: (files) => {
    if (!win || win.isDestroyed()) throw new Error('no-window');
    const icon = dragIcon();
    try {
      win.webContents.startDrag({ file: files[0]!, files, icon });
    } catch (err) {
      rethrowStartDrag(err, icon);
    }
  },
});

/** 字符串是入口键。对象可另给标题和过滤器。缺省键由调用方传入。 */
function asPickSpec(input: unknown, fallbackKey: string, fallbackTitle: string): { key: string; title: string; filters?: Electron.FileFilter[] } {
  if (input && typeof input === 'object') {
    const row = input as { dialogKey?: unknown; title?: unknown; filters?: Electron.FileFilter[] };
    const key = typeof row.dialogKey === 'string' && row.dialogKey.trim() ? row.dialogKey.trim() : fallbackKey;
    const title = typeof row.title === 'string' && row.title.trim() ? row.title.trim() : fallbackTitle;
    return { key, title, filters: Array.isArray(row.filters) ? row.filters : undefined };
  }
  if (typeof input === 'string' && input.trim()) return { key: input.trim(), title: fallbackTitle };
  return { key: fallbackKey, title: fallbackTitle };
}

function registerIpc() {
  // host-r1 L2: native-app-host service (merge onto 6e3c42b; DEVICE_BLOCKED for live ASSERT)
  const nativeHost = new NativeHostService({
    helper: createWin32Helper(),
    resolveParentHwnd: createResolveParentHwnd((panelId) => {
      void panelId;
      if (!win || win.isDestroyed()) return null;
      return win;
    }),
    listDisplays: () => screen.getAllDisplays().map((d) => ({
      id: d.id,
      bounds: d.bounds,
      scaleFactor: d.scaleFactor,
    })),
  });

  let rebirthRepo: RebirthRepository | null = null;
  let aiWrite: AiWriteChannel | null = null;
  function aiWriteService(): AiWriteChannel {
    const resolved = resolveAgentDataRoot();
    if (!resolved) throw new Error('无法创建 Agent 数据目录');
    const dir = path.join(resolved.root, 'ai-write');
    if (!aiWrite || aiWrite.dir !== dir) {
      void aiWrite?.close();
      aiWrite = new AiWriteChannel(dir, { watch: true, trash: (file) => shell.trashItem(file) });
      aiWrite.start();
    }
    return aiWrite;
  }
  function repository(): RebirthRepository {
    const resolved = resolveAgentDataRoot();
    if (!resolved) throw new Error('无法创建 Agent 数据目录');
    if (!rebirthRepo || rebirthRepo.dataDir !== resolved.root) {
      rebirthRepo?.close();
      rebirthRepo = new RebirthRepository(resolved.root, () => { send('rebirth:changed', {}); void plane?.call('agentMarks.rebirthRefresh', [resolved.root]).catch(err => console.error('[rebirth] 标红同步失败',err)); }, file => shell.trashItem(file), {
        onNeedWorkspace: (apply) => {
          void (async () => {
            try {
              if (!plane) { apply(null, null); return; }
              const current = await plane.call('getCurrentWorkspaceId', []);
              const list = await plane.call('listWorkspaces', []) as { id?: string }[];
              const ids = Array.isArray(list) ? list.map((row) => String(row?.id ?? '')).filter(Boolean) : [];
              apply(typeof current === 'string' ? current : null, ids);
            } catch (err) {
              console.error('[rebirth] 读取工作区失败', err);
              apply(null, null);
            }
          })();
        },
      });
      rebirthRepo.start();
    }
    return rebirthRepo;
  }
  const rebirthMethods = () => bindRebirthMethods(repository(), {
    rootEntryText: async (agentId?: string, target?: string) => {
      const entry = String(await plane!.call('agentLiveEntryPath', ['workspace']));
      const roots = await plane!.call('listRoots', []) as { path?: string; absPath?: string; name?: string }[];
      const list = roots.map((root) => ({ path: root.path || root.absPath || '', name: root.name })).filter((root) => root.path);
      let materials: { absPath: string; name?: string }[] = [];
      try {
        const ws = await plane!.call('getCurrentWorkspaceId', []);
        const rows = await plane!.call('agentLiveList', [ws]) as { absPath?: string; name?: string; status?: string; tier?: string }[];
        if (Array.isArray(rows)) {
          materials = rows.filter((row) => row && typeof row.absPath === 'string' && row.absPath && row.status !== 'missing').map((row) => ({ absPath: row.absPath as string, name: row.name }));
        }
      } catch {
        materials = [];
      }
      return aiWriteService().composeLink({ roots: list, entry, agentId, materials, target });
    },
    loadPlaybookPaste: async () => {
      try {
        if (!plane) return null;
        const ws = await plane.call('getCurrentWorkspaceId', []);
        if (typeof ws !== 'string' || !ws) return null;
        const state = await plane.call('agentLivePlaybookGet', [ws]) as { enabled?: boolean } | null;
        if (!state?.enabled) return null;
        const rows = await plane.call('agentLiveList', [ws]);
        return {
          enabled: true as const,
          state: state as import('../shared/ctxPlaybook').CtxPlaybookState,
          materials: (Array.isArray(rows) ? rows : []) as import('../shared/ctxPlaybook').PlaybookMaterialRef[],
        };
      } catch {
        return null;
      }
    },
    pickFolder: async () => { const r = await openDialogWithMemory(DIALOG_LAST_DIR.rebirthExportFolder, win, {properties:['openDirectory','createDirectory']}); return r.canceled ? null : r.filePaths[0] ?? null; },
    pickCover: async () => { const r = await openDialogWithMemory(DIALOG_LAST_DIR.rebirthCover, win, {properties:['openFile'],filters:[{name:'封面图片',extensions:['png','jpg','jpeg','webp']}]}); return r.canceled ? null : r.filePaths[0] ?? null; },
    pickJson: async () => { const r = await openDialogWithMemory(DIALOG_LAST_DIR.rebirthImportJson, win, {properties:['openFile'],filters:[{name:'重生 JSON',extensions:['json']} ]}); return r.canceled ? null : r.filePaths[0] ?? null; },
    saveFile: async name => { const r = await saveDialogWithMemory(DIALOG_LAST_DIR.rebirthExport, win, {defaultPath:name,filters:[{name:'Markdown',extensions:['md']}]}); return r.canceled ? null : r.filePath ?? null; },
    copy: text => clipboard.writeText(text),
    startDrag: file => { if (!win || win.isDestroyed()) throw new Error('窗口不可用'); win.webContents.startDrag({file,icon:dragIcon()}); },
    exportToRoot: async ({ dir, name, content }): Promise<BlankFileCreated> => {
      if (!plane) throw new Error('数据进程还没就绪');
      return await plane.call('createFileWithContent', [{ dir, name, content }]) as BlankFileCreated;
    },
  });
  registerAgentPicker({
    getMainWindow: () => win,
    load: async () => {
      const repo = repository();
      if (!plane) throw new Error('数据进程还没就绪');
      const list = await plane.call('listWorkspaces', []) as { id?: string; name?: string }[];
      const current = await plane.call('getCurrentWorkspaceId', []);
      const workspaces = Array.isArray(list) ? list.flatMap((row) => {
        const id = String(row?.id ?? '').trim();
        if (!id) return [];
        return [{ id, name: String(row?.name ?? '').trim() || id }];
      }) : [];
      const targetId = typeof current === 'string' ? current.trim() : '';
      repo.setWorkspaceContext(targetId || null, workspaces.map((row) => row.id));
      const targetName = workspaces.find((row) => row.id === targetId)?.name || (targetId || '当前工作区');
      return { targetId, targetName, workspaces, files: repo.libraryList() };
    },
    preview: (id) => repository().readPreview(id),
    apply: (targetId, checkedIds) => repository().applyMembership(targetId, checkedIds),
  });
  repository();
  app.once('before-quit', () => { rebirthRepo?.close(); void aiWrite?.close(); });
  ipcMain.on('kb:rebirth-drag', (event, input) => {
    if (event.sender !== win?.webContents) return;
    try { rebirthMethods().rebirthDragOut(input); } catch (err) { console.error('[rebirth] 拖出失败', err); }
  });
  const api: Record<string, (...a: any[]) => unknown> = {
    ...Object.fromEntries(REBIRTH_METHODS.map(name => [name, (...args: any[]) => rebirthMethods()[name](...args)])),
    ...bindAiWriteMethods(() => aiWriteService()),
    agentPanelLocationGet: () => { const r = resolveAgentDataRoot(); return {dir:r?.root ?? '', defaultDir:r?.anchor ?? '', envLocked:r?.source==='env', source:r?.source}; },
    agentPanelLocationSet: async input => {
      const r=resolveAgentDataRoot(); if(!r?.anchor)throw new Error('环境变量已锁定数据位置');
      const dest=input?.dir ? path.resolve(input.dir) : r.anchor;
      if(input?.migrate && dest!==r.root) { if(dest.startsWith(r.root+path.sep))throw new Error('新位置不能在原目录内'); fs.cpSync(r.root,dest,{recursive:true,errorOnExist:true,force:false}); }
      fs.mkdirSync(dest,{recursive:true}); writeLocationDir(r.anchor,input?.dir ? dest : null); rebirthRepo?.close();rebirthRepo=null;repository();
      return api.agentPanelLocationGet();
    },
    pickFolder: async (spec?: unknown) => {
      const pickedSpec = asPickSpec(spec, DIALOG_LAST_DIR.registerRoot, '选择要注册为根的文件夹');
      const picked = await openDialogWithMemory(pickedSpec.key, win, { properties: ['openDirectory'], title: pickedSpec.title });
      return picked.canceled ? null : picked.filePaths[0];
    },
    pickFile: async (spec?: unknown) => {
      const pickedSpec = asPickSpec(spec, DIALOG_LAST_DIR.registerFile, '选择要注册为来源的单个文件');
      const picked = await openDialogWithMemory(pickedSpec.key, win, { properties: ['openFile'], title: pickedSpec.title, filters: pickedSpec.filters });
      return picked.canceled ? null : picked.filePaths[0];
    },
    readUtf8File: async (filePath: unknown) => {
      const abs = path.resolve(String(filePath ?? ''));
      const st = fs.statSync(abs);
      if (!st.isFile()) throw new Error('不是文件');
      if (st.size > 1024 * 1024) throw new Error('文件超过 1MB');
      return fs.readFileSync(abs, 'utf8');
    },
    agentLiveStartDrag: (files: unknown) => {
      if (!win || win.isDestroyed()) return nativeDrag.deny(files, 'no-window').ok;
      return nativeDrag.start(files).ok;
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
    webDestroy: (viewId: string) => webPanels?.releaseFromRenderer(viewId),
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
    extBrowseCreate: (viewId: string, url: string) => extBrowse?.create(String(viewId), String(url)) ?? { ok: false, reason: '外链浏览还没准备好' },
    extBrowseDestroy: (viewId: string) => extBrowse?.destroy(String(viewId)),
    extBrowseNavigate: (viewId: string, url: string) => extBrowse?.navigate(String(viewId), String(url)) ?? { ok: false, reason: '外链浏览还没准备好' },
    extBrowseBack: (viewId: string) => extBrowse?.back(String(viewId)),
    extBrowseReload: (viewId: string) => extBrowse?.reload(String(viewId)),
    extBrowseOpenSystem: (viewId: string) => extBrowse?.openSystem(String(viewId)) ?? Promise.resolve({ ok: false, reason: '外链浏览还没准备好' }),
    extBrowseSnapshot: (viewId: string) => extBrowse?.snapshot(String(viewId)) ?? Promise.resolve(null),
    killPluginFrames: (pluginId: string) => killPluginFrames(pluginId),
    pluginProcesses: () => pluginProcesses(),
    openMigration: (tab: string) => void openMigrationWindow((['export', 'import', 'repair', 'backups'] as const).find((item) => item === tab) ?? 'repair'),
    openAgentPicker: () => openAgentPickerWindow(),
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
    obsidianBridgeGet: () => obsidian().getSettings(),
    obsidianBridgeSetVault: (dir: unknown) => obsidian().setVaultDir(dir == null || dir === '' ? null : dir),
    obsidianBridgeInit: () => obsidian().initRelay(),
    obsidianBridgeSetJunction: (enabled: unknown) => obsidian().setJunction(enabled === true),
    obsidianOpen: (req: unknown) => obsidian().openInObsidian((req ?? {}) as { absPath: string; block?: string; heading?: string }),
  };
  Object.assign(api, nativeHostMethodTable(nativeHost));
  Object.assign(api, grabMethodTable({
    enumerateSources: () => enumerateGrabSources(),
    runRendererCommand: async (id) => {
      if (!win || win.isDestroyed()) return { ok: false, code: 'RENDERER_UNAVAILABLE', commandId: id, message: 'main window not available' };
      const js = `(async () => { const k = window.__kb; if (!k || typeof k.runCommandResult !== 'function') return { ok: false, code: 'RENDERER_UNAVAILABLE', commandId: ${JSON.stringify(id)}, message: 'window.__kb.runCommandResult not available' }; return await k.runCommandResult(${JSON.stringify(id)}); })()`;
      return await win.webContents.executeJavaScript(js, false);
    },
  }));
  ipcMain.on('kb:web-bounds', (event, viewId: string, bounds: WebBounds | null) => {
    if (!win || event.sender !== win.webContents) return;
    const id = String(viewId);
    const next = bounds && typeof bounds === 'object' && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ? bounds : null;
    if (extBrowse?.has(id)) {
      extBrowse.setBounds(id, next);
      return;
    }
    webPanels?.setBounds(id, next);
  });
  ipcMain.on('kb:startup-mark', (event, name: unknown, wall: unknown) => {
    if (!win || event.sender !== win.webContents || typeof name !== 'string' || !/^[a-z0-9:-]{1,48}$/.test(name)) return;
    startupMark(`renderer:${name}`, 'renderer', typeof wall === 'number' && Number.isFinite(wall) ? wall : Date.now());
    if (name === 'interactive') tellInteractive('interactive');
    if (name === 'visible-content-loaded' || name === 'visible-content-timeout') {
      try { if (win && !win.isDestroyed()) win.webContents.setBackgroundThrottling(true); } catch { /* ignore */ }
      traceGates.visible = true;
      maybeFinishTrace();
      if (name === 'visible-content-timeout') void offerBlankWindowRecovery('renderer-visible-content-timeout');
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
  ipcMain.on(NATIVE_DRAG_START_CHANNEL, (event, payload: unknown) => {
    const result = handleNativeDragIpc({
      payload,
      allowed: !!(win && !win.isDestroyed() && event.sender === win.webContents),
      controller: nativeDrag,
      icon: () => dragIcon(),
      startDrag: (files, icon) => {
        event.sender.startDrag({ file: files[0]!, files, icon });
      },
      notifyEnded: () => {
        try { event.sender.send(NATIVE_DRAG_ENDED_CHANNEL); } catch { /* 发送方已销毁 */ }
      },
    });
    if (nativeDragWantsSyncReply(payload)) event.returnValue = result;
    void refreshNativeDragAllow();
  });
  ipcMain.on('kb:native-drag-log', (event) => {
    if (!win || win.isDestroyed() || event.sender !== win.webContents) {
      event.returnValue = [];
      return;
    }
    event.returnValue = nativeDrag.readLog();
  });
  ipcMain.handle('kb:native-drag-prepare', async (event) => {
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return { ok: false };
    await refreshNativeDragAllow();
    return { ok: true };
  });
  void refreshNativeDragAllow();
  registerSidebarWindow(() => win, { get: key => plane!.call('getLayout', [key]), set: (key, value) => plane!.call('setLayout', [key, value]) }, () => webPanels?.suspendForSidebar(), () => webPanels?.resumeFromSidebar());
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

import { once, protocolNotReady } from './protocolGate';
let protocolRegistered = false;
const registerProtocolOnce = once(() => registerProtocolImpl());
function registerProtocol() {
  if (protocolRegistered) return;
  protocolRegistered = true;
  registerProtocolOnce();
  startupMark('main:protocol-registered');
}
function registerProtocolImpl() {
  protocol.handle('kbfile', async (req) => {
    try {
      const notReady = protocolNotReady(rendererReady && !!plane);
      if (notReady) return notReady;
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
      const notReadyP = protocolNotReady(rendererReady && !!plane, headers);
      if (notReadyP) return notReadyP;
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

function pushPort(force = false) {
  if (!win || win.isDestroyed() || !plane) return;
  // startup-ready-race: a port claimed before the data plane is ready can be silently dropped (calls hang => blank sidebar).
  if (!rendererReady && !force) return;
  if (portPushedForLoad && !force) return;
  portPushedForLoad = true;
  const port = plane.claimRendererPort();
  win.webContents.postMessage('kb:data-port', {}, [port]);
}

function createWindow(saved: { width?: number; height?: number; x?: number; y?: number } | null) {
  const wa = (saved?.x !== undefined ? screen.getDisplayMatching({ x: saved.x, y: saved.y ?? 0, width: 100, height: 100 }) : screen.getPrimaryDisplay()).workArea;
  const width = Math.min(saved?.width ?? 1400, wa.width);
  const height = Math.min(saved?.height ?? 900, wa.height);
  const inside = saved?.x !== undefined && saved.x >= wa.x && saved.x + width <= wa.x + wa.width && (saved.y ?? 0) >= wa.y && (saved.y ?? 0) + height <= wa.y + wa.height;
  win = new BrowserWindow({
    show: false,
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
    extBrowse?.destroyAll();
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
    if (details.isMainFrame && !details.isSameDocument) {
      webPanels?.destroyAll();
      extBrowse?.destroyAll();
    }
  });
  win.on('closed', () => { webPanels?.destroyAll(); extBrowse?.destroyAll(); stallNote('window-closed'); win = null; });
  // desk-r1 A: fullscreen presentation → capture pause/resume
  win.on('enter-full-screen', () => { void onHostPresentationEvent('enter-fullscreen', win); });
  win.on('leave-full-screen', () => { void onHostPresentationEvent('leave-fullscreen', win); });
  stallNote('createWindow:constructed');
  // startup-ready-race v3: window may be occluded during startup; keep rAF/timers running until visible content settles.
  try { win.webContents.setBackgroundThrottling(false); } catch { /* ignore */ }
  startupMark('window:created');
  const current = win;
  let presented = false;
  const present = () => {
    if (presented || current.isDestroyed()) return;
    presented = true;
    clearTimeout(presentTimer);
    current.show();
    if (current.isDestroyed()) return;
    const bounds = current.getBounds();
    const plan = presentPlan({ ...bounds, minimized: current.isMinimized() }, screen.getDisplayMatching(bounds).workArea);
    if (plan.restore) current.restore();
    if (current.isDestroyed()) return;
    current.setBounds(plan.bounds);
    // 宽度加一再还原，强制 Windows 重新呈现 DirectComposition 表面。
    if (plan.nudge) {
      current.setBounds({ ...plan.bounds, width: plan.bounds.width + 1 });
      current.setBounds(plan.bounds);
    }
    if (!current.isDestroyed() && !current.webContents.isDestroyed()) current.webContents.invalidate();
  };
  const presentTimer = setTimeout(present, 3000);
  current.once('closed', () => clearTimeout(presentTimer));
  current.once('ready-to-show', () => {
    startupMark('window:ready-to-show');
    present();
  });
  win.webContents.on('did-start-loading', () => stallNote('did-start-loading'));
  win.webContents.on('did-fail-load', (_event, code, desc, url, isMainFrame) => {
    if (isMainFrame) stallNote(`did-fail-load ${code} ${desc} ${url}`);
  });
  win.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) portPushedForLoad = false;
  });
  win.webContents.on('did-finish-load', () => { pageLoadedOnce = true; bumpBlankWatchdogBase(); pushPort(); });
  win.webContents.once('did-finish-load', () => startupMark('window:did-finish-load'));
  win.webContents.once('did-finish-load', () => {
    updater?.noteWindowLoaded();
    if (process.env.KB_TEST_FREEZE_RENDERER === '1') {
      (globalThis as { __kbRendererFreezeStarted?: boolean }).__kbRendererFreezeStarted = true;
      console.log('[update] renderer freeze');
      void win?.webContents.executeJavaScript('while(true){}').catch(() => undefined);
    }
  });
  if (win.isVisible()) {
    startupMark('window:shown');
    armBlankWindowWatchdog();
  } else {
    win.once('show', () => {
      startupMark('window:shown');
      armBlankWindowWatchdog();
    });
  }
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

/** 主窗 show 后可见内容仍未就绪时的恢复超时（与 renderer VisibleContentTracker 15s 对齐并留余量） */
const BLANK_WINDOW_TIMEOUT_MS = 25_000;
let blankRecoveryShown = false;
let blankWatchdogArmed = false;

function writeBlankWindowDiag(reason: string) {
  const dataDir = app.getPath('userData');
  const body = {
    at: new Date().toISOString(),
    reason,
    execPath: process.execPath,
    userData: dataDir,
    formalInstall: isFormalInstallPath(process.execPath),
    marks: startupMarks(),
    summary: {
      windowShownMs: startupMarks().find((m) => m.name === 'window:shown')?.ms ?? null,
      interactiveMs: startupMarks().find((m) => m.name === 'renderer:interactive')?.ms ?? null,
      visibleContentLoadedMs: startupMarks().find((m) => m.name === 'renderer:visible-content-loaded')?.ms ?? null,
      visibleContentTimedOut: startupMarks().some((m) => m.name === 'renderer:visible-content-timeout'),
    },
  };
  try {
    fs.writeFileSync(path.join(dataDir, 'blank-window-diag.json'), JSON.stringify(body, null, 2));
  } catch {
    /* 诊断写失败不挡主流程 */
  }
  stallNote(`blank-window-diag ${reason}`);
}

function injectBlankWindowBanner(reason: string) {
  if (!win || win.isDestroyed()) return;
  const safe = JSON.stringify(String(reason || 'timeout'));
  const js = `(function(){
    try {
      var id='kb-blank-window-recovery';
      if (document.getElementById(id)) return;
      var bar=document.createElement('div');
      bar.id=id;
      bar.setAttribute('role','alert');
      bar.style.cssText='position:fixed;z-index:2147483647;left:12px;right:12px;top:12px;padding:12px 14px;border-radius:8px;background:#5c1a1a;color:#ffe8e8;font:13px/1.45 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.45);display:flex;gap:12px;align-items:center;';
      bar.innerHTML='<div style="flex:1">窗口内容加载超时（可见内容未就绪）。可重新加载，或关闭本提示后继续等待。</div>';
      var reload=document.createElement('button');
      reload.textContent='重新加载';
      reload.style.cssText='border:0;border-radius:6px;padding:6px 12px;background:#f3f3f3;color:#222;cursor:pointer;font-weight:600';
      reload.onclick=function(){ location.reload(); };
      var dismiss=document.createElement('button');
      dismiss.textContent='关闭';
      dismiss.style.cssText='border:0;border-radius:6px;padding:6px 12px;background:#7a3030;color:#fff;cursor:pointer';
      dismiss.onclick=function(){ bar.remove(); };
      bar.appendChild(reload);
      bar.appendChild(dismiss);
      (document.body||document.documentElement).appendChild(bar);
      console.warn('[blank-window]', ${safe});
    } catch (e) { console.error('[blank-window] banner failed', e); }
  })();`;
  void win.webContents.executeJavaScript(js, true).catch(() => undefined);
}

async function offerBlankWindowRecovery(reason: string) {
  if (blankRecoveryShown) return;
  const loaded = startupMarks().some((m) => m.name === 'renderer:visible-content-loaded');
  if (loaded) return;
  blankRecoveryShown = true;
  if (!startupMarks().some((m) => m.name === 'renderer:visible-content-timeout')) {
    startupMark('renderer:visible-content-timeout', 'renderer');
  }
  traceGates.visible = true;
  maybeFinishTrace();
  writeBlankWindowDiag(reason);
  // 页内错误条：不抢其他应用前台；dialog 挂到已有主窗
  injectBlankWindowBanner(reason);
  const opts = {
    type: 'warning' as const,
    buttons: ['重新加载', '继续等待'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: APP_DISPLAY_NAME,
    message: '窗口内容加载超时',
    detail: '主窗口已显示，但可见内容未在时限内就绪（visibleContentLoadedMs 仍为空）。可重新加载 renderer，或继续等待后台完成。诊断已写入 userData/blank-window-diag.json。',
  };
  try {
    if (!win || win.isDestroyed()) return;
    const picked = await dialog.showMessageBox(win, opts);
    if (picked.response === 0 && win && !win.isDestroyed()) {
      blankRecoveryShown = false;
      blankWatchdogArmed = false;
      win.webContents.once('did-finish-load', () => armBlankWindowWatchdog());
      win.webContents.reload();
    }
  } catch (err) {
    console.error('[blank-window] recovery dialog failed', err);
  }
}

/** startup-ready-race: watchdog window starts at the later of plane-ready signal and page did-finish-load. */
let watchdogBaseAt = Date.now();
function bumpBlankWatchdogBase() { watchdogBaseAt = Date.now(); }
/** startup-ready-race v2: page has finished loading at least once; until then a slow renderer start is not a blank window. */
let pageLoadedOnce = false;
const BLANK_WINDOW_HARD_CAP_MS = 120000;
function armBlankWindowWatchdog() {
  if (blankWatchdogArmed) return;
  blankWatchdogArmed = true;
  watchdogBaseAt = Date.now();
  const armedAt = Date.now();
  const fire = () => {
    if (!pageLoadedOnce && Date.now() - armedAt < BLANK_WINDOW_HARD_CAP_MS) { setTimeout(fire, 2000).unref?.(); return; }
    const left = BLANK_WINDOW_TIMEOUT_MS - (Date.now() - watchdogBaseAt);
    if (left > 500) { setTimeout(fire, left).unref?.(); return; }
    const loaded = startupMarks().some((m) => m.name === 'renderer:visible-content-loaded');
    if (loaded) return;
    // startup-ready-race: the timeout is measured from data-plane readiness, not from window show.
    if (!rendererReady) { blankWatchdogArmed = false; return; }
    void offerBlankWindowRecovery('main-watchdog-after-show');
  };
  setTimeout(fire, BLANK_WINDOW_TIMEOUT_MS).unref?.();
}


if (process.platform === 'win32') app.setAppUserModelId('local.kb.workbench');
app.setAboutPanelOptions({ applicationName: APP_DISPLAY_NAME, applicationVersion: app.getVersion() });

app.whenReady().then(async () => {
  startupMark('app:ready');
  installEditContextMenu();
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
  obsidian().start();
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
    pushPort(true);
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
  // startup-ready-race: queryable readiness, registered before the window exists so the renderer can never miss it.
  ipcMain.handle('kb:plane-ready-state', () => ({ ready: rendererReady }));
  // imgfix: register kbfile:/kbplugin: before the window navigates (503 until ready), else ERR_UNKNOWN_URL_SCHEME for that page.
  registerProtocol();
  // startup-ipc P0 (fd6724a, re-applied by overlay): open window before awaiting data plane ready
  stallNote('fd6724a, re-applied');
  createWindow(readBoundsFile(dataDir));

  let info: DataReady;
  try {
    info = await plane.ready;
    // test-only knob: widen the plane-ready window to reproduce the cold-start race deterministically
    const testDelay = Number(process.env.KB_TEST_PLANE_READY_DELAY_MS || 0);
    if (testDelay > 0) { startupMark('test:plane-ready-delay'); await new Promise((r) => setTimeout(r, testDelay)); }
  } catch (err) {
    const message = errorText(err);
    console.error('[data] 数据库或迁移失败', err);
    await bootUpdater(dataDir, { dbOpened: false, migrationOk: false, windowLoaded: false, dbError: message, migrationError: message });
    // Window already created; do not leave user on a no-window failure path.
    return;
  }
  startupMark('main:workbench-ready');
  applyReady(info);
  if (info.window && typeof info.window.width === 'number' && win && !win.isDestroyed()) {
    const cur = win.getBounds();
    const next = info.window;
    if (next.width !== cur.width || next.height !== cur.height || next.x !== cur.x || next.y !== cur.y) {
      win.setBounds({
        width: next.width,
        height: next.height,
        ...(typeof next.x === 'number' ? { x: next.x } : {}),
        ...(typeof next.y === 'number' ? { y: next.y } : {}),
      });
    }
  }
  startupMark('main:service-open');
  if (process.env.KB_PERF_BOUNDS === '1') {
    const heapBeat = setInterval(() => {
      try { stallNote(perfMemLine()); } catch (err) { stallNote(`mem-error ${errorText(err)}`); }
    }, 2000);
    heapBeat.unref?.();
  }
  siteGrants = new WebSiteGrantStore(path.join(dataDir, WEB_SITE_GRANT_FILE));
  await siteGrants.load();
  extBrowse = new ExternalBrowseHost(() => win, siteGrants, (ev) => send('kb:ext-browse', ev));
  webPanels = new WebPanelManager(() => win, {
    webAccess: (pluginId, adapterId) => mirror.webAccess(pluginId, adapterId),
    webPlugins: () => mirror.webPlugins(),
    onGrantsChanged: (cb) => mirror.onGrantsChanged(cb),
    audit: (pluginId, adapterId, kind: AuditKind, detail, code) => {
      void plane?.call('plugin.audit', [pluginId, adapterId, kind, detail, code ?? null]).catch((err) => console.error('[web] 审计写入失败', err));
    },
  }, (ev) => send('kb:web-event', ev), kv, siteGrants);
  webPanels.setExternalOpener((url) => send('kb:ext-browse', { type: 'open', url }));
  (globalThis as { __kbWeb?: WebPanelManager }).__kbWeb = webPanels;
  webPanels.setBoundShortcuts([...boundShortcutKeys]);
  registerIpc();
  registerDesktopCaptureIpc(); // desk-r1 A：画面捕获 IPC
  registerDesktopSourceEnumerateIpc(); // desk-r1 B: desktopPanel.source.enumerate
  registerDesktopCaptureUiIpc(); // GrabFrame close: panel uiStart/uiStop (raise:false stub gate)
  registerDesktopInputIpc(); // desk-input: panel real click + enter mode (validated, user-initiated only)
  registerMigration({ call: (method, ...args) => plane!.call(method, args), getMainWindow: () => win });
  registerProtocol();
  rendererReady = true;
  startupMark('main:renderer-ready-signal');
  pushPort();
  send('kb:plane-ready', { ready: true });
  // blank-window watchdog counts from here (it stood down while the plane was not ready).
  bumpBlankWatchdogBase();
  if (win && !win.isDestroyed() && !blankWatchdogArmed) armBlankWindowWatchdog();
  await bootUpdater(dataDir, { dbOpened: true, migrationOk: true, windowLoaded: false });
  // did-finish-load may have run before plane ready; push port now that plane is up.
  pushPort();
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
    extBrowse?.destroyAll();
    obsidianBridge?.stop();
    if (plane) await plane.stop();
    if (userDataPath) await finishInstance(userDataPath);
    if (install) await updater?.spawnQuitInstall();
    console.log('[shutdown] databases closed; exiting');
    app.exit(0);
  })().catch((error) => console.error('[shutdown] failed', error));
});
app.on('window-all-closed', () => app.quit());
