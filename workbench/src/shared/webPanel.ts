/**
 * 网页面板（H9，SDK §6.3 / §12.2）：主进程 WebContentsView 管理器与渲染进程之间的共享定义与纯函数。
 * 域名判定全部复用 SDK policy（checkNavigation / isHostAllowed），这里只组合：
 *  - 顶层导航：net.domains；子框架与子资源：domains ∪ resourceDomains（D1）
 *  - 系统浏览器：只允许 https、无 userinfo（D2）
 */
import { checkNavigation, isHostAllowed } from './adapter-sdk/policy';
import type { AdapterContribution, NavigateResult, NetPermission, WebAdapterOptions } from './adapter-sdk/types';

export function netDecl(a: Pick<AdapterContribution, 'permissions'> | undefined): NetPermission | undefined {
  return a?.permissions.find((p): p is NetPermission => p.kind === 'net' && !p.optional) ?? a?.permissions.find((p): p is NetPermission => p.kind === 'net');
}

/** 宿主派生的分区名（插件不能指定）：持久 persist:kbweb.<id>，临时 kbweb-mem.<id> */
export function webPartition(pluginId: string, mode: WebAdapterOptions['session']['partition'] = 'persistent'): string {
  return mode === 'ephemeral' ? `kbweb-mem.${pluginId}` : `persist:kbweb.${pluginId}`;
}

export function navDomains(a: Pick<AdapterContribution, 'permissions'> | undefined): string[] {
  return [...(netDecl(a)?.domains ?? [])];
}
/** D1：子资源只允许 domains ∪ resourceDomains（缺省 resourceDomains = domains） */
export function resourceDomainsOf(a: Pick<AdapterContribution, 'permissions'> | undefined): string[] {
  const n = netDecl(a);
  if (!n) return [];
  return [...new Set([...n.domains, ...(n.resourceDomains ?? [])])];
}

/**
 * 子资源/子框架检查：只允许 https、默认端口、无 userinfo、主机在白名单。
 * data:/blob: 子资源不经过网络（不在 webRequest 中出现），由页面自身产生，允许；其他协议（file:、kbfile:、http: …）一律拒绝。
 */
export function checkSubresource(url: string, domains: readonly string[], opts?: { allowHttp?: boolean }): NavigateResult {
  if (/^(data|blob):/i.test(url)) return { ok: true };
  return checkNavigation(url, domains, opts);
}

/** D2：交给系统浏览器的地址只能是 https（不含 userinfo、不是 IP 以外的奇怪写法由 URL 解析统一） */
export function externalUrlError(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return '地址无效';
  }
  if (u.protocol !== 'https:') return `只允许用系统浏览器打开 https 地址（实际为 ${u.protocol.replace(/:$/, '')}）`;
  if (u.username || u.password) return '地址中不允许包含用户名或密码';
  if (!u.hostname) return '地址无效';
  return null;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host || url.slice(0, 80);
  } catch {
    return url.slice(0, 80);
  }
}

export { isHostAllowed };

export type WebBlockReason = 'domain-blocked' | 'scheme-blocked' | 'popup-blocked' | 'download-blocked';

/** 主进程 → 渲染进程的网页面板事件（kb:web-event） */
export type WebEvent =
  | { viewId: string; type: 'navigate'; url: string; inPage: boolean; canGoBack: boolean; canGoForward: boolean; title: string }
  | { viewId: string; type: 'load'; state: 'loading' | 'ready' | 'failed'; error?: string }
  | { viewId: string; type: 'scroll'; x: number; y: number }
  | { viewId: string; type: 'zoom'; scale: number }
  | { viewId: string; type: 'blocked'; url: string; reason: WebBlockReason; external: boolean }
  | { viewId: string; type: 'resource-blocked'; host: string; count: number }
  /** r12：当前页被拦的网站，去重并带计数。渲染进程用同一条提示条替换，不按资源另开提示。 */
  | { viewId: string; type: 'external-sites'; sites: { site: string; count: number }[]; blockedCount: number }
  | { viewId: string; type: 'gone'; reason: string }
  // ---- r11-A 网络资料：逐站授权（SDK 修订 10）——顶层导航到尚未批准的主机，主进程已取消，等用户在“允许访问 <host>？”中决定
  | { viewId: string; type: 'site-prompt'; host: string; url: string }
  // ---- r11-A：允许的主机变化（逐站批准 / 撤销后）
  | { viewId: string; type: 'access'; allowedDomains: string[]; resourceDomains: string[] };

/** webCreate 的返回：只读信息，全部由主进程按 manifest 与授权派生 */
export interface WebViewInfo {
  viewId: string;
  partition: string;
  allowedDomains: string[];
  resourceDomains: string[];
  homeUrl: string;
  offDomain: WebAdapterOptions['offDomain'];
  popups: WebAdapterOptions['popups'];
  downloads: WebAdapterOptions['downloads'];
  /** r11-A：逐站授权（net.mode = ask-per-site，仅内置 web.generic）；allowedDomains 是当前已批准的主机 */
  perSite?: boolean;
}

export interface WebBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 渲染进程用于判定“工作台浮层”的选择器：与这些元素相交的网页面板被隐藏（原生视图总在 DOM 之上，见 docs/06 §11.3） */
export const OVERLAY_SELECTOR = '.kb-dialog-backdrop, .kb-popover, .states-sheet, [data-kb-overlay]';

/** 滚动位置上报间隔（SDK：宿主节流 ≥ 250 ms） */
export const SCROLL_POLL_MS = 300;

/** 网页面板外框的显示状态（渲染进程；纯函数便于单测） */
export interface WebUiState {
  url: string | null;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  load: 'loading' | 'ready' | 'failed' | 'idle';
  error?: string;
  blocked: { url: string; reason: string; external: boolean; n: number } | null;
  resourcesBlocked: number;
  resourceHosts: string[];
  /** r12：还在等决定的网站。空数组表示不显示提示条。 */
  externalSites: { site: string; count: number }[];
  /** r11-A：等待用户决定的逐站授权（最近一次） */
  sitePrompt?: { host: string; url: string } | null;
  /** 会话内页面比例。缺省按 1。不写入工作区。 */
  zoom?: number;
}
export const initialWebUi: WebUiState = { url: null, title: '', canGoBack: false, canGoForward: false, load: 'idle', blocked: null, resourcesBlocked: 0, resourceHosts: [], externalSites: [], sitePrompt: null };

export function reduceWebUi(s: WebUiState, ev: WebEvent): WebUiState {
  switch (ev.type) {
    case 'navigate':
      return { ...s, url: ev.url, title: ev.title, canGoBack: ev.canGoBack, canGoForward: ev.canGoForward };
    case 'external-sites':
      return { ...s, externalSites: ev.sites, resourcesBlocked: ev.blockedCount, resourceHosts: ev.sites.map((row) => row.site) };
    case 'load':
      return { ...s, load: ev.state, error: ev.state === 'failed' ? ev.error : undefined };
    case 'blocked':
      return { ...s, blocked: { url: ev.url, reason: ev.reason, external: ev.external, n: (s.blocked?.n ?? 0) + 1 } };
    case 'resource-blocked':
      return { ...s, resourcesBlocked: ev.count, resourceHosts: s.resourceHosts.includes(ev.host) ? s.resourceHosts : [...s.resourceHosts, ev.host].slice(-10) };
    case 'site-prompt':
      return { ...s, sitePrompt: { host: ev.host, url: ev.url } };
    case 'access':
      // 新批准的主机不再计入“被拦截的子资源主机”
      return { ...s, resourceHosts: s.resourceHosts.filter((h) => !ev.resourceDomains.includes(h)) };
    case 'zoom':
      return { ...s, zoom: ev.scale };
    default:
      return s;
  }
}

