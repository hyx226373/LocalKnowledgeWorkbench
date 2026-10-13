/**
 * 网络资料的界面动作（第 11 轮 A）：打开网址（web.openUrl）、加入本工作资料（web.addToRefs）、复制网址（web.copyUrl）、
 * 保存到本地、按 web resourceId 打开。App 通过 webBridge.attach 提供打开条目 / 当前工作区等能力（App.tsx 只挂一个钩子）。
 */
import React, { useEffect, useState } from 'react';
import { kb } from '../kb';
import { dialogs } from '../ui/dialogs';
import { makeWebItem, type WorkspaceItem } from '../plugin-host/layoutModel';
import { WEB_FILE_ADAPTER, WEB_GENERIC_ADAPTER, normalizeUserInput, safeCacheFileName, sanitizeWebRef, webExtOfUrl, type WebResource } from '../../shared/webResources';
import type { Root, WorkspaceRef } from '../../shared/types';

export type OpenMode = 'tab' | 'right' | 'below';

export interface WebBridge {
  /** 加入一个条目并打开面板（已有同 ref + adapterId 的面板则激活） */
  openItem(item: WorkspaceItem, title: string, mode?: OpenMode): void;
  currentWorkspaceId(): string | null;
  /** 当前活动面板的条目 */
  activeItem(): WorkspaceItem | null;
  /** 工作资料变化后刷新侧栏（addWorkspaceRefs 的返回值） */
  refsChanged?(refs: WorkspaceRef[]): void;
}

let bridge: WebBridge | null = null;
export const webBridge = {
  attach(b: WebBridge) {
    bridge = b;
    return () => {
      if (bridge === b) bridge = null;
    };
  },
  get: () => bridge,
};

/** 当前活动网页面板的页面信息（WebSurface 挂载时登记 viewId → 条目） */
const liveViews = new Map<string, { viewId: string; url: () => string | null; title: () => string }>();
export function registerLiveWebView(itemId: string, v: { viewId: string; url: () => string | null; title: () => string }) {
  liveViews.set(itemId, v);
  return () => {
    if (liveViews.get(itemId) === v) liveViews.delete(itemId);
  };
}

function errText(e: unknown) {
  return String((e as Error)?.message ?? e).replace(/^Error invoking remote method 'kb': (Error: )?/, '').replace(/^\[[\w-]+\]\s*/, '');
}

/**
 * 打开网址：补协议 → sanitize（只允许 http/https，拒绝 IP/端口；去 query/账号密码）→ 白名单扩展名走直链阅读器（web.file），
 * 其余走内置网页面板（web.generic）→ 写入网络资料（同一网址同一 resourceId）。首次访问的网站在面板中逐站询问。
 */
export async function openUrl(input: string, mode: OpenMode = 'tab', opts: { adapterId?: string } = {}): Promise<WebResource | null> {
  const url = normalizeUserInput(input);
  const s = sanitizeWebRef(url);
  if (!s.ok) {
    await dialogs.alert({ title: '无法打开网址', body: s.reason });
    return null;
  }
  const ext = webExtOfUrl(s.url);
  const adapterId = opts.adapterId ?? (ext ? WEB_FILE_ADAPTER : WEB_GENERIC_ADAPTER);
  const fileTitle = ext && adapterId === WEB_FILE_ADAPTER ? fileNameOfUrl(s.url) : '';
  const prev = fileTitle ? await kb.webResourceGetByUrl(s.url) : null;
  const w = await kb.webResourceAdd({ url: s.url, adapterId, opened: true, ...(ext && adapterId === WEB_FILE_ADAPTER ? { ext: ext === 'jpeg' ? 'jpg' : ext } : {}), ...(fileTitle && (!prev || prev.title === s.host) ? { title: fileTitle } : {}) });
  if (adapterId !== w.adapterId) await kb.webResourceUpdate(w.resourceId, { adapterId });
  const b = bridge;
  if (!b) throw new Error('工作台尚未就绪');
  b.openItem(makeWebItem(s.url, adapterId), w.title || s.host, mode);
  return w;
}

/** 直链的默认标题：网址最后一段（解码）；失败时空 */
function fileNameOfUrl(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '').slice(0, 200);
  } catch {
    return '';
  }
}

/** 按 web resourceId 打开（工作资料、搜索结果、侧栏）；不是网络资料返回 false */
export async function openWebResource(resourceId: string, mode: OpenMode = 'tab'): Promise<boolean> {
  const w = await kb.webResourceGet(resourceId).catch(() => null);
  if (!w) return false;
  await openUrl(w.url, mode, { adapterId: w.adapterId === WEB_FILE_ADAPTER ? WEB_FILE_ADAPTER : WEB_GENERIC_ADAPTER });
  return true;
}

export async function openUrlPrompt() {
  const r = await dialogs.prompt({ title: '打开网址', body: '支持 http / https 网址。首次访问的网站会先询问是否允许；PDF、图片、Markdown、文本直链用内置阅读器打开。', fields: [{ name: 'url', label: '网址', value: 'https://' }], ok: '打开' });
  if (!r?.url?.trim()) return;
  try {
    await openUrl(r.url.trim());
  } catch (e) {
    await dialogs.alert({ title: '无法打开', body: errText(e) });
  }
}

/** 当前（或指定）网页条目的网址与标题：网页面板取当前页面，直链取条目地址 */
function currentWeb(item?: WorkspaceItem | null): { url: string; title: string; viewId?: string; item: WorkspaceItem } | null {
  const it = item ?? bridge?.activeItem() ?? null;
  if (!it || it.sourceKind !== 'web') return null;
  const live = liveViews.get(it.itemId);
  const url = live?.url() || it.ref;
  return { url, title: live?.title() || it.title || '', ...(live ? { viewId: live.viewId } : {}), item: it };
}

export async function addToRefs(item?: WorkspaceItem | null, notify = true): Promise<string | null> {
  const cur = currentWeb(item);
  const ws = bridge?.currentWorkspaceId();
  if (!cur || !ws) {
    if (notify) await dialogs.alert({ title: '加入本工作资料', body: '请先激活一个网页或网络资料面板。' });
    return null;
  }
  try {
    const w = await kb.webResourceAdd({ url: cur.url, ...(cur.title ? { title: cur.title } : {}), adapterId: cur.item.adapterId === WEB_FILE_ADAPTER ? WEB_FILE_ADAPTER : WEB_GENERIC_ADAPTER });
    bridge?.refsChanged?.(await kb.addWorkspaceRefs(ws, [w.resourceId]));
    flash(`已加入本工作资料：${w.title}`);
    return w.resourceId;
  } catch (e) {
    if (notify) await dialogs.alert({ title: '无法加入工作资料', body: errText(e) });
    return null;
  }
}

export async function copyUrl(item?: WorkspaceItem | null, url?: string) {
  const u = url ?? currentWeb(item)?.url;
  if (!u) return;
  try {
    await navigator.clipboard.writeText(u);
  } catch {
    // 剪贴板 API 需要窗口焦点（网页视图抢走焦点时）：退回 execCommand
    const ta = document.createElement('textarea');
    ta.value = u;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  lastCopied.value = u;
  flash('网址已复制');
}
/** e2e 检查用：最近一次复制的网址 */
export const lastCopied = { value: '' };

// ---------------- 保存到本地 ----------------

function SaveBody({ roots, name, done }: { roots: Root[]; name: string; done: (v: { rootId: string; relPath: string } | null) => void }) {
  const [rootId, setRootId] = useState(roots[0]?.id ?? '');
  const [dir, setDir] = useState('网络资料');
  const [file, setFile] = useState(name);
  const rel = [dir.trim().replace(/^[\\/]+|[\\/]+$/g, ''), file.trim()].filter(Boolean).join('/');
  return (
    <>
      <div className="kb-dialog-body" data-testid="web-save-dialog">
        {!roots.length ? (
          <div className="meta">还没有注册任何文件夹。请先在侧栏添加一个根，再保存到本地。</div>
        ) : (
          <div className="kb-form">
            <label>
              保存到根
              <select value={rootId} onChange={(e) => setRootId(e.target.value)} data-testid="web-save-root">
                {roots.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              文件夹（根内相对路径，可留空）
              <input value={dir} onChange={(e) => setDir(e.target.value)} data-testid="web-save-dir" />
            </label>
            <label>
              文件名
              <input value={file} onChange={(e) => setFile(e.target.value)} data-testid="web-save-name" />
            </label>
            <div className="meta">保存为根内的新文件（同名时自动加“(2)”，不覆盖），记入操作记录、可撤销；网络资料本身保留。不会写回网站。</div>
          </div>
        )}
      </div>
      <div className="kb-dialog-actions">
        <button className="kb-button kb-button--secondary" onClick={() => done(null)}>
          取消
        </button>
        <button className="kb-button" data-testid="web-save-ok" disabled={!roots.length || !rootId || !file.trim()} onClick={() => done({ rootId, relPath: rel })}>
          保存
        </button>
      </div>
    </>
  );
}

/** 保存到本地：直链复制缓存文件，网页存为 MHTML。返回新文件 resourceId */
export async function saveToLocal(o: { resourceId?: string; item?: WorkspaceItem | null }): Promise<string | null> {
  let resourceId = o.resourceId;
  let viewId: string | undefined;
  let name = '';
  const cur = resourceId ? null : currentWeb(o.item);
  if (!resourceId) {
    if (!cur) {
      await dialogs.alert({ title: '保存到本地', body: '请先激活一个网页或网络资料面板。' });
      return null;
    }
    if (cur.item.adapterId === WEB_FILE_ADAPTER) resourceId = (await kb.webResourceAdd({ url: cur.item.ref, adapterId: WEB_FILE_ADAPTER })).resourceId;
    else {
      viewId = cur.viewId;
      if (!viewId) {
        await dialogs.alert({ title: '保存到本地', body: '网页需要先在网页面板中打开。' });
        return null;
      }
      let host = cur.url;
      try {
        host = new URL(cur.url).hostname;
      } catch {
        /* keep */
      }
      name = `${safeCacheFileName(cur.title || host)}.mhtml`;
    }
  }
  if (resourceId) {
    const w = await kb.webResourceGet(resourceId);
    if (!w) return null;
    if (w.adapterId !== WEB_FILE_ADAPTER && !w.cached) {
      await dialogs.alert({ title: '保存到本地', body: '网页需要先在网页面板中打开，然后在面板工具条上点“保存到本地”。' });
      return null;
    }
    let last = '';
    try {
      last = decodeURIComponent(new URL(w.url).pathname.split('/').pop() ?? '');
    } catch {
      /* ignore */
    }
    name = safeCacheFileName(last || w.title || 'download');
  }
  const roots = await kb.listRoots();
  const target = await dialogs.custom<{ rootId: string; relPath: string } | null>({ title: '保存到本地', testid: 'web-save', cancelValue: null, render: (done) => <SaveBody roots={roots} name={name} done={done} /> });
  if (!target) return null;
  try {
    const r = await kb.webSaveToLocal({ ...(resourceId ? { resourceId } : { viewId }), rootId: target.rootId, relPath: target.relPath });
    flash(`已保存到本地：${roots.find((x) => x.id === r.rootId)?.name ?? ''}/${r.relPath}`);
    lastSaved.value = r;
    return r.resourceId;
  } catch (e) {
    await dialogs.alert({ title: '保存失败', body: errText(e) });
    return null;
  }
}
/** e2e 检查用：最近一次保存的结果 */
export const lastSaved: { value: { resourceId: string; rootId: string; relPath: string; opId: number } | null } = { value: null };

// ---------------- 轻提示 ----------------

const flashListeners = new Set<(m: string | null) => void>();
let flashTimer: ReturnType<typeof setTimeout> | undefined;
export function flash(msg: string) {
  flashListeners.forEach((l) => l(msg));
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => flashListeners.forEach((l) => l(null)), 3500);
}
export function WebFlash() {
  const [m, setM] = useState<string | null>(null);
  useEffect(() => {
    flashListeners.add(setM);
    return () => void flashListeners.delete(setM);
  }, []);
  if (!m) return null;
  return (
    <div className="kb-web-flash" role="status" data-testid="web-flash">
      {m}
    </div>
  );
}
