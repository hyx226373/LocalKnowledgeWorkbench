import { contextBridge, ipcRenderer } from 'electron';
import type { KbApi } from '../shared/types';
import { MAIN_METHOD_SET } from '../shared/dataMethods';
import { WORKSPACE_SNAPSHOT_CAPTURE_CHANNEL } from '../shared/workspacePicker/snapshotCapture';

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

ipcRenderer.on('kb:data-port', (event) => {
  const next = event.ports?.[0];
  if (next) usePort(next);
});

function callData(method: string, args: unknown[]) {
  const current = port;
  if (!current) return ipcRenderer.invoke('kb', method, ...args);
  return new Promise((resolve, reject) => {
    const id = callSeq++;
    pendingCalls.set(id, { resolve, reject });
    current.postMessage({ t: 'call', id, method, args });
  });
}
const methods = [
  'pickFolder', 'pickFile', 'listRoots', 'addRoot', 'addFileSource', 'removeRoot',
  'detachRoot', 'deleteRootFolder', 'listRootTasks', 'cancelRootTask', 'retryRootTask', 'restoreRoot',
  'remapRoot', 'listFavorites', 'addFavorite', 'removeFavorite',
  'listDir', 'getShowIgnored', 'setShowIgnored', 'getResource', 'resourceAbsPath', 'rootWorkspace', 'readText', 'rescan', 'cancelScan', 'search', 'searchGrouped', 'opsPropose', 'opsPending', 'opsGet', 'opsReview', 'opsApprove', 'opsReject', 'agentInfo', 'getLayout', 'setLayout', 'getIndexStatus',
  // ---- r11-E
  'getIndexHealth', 'debugDualDbCheck', 'indexRebuild',
  'listOps', 'opsView', 'opUndo', 'opRestoreBackup', 'showInFolder', 'registerPlugin', 'listPlugins', 'setPluginEnabled',
  'getDevMode', 'setDevMode', 'listAdapterPlugins', 'installAdapterPluginFromFolder', 'setAdapterPluginEnabled', 'setPermissionGrant',
  'revokePermission', 'pluginFile', 'mintPluginFileToken', 'releasePluginFileToken', 'adapterStorage', 'adapterUninstallInfo',
  'uninstallAdapterPlugin', 'planPreview', 'planExecute', 'planDiscard', 'listPluginAudit', 'recordPluginEvent', 'killPluginFrames', 'pluginProcesses',
  'pluginStorageGet', 'pluginStorageSet',
  'appProfileCreate', 'appProfileGet', 'appDetect', 'appLaunch', 'appList', 'appFocus', 'appClose', 'appPendingChanges', 'appUndoExternal', 'openMigration',
  'webCreate', 'webDestroy', 'webNavigate', 'webBack', 'webForward', 'webReload', 'webGetScroll', 'webSetScroll', 'webGetZoom', 'webSetZoom', 'webSnapshot', 'webClearSessionData', 'clearPluginSiteData', 'webOpenExternal', 'webSiteApply', 'webSiteList',
  'listWorkspaces', 'getWorkspace', 'createWorkspace', 'saveWorkspaceLayout', 'updateWorkspace', 'deleteWorkspace',
  'listWorkspaceRefs', 'addWorkspaceRefs', 'removeWorkspaceRef', 'workspacesReferencing',
  'listVirtualFolders', 'createVirtualFolder', 'renameVirtualFolder', 'deleteVirtualFolder', 'moveVirtualFolder',
  'setVfolderMembership', 'listVfolderMembership', 'listVfolderView', 'removeVfolderMembership',
  'classifyByType', 'undoVfolderClassify', 'vfolderUndoAvailable', 'rememberWebStub',
  'getCurrentWorkspaceId', 'setCurrentWorkspace', 'exportWorkspaceToFile', 'importWorkspaceFromFile',
  'agentLiveList', 'agentLiveAdd', 'agentLiveAddMany', 'agentLiveRemove', 'agentLiveReorder', 'agentLiveSetPurpose',
  'agentLivePin', 'agentLiveUnpin', 'agentLiveClearSession', 'agentLiveRelocate', 'agentLiveEntryPath', 'agentLiveNoteScene',
  'agentLiveStartDrag',
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
] as const;

const api: Record<string, unknown> = {};
for (const m of methods) api[m] = (...args: unknown[]) => (MAIN_METHOD_SET.has(m) ? ipcRenderer.invoke('kb', m, ...args) : callData(m, args));
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
api.startupMark = (name: string, wall?: number) => ipcRenderer.send('kb:startup-mark', name, wall ?? Date.now());
api.setWindowChrome = (colors: { color?: unknown; symbolColor?: unknown }) => {
  const color = colors?.color;
  const symbolColor = colors?.symbolColor;
  if (typeof color !== 'string' || typeof symbolColor !== 'string') return Promise.resolve();
  return ipcRenderer.invoke('kb:set-window-chrome', { color, symbolColor });
};
api.captureWorkspaceSnapshot = (input: unknown) => ipcRenderer.invoke(WORKSPACE_SNAPSHOT_CAPTURE_CHANNEL, input);
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
