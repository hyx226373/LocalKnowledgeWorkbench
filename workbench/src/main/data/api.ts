/**
 * 数据进程上的 kb 方法。对话框、网页面板和更新留在主进程，经 ask 过去。
 */
import fs from 'node:fs';
import path from 'node:path';
import { RENDERER_AUDIT_KINDS, type AuditKind } from '../../shared/pluginIpc';
import { TextEditService } from '../service/textEdit';
import { debugDualDbCheck } from '../backend/dualDbCheck';
import { omitAgentBridgeFromLayout } from '../agent-bridge/layoutPolicy';
import { writeConsoleDraft, type ConsoleDraftWriteRequest } from '../console/draft';
import { migrationMethods } from './migrationOps';
import type { WorkbenchService } from '../service/WorkbenchService';
import type { BackendBundle } from '../backend/wire';
import type { RootWatchers } from '../service/watcher';
import type { AppHost } from '../adapters/appHost';
import type { WebResourceStore } from '../webResources';
import type { AppHarness } from '../adapters/appHarness';
import { stallNote } from '../startupTrace';
import { openInsideRoots } from '../../shared/shellReveal';
import { PluginCatalogInstaller } from '../service/pluginCatalogInstall';
import { DIALOG_LAST_DIR } from '../../shared/dialogLastDir';
import { createBlankFile, createFileWithContent } from '../service/blankFile';
import { CONTENT_SEARCH_UNAVAILABLE_NOTICE, isContentBodyIndexEnabled } from '../../shared/contentIndexScope';

export type AskMain = (method: string, args: unknown[]) => Promise<unknown>;

export interface DataApiDeps {
  svc: WorkbenchService;
  backend: BackendBundle;
  watchers: RootWatchers;
  appHost: AppHost;
  ask: AskMain;
  packaged: boolean;
  e2e: boolean;
  version: string;
  onRootsReplaced: () => Promise<void>;
  webApi: Record<string, (...a: any[]) => unknown>;
  store: WebResourceStore;
  harness: AppHarness | null;
  publishPlugins: () => void;
  publishHarness: () => void;
}

function asExtList(v: unknown): string[] | undefined {
  if (v == null) return undefined;
  if (!Array.isArray(v)) throw new Error('extensions 必须是字符串数组');
  return v.filter((x): x is string => typeof x === 'string');
}

function themeDevDirs(): string[] {
  return (process.env.KB_THEME_DIRS ?? '').split(path.delimiter).map((s) => s.trim()).filter(Boolean);
}

export function createDataApi(deps: DataApiDeps): Record<string, (...a: any[]) => unknown> {
  const { svc, backend, watchers, appHost, ask } = deps;
  svc.on('root-purged', (rootId: string) => {
    try { backend.onRootRemoved(String(rootId)); } catch (err) { console.error('[root] 移除镜像失败', err); }
  });
  const textEdit = new TextEditService(backend.fileOps);
  const uiOps = backend.ops.forUi();
  const api: Record<string, (...a: any[]) => unknown> = {
    textOpen: (rid: string) => textEdit.open(String(rid)),
    textStat: (rid: string) => textEdit.stat(String(rid)),
    textPreviewSave: (rid: string, text: string, baseHash: string) => textEdit.previewSave(String(rid), String(text), String(baseHash)),
    textSave: (rid: string, text: string, baseHash: string) => textEdit.save(String(rid), String(text), String(baseHash), 'user'),
    textHistory: (rid: string) => textEdit.history(String(rid)),
    textUndoLastSave: (rid: string, force?: boolean) => textEdit.undoLastSave(String(rid), force === true, 'user'),
    listRoots: () => svc.rootsToWatch(),
    addRoot: (p: string, name?: string, extensions?: unknown) => {
      const watched = new Set(svc.rootsToWatch().map((root) => root.id));
      const r = svc.addRoot(p, name, asExtList(extensions));
      if (r.alias) return r;
      backend.onRootAdded(r.id, r.name, r.path);
      watchers.sync();
      if (isContentBodyIndexEnabled() && !watched.has(r.id)) backend.indexContent(r.id, r.path);
      return r;
    },
    addFileSource: (p: string, name?: string, extensions?: unknown) => {
      const r = svc.addFileSource(p, name, asExtList(extensions));
      if (!r.alias && r.kind === 'file') watchers.sync();
      return r;
    },
    createBlankFile: async (input: unknown) => {
      if (!input || typeof input !== 'object') throw new Error('参数不正确');
      const body = input as { dir?: unknown; name?: unknown; ext?: unknown };
      if (typeof body.dir !== 'string' || typeof body.name !== 'string' || typeof body.ext !== 'string') throw new Error('参数不正确');
      const created = await createBlankFile(svc, { dir: body.dir, name: body.name, ext: body.ext });
      if (created.placed === 'source') watchers.sync();
      return created;
    },
    createFileWithContent: async (input: unknown) => {
      if (!input || typeof input !== 'object') throw new Error('参数不正确');
      const body = input as { dir?: unknown; name?: unknown; ext?: unknown; content?: unknown };
      if (typeof body.dir !== 'string' || typeof body.name !== 'string' || typeof body.content !== 'string') throw new Error('参数不正确');
      const created = await createFileWithContent(svc, {
        dir: body.dir,
        name: body.name,
        ext: typeof body.ext === 'string' ? body.ext : 'md',
        content: body.content,
      });
      if (created.placed === 'source') watchers.sync();
      return created;
    },
    removeRoot: (id: string) => {
      svc.removeRoot(String(id));
      watchers.sync();
    },
    detachRoot: (id: string) => {
      const receipt = svc.detachRoot(String(id));
      watchers.sync();
      return receipt;
    },
    deleteRootFolder: (id: string) => {
      const receipt = svc.deleteRootFolder(String(id));
      watchers.sync();
      return receipt;
    },
    trashInsideRoot: (rootId: string, rel: string) => svc.trashInsideRoot(String(rootId), String(rel)),
    hideFromRoot: (rootId: string, rel: string) => svc.hideFromRoot(String(rootId), String(rel)),
    restoreHidden: (rootId: string, rel: string) => svc.restoreHidden(String(rootId), String(rel)),
    restoreAllHidden: (rootId: string) => svc.restoreAllHidden(String(rootId)),
    listHiddenItems: () => svc.listHiddenItems(),
    listRootTasks: () => svc.listRootTasks(),
    cancelRootTask: (id: string) => {
      svc.cancelRootTask(String(id));
      watchers.sync();
    },
    retryRootTask: (id: string) => svc.retryRootTask(String(id)),
    restoreRoot: (id: string) => {
      const root = svc.restoreRoot(String(id));
      watchers.sync();
      return root;
    },
    remapRoot: (id: string, p: string) => {
      const r = svc.remapRoot(id, p);
      backend.onRootAdded(r.id, r.name, r.path);
      watchers.restart(id);
      if (isContentBodyIndexEnabled()) backend.indexContent(r.id, r.path, { existingOnly: true });
      return r;
    },
    listFavorites: () => svc.listFavorites(),
    addFavorite: (rid: string) => svc.addFavorite(rid),
    removeFavorite: (id: number) => svc.removeFavorite(id),
    listDir: (rootId: string, rel: string) => svc.listDir(rootId, rel, { showIgnored: svc.getLayout('settings.showIgnored') === true }),
    listDirAbs: (absPath: string) => svc.listDirAbs(String(absPath ?? ''), { showIgnored: svc.getLayout('settings.showIgnored') === true }),
    getShowIgnored: () => svc.getLayout('settings.showIgnored') === true,
    setShowIgnored: (on: boolean) => svc.setLayout('settings.showIgnored', !!on),
    getResource: (rid: string) => svc.getResource(rid),
    resourceAbsPath: (rid: string) => svc.resolveResourcePath(String(rid)),
    rootWorkspace: (rootId: string) => svc.rootWorkspace(String(rootId ?? '')),
    readText: (rid: string) => svc.readText(rid),
    rescan: (rootId: string) => {
      const root = svc.listRoots().find((r) => r.id === rootId);
      void svc.scanRoot(rootId);
      if (isContentBodyIndexEnabled() && root && root.kind !== 'file') backend.indexContent(root.id, root.path);
    },
    cancelScan: (rootId: string) => {
      svc.cancelScan(rootId);
      try {
        backend.sync.startSync(rootId).cancel();
      } catch {
        /* 这个根没有同步任务 */
      }
    },
    search: async (q: string) => {
      const rootIds = svc.rootsToWatch().map((root) => root.id);
      const grouped = await backend.search.search(String(q), { limit: 50, rootIds });
      return grouped.hits.map((h) => ({
        resourceId: h.resourceId,
        rootId: h.rootId,
        relPath: h.relPath,
        name: h.title,
        kind: 'file' as const,
        matchKind: h.matchKind,
        snippet: h.snippet,
        page: h.page,
        score: h.score,
        matches: h.matches,
      }));
    },
    searchGrouped: async (q: string, o?: { limit?: number; rootIds?: string[]; scope?: string }) => {
      if (!isContentBodyIndexEnabled() && o?.scope === 'content') {
        return { hits: [], truncated: false, degraded: true, notice: CONTENT_SEARCH_UNAVAILABLE_NOTICE };
      }
      const allowed = svc.rootsToWatch().map((root) => root.id);
      const allow = new Set(allowed);
      const requested = Array.isArray(o?.rootIds) ? o.rootIds.map(String) : null;
      const rootIds = requested ? requested.filter((id) => allow.has(id)) : allowed;
      const scope = o?.scope === 'name' || o?.scope === 'content' || o?.scope === 'all' ? o.scope : undefined;
      const result = await backend.search.search(String(q), {
        limit: typeof o?.limit === 'number' ? o.limit : undefined,
        rootIds,
        ...(scope ? { scope } : {}),
      });
      if (scope !== 'content') return result;
      const hits = result.hits.filter((h) => h.matchKind === 'content' || h.matchKind === 'heading');
      const health = backend.getHealth();
      const unavailable = health.engine === 'local-fallback' || (!health.contentSearch && health.engine !== 'starting');
      if (!unavailable) return { ...result, hits };
      if (hits.length > 0) return { ...result, hits, degraded: true };
      return { ...result, hits: [], degraded: true, notice: result.notice || CONTENT_SEARCH_UNAVAILABLE_NOTICE };
    },
    opsPropose: (title: string, ops: unknown[]) => uiOps.propose(String(title), Array.isArray(ops) ? (ops as never) : []),
    opsPending: () => uiOps.pending(),
    opsGet: (planId: string) => uiOps.get(String(planId)),
    opsReview: (planId: string) => uiOps.review(String(planId)),
    opsApprove: (planId: string, opIds: string[], contentHash: string) =>
      uiOps.approve(String(planId), Array.isArray(opIds) ? opIds.map(String) : [], String(contentHash)),
    opsReject: (planId: string, reason?: string) => uiOps.reject(String(planId), String(reason ?? '用户拒绝')),
    agentInfo: () =>
      backend.agent
        ? { url: backend.agent.url, tokenFile: backend.agent.tokenFile, host: backend.agent.host, port: backend.agent.port }
        : null,
    getLayout: (k: string) => svc.getLayout(k),
    setLayout: (k: string, v: unknown) => svc.setLayout(k, v),
    getIndexStatus: () => svc.getIndexStatus(),
    getIndexHealth: () => {
      const h = backend.getHealth();
      const scanned = svc.getIndexStatus().reduce((n, s) => n + (s.fileCount || 0), 0);
      return { ...h, scannedFiles: scanned, contentIndexedFiles: svc.countIndexedFiles() };
    },
    debugDualDbCheck: (rootId?: string) => {
      const allowed = !deps.packaged || deps.e2e || process.env.NODE_ENV === 'development';
      if (!allowed) throw new Error('debugDualDbCheck 仅开发模式或 e2e 可用');
      return debugDualDbCheck(
        svc.db,
        backend.stack,
        svc.listRoots().map((r) => ({ id: r.id, path: r.path })),
        rootId ? String(rootId) : undefined,
      );
    },
    indexRebuild: (rootId?: string) => {
      const roots = rootId ? svc.listRoots().filter((r) => r.id === rootId) : svc.rootsToWatch();
      if (!roots.length) return { ok: false, detail: '无根可重建' };
      if (!isContentBodyIndexEnabled()) {
        for (const r of roots) void svc.scanRoot(r.id);
        return { ok: true, detail: `已重新扫描 ${roots.length} 个根的文件名。本软件只按文件名搜索。` };
      }
      for (const r of roots) {
        void svc.scanRoot(r.id);
        backend.indexContent(r.id, r.path);
      }
      const h = backend.getHealth();
      if (h.engine === 'local-fallback' || !h.contentSearch) {
        return {
          ok: false,
          detail: `已重新扫描 ${roots.length} 个根的文件名，但全文索引后端没有启动，正文仍不能搜。原因：${h.reason || '未知'}。重建无法修复这个问题，请重启应用；仍不行请把这段原因发给开发者。`,
        };
      }
      return { ok: true, detail: `已触发 ${roots.length} 个根的扫描与正文索引` };
    },
    listOps: (n?: number) => svc.listOps(n),
    opsView: (n?: number) => svc.opsView(typeof n === 'number' ? Math.min(Math.max(1, n), 1000) : 200),
    opUndo: (opId: number, force?: boolean) => svc.undoFromLog(Number(opId), force === true),
    opRestoreBackup: (opId: number, force?: boolean) => svc.restoreUndoBackup(Number(opId), force === true),
    registerPlugin: (id: string, v: string, src: 'builtin' | 'user') => svc.registerPlugin(id, v, src),
    listPlugins: () => svc.listPlugins(),
    setPluginEnabled: (id: string, on: boolean) => svc.setPluginEnabled(id, on),
    getDevMode: () => svc.getLayout('settings.devMode') === true,
    setDevMode: (on: boolean) => svc.setLayout('settings.devMode', !!on),
    listAdapterPlugins: () => svc.plugins.list(),
    installAdapterPluginFromFolder: async () => {
      if (svc.getLayout('settings.devMode') !== true) throw new Error('请先在插件管理中打开“开发者模式”');
      const picked = await ask('pickDirectory', [{ title: '选择插件文件夹（包含 manifest.json 与打包后的 main）', dialogKey: DIALOG_LAST_DIR.pluginFolder }]);
      if (typeof picked !== 'string' || !picked) return null;
      return svc.plugins.installFromFolder(picked);
    },
    listPluginCatalog: async () => {
      const installer = makePluginCatalogInstaller(svc, deps.packaged);
      return installer.loadCatalog();
    },
    installPluginFromCatalog: async (entryId: string) => {
      const installer = makePluginCatalogInstaller(svc, deps.packaged);
      const d = await installer.installFromCatalog(String(entryId));
      deps.publishPlugins();
      return d;
    },
    setPluginCatalogUrl: (url: string | null) => {
      const v = url == null || String(url).trim() === '' ? null : String(url).trim();
      svc.setLayout('settings.pluginCatalogUrl', v);
      return v;
    },
    setAdapterPluginEnabled: async (id: string, on: boolean) => {
      svc.plugins.setEnabled(id, on);
      if (!on) await ask('web.destroyPlugin', [id]);
    },
    setPermissionGrant: (g: Parameters<typeof svc.plugins.setGrant>[0]) => svc.plugins.setGrant(g),
    revokePermission: async (pluginId: string, adapterId: string, permissionId: string) => {
      const g = svc.plugins.revoke(pluginId, adapterId, permissionId);
      await ask('web.destroyRevoked', [pluginId, adapterId]);
      return g;
    },
    pluginFile: (pluginId: string, adapterId: string, req: Parameters<typeof svc.plugins.file>[2]) => svc.plugins.file(pluginId, adapterId, req),
    mintPluginFileToken: (pluginId: string, adapterId: string) => svc.plugins.mintFileToken(pluginId, adapterId),
    releasePluginFileToken: (token: string) => svc.plugins.releaseFileToken(token),
    adapterStorage: (pluginId: string, op: 'get' | 'set' | 'delete' | 'keys', key?: string, value?: unknown) =>
      op === 'get' ? svc.plugins.storageGet(pluginId, key!) : op === 'set' ? svc.plugins.storageSet(pluginId, key!, value) : op === 'delete' ? svc.plugins.storageDelete(pluginId, key!) : svc.plugins.storageKeys(pluginId),
    adapterUninstallInfo: async (id: string) => {
      const info = svc.plugins.uninstallInfo(id);
      if (info.siteDataBytes !== null) {
        deps.publishPlugins();
        info.siteDataBytes = Number(await ask('web.siteDataBytes', [id]).catch(() => 0));
      }
      return info;
    },
    uninstallAdapterPlugin: async (id: string, opts: { keepData: boolean; removeItems?: boolean }) => {
      const partitions = svc.plugins.webPlugins().find((w) => w.pluginId === id)?.partitions ?? [];
      await ask('web.destroyPlugin', [id]);
      const r = svc.plugins.uninstall(id, { keepData: !!opts?.keepData, removeItems: !!opts?.removeItems });
      if (!opts?.keepData) {
        for (const part of partitions) await ask('web.clearSessionData', [part]);
        svc.setLayout(`web.lastUsed.${id}`, null);
      }
      return r;
    },
    clearPluginSiteData: async (pluginId: string) => {
      deps.publishPlugins();
      for (const part of svc.plugins.webPlugins().find((w) => w.pluginId === pluginId)?.partitions ?? []) {
        await ask('web.clearSessionData', [part]);
      }
    },
    planPreview: (pluginId: string, adapterId: string, plan: Parameters<typeof svc.plugins.planPreview>[2]) => svc.plugins.planPreview(pluginId, adapterId, plan),
    planExecute: (planId: string) => svc.plugins.planExecute(planId),
    planDiscard: (planId: string) => svc.plugins.planDiscard(planId),
    listPluginAudit: (pluginId: string | null, limit?: number) => svc.plugins.listAudit(pluginId, limit),
    recordPluginEvent: (pluginId: string, adapterId: string | null, kind: string, detail: string) => {
      if (!RENDERER_AUDIT_KINDS.includes(kind as AuditKind)) throw new Error(`渲染进程不能写入审计类型 ${kind}`);
      svc.plugins.audit(pluginId, adapterId, kind as AuditKind, detail);
    },
    appProfileCreate: (input: Parameters<AppHost['createProfile']>[0]) => appHost.createProfile(input),
    appProfileGet: (id: string) => appHost.getProfile(String(id)),
    appDetect: (pluginId: string, adapterId: string, programId: string) => appHost.launcher.detect(String(pluginId), String(adapterId), String(programId)),
    appLaunch: (pluginId: string, adapterId: string, itemId: string, appProfileId: string, req: Parameters<AppHost['launch']>[4]) =>
      appHost.launch(String(pluginId), String(adapterId), String(itemId), String(appProfileId), req && typeof req === 'object' ? req : ({} as never)),
    appList: (pluginId: string, itemId?: string) => appHost.launcher.list(String(pluginId)).filter((h) => typeof itemId !== 'string' || appHost.launcher.owner(h.launchId)?.itemId === itemId),
    appFocus: () => false,
    appClose: () => false,
    appPendingChanges: (itemId?: string) => appHost.pendingChanges(typeof itemId === 'string' ? itemId : undefined),
    appUndoExternal: (launchId: string, force?: boolean) => appHost.undoExternal(String(launchId), force === true),
    pluginStorageGet: (id: string, k: string) => svc.pluginStorageGet(id, k),
    pluginStorageSet: (id: string, k: string, v: unknown) => svc.pluginStorageSet(id, k, v),
    showInFolder: (rid: string) => ask('showItem', [svc.resolveResourcePath(rid)]),
    openWithDefaultApp: (rid: string) => openInsideRoots(svc.resolveResourcePath(String(rid)), svc.listRoots().map((root) => root.path), {
      pathLib: path,
      caseInsensitive: process.platform === 'win32' || process.platform === 'darwin',
      openPath: (target) => ask('openPath', [target]) as Promise<string | void>,
    }),
    listWorkspaces: () => svc.listWorkspaces(),
    getWorkspace: (id: string) => svc.getWorkspace(id),
    createWorkspace: (name: string, project: string, layout: unknown, items?: unknown[]) => svc.createWorkspace(name, project, layout, items),
    saveWorkspaceLayout: (id: string, layout: unknown, items?: unknown[]) => svc.saveWorkspaceLayout(id, layout, items),
    updateWorkspace: (id: string, patch: { name?: string; project?: string; favorite?: boolean }) => svc.updateWorkspace(id, patch),
    deleteWorkspace: (id: string) => svc.deleteWorkspace(id),
    listWorkspaceRefs: (id: string) => svc.listWorkspaceRefs(id),
    addWorkspaceRefs: (id: string, rids: string[]) => svc.addWorkspaceRefs(id, Array.isArray(rids) ? rids.map(String) : []),
    removeWorkspaceRef: (id: string, rid: string) => svc.removeWorkspaceRef(id, String(rid)),
    workspacesReferencing: (rid: string) => svc.workspacesReferencing(String(rid)),
    listVirtualFolders: () => svc.listVirtualFolders(),
    createVirtualFolder: (parentId: unknown, name: unknown) => svc.createVirtualFolder(parentId == null || parentId === '' ? null : String(parentId), String(name ?? '')),
    renameVirtualFolder: (folderId: unknown, name: unknown) => svc.renameVirtualFolder(String(folderId ?? ''), String(name ?? '')),
    deleteVirtualFolder: (folderId: unknown) => svc.deleteVirtualFolder(String(folderId ?? '')),
    moveVirtualFolder: (folderId: unknown, newParentId: unknown, sort: unknown) =>
      svc.moveVirtualFolder(String(folderId ?? ''), newParentId == null || newParentId === '' ? null : String(newParentId), Number(sort)),
    setVfolderMembership: (resourceId: unknown, folderIds: unknown) => svc.setVfolderMembership(String(resourceId ?? ''), Array.isArray(folderIds) ? folderIds.map(String) : []),
    listVfolderMembership: (resourceId: unknown) => svc.listVfolderMembership(String(resourceId ?? '')),
    listVfolderView: (folderId: unknown) => svc.listVfolderView(folderId == null || folderId === '' ? null : String(folderId)),
    removeVfolderMembership: (resourceId: unknown, folderId: unknown) => svc.removeVfolderMembership(String(resourceId ?? ''), folderId == null || folderId === '' ? null : String(folderId)),
    classifyByType: (resourceIds: unknown) => svc.classifyByType(Array.isArray(resourceIds) ? resourceIds.map(String) : []),
    undoVfolderClassify: () => svc.undoVfolderClassify(),
    vfolderUndoAvailable: () => svc.vfolderUndoAvailable(),
    rememberWebStub: (stub: { resourceId?: string; url?: string; title?: string }) => svc.rememberWebStub({ resourceId: String(stub?.resourceId ?? ''), url: String(stub?.url ?? ''), title: String(stub?.title ?? '') }),
    getCurrentWorkspaceId: () => svc.getCurrentWorkspaceId(),
    setCurrentWorkspace: (id: string) => {
      const { attached } = svc.setCurrentWorkspace(id);
      watchers.sync();
      stallNote(`workspace-switch id=${id} attached=${attached.length} bodyReads=${attached.length === 0 ? 0 : 'pending'}`);
      for (const rootId of attached) {
        void Promise.resolve(svc.scanRoot(rootId)).then((result) => {
          const changed = result && Array.isArray(result.changed) ? result.changed.length : 0;
          const bodyReads = changed === 0 ? 0 : changed;
          stallNote(`workspace-switch-settled id=${id} root=${rootId} changed=${changed} bodyReads=${bodyReads}`);
        }, () => {
          stallNote(`workspace-switch-settled id=${id} root=${rootId} changed=0 bodyReads=0`);
        });
      }
      return { attached };
    },
    exportWorkspaceToFile: async (id: string) => {
      const data = omitAgentBridgeFromLayout(svc.exportWorkspace(id));
      const safe = data.workspace.name.replace(/[\\/:*?"<>|]/g, '_');
      const picked = await ask('saveFile', [{
        title: '导出工作区布局',
        dialogKey: DIALOG_LAST_DIR.exportWorkspace,
        defaultPath: `${safe}.kblayout.json`,
        filters: [{ name: '工作区布局', extensions: ['kblayout.json', 'json'] }],
      }]);
      if (typeof picked !== 'string' || !picked) return null;
      fs.writeFileSync(picked, JSON.stringify(data, null, 2), 'utf8');
      return path.basename(picked);
    },
    importWorkspaceFromFile: async () => {
      const picked = await ask('pickFile', [{ title: '导入工作区布局', dialogKey: DIALOG_LAST_DIR.importWorkspace, filters: [{ name: '工作区布局', extensions: ['json'] }] }]);
      if (typeof picked !== 'string' || !picked) return null;
      const st = fs.statSync(picked);
      if (st.size > 2 * 1024 * 1024) throw new Error('布局文件过大');
      return svc.importWorkspace(JSON.parse(fs.readFileSync(picked, 'utf8').replace(/^\uFEFF/, '')));
    },
    listThemePacks: () => svc.listThemePacks(themeDevDirs()),
    installThemePackFromFolder: async () => {
      const picked = await ask('pickDirectory', [{ title: '选择主题包文件夹（包含 theme.json）', dialogKey: DIALOG_LAST_DIR.themePack }]);
      if (typeof picked !== 'string' || !picked) return null;
      return svc.installThemePack(picked);
    },
    consoleWriteDraft: (req: ConsoleDraftWriteRequest) => writeConsoleDraft(svc, req),
    consoleResolvePath: (rootId: string, relPath: string) => svc.resourceIdFor(String(rootId), String(relPath)),
    ...deps.webApi,
    resolveKbfile: (url: string) => svc.resolveKbfileUrl(String(url)),
    resolvePluginFile: (url: string) => svc.plugins.resolvePluginFileUrl(String(url)),
    resolvePluginAsset: (pluginId: string, rel: string) => svc.plugins.resolveAsset(String(pluginId), String(rel)),
    'plugin.webAccess': (pluginId: string, adapterId: string) => JSON.parse(JSON.stringify(svc.plugins.webAccess(String(pluginId), String(adapterId)))),
    'plugin.audit': (pluginId: string, adapterId: string | null, kind: string, detail: string, code?: string | null) => {
      svc.plugins.audit(String(pluginId), adapterId == null ? null : String(adapterId), kind as AuditKind, String(detail ?? ''), code == null ? null : String(code));
    },
    'plugin.webPlugins': () => svc.plugins.webPlugins(),
    'plugin.accessList': (pluginId?: string) => accessSnapshots(svc, pluginId ? String(pluginId) : undefined),
    'plugin.maintenance': () => ({ webPlugins: svc.plugins.webPlugins(), lastUsed: lastUsedOf(svc), access: accessSnapshots(svc) }),
    'web.cacheFile': (rid: string) => deps.store.cacheFile(String(rid)),
    'harness.realPath': (winPath: string) => deps.harness?.realPath(String(winPath)) ?? null,
    'harness.exit': (pid: number, code?: number) => {
      const ok = deps.harness?.exit(Number(pid), code == null ? 0 : Number(code)) ?? false;
      deps.publishHarness();
      return ok;
    },
    'harness.setConfirm': (value: boolean) => {
      if (deps.harness) deps.harness.confirmAnswer = value === true;
      deps.publishHarness();
      return true;
    },
    'harness.expireAfterDays': (days: number) => svc.purgeExternalBackups(Date.now() + Number(days) * 24 * 3600 * 1000),
    ...migrationMethods(svc, deps.onRootsReplaced, deps.version),
  };
  return api;
}

export function accessSnapshots(svc: WorkbenchService, pluginId?: string) {
  const out: Array<{ pluginId: string; adapterId: string; snap: unknown }> = [];
  for (const plugin of svc.plugins.list()) {
    if (pluginId && plugin.id !== pluginId) continue;
    const adapters = plugin.manifest?.contributes?.adapters ?? [];
    for (const adapter of adapters) {
      if (!adapter.sourceKinds?.includes('web') || !adapter.web) continue;
      try {
        out.push({ pluginId: plugin.id, adapterId: adapter.id, snap: JSON.parse(JSON.stringify(svc.plugins.webAccess(plugin.id, adapter.id))) });
      } catch {
        /* 没授权的适配器不放进快照 */
      }
    }
  }
  return out;
}

export function lastUsedOf(svc: WorkbenchService): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const plugin of svc.plugins.webPlugins()) out[plugin.pluginId] = svc.getLayout(`web.lastUsed.${plugin.pluginId}`);
  return out;
}


function makePluginCatalogInstaller(svc: WorkbenchService, packaged: boolean): PluginCatalogInstaller {
  return new PluginCatalogInstaller(svc, svc.plugins, () => resolveFixturePluginCatalog(packaged));
}

/** 内置 fixture：开发时仓库 resources/plugin-catalog；打包后 resourcesPath/plugin-catalog */
function resolveFixturePluginCatalog(packaged: boolean): string | null {
  const fromEnv = (process.env.KB_PLUGIN_CATALOG_FIXTURE ?? '').trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  try {
    if (packaged && typeof process.resourcesPath === 'string') {
      const p = path.join(process.resourcesPath, 'plugin-catalog', 'fixture-catalog.json');
      if (fs.existsSync(p)) return p;
    }
  } catch { /* ignore */ }
  // 从 cwd / 本文件相对位置向上找
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const p = path.join(dir, 'resources', 'plugin-catalog', 'fixture-catalog.json');
    if (fs.existsSync(p)) return p;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
