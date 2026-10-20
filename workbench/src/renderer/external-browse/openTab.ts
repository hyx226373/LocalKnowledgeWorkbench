/**
 * 在主窗口内容区打开外链标签。开关关着时不拦截，原来的提示照旧。
 */
import type { DockviewApi } from 'dockview-react';
import { kb } from '../kb';
import { browseTabTitle, decideExternalLink, type ExternalBrowsePrefs } from '../../shared/externalBrowse';
import { EXTERNAL_BROWSE_COMPONENT } from './layout';

let prefs: ExternalBrowsePrefs = { allowOpenExternal: true, trustInsecureLinks: false };
let getApi: () => DockviewApi | null = () => null;
let seq = 0;
const pending: string[] = [];

export function noteExternalBrowsePrefs(listed: { allowOpenExternal?: boolean; trustInsecureLinks?: boolean } | null | undefined): void {
  if (!listed || Array.isArray(listed)) return;
  prefs = {
    allowOpenExternal: listed.allowOpenExternal !== false,
    trustInsecureLinks: listed.trustInsecureLinks === true,
  };
}

export function currentExternalBrowsePrefs(): ExternalBrowsePrefs {
  return prefs;
}

export async function refreshExternalBrowsePrefs(): Promise<void> {
  try {
    const listed = await kb.webSiteList();
    noteExternalBrowsePrefs(listed);
  } catch {
    /* 保持上次读到的开关。缺省：允许外链开，信任不安全链接关。 */
  }
}

export function setExternalBrowseDock(get: () => DockviewApi | null): void {
  getApi = get;
  flushExternalBrowseTabs();
}

export function flushExternalBrowseTabs(): void {
  if (!getApi()) return;
  const urls = pending.splice(0);
  for (const url of urls) openExternalBrowseTab(url);
}

export function openExternalBrowseTab(url: string): string | null {
  const api = getApi();
  if (!api) {
    pending.push(url);
    return null;
  }
  const id = `extbrowse-${Date.now().toString(36)}-${++seq}`;
  api.addPanel({
    id,
    component: EXTERNAL_BROWSE_COMPONENT,
    title: browseTabTitle(url),
    params: { browseId: id, url },
    renderer: 'always',
  });
  return id;
}

/** 捕获阶段处理文档里的外链。block 不 preventDefault，交给原来的拦截。 */
export function installExternalBrowseClicks(): () => void {
  const onEvent = (ev: { type?: string; url?: string }) => {
    if (ev?.type === 'open' && typeof ev.url === 'string') openExternalBrowseTab(ev.url);
  };
  const off = kb.onExtBrowse(onEvent);
  const onClick = (e: MouseEvent) => {
    if (e.button !== 0 || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const el = e.target instanceof Element ? e.target : null;
    const a = el?.closest('a[href]');
    if (!(a instanceof HTMLAnchorElement)) return;
    if (a.hasAttribute('data-kb-anchor')) return;
    const href = a.getAttribute('href') ?? '';
    const decision = decideExternalLink(href, prefs);
    if (decision.action === 'ignore' || decision.action === 'block') return;
    e.preventDefault();
    e.stopPropagation();
    if (decision.action === 'open') openExternalBrowseTab(decision.url);
  };
  document.addEventListener('click', onClick, true);
  void refreshExternalBrowsePrefs();
  return () => {
    off();
    document.removeEventListener('click', onClick, true);
  };
}
