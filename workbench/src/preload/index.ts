import { REBIRTH_METHODS, REBIRTH_CHANGED_CHANNEL } from '../shared/rebirth';
import { contextBridge, ipcRenderer } from 'electron';
import { CONTEXT_MENU_HANDLED_CHANNEL } from '../shared/editContextMenu';
import type { KbApi } from '../shared/types';
import { MAIN_METHOD_SET } from '../shared/dataMethods';
import { AGENT_PANEL_METHODS } from '../shared/agentPanel';
import { WORKSPACE_SNAPSHOT_CAPTURE_CHANNEL, WORKSPACE_SNAPSHOT_DELETE_CHANNEL, WORKSPACE_SNAPSHOT_LOAD_CHANNEL } from '../shared/workspacePicker/snapshotCapture';
import { exposeDesktopPanelWithCapture } from './desktopPanelPreload'; // desk-r1 A GrabFrame

let port: MessagePort | null = null;
let callSeq = 1;
const pendingCalls = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

function usePort(next: MessagePort) {
  const previous = port;
  port = next;
  for (const item of pendingCalls.values()) item.reject(new Error('数据进程已重连'));
  pendingCalls.clear();
  previous?.close();
  next.onmessage = (ev: MessageEvent) => {
    const msg = ev.data as { t?: string; id?: number; ok?: boolean; value?: unknown; error?: string };
    if (msg?.t !== 'result' || typeof msg.id !== 'number') return;
    const item = pendingCalls.get(msg.id);
    if (!item) return;
    pendingCalls.delete(msg.id);
    if (msg.ok) item.resolve(msg.value);
    else item.reject(new Error(msg.error || '数据进程调用失败'));
  };
  next.start();
}

// startup-ready-race: the window opens before the data plane is ready (fd6724a). Every call waits for readiness,
// learned both by subscription (kb:plane-ready) and by active query (kb:plane-ready-state), so a missed push cannot hang it.
let planeReady = false;
const readyWaiters: Array<() => void> = [];
function markPlaneReady() {
  if (planeReady) return;
  planeReady = true;
  for (const fn of readyWaiters.splice(0)) fn();
}
ipcRenderer.on('kb:plane-ready', () => markPlaneReady());
function pollReady(delay: number) {
  if (planeReady) return;
  ipcRenderer.invoke('kb:plane-ready-state').then((s: { ready?: boolean } | null) => {
    if (s?.ready) markPlaneReady();
    else setTimeout(() => pollReady(Math.min(delay * 2, 1000)), delay);
  }, () => setTimeout(() => pollReady(Math.min(delay * 2, 1000)), delay));
}
pollReady(100);
function whenReady(): Promise<void> {
  return planeReady ? Promise.resolve() : new Promise((resolve) => readyWaiters.push(resolve));
}
const NO_HANDLER = /No handler registered/;
/** invoke after readiness; a call that hit a not-yet-registered handler never ran, so retrying it is safe. */
async function readyInvoke(channel: string, ...args: unknown[]): Promise<unknown> {
  await whenReady();
  for (let attempt = 0; ; attempt++) {
    try {
      return await ipcRenderer.invoke(channel, ...args);
    } catch (err) {
      if (attempt >= 20 || !NO_HANDLER.test(String((err as Error)?.message ?? err))) throw err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

ipcRenderer.on('kb:data-port', (event) => {
  const next = event.ports?.[0];
  if (next) usePort(next);
});

async function callData(method: string, args: unknown[]) {
  await whenReady();
  const current = port;
  if (!current) return readyInvoke('kb', method, ...args);
  return new Promise((resolve, reject) => {
    const id = callSeq++;
    pendingCalls.set(id, { resolve, reject });
    current.postMessage({ t: 'call', id, method, args });
  });
}
const methods = [
  'pickFolder', 'pickFile', 'readUtf8File', 'listRoots', 'addRoot', 'addFileSource', 'createBlankFile', 'removeRoot',
  'detachRoot', 'deleteRootFolder', 'trashInsideRoot', 'hideFromRoot', 'restoreHidden', 'restoreAllHidden', 'listHiddenItems', 'listRootTasks', 'cancelRootTask', 'retryRootTask', 'restoreRoot',
  'remapRoot', 'listFavorites', 'addFavorite', 'removeFavorite',
  'listDir', 'listDirAbs', 'getShowIgnored', 'setShowIgnored', 'getResource', 'resourceAbsPath', 'rootWorkspace', 'readText', 'rescan', 'cancelScan', 'search', 'searchGrouped', 'opsPropose', 'opsPending', 'opsGet', 'opsReview', 'opsApprove', 'opsReject', 'agentInfo', 'getLayout', 'setLayout', 'getIndexStatus',
  // ---- r11-E
  'getIndexHealth', 'debugDualDbCheck', 'indexRebuild',
  'listOps', 'opsView', 'opUndo', 'opRestoreBackup', 'showInFolder', 'openWithDefaultApp', 'registerPlugin', 'listPlugins', 'setPluginEnabled',
  'getDevMode', 'setDevMode', 'listAdapterPlugins', 'installAdapterPluginFromFolder', 'listPluginCatalog', 'installPluginFromCatalog', 'setPluginCatalogUrl', 'setAdapterPluginEnabled', 'setPermissionGrant',
  'revokePermission', 'pluginFile', 'mintPluginFileToken', 'releasePluginFileToken', 'adapterStorage', 'adapterUninstallInfo',
  'uninstallAdapterPlugin', 'planPreview', 'planExecute', 'planDiscard', 'listPluginAudit', 'recordPluginEvent', 'killPluginFrames', 'pluginProcesses',
  'pluginStorageGet', 'pluginStorageSet',
  'appProfileCreate', 'appProfileGet', 'appDetect', 'appLaunch', 'appList', 'appFocus', 'appClose', 'appPendingChanges', 'appUndoExternal', 'openMigration', 'openAgentPicker',
  'webCreate', 'webDestroy', 'webNavigate', 'webBack', 'webForward', 'webReload', 'webGetScroll', 'webSetScroll', 'webGetZoom', 'webSetZoom', 'webSnapshot', 'webClearSessionData', 'clearPluginSiteData', 'webOpenExternal', 'webSiteApply', 'webSiteList',
  'extBrowseCreate', 'extBrowseDestroy', 'extBrowseNavigate', 'extBrowseBack', 'extBrowseReload', 'extBrowseOpenSystem', 'extBrowseSnapshot',
  'listWorkspaces', 'getWorkspace', 'createWorkspace', 'saveWorkspaceLayout', 'updateWorkspace', 'deleteWorkspace',
  'listWorkspaceRefs', 'addWorkspaceRefs', 'removeWorkspaceRef', 'workspacesReferencing',
  'listVirtualFolders', 'createVirtualFolder', 'renameVirtualFolder', 'deleteVirtualFolder', 'moveVirtualFolder',
  'setVfolderMembership', 'listVfolderMembership', 'listVfolderView', 'removeVfolderMembership',
  'classifyByType', 'undoVfolderClassify', 'vfolderUndoAvailable', 'rememberWebStub',
  'getCurrentWorkspaceId', 'setCurrentWorkspace', 'exportWorkspaceToFile', 'importWorkspaceFromFile',
  'agentLiveList', 'agentLiveAdd', 'agentLiveAddMany', 'agentLiveRemove', 'agentLiveReorder', 'agentLiveSetPurpose',
  'agentLivePin', 'agentLiveUnpin', 'agentLiveClearSession', 'agentLiveRelocate', 'agentLiveEntryPath', 'agentLiveNoteScene',
  'agentLivePlaybookGet', 'agentLivePlaybookSet', 'agentLivePlaybookGuess', 'agentLiveMaterialPlace',
  'agentLiveStartDrag',
  'aiWriteSettingsGet', 'aiWriteSettingsSet', 'aiWriteSyncRoots', 'aiWritePending', 'aiWriteApprove', 'aiWriteReject', 'aiWriteConflictResolve',
  'aiWriteLinksGet', 'aiWriteLinksAdd', 'aiWriteLinksRemove', 'aiWriteLinksClear', 'aiWriteLinkStatus',
  'aiWriteCollect', 'aiWriteApply', 'aiWriteSessionDiscard', 'aiWriteLegacyStages', 'aiWriteLegacyStageTrash', 'aiWritePlanDrop',
  'agentMarksList', 'agentMarksAdd', 'agentMarksUnmark', 'agentMarksClear', 'agentMarksRetention', 'agentMarksSetRetention', 'agentMarksEligible',
  ...AGENT_PANEL_METHODS,
  ...REBIRTH_METHODS,
  'textOpen', 'textStat', 'textPreviewSave', 'textSave', 'textHistory', 'textUndoLastSave',
  'listThemePacks', 'installThemePackFromFolder', 'getStartupTrace',
  // ---- r11-F 控制台
  'consoleWriteDraft', 'consoleResolvePath',
  // ---- r11-B 自定义快捷键
  'setBoundShortcuts',
  // ---- r11-A 网络资料
  'webResourceAdd', 'webResourceUpdate', 'webResourceGet', 'webResourceGetByUrl', 'webResourceList', 'webResourceRemove',
  'webFetchCache', 'webGrantSite', 'webRevokeSite', 'webGrantedSites', 'webPageInfo', 'webSaveToLocal',
  // ---- r11-A 网络资料 end
  // ---- r12 自动升级
  'updateState', 'aboutInfo', 'updateCheck', 'updateSaveSettings', 'updateApply',
  'host.list', 'host.attach', 'host.detach', 'host.setBounds', 'host.setVisible', 'host.activate', 'host.getState', 'host.screenToPanel', 'host.panelToScreen',
  // host-r1 L2: GrabFrame runtime entry (main-routed like host.*)
  'grab.open', 'grab.pickSource',
  'obsidianBridgeGet', 'obsidianBridgeSetVault', 'obsidianBridgeInit', 'obsidianBridgeSetJunction', 'obsidianOpen',
] as const;

const api: Record<string, unknown> = {};
api.sidebarWindow = (request: import('../shared/sidebarWindow').SidebarWindowRequest) => readyInvoke('kb:sidebar-window', request);
for (const m of methods) api[m] = (...args: unknown[]) => (MAIN_METHOD_SET.has(m) ? readyInvoke('kb', m, ...args) : callData(m, args));
api.rebirthDragOut = (input: {id:string}) => { ipcRenderer.send('kb:rebirth-drag', input); return true; };
api.onRebirthChanged = (cb: () => void) => { const h = () => cb(); ipcRenderer.on(REBIRTH_CHANGED_CHANNEL,h); return () => ipcRenderer.removeListener(REBIRTH_CHANGED_CHANNEL,h); };
api.isDataReady = () => planeReady;
api.whenDataReady = () => whenReady();
api.onFsChange = (cb: (e: unknown) => void) => {
  const h = (_: unknown, e: unknown) => cb(e);
  ipcRenderer.on('kb:fs-change', h);
  return () => ipcRenderer.removeListener('kb:fs-change', h);
};
// r11-C：自建目录是全局的；工作资料引用按工作区通知。
api.onVfoldersChange = (cb: () => void) => {
  const h = () => cb();
  ipcRenderer.on('kb:vfolders-change', h);
  return () => ipcRenderer.removeListener('kb:vfolders-change', h);
};
api.onRefsChange = (cb: (e: { workspaceId: string }) => void) => {
  const h = (_: unknown, e: { workspaceId: string }) => cb(e ?? { workspaceId: '' });
  ipcRenderer.on('kb:refs-change', h);
  return () => ipcRenderer.removeListener('kb:refs-change', h);
};
api.onIndexStatus = (cb: (e: unknown) => void) => {
  const h = (_: unknown, e: unknown) => cb(e);
  ipcRenderer.on('kb:index-status', h);
  return () => ipcRenderer.removeListener('kb:index-status', h);
};
api.onRootTasks = (cb: (e: unknown) => void) => {
  const h = (_: unknown, e: unknown) => cb(e);
  ipcRenderer.on('kb:root-tasks', h);
  return () => ipcRenderer.removeListener('kb:root-tasks', h);
};
api.onIndexHealth = (cb: (e: unknown) => void) => {
  const h = (_: unknown, e: unknown) => cb(e);
  ipcRenderer.on('kb:index-health', h);
  return () => ipcRenderer.removeListener('kb:index-health', h);
};

api.onMenuCommand = (cb: (id: string) => void) => {
  const h = (_: unknown, id: unknown) => typeof id === 'string' && cb(id);
  ipcRenderer.on('kb:menu-command', h);
  return () => ipcRenderer.removeListener('kb:menu-command', h);
};
// ---- r11-B：网页面板转发的已绑定组合键
api.onForwardedShortcut = (cb: (accel: string) => void) => {
  const h = (_: unknown, accel: unknown) => typeof accel === 'string' && cb(accel);
  ipcRenderer.on('kb:forwarded-shortcut', h);
  return () => ipcRenderer.removeListener('kb:forwarded-shortcut', h);
};
api.onKeybindingsChange = (cb: () => void) => {
  const h = () => cb();
  ipcRenderer.on('kb:keybindings-change', h);
  return () => ipcRenderer.removeListener('kb:keybindings-change', h);
};
// marks sent before the main listener exists were silently dropped (lost visible-content-loaded => false timeout); queue until ready.
api.startupMark = (name: string, wall?: number) => {
  const at = wall ?? Date.now();
  void whenReady().then(() => ipcRenderer.send('kb:startup-mark', name, at));
};
api.setWindowChrome = (colors: { color?: unknown; symbolColor?: unknown }) => {
  const color = colors?.color;
  const symbolColor = colors?.symbolColor;
  if (typeof color !== 'string' || typeof symbolColor !== 'string') return Promise.resolve();
  return readyInvoke('kb:set-window-chrome', { color, symbolColor });
};
function nativeDragPaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) return [];
  return paths.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}
// 测试和旧调用仍走 sendSync。界面拖出用 postNativeFileDrag：startDrag 在 Windows 上阻塞到放下，不能卡在同步 IPC 里。
api.startNativeDrag = (paths: unknown, mode?: unknown) => {
  const body = { paths: nativeDragPaths(paths), mode: mode === 'path' ? 'path' : 'file', sync: true as const };
  try {
    return ipcRenderer.sendSync('kb:native-drag-start', body);
  } catch {
    return { ok: false, reason: 'ipc', paths: body.paths };
  }
};
api.postNativeFileDrag = (paths: unknown) => {
  const body = { paths: nativeDragPaths(paths), mode: 'file' as const };
  try { ipcRenderer.send('kb:native-drag-start', body); } catch { /* 通道还没挂上 */ }
};
api.onNativeDragEnded = (cb: () => void) => {
  const handler = () => cb();
  ipcRenderer.on('kb:native-drag-ended', handler);
  return () => ipcRenderer.removeListener('kb:native-drag-ended', handler);
};
api.nativeDragLog = () => {
  try {
    const rows = ipcRenderer.sendSync('kb:native-drag-log');
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
};
api.prepareNativeDrag = () => readyInvoke('kb:native-drag-prepare');
api.captureWorkspaceSnapshot = (input: unknown) => readyInvoke(WORKSPACE_SNAPSHOT_CAPTURE_CHANNEL, input);
api.loadWorkspaceSnapshots = (workspaceIds: unknown) => readyInvoke(WORKSPACE_SNAPSHOT_LOAD_CHANNEL, workspaceIds);
api.deleteWorkspaceSnapshots = (relativeNames: unknown) => readyInvoke(WORKSPACE_SNAPSHOT_DELETE_CHANNEL, relativeNames);
api.noteLongTask = (ms: number) => {
  if (typeof ms === 'number' && Number.isFinite(ms)) ipcRenderer.send('kb:long-task', ms);
};
if (process.env.KB_PERF_BOUNDS === '1') {
  api.perfBounds = () => ipcRenderer.invoke('kb:perf-bounds');
  api.perfSample = () => ipcRenderer.invoke('kb:perf-sample');
  api.perfGc = () => ipcRenderer.invoke('kb:perf-gc');
}
api.sendWebBounds = (viewId: string, b: unknown) => ipcRenderer.send('kb:web-bounds', viewId, b);
api.onWebEvent = (cb: (e: unknown) => void) => {
  const h = (_: unknown, e: unknown) => cb(e);
  ipcRenderer.on('kb:web-event', h);
  return () => ipcRenderer.removeListener('kb:web-event', h);
};
api.onExtBrowse = (cb: (e: unknown) => void) => {
  const h = (_: unknown, e: unknown) => cb(e);
  ipcRenderer.on('kb:ext-browse', h);
  return () => ipcRenderer.removeListener('kb:ext-browse', h);
};

// ---- r11-A 网络资料
api.onWebResourcesChange = (cb: (e: unknown) => void) => {
  const h = (_: unknown, e: unknown) => cb(e);
  ipcRenderer.on('kb:web-resources-change', h);
  return () => ipcRenderer.removeListener('kb:web-resources-change', h);
};
// ---- r11-A 网络资料 end

api.onUpdate = (cb: (e: unknown) => void) => {
  const h = (_: unknown, e: unknown) => cb(e);
  ipcRenderer.on('kb:update', h);
  return () => ipcRenderer.removeListener('kb:update', h);
};

api.onAppEvent = (cb: (e: unknown) => void) => {
  const h = (_: unknown, e: unknown) => cb(e);
  ipcRenderer.on('kb:app-event', h);
  return () => ipcRenderer.removeListener('kb:app-event', h);
};

// ---- r11-G 文件 Agent 桥。主进程 send 的频道就是事件名，载荷是打开参数或 { commandId }。
api.onAgentBridgeOpen = (cb: (payload: unknown) => void) => {
  const h = (_: unknown, payload: unknown) => cb(payload);
  ipcRenderer.on('kb:agent-bridge-open', h);
  return () => ipcRenderer.removeListener('kb:agent-bridge-open', h);
};
api.onAgentLiveChanged = (cb: (workspaceId: string) => void) => {
  const h = (_: unknown, payload: { workspaceId?: string } | undefined) => {
    if (payload?.workspaceId) cb(payload.workspaceId);
  };
  ipcRenderer.on('kb:agent-live', h);
  return () => ipcRenderer.removeListener('kb:agent-live', h);
};
api.onAgentBridgeInvoke = (cb: (payload: { commandId?: string; actionId?: string; args?: unknown }) => void) => {
  const h = (_: unknown, payload: unknown) => cb((payload ?? {}) as { commandId?: string; actionId?: string; args?: unknown });
  ipcRenderer.on('kb:agent-bridge-invoke', h);
  return () => ipcRenderer.removeListener('kb:agent-bridge-invoke', h);
};

api.onDataReset = (cb: () => void) => {
  const handler = () => cb();
  ipcRenderer.on('kb:data-reset', handler);
  return () => ipcRenderer.removeListener('kb:data-reset', handler);
};

api.onBeforeQuit = (cb: () => Promise<void>) => {
  const h = async () => {
    try {
      await cb();
    } finally {
      ipcRenderer.send('kb:flush-done');
    }
  };
  ipcRenderer.on('kb:before-quit', h);
  return () => ipcRenderer.removeListener('kb:before-quit', h);
};

contextBridge.exposeInMainWorld('kb', api as unknown as KbApi);

// 自定义右键已经 preventDefault 时同步打标。主进程若仍收到 context-menu，就不再弹编辑菜单。
// 可编辑区不 preventDefault，因此不会打标，编辑菜单照常出现。
window.addEventListener('contextmenu', (event) => {
  if (!event.defaultPrevented) return;
  ipcRenderer.sendSync(CONTEXT_MENU_HANDLED_CHANNEL);
});

// desk-r1 A: mount desktopPanel.capture (day-merge has no B desktopPanel yet).
// INTEGRATOR with B: use getDesktopPanelCaptureSubtree() and merge instead of this call.
exposeDesktopPanelWithCapture();

