/**
 * 外链内置浏览。判断是纯函数：关着「允许打开外链」时返回 block，调用方保持原来的拦截提示。
 * javascript: 永远拒绝。kbfile: / kbplugin: 永远拒绝，避免浏览分区读到工作台数据。
 * 浏览分区名不带 persist:，会话只在内存里，不写用户数据目录里的分区文件。
 */
export const EXT_BROWSE_PARTITION = 'kb-ext-browse';

export interface ExternalBrowsePrefs {
  /** 允许在主窗口内容区用标签打开外链。缺省开（用户确认的预览图）。 */
  allowOpenExternal: boolean;
  /** 放行 file: 等非 http(s)。缺省关。javascript: 仍然拒绝。 */
  trustInsecureLinks: boolean;
}

export const DEFAULT_EXTERNAL_BROWSE_PREFS: ExternalBrowsePrefs = {
  allowOpenExternal: true,
  trustInsecureLinks: false,
};

export type ExternalLinkDecision =
  | { action: 'ignore' }
  | { action: 'open'; url: string }
  | { action: 'block' }
  | { action: 'deny'; reason: 'javascript' | 'workbench' };

export type ExtBrowseEvent =
  | { type: 'open'; url: string }
  | { type: 'nav'; viewId: string; url: string; title: string; canGoBack: boolean }
  | { type: 'load'; viewId: string; state: 'loading' | 'ready' | 'failed'; error?: string }
  | { type: 'blocked'; viewId: string; url: string; reason: string };

const MAX_URL = 8000;

export function browsePrefsOf(snap: { allowOpenExternal?: boolean; trustInsecureLinks?: boolean } | null | undefined): ExternalBrowsePrefs {
  return {
    allowOpenExternal: snap?.allowOpenExternal !== false,
    trustInsecureLinks: snap?.trustInsecureLinks === true,
  };
}

/** 去掉空白和控制字符后再认 javascript:，避免用换行绕过。 */
export function isJavascriptUrl(raw: string): boolean {
  const compact = raw.replace(/[\u0000-\u001F\u007F\s]+/g, '');
  return /^javascript:/i.test(compact);
}

function isWorkbenchUrl(raw: string): boolean {
  return /^(kbfile|kbplugin):/i.test(raw.trim());
}

/**
 * 用户点到或输入的地址该怎么处理。
 * ignore：页内锚点、相对路径，不是外链。
 * block：开关关着，或未信任的非 http(s)。调用方维持原来的拦截。
 * open：在主窗口内容区打开。
 * deny：javascript: 或工作台协议，任何开关都不放行。
 */
export function decideExternalLink(raw: string, prefs: ExternalBrowsePrefs): ExternalLinkDecision {
  if (typeof raw !== 'string') return { action: 'ignore' };
  let text = raw.trim();
  if (!text || text.length > MAX_URL) return text ? { action: 'block' } : { action: 'ignore' };
  if (text.startsWith('#')) return { action: 'ignore' };
  if (text.startsWith('//')) text = `https:${text}`;
  if (isJavascriptUrl(text)) return { action: 'deny', reason: 'javascript' };
  if (isWorkbenchUrl(text)) return { action: 'deny', reason: 'workbench' };
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) return { action: 'ignore' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { action: 'ignore' };
  }
  const proto = url.protocol.toLowerCase();
  if (proto === 'javascript:') return { action: 'deny', reason: 'javascript' };
  if (proto === 'kbfile:' || proto === 'kbplugin:') return { action: 'deny', reason: 'workbench' };
  if (proto === 'http:' || proto === 'https:') {
    if (!url.hostname) return { action: 'block' };
    if (!prefs.allowOpenExternal) return { action: 'block' };
    return { action: 'open', url: url.toString() };
  }
  if (!prefs.allowOpenExternal || !prefs.trustInsecureLinks) return { action: 'block' };
  return { action: 'open', url: url.toString() };
}

export function externalLinkRejectReason(decision: ExternalLinkDecision): string {
  if (decision.action === 'deny' && decision.reason === 'javascript') return '已拒绝 javascript: 链接';
  if (decision.action === 'deny') return '这个地址会访问工作台数据，已拒绝';
  if (decision.action === 'block') return '按当前设置，这个链接不在应用内打开';
  return '地址无效';
}

/**
 * 浏览视图里的请求。子资源的 http(s)、ws(s)、blob 始终放行，否则视频播不了。
 * 顶层文档仍走 decideExternalLink。工作台协议和 javascript: 一律取消。
 */
export function browseRequestAllowed(url: string, isMain: boolean, prefs: ExternalBrowsePrefs): boolean {
  if (!url || url === 'about:blank' || url === 'about:srcdoc') return true;
  if (isJavascriptUrl(url) || isWorkbenchUrl(url)) return false;
  if (/^(data|blob):/i.test(url)) return !isMain || prefs.trustInsecureLinks;
  if (/^wss?:/i.test(url)) return !isMain || decideExternalLink(url, prefs).action === 'open';
  if (/^https?:/i.test(url)) {
    if (!isMain) return true;
    return decideExternalLink(url, prefs).action === 'open';
  }
  if (!isMain && !prefs.trustInsecureLinks) return false;
  if (isMain) return decideExternalLink(url, prefs).action === 'open';
  return prefs.trustInsecureLinks;
}

export function browseTabTitle(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.hostname || '外链';
    if (u.protocol === 'file:') {
      const name = u.pathname.split(/[/\\]/).filter(Boolean).pop();
      return name ? decodeURIComponent(name) : '本地文件';
    }
    return u.protocol.replace(':', '') || '外链';
  } catch {
    return '外链';
  }
}

/** 地址栏「用系统浏览器打开」。http(s) 交给系统；file: 只在已信任时交给系统打开路径。 */
export function systemBrowserTarget(url: string): { kind: 'external'; url: string } | { kind: 'file'; url: string } | { kind: 'reject'; reason: string } {
  if (typeof url !== 'string' || !url.trim()) return { kind: 'reject', reason: '还没有地址' };
  if (isJavascriptUrl(url)) return { kind: 'reject', reason: '已拒绝 javascript: 链接' };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { kind: 'reject', reason: '地址无效' };
  }
  if (u.protocol === 'kbfile:' || u.protocol === 'kbplugin:') return { kind: 'reject', reason: '这个地址不能交给系统打开' };
  if (u.protocol === 'http:' || u.protocol === 'https:') {
    if (u.username || u.password) return { kind: 'reject', reason: '地址中不允许包含用户名或密码' };
    if (!u.hostname) return { kind: 'reject', reason: '地址无效' };
    return { kind: 'external', url: u.toString() };
  }
  if (u.protocol === 'file:') return { kind: 'file', url: u.toString() };
  return { kind: 'reject', reason: '这个地址不能用系统浏览器打开' };
}
