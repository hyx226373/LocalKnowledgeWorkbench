/**
 * 网络资料的主进程接线（第 11 轮 A · 星图组）：内置适配器目录、WebResourceStore 与 WorkbenchService 钩子、
 * r11-A 的 IPC 方法（main/index.ts 的 `// ---- r11-A 网络资料` 块只做展开），以及对 textOpen / 文本保存 / search 的只读与搜索包装。
 */
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { WorkbenchService } from './service/WorkbenchService';

/** 数据进程里没有 WebContentsView。取页、下载、存页都问主进程。 */
export interface WebPanelHooks {
  fetchForCache(pluginId: string, adapterId: string, url: string, opts?: { timeoutMs?: number; maxBytes?: number }): ReturnType<Fetcher>;
  pageInfo(viewId: string): { url: string; title?: string } | Promise<{ url: string; title?: string }>;
  savePage(viewId: string, abs: string): Promise<void>;
}
import { normalizeRelPath, resolveInRoot } from './service/paths';
import { WebResourceStore, fetchAndCache, type Fetcher } from './webResources';
import { WEB_GENERIC_ADAPTER, WEB_GENERIC_PLUGIN, safeCacheFileName, sanitizeWebRef, type FetchCacheResult } from '../shared/webResources';
import type { TextSnapshot } from '../shared/textEdit';

export const WEB_READONLY_REASON = '网络资料只读；需要编辑请先“保存到本地”';

/** 内置适配器目录：KB_BUILTIN_ADAPTERS_DIR（测试）> 打包后 <resources>/builtin-adapters > 开发时 <仓库>/resources/builtin-adapters */
export function builtinAdaptersDir(): string | null {
  const env = process.env.KB_BUILTIN_ADAPTERS_DIR;
  if (env) return env === 'none' ? null : path.resolve(env);
  if (!app || typeof app.getAppPath !== 'function') return null;
  if (app.isPackaged) return path.join(process.resourcesPath, 'builtin-adapters');
  for (let d = app.getAppPath(), i = 0; i < 4; i++, d = path.dirname(d)) {
    const p = path.join(d, 'resources', 'builtin-adapters');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export interface WebMainDeps {
  svc: WorkbenchService;
  webPanels: WebPanelHooks;
  send: (channel: string, payload: unknown) => void;
}

export function createWebResourcesMain({ svc, webPanels, send }: WebMainDeps) {
  const dir = builtinAdaptersDir();
  const loaded = dir ? svc.plugins.loadBuiltins(dir) : [];
  if (loaded.length) console.log(`[builtin] 内置适配器：${loaded.join(', ')}`);
  const store = new WebResourceStore(svc.db, path.join(svc.dataDir, 'web-cache'));
  svc.externalResources = store;
  store.onChange((ev) => send('kb:web-resources-change', ev));
  const fetcher = (url: string) => webPanels.fetchForCache(WEB_GENERIC_PLUGIN, WEB_GENERIC_ADAPTER, url, { timeoutMs: Number(process.env.KB_WEB_FETCH_TIMEOUT_MS) || 20000 });
  (globalThis as { __kbWebResources?: { store: WebResourceStore; svc: WorkbenchService } }).__kbWebResources = { store, svc }; // e2e 检查

  /** 保存到本地：写到已注册根内的新文件（不覆盖；重名加 (2)），记 op_log（撤销 = 删除该文件），返回新的文件 resourceId */
  async function saveToLocal(input: { resourceId?: string; viewId?: string; rootId: string; relPath: string }) {
    const root = svc.listRoots().find((r) => r.id === input?.rootId);
    if (!root) throw new Error('请选择一个已注册的根');
    let rel = normalizeRelPath(String(input.relPath ?? ''));
    if (!rel) throw new Error('请填写文件名');
    const parts = rel.split('/');
    parts[parts.length - 1] = safeCacheFileName(parts[parts.length - 1]);
    rel = parts.join('/');
    let url = '';
    let src: string | null = null;
    let viewId: string | null = null;
    if (input.resourceId) {
      const w = store.get(String(input.resourceId));
      if (!w) throw new Error('网络资料不存在');
      url = w.url;
      if (w.adapterId !== WEB_GENERIC_ADAPTER || w.cached) {
        if (!w.cached) {
          const r = await fetchAndCache(store, w.resourceId, fetcher);
          if (!r.ok) throw new Error(r.kind === 'error' ? `下载失败：${r.detail}` : r.kind === 'site-not-granted' ? `尚未允许访问 ${r.host}` : r.detail);
        }
        src = store.cacheFile(w.resourceId);
      }
    }
    if (!src) {
      if (!input.viewId) throw new Error('网页需要在打开的网页面板中保存');
      viewId = String(input.viewId);
      url ||= (await Promise.resolve(webPanels.pageInfo(viewId))).url;
    }
    const dirRel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    const m = /^(.*?)(\.[^.]*)?$/.exec(base)!;
    let finalRel = rel;
    let abs = resolveInRoot(root.path, finalRel);
    for (let i = 2; fs.existsSync(abs); i++) {
      if (i > 999) throw new Error('同名文件过多');
      finalRel = (dirRel ? `${dirRel}/` : '') + `${m[1]} (${i})${m[2] ?? ''}`;
      abs = resolveInRoot(root.path, finalRel);
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (src) {
      fs.copyFileSync(src, abs, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(abs, 0o644); // 缓存是只读的，保存出来的是普通可编辑文件
    } else {
      const tmp = path.join(svc.stagingDir, `web-save-${Date.now()}-${process.pid}.mhtml`);
      await webPanels.savePage(viewId!, tmp);
      fs.copyFileSync(tmp, abs, fs.constants.COPYFILE_EXCL);
      fs.rmSync(tmp, { force: true });
    }
    const op = svc.recordExternalWrite(root.id, finalRel, null, 'user', { via: 'web-save', url: sanitizeWebRef(url).ok ? (sanitizeWebRef(url) as { url: string }).url : '' });
    await svc.applyFsEvents(root.id, [{ type: 'add', relPath: finalRel }]).catch(() => undefined);
    const resourceId = svc.resourceIdFor(root.id, finalRel);
    return { resourceId, rootId: root.id, relPath: finalRel, opId: op.id };
  }

  const isWeb = (rid: unknown) => typeof rid === 'string' && store.has(rid);

  // ---- r11-A 网络资料：IPC 方法（main/index.ts 展开）
  const inflight = new Map<string, Promise<FetchCacheResult>>();
  const api: Record<string, (...a: any[]) => unknown> = {
    webResourceAdd: (input: Parameters<WebResourceStore['add']>[0]) => store.add(input),
    webResourceUpdate: (rid: string, patch: Parameters<WebResourceStore['update']>[1]) => store.update(String(rid), patch ?? {}),
    webResourceGet: (rid: string) => store.get(String(rid)),
    webResourceGetByUrl: (url: string) => store.getByUrl(String(url)),
    webResourceList: (opts?: { favoritesOnly?: boolean; limit?: number }) => store.list(opts ?? {}),
    webResourceRemove: (rid: string) => store.remove(String(rid)),
    webFetchCache: (rid: string, opts?: { force?: boolean }) => {
      // 同一资料的并发下载合并为一次（界面重试 / 多个面板同时打开同一直链时不互相覆盖缓存）
      const key = `${String(rid)}|${opts?.force === true ? 'f' : ''}`;
      const cur = inflight.get(key);
      if (cur) return cur;
      const p = fetchAndCache(store, String(rid), fetcher, { force: opts?.force === true }).finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
    },
    webGrantSite: (pluginId: string, adapterId: string, host: string) => svc.plugins.grantSite(String(pluginId), String(adapterId), String(host)),
    webRevokeSite: (pluginId: string, adapterId: string, host: string) => svc.plugins.revokeSite(String(pluginId), String(adapterId), String(host)),
    webGrantedSites: (pluginId: string, adapterId: string) => svc.plugins.grantedSites(String(pluginId), String(adapterId)),
    webPageInfo: (viewId: string) => Promise.resolve(webPanels.pageInfo(String(viewId))),
    webSaveToLocal: (input: { resourceId?: string; viewId?: string; rootId: string; relPath: string }) => saveToLocal(input ?? ({} as never)),
  };

  /** 包装已有方法：网络资料只读（textOpen 不可编辑、保存一律拒绝）；search 追加标题 / 网址命中（matchKind 'name'） */
  function wrap(base: Record<string, (...a: any[]) => unknown>) {
    const textOpen = base.textOpen;
    base.textOpen = async (rid: string) => {
      const snap = (await textOpen(rid)) as TextSnapshot;
      return isWeb(rid) ? { ...snap, editable: false, readOnlyReason: WEB_READONLY_REASON } : snap;
    };
    for (const m of ['textPreviewSave', 'textSave', 'textUndoLastSave']) {
      const f = base[m];
      base[m] = (rid: string, ...rest: unknown[]) => {
        if (isWeb(rid)) throw new Error(WEB_READONLY_REASON);
        return f(rid, ...rest);
      };
    }
    const search = base.search;
    base.search = async (q: string) => {
      const hits = (await search(q)) as unknown[];
      return [...hits, ...store.search(String(q), 20)];
    };
    return base;
  }

  return { store, api, wrap };
}
