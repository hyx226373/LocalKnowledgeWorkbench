/**
 * 网页面板外部资源按网站授权（r12）。
 * 授权单位是可注册域名：example.com 覆盖 cdn.example.com；第三方 CDN 用自己的可注册域名。
 * 判断只读内存快照，O(1) 查表，不做磁盘 IO。
 */
import { checkSubresource } from './webPanel';

/** 全局开关的固定提示。界面必须原样出现这句。 */
export const GLOBAL_NEVER_BLOCK_WARNING = '所有网页面板将不再拦截外部资源';

export const WEB_SITE_GRANT_FILE = 'web-site-grants.json';

export const WEB_SITE_ACTIONS = ['web.allowSite', 'web.allowAllBlocked', 'web.neverBlock', 'web.revokeSite'] as const;
export type WebSiteActionId = (typeof WEB_SITE_ACTIONS)[number];

export type SiteDecision = 'allow' | 'deny' | 'never-block';
export type SiteSource = 'manual' | 'allow-all';
export type SitePersistence = 'session' | 'always';
export type SiteChoice = 'session' | 'always' | 'deny';

export interface SiteGrant {
  decision: SiteDecision;
  persistence: SitePersistence;
  source: SiteSource;
  at: string;
}

export interface GrantSnapshot {
  globalNeverBlock: boolean;
  /** 键是可注册域名。调用方持有的就是内存表，判断时不得复制。 */
  sites: ReadonlyMap<string, SiteGrant>;
}

export const EMPTY_GRANTS: GrantSnapshot = { globalNeverBlock: false, sites: new Map() };

/** 写入配置文件的形状。本次允许不进文件。 */
export interface WebSiteGrantDocument {
  version: 1;
  globalNeverBlock: boolean;
  sites: Record<string, { decision: SiteDecision; source: SiteSource; at: string }>;
}

export interface WebSiteGrantRow extends SiteGrant {
  site: string;
}

export interface SubresourceJudgment {
  action: 'allow' | 'cancel';
  /** 还没决定，应进入同一条提示，不准再开新提示。 */
  prompt: boolean;
  site: string | null;
  reason: 'declared' | 'data' | 'scheme' | 'credential' | 'port' | 'ip' | 'invalid' | 'global' | 'grant' | 'denied' | 'pending';
}

/**
 * 多级公共后缀。没有完整 PSL；这些后缀下面再取一级才是网站。
 * github.io 这类托管后缀各自成站，不会因为允许一个用户而放行整个后缀。
 */
const MULTI_SUFFIXES = [
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'ltd.uk', 'plc.uk', 'me.uk', 'net.uk',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
  'co.kr', 'ne.kr', 'or.kr',
  'com.hk', 'com.tw', 'com.sg', 'com.br', 'com.mx', 'co.nz', 'co.za', 'com.tr', 'co.in', 'com.ar',
  'github.io', 'blogspot.com', 'vercel.app', 'netlify.app', 'pages.dev',
  'cloudfront.net', 'amazonaws.com', 'azurewebsites.net', 'herokuapp.com', 'github.io',
].sort((a, b) => b.length - a.length);

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** 可注册域名。IP、非法主机返回 null。单标签（localhost）就是它自己。 */
export function registrableDomain(host: string): string | null {
  if (typeof host !== 'string') return null;
  let h = host.trim().toLowerCase();
  if (h.startsWith('*.')) h = h.slice(2);
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (!h || h.includes('..') || h.includes('*') || h.includes('/') || h.includes(':') || h.startsWith('[')) return null;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return null;
  const labels = h.split('.');
  if (labels.some((label) => !LABEL.test(label))) return null;
  if (labels.length === 1) return labels[0]!;
  const suffix = MULTI_SUFFIXES.find((item) => h === item || h.endsWith('.' + item));
  if (suffix) {
    if (h === suffix) return h;
    const left = h.slice(0, -(suffix.length + 1)).split('.').pop();
    return left ? `${left}.${suffix}` : null;
  }
  return labels.slice(-2).join('.');
}

export function emptyDocument(): WebSiteGrantDocument {
  return { version: 1, globalNeverBlock: false, sites: {} };
}

export function serializeWebSiteGrantDocument(doc: WebSiteGrantDocument): string {
  const sites: WebSiteGrantDocument['sites'] = {};
  for (const site of Object.keys(doc.sites).sort()) sites[site] = doc.sites[site]!;
  return JSON.stringify({ version: 1, globalNeverBlock: doc.globalNeverBlock === true, sites }, null, 2) + '\n';
}

function isDecision(v: unknown): v is SiteDecision {
  return v === 'allow' || v === 'deny' || v === 'never-block';
}

function isSource(v: unknown): v is SiteSource {
  return v === 'manual' || v === 'allow-all';
}

/** 读配置。坏文件返回 null，调用方保持空表，不把坏内容写回去。 */
export function parseWebSiteGrantDocument(text: string): WebSiteGrantDocument | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as { version?: unknown; globalNeverBlock?: unknown; sites?: unknown };
  if (body.version !== 1 || !body.sites || typeof body.sites !== 'object' || Array.isArray(body.sites)) return null;
  const sites: WebSiteGrantDocument['sites'] = {};
  for (const [key, value] of Object.entries(body.sites as Record<string, unknown>)) {
    const site = registrableDomain(key);
    if (!site || !value || typeof value !== 'object') continue;
    const row = value as { decision?: unknown; source?: unknown; at?: unknown };
    if (!isDecision(row.decision)) continue;
    const source = isSource(row.source) ? row.source : 'manual';
    const at = typeof row.at === 'string' && row.at ? row.at : '';
    sites[site] = { decision: row.decision, source, at };
  }
  return { version: 1, globalNeverBlock: body.globalNeverBlock === true, sites };
}

/**
 * 子资源是否放行。已声明的域名仍走原来的精确/通配检查。
 * 只有“主机不在声明里”才查网站授权。协议、账号、端口、IP 一律不放行，全局开关也不例外。
 */
export function judgeSubresource(url: string, domains: readonly string[], opts: { allowHttp?: boolean } | undefined, snap: GrantSnapshot): SubresourceJudgment {
  if (/^(data|blob):/i.test(url)) return { action: 'allow', prompt: false, site: null, reason: 'data' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { action: 'cancel', prompt: false, site: null, reason: 'invalid' };
  }
  const allowHttp = opts?.allowHttp === true;
  if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) return { action: 'cancel', prompt: false, site: null, reason: 'scheme' };
  if (parsed.username || parsed.password) return { action: 'cancel', prompt: false, site: null, reason: 'credential' };
  if (parsed.port !== '') return { action: 'cancel', prompt: false, site: null, reason: 'port' };
  const host = parsed.hostname.toLowerCase();
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')) return { action: 'cancel', prompt: false, site: null, reason: 'ip' };
  const site = registrableDomain(host);
  if (checkSubresource(url, domains, opts).ok) return { action: 'allow', prompt: false, site, reason: 'declared' };
  if (!site) return { action: 'cancel', prompt: false, site: null, reason: 'invalid' };
  if (snap.globalNeverBlock) return { action: 'allow', prompt: false, site, reason: 'global' };
  const grant = snap.sites.get(site);
  if (grant && (grant.decision === 'allow' || grant.decision === 'never-block')) return { action: 'allow', prompt: false, site, reason: 'grant' };
  if (grant?.decision === 'deny') return { action: 'cancel', prompt: false, site, reason: 'denied' };
  return { action: 'cancel', prompt: true, site, reason: 'pending' };
}

/** 同一网站合并成一行。已在列表里的只加计数，不新增一行。 */
export function bumpBanner(rows: readonly { site: string; count: number }[], site: string): { site: string; count: number }[] {
  const index = rows.findIndex((row) => row.site === site);
  if (index < 0) return [...rows, { site, count: 1 }];
  const next = rows.slice();
  next[index] = { site, count: rows[index]!.count + 1 };
  return next;
}

export interface WebSiteApplyRequest {
  actionId: WebSiteActionId;
  site?: string;
  choice?: SiteChoice;
  sites?: string[];
  /** web.neverBlock：true 表示全局开关，不是单个网站。 */
  global?: boolean;
  /** 全局开关的目标。缺省为打开。 */
  enabled?: boolean;
  viewId?: string;
}

export interface WebSiteApplyResult {
  status: 'success' | 'failed' | 'awaiting_approval';
  actionId: string;
  executed: boolean;
  reload: 'none' | 'view' | 'all';
  sites?: string[];
  error?: { code: string; message: string };
}

export interface WebSiteGrantWriter {
  allow(site: string, choice: SiteChoice, source: SiteSource): Promise<void>;
  allowAll(sites: readonly string[]): Promise<void>;
  neverBlockSite(site: string): Promise<void>;
  setGlobalNeverBlock(enabled: boolean): Promise<void>;
  revoke(site: string): Promise<void>;
}

function oneSite(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  return registrableDomain(input);
}

function manySites(input: unknown): string[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > 200) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const site = oneSite(item);
    if (!site) return null;
    if (seen.has(site)) continue;
    seen.add(site);
    out.push(site);
  }
  return out;
}

/**
 * 人机界面把 approved 设为 true 之后才改授权。
 * 文件桥上的 approved 到不了这里：桥见 approvalRequired 就返回 awaiting_approval。
 */
export async function runWebSiteApply(store: WebSiteGrantWriter, req: WebSiteApplyRequest, approved: boolean): Promise<WebSiteApplyResult> {
  const actionId = typeof req?.actionId === 'string' ? req.actionId : '';
  if (approved !== true) return { status: 'awaiting_approval', actionId, executed: false, reload: 'none' };
  if (actionId === 'web.allowSite') {
    const site = oneSite(req.site);
    const choice = req.choice;
    if (!site || (choice !== 'session' && choice !== 'always' && choice !== 'deny')) {
      return { status: 'failed', actionId, executed: false, reload: 'none', error: { code: 'invalid_args', message: 'web.allowSite 需要网站和选择（允许本次、始终允许或拒绝）' } };
    }
    await store.allow(site, choice, 'manual');
    return { status: 'success', actionId, executed: true, reload: choice === 'deny' ? 'none' : 'view', sites: [site] };
  }
  if (actionId === 'web.allowAllBlocked') {
    const sites = manySites(req.sites);
    if (!sites) return { status: 'failed', actionId, executed: false, reload: 'none', error: { code: 'invalid_args', message: 'web.allowAllBlocked 需要当前被拦网站列表' } };
    await store.allowAll(sites);
    return { status: 'success', actionId, executed: true, reload: 'view', sites };
  }
  if (actionId === 'web.neverBlock') {
    if (req.global === true) {
      await store.setGlobalNeverBlock(req.enabled !== false);
      return { status: 'success', actionId, executed: true, reload: 'all' };
    }
    const site = oneSite(req.site);
    if (!site) return { status: 'failed', actionId, executed: false, reload: 'none', error: { code: 'invalid_args', message: 'web.neverBlock 需要网站或全局开关' } };
    if (req.enabled === false) {
      await store.revoke(site);
      return { status: 'success', actionId, executed: true, reload: 'view', sites: [site] };
    }
    await store.neverBlockSite(site);
    return { status: 'success', actionId, executed: true, reload: 'view', sites: [site] };
  }
  if (actionId === 'web.revokeSite') {
    const site = oneSite(req.site);
    if (!site) return { status: 'failed', actionId, executed: false, reload: 'none', error: { code: 'invalid_args', message: 'web.revokeSite 需要网站' } };
    await store.revoke(site);
    return { status: 'success', actionId, executed: true, reload: 'view', sites: [site] };
  }
  return { status: 'failed', actionId, executed: false, reload: 'none', error: { code: 'unknown_action', message: `未知操作：${actionId}` } };
}
