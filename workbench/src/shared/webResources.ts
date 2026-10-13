/**
 * 网络资料（第 11 轮 A · 星图组）：主进程与渲染进程共用的类型与纯函数。
 *  - sanitizeWebRef：网址规范化（只允许 http/https；去 query、fragment、账号密码；拒绝 IP、非默认端口、单级主机）
 *  - normalizeUserInput：地址栏输入 → 完整网址（缺协议时补 https://）
 *  - classifyWebContent：直链判型（Content-Type + 扩展名 + 魔数），白名单 PDF / png / jpeg / gif / webp / md / txt
 */
import { siteHostError } from './adapter-sdk/policy';

export interface WebResource {
  resourceId: string;
  /** sanitize 后的网址（无 query / fragment / 账号密码） */
  url: string;
  title: string;
  /** 最近一次已知的 Content-Type（网页为 text/html；直链为下载时的响应头） */
  contentType: string | null;
  /** 打开方式：web.generic（网页面板）或 web.file（直链缓存后交给内置阅读器） */
  adapterId: string;
  /** 直链类型的扩展名（pdf / png / jpg / gif / webp / md / txt），网页为 '' */
  ext: string;
  addedAt: number;
  lastOpenedAt: number | null;
  favorite: boolean;
  favoriteAt: number | null;
  /** 直链已缓存到本地（<userData>/web-cache/<resourceId>/） */
  cached: boolean;
  cacheBytes: number | null;
  cachedAt: number | null;
  host: string;
}

/** kb:web-resources-change 的载荷 */
export interface WebResourcesChange {
  type: 'add' | 'update' | 'remove';
  resourceId: string;
}

/** webFetchCache 的结果：cached（交给阅读器）/ html / unknown / conflict（提示“无法识别类型，仍按网页打开 / 取消”）/ site-not-granted / 可重试错误 */
export type FetchCacheResult =
  | { ok: true; kind: 'cached'; resource: WebResource }
  | { ok: false; kind: 'html' | 'unknown' | 'conflict'; detail: string; contentType: string }
  | { ok: false; kind: 'site-not-granted'; host: string; url: string }
  | { ok: false; kind: 'error'; reason: 'network' | 'timeout' | 'http' | 'too-large' | 'blocked'; status?: number; detail: string };


export type WebFileExt = 'pdf' | 'png' | 'jpeg' | 'gif' | 'webp' | 'md' | 'txt';
export const WEB_FILE_MIME: Record<WebFileExt, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  md: 'text/markdown',
  txt: 'text/plain',
};
const EXT_ALIASES: Record<string, WebFileExt> = { pdf: 'pdf', png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', webp: 'webp', md: 'md', markdown: 'md', txt: 'txt' };
const MIME_EXT: Record<string, WebFileExt> = {
  'application/pdf': 'pdf',
  'application/x-pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/pjpeg': 'jpeg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'text/markdown': 'md',
  'text/x-markdown': 'md',
  'text/plain': 'txt',
};
const BINARY: ReadonlySet<WebFileExt> = new Set(['pdf', 'png', 'jpeg', 'gif', 'webp']);

export type WebSanitizeResult = { ok: true; url: string; host: string; scheme: 'http' | 'https' } | { ok: false; reason: string };

export function sanitizeWebRef(input: string): WebSanitizeResult {
  let u: URL;
  try {
    u = new URL(String(input ?? '').trim());
  } catch {
    return { ok: false, reason: '网址无效' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: `只支持 http / https 网址（实际为 ${u.protocol.replace(/:$/, '') || '空'}）` };
  if (u.port !== '') return { ok: false, reason: `不支持带端口的网址: ${u.host}` };
  const herr = siteHostError(u.hostname);
  if (herr) return { ok: false, reason: herr };
  u.username = '';
  u.password = '';
  u.search = '';
  u.hash = '';
  const url = u.toString();
  if (url.length > 2048) return { ok: false, reason: '网址过长（上限 2048 字符）' };
  return { ok: true, url, host: u.hostname, scheme: u.protocol === 'http:' ? 'http' : 'https' };
}

/** 地址栏输入：缺协议时补 https://（"example.com/a" → "https://example.com/a"）；不做 sanitize（调用方自行检查） */
export function normalizeUserInput(input: string): string {
  const t = String(input ?? '').trim();
  if (!t) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[\w.-]+:\d+(\/|$)/.test(t)) return t;
  return `https://${t.replace(/^\/+/, '')}`;
}

/** 网址路径的扩展名（白名单内才返回；jpg → jpeg） */
export function webExtOfUrl(url: string): WebFileExt | null {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
    const m = /\.([a-z0-9]{1,8})$/i.exec(last);
    return m ? (EXT_ALIASES[m[1].toLowerCase()] ?? null) : null;
  } catch {
    return null;
  }
}

/** 路径有扩展名但不在白名单（例如 .zip / .html）时返回它；无扩展名返回 null */
function rawExtOfName(name: string): string | null {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name);
  return m ? m[1].toLowerCase() : null;
}

export function sniffWebFile(head: Uint8Array): WebFileExt | null {
  const b = head;
  const s = (i: number, str: string) => [...str].every((c, k) => b[i + k] === c.charCodeAt(0));
  if (b.length >= 5 && s(0, '%PDF-')) return 'pdf';
  if (b.length >= 8 && b[0] === 0x89 && s(1, 'PNG') && b[4] === 0x0d && b[5] === 0x0a) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 6 && (s(0, 'GIF87a') || s(0, 'GIF89a'))) return 'gif';
  if (b.length >= 12 && s(0, 'RIFF') && s(8, 'WEBP')) return 'webp';
  return null;
}

function looksBinary(head: Uint8Array): boolean {
  for (let i = 0; i < head.length; i++) if (head[i] === 0) return true;
  return false;
}

function looksHtml(head: Uint8Array): boolean {
  const t = new TextDecoder('utf-8', { fatal: false }).decode(head).trimStart().slice(0, 32).toLowerCase();
  return t.startsWith('<!doctype html') || t.startsWith('<html');
}

function fileNameOf(url: string, contentDisposition: string): string {
  const cd = String(contentDisposition ?? '');
  const star = /filename\*\s*=\s*(?:utf-8|UTF-8)''([^;]+)/.exec(cd);
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  let name = '';
  try {
    name = star ? decodeURIComponent(star[1].trim()) : plain ? plain[1].trim() : decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
  } catch {
    name = '';
  }
  return safeCacheFileName(name || 'download');
}

/** 缓存 / 保存用的文件名：去掉路径分隔符、控制字符与 Windows 保留字符，限制长度 */
export function safeCacheFileName(name: string): string {
  let n = String(name ?? '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120);
  if (!n || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = `file${n ? `_${n}` : ''}`;
  return n;
}

export type WebClassifyResult =
  | { kind: 'file'; ext: WebFileExt; fileName: string; mime: string }
  | { kind: 'html'; detail: string }
  | { kind: 'unknown'; detail: string }
  | { kind: 'conflict'; detail: string };

/**
 * 直链判型（A5）：
 *  - text/html / xhtml → html（按网页打开）
 *  - 白名单二进制类型（PDF / 图片）：魔数必须吻合，网址扩展名（若在白名单）必须一致，否则 conflict
 *  - text/plain / text/markdown：内容不能是二进制；网址扩展名是二进制白名单类型时 conflict；.md 按 Markdown
 *  - 缺失或 application/octet-stream：靠魔数；文本只在网址扩展名为 .md / .txt 且内容无 NUL 时接受；否则 unknown
 *  - 其他类型（zip、json…）→ unknown
 * 不静默把未知类型当二进制解码：unknown / conflict 由界面提示“无法识别类型，仍按网页打开 / 取消”。
 */
export function classifyWebContent(url: string, contentType: string, head: Uint8Array, contentDisposition = ''): WebClassifyResult {
  const mime = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  const fileName = fileNameOf(url, contentDisposition);
  const nameExtRaw = rawExtOfName(fileName);
  const nameExt = nameExtRaw ? (EXT_ALIASES[nameExtRaw] ?? null) : null;
  const sniff = sniffWebFile(head);
  const file = (ext: WebFileExt): WebClassifyResult => ({ kind: 'file', ext, fileName, mime: WEB_FILE_MIME[ext] });
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return { kind: 'html', detail: '这是网页（text/html）' };
  const mimeExt = MIME_EXT[mime];
  if (mimeExt && BINARY.has(mimeExt)) {
    if (sniff !== mimeExt) return { kind: 'conflict', detail: `内容与声明的类型（${mime}）不符` };
    if (nameExt && nameExt !== mimeExt) return { kind: 'conflict', detail: `扩展名 .${nameExtRaw} 与类型 ${mime} 冲突` };
    return file(mimeExt);
  }
  if (mimeExt) {
    // text/plain、text/markdown
    if (looksBinary(head) || sniff) return { kind: 'conflict', detail: `声明为文本（${mime}），内容却是二进制` };
    if (looksHtml(head) && nameExt !== 'md' && nameExt !== 'txt') return { kind: 'html', detail: '内容是网页' };
    if (nameExt && BINARY.has(nameExt)) return { kind: 'conflict', detail: `扩展名 .${nameExtRaw} 与类型 ${mime} 冲突` };
    if (nameExtRaw && !nameExt && !['text', 'log'].includes(nameExtRaw)) return { kind: 'conflict', detail: `扩展名 .${nameExtRaw} 不在支持范围` };
    return file(nameExt === 'md' || mimeExt === 'md' ? 'md' : 'txt');
  }
  if (!mime || mime === 'application/octet-stream' || mime === 'binary/octet-stream') {
    if (sniff) {
      if (nameExt && nameExt !== sniff) return { kind: 'conflict', detail: `扩展名 .${nameExtRaw} 与内容（${sniff}）冲突` };
      return file(sniff);
    }
    if ((nameExt === 'md' || nameExt === 'txt') && !looksBinary(head)) return file(nameExt);
    return { kind: 'unknown', detail: mime ? `无法识别类型（${mime}）` : '服务器没有给出类型' };
  }
  return { kind: 'unknown', detail: `不支持的类型（${mime}）` };
}

/** 是否 http（不安全连接，界面标注） */
export function isInsecureUrl(url: string | null | undefined): boolean {
  return typeof url === 'string' && /^http:\/\//i.test(url);
}

/** 内置网页适配器 id */
export const WEB_GENERIC_ADAPTER = 'web.generic';
export const WEB_GENERIC_PLUGIN = 'web.generic';
/** 直链阅读器（渲染进程内置）适配器 id */
export const WEB_FILE_ADAPTER = 'web.file';
