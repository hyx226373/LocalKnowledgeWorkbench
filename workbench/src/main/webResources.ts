/**
 * 网络资料（第 11 轮 A · 星图组，总包 §2.1）：网址作为一等资料。
 *
 * - 表 web_resources：每条网址一个 UUID v4 resourceId（同一 url 只有一条 → 稳定身份），url 经 sanitizeWebRef（去 query / fragment / 账号密码）。
 *   本组不占迁移号：建表写成幂等函数 migrateWebResources(db)，由集成负责人追加到 db.ts 的 MIGRATIONS（见 REPORT）；在此之前由主进程启动时调用。
 * - 直链缓存（A5）：公开 PDF / 图片 / md / txt 由主进程受控下载到 <userData>/web-cache/<resourceId>/<文件名>，
 *   再通过 WorkbenchService.externalResources 钩子让现有阅读器把它当本地文件读（getResource / resolveResourcePath / kbfile://res）。
 *   缓存文件只读：所有写操作仍按 resources 表查找，web resourceId 不在其中，天然失败（首轮只读，不写回远程）。
 * - 索引边界（A7）：不抓网页正文；标题与网址参与文件名式搜索（searchWeb → matchKind 'name'）；
 *   已缓存的直链文件通过 cachedFilesForIndex() 暴露给 E（索引组）按本地文件做正文索引，本组不实现索引。
 * 不依赖 Electron（下载由调用方注入，便于单测）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DB } from './service/db';
import type { ResourceInfo, SearchHit, WorkspaceRef } from '../shared/types';
import { readerTypeOf } from '../shared/types';
import type { FetchCacheResult, WebFileExt, WebResource, WebSanitizeResult, WebClassifyResult } from '../shared/webResources';
export type { FetchCacheResult };
import { WEB_FILE_MIME, classifyWebContent, sanitizeWebRef, safeCacheFileName } from '../shared/webResources';

export { sanitizeWebRef, classifyWebContent };

/** 删掉缓存目录。Windows 上 chmod 0o444 会变成只读属性，直接 rm 会 EPERM，先清掉再删。 */
function rmCacheTree(dir: string) {
  if (process.platform === 'win32' && fs.existsSync(dir)) {
    const clear = (d: string) => {
      let ents: fs.Dirent[] = [];
      try {
        ents = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of ents) {
        const child = path.join(d, ent.name);
        if (ent.isDirectory()) clear(child);
        else {
          try {
            fs.chmodSync(child, 0o666);
          } catch {
            /* 清不掉就交给下面的 rm */
          }
        }
      }
    };
    clear(dir);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

/** 建表（幂等，不占迁移号）：集成负责人把 migrateWebResources 追加到 MIGRATIONS 末尾即可，函数体不变 */
export const WEB_RESOURCES_SQL = `
CREATE TABLE IF NOT EXISTS web_resources (
  resource_id   TEXT PRIMARY KEY,
  url           TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL DEFAULT '',
  content_type  TEXT,
  adapter_id    TEXT NOT NULL DEFAULT 'web.generic',
  ext           TEXT NOT NULL DEFAULT '',
  added_at      INTEGER NOT NULL,
  last_opened_at INTEGER,
  favorite_at   INTEGER,
  cache_file    TEXT,
  cache_bytes   INTEGER,
  cached_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_web_resources_last_opened ON web_resources(last_opened_at);
`;
export function migrateWebResources(db: DB): void {
  db.exec(WEB_RESOURCES_SQL);
}

interface Row {
  resource_id: string;
  url: string;
  title: string;
  content_type: string | null;
  adapter_id: string;
  ext: string;
  added_at: number;
  last_opened_at: number | null;
  favorite_at: number | null;
  cache_file: string | null;
  cache_bytes: number | null;
  cached_at: number | null;
}

export class WebResourceError extends Error {
  constructor(
    public readonly code: 'invalid-url' | 'not-found' | 'invalid-request',
    msg: string,
  ) {
    super(`[${code}] ${msg}`);
    this.name = 'WebResourceError';
  }
}

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class WebResourceStore {
  private listeners = new Set<(ev: { type: 'add' | 'update' | 'remove'; resourceId: string }) => void>();

  constructor(
    private db: DB,
    readonly cacheDir: string,
  ) {
    migrateWebResources(db);
  }

  onChange(f: (ev: { type: 'add' | 'update' | 'remove'; resourceId: string }) => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }
  private emit(type: 'add' | 'update' | 'remove', resourceId: string) {
    for (const f of this.listeners) f({ type, resourceId });
  }

  private row(resourceId: string): Row | undefined {
    if (typeof resourceId !== 'string' || !ID_RE.test(resourceId)) return undefined;
    return this.db.prepare('SELECT * FROM web_resources WHERE resource_id=?').get(resourceId) as Row | undefined;
  }

  private dto(r: Row): WebResource {
    const cachePath = r.cache_file ? this.cachePathOf(r.resource_id, r.cache_file) : null;
    return {
      resourceId: r.resource_id,
      url: r.url,
      title: r.title,
      contentType: r.content_type,
      adapterId: r.adapter_id,
      ext: r.ext,
      addedAt: r.added_at,
      lastOpenedAt: r.last_opened_at,
      favorite: r.favorite_at != null,
      favoriteAt: r.favorite_at,
      cached: !!cachePath && fs.existsSync(cachePath),
      cacheBytes: r.cache_bytes,
      cachedAt: r.cached_at,
      host: hostOfSafe(r.url),
    };
  }

  /** 同一 url（sanitize 后）只有一条：已有则返回原 resourceId（可顺带更新标题 / 类型） */
  add(input: { url: string; title?: string; contentType?: string | null; adapterId?: string; ext?: string; opened?: boolean }): WebResource {
    const s = sanitizeWebRef(String(input?.url ?? ''));
    if (!s.ok) throw new WebResourceError('invalid-url', s.reason);
    const now = Date.now();
    const cur = this.db.prepare('SELECT * FROM web_resources WHERE url=?').get(s.url) as Row | undefined;
    if (cur) {
      this.update(cur.resource_id, { ...(input.title ? { title: input.title } : {}), ...(input.contentType !== undefined ? { contentType: input.contentType } : {}), ...(input.adapterId ? { adapterId: input.adapterId } : {}), ...(input.ext !== undefined ? { ext: input.ext } : {}), ...(input.opened ? { opened: true } : {}) });
      return this.get(cur.resource_id)!;
    }
    const id = crypto.randomUUID();
    this.db
      .prepare('INSERT INTO web_resources(resource_id,url,title,content_type,adapter_id,ext,added_at,last_opened_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, s.url, cleanTitle(input.title) || s.host, input.contentType ?? null, cleanAdapter(input.adapterId), cleanExt(input.ext), now, input.opened ? now : null);
    this.emit('add', id);
    return this.get(id)!;
  }

  update(resourceId: string, patch: { title?: string; contentType?: string | null; adapterId?: string; ext?: string; opened?: boolean; favorite?: boolean }): WebResource {
    const r = this.row(resourceId);
    if (!r) throw new WebResourceError('not-found', `网络资料不存在: ${resourceId}`);
    const sets: string[] = [];
    const args: unknown[] = [];
    if (typeof patch.title === 'string' && cleanTitle(patch.title)) (sets.push('title=?'), args.push(cleanTitle(patch.title)));
    if (patch.contentType !== undefined) (sets.push('content_type=?'), args.push(patch.contentType ? String(patch.contentType).slice(0, 200) : null));
    if (typeof patch.adapterId === 'string') (sets.push('adapter_id=?'), args.push(cleanAdapter(patch.adapterId)));
    if (typeof patch.ext === 'string') (sets.push('ext=?'), args.push(cleanExt(patch.ext)));
    if (patch.opened) (sets.push('last_opened_at=?'), args.push(Date.now()));
    if (typeof patch.favorite === 'boolean') (sets.push('favorite_at=?'), args.push(patch.favorite ? (r.favorite_at ?? Date.now()) : null));
    if (sets.length) {
      this.db.prepare(`UPDATE web_resources SET ${sets.join(', ')} WHERE resource_id=?`).run(...args, resourceId);
      this.emit('update', resourceId);
    }
    return this.get(resourceId)!;
  }

  get(resourceId: string): WebResource | null {
    const r = this.row(resourceId);
    return r ? this.dto(r) : null;
  }

  getByUrl(url: string): WebResource | null {
    const s = sanitizeWebRef(String(url ?? ''));
    if (!s.ok) return null;
    const r = this.db.prepare('SELECT * FROM web_resources WHERE url=?').get(s.url) as Row | undefined;
    return r ? this.dto(r) : null;
  }

  has(resourceId: string): boolean {
    return !!this.row(resourceId);
  }

  /** 收藏在前（按收藏时间倒序），其余按最近打开 / 加入时间倒序 */
  list(opts: { favoritesOnly?: boolean; limit?: number } = {}): WebResource[] {
    const n = Math.max(1, Math.min(Number(opts.limit) || 500, 5000));
    const rows = this.db
      .prepare(`SELECT * FROM web_resources ${opts.favoritesOnly ? 'WHERE favorite_at IS NOT NULL' : ''} ORDER BY (favorite_at IS NULL), favorite_at DESC, COALESCE(last_opened_at, added_at) DESC LIMIT ?`)
      .all(n) as Row[];
    return rows.map((r) => this.dto(r));
  }

  /** 删除网络资料记录与缓存（工作区引用保留为“缺失”，由用户自行移除；不会自动删除引用） */
  remove(resourceId: string): boolean {
    const r = this.row(resourceId);
    if (!r) return false;
    this.db.prepare('DELETE FROM web_resources WHERE resource_id=?').run(resourceId);
    rmCacheTree(path.join(this.cacheDir, resourceId));
    this.emit('remove', resourceId);
    return true;
  }

  // ---------------- 直链缓存 ----------------

  /** 缓存文件的绝对路径：<cacheDir>/<resourceId>/<文件名>（文件名经过清洗，不能越出该目录） */
  cachePathOf(resourceId: string, fileName: string): string {
    if (!ID_RE.test(resourceId)) throw new WebResourceError('invalid-request', 'resourceId 不合法');
    const name = safeCacheFileName(fileName);
    const dir = path.join(this.cacheDir, resourceId);
    const abs = path.join(dir, name);
    if (path.dirname(abs) !== dir) throw new WebResourceError('invalid-request', '缓存文件名不合法');
    return abs;
  }

  /** 写入缓存（原子替换）。ext 必须是白名单类型 */
  writeCache(resourceId: string, data: { fileName: string; ext: WebFileExt; contentType: string; bytes: Buffer }): WebResource {
    const r = this.row(resourceId);
    if (!r) throw new WebResourceError('not-found', `网络资料不存在: ${resourceId}`);
    if (!(data.ext in WEB_FILE_MIME)) throw new WebResourceError('invalid-request', `不支持缓存的类型: ${data.ext}`);
    let name = safeCacheFileName(data.fileName);
    if (!name.toLowerCase().endsWith(`.${data.ext}`) && !(data.ext === 'jpeg' && /\.jpe?g$/i.test(name))) name = `${name.replace(/\.[^.]*$/, '') || 'file'}.${data.ext === 'jpeg' ? 'jpg' : data.ext}`;
    const abs = this.cachePathOf(resourceId, name);
    rmCacheTree(path.dirname(abs));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.part-${process.pid}`;
    fs.writeFileSync(tmp, data.bytes);
    fs.renameSync(tmp, abs);
    try {
      fs.chmodSync(abs, 0o444); // 缓存只读（Windows 上是只读属性；删除前由 rmCacheTree 清掉）
    } catch {
      /* 设不了只读时仍保留缓存 */
    }
    this.db
      .prepare('UPDATE web_resources SET cache_file=?, cache_bytes=?, cached_at=?, content_type=?, ext=?, adapter_id=? WHERE resource_id=?')
      .run(name, data.bytes.length, Date.now(), data.contentType.slice(0, 200), data.ext === 'jpeg' ? 'jpg' : data.ext, 'web.file', resourceId);
    this.emit('update', resourceId);
    return this.get(resourceId)!;
  }

  /** 当前缓存文件（不存在返回 null） */
  cacheFile(resourceId: string): string | null {
    const r = this.row(resourceId);
    if (!r?.cache_file) return null;
    const abs = this.cachePathOf(resourceId, r.cache_file);
    return fs.existsSync(abs) ? abs : null;
  }

  dropCache(resourceId: string) {
    if (!ID_RE.test(resourceId)) return;
    rmCacheTree(path.join(this.cacheDir, resourceId));
    this.db.prepare('UPDATE web_resources SET cache_file=NULL, cache_bytes=NULL, cached_at=NULL WHERE resource_id=?').run(resourceId);
    this.emit('update', resourceId);
  }

  // ---------------- WorkbenchService.externalResources 钩子 ----------------

  /** 已缓存的直链 → ResourceInfo（rootId ''；relPath = 缓存文件名；未缓存时 exists=false） */
  resourceInfo(resourceId: string): ResourceInfo | null {
    const r = this.row(resourceId);
    if (!r) return null;
    const abs = r.cache_file ? this.cachePathOf(resourceId, r.cache_file) : null;
    const st = abs ? fs.statSync(abs, { throwIfNoEntry: false }) : undefined;
    const ext = (r.ext || '').toLowerCase();
    return {
      resourceId,
      rootId: '',
      relPath: r.cache_file ?? '',
      name: r.title || r.cache_file || hostOfSafe(r.url),
      kind: 'file',
      size: st?.size ?? 0,
      mtimeMs: Math.round(st?.mtimeMs ?? r.added_at),
      ext,
      exists: !!st,
      readerType: st ? readerTypeOf(ext, 'file') : 'unsupported',
    };
  }

  /** 已缓存直链的绝对路径（只读）；未缓存时抛错 */
  resolvePath(resourceId: string): string {
    const abs = this.cacheFile(resourceId);
    if (!abs) throw new WebResourceError('not-found', '网络资料尚未缓存到本地（需要先在网络资料面板中下载）');
    return abs;
  }

  /** 工作资料中的 web 条目（总包 §2.1：rootId ''、relPath ''、ext ''、kind 'file'） */
  workspaceRef(resourceId: string, addedAt: number): WorkspaceRef | null {
    const r = this.row(resourceId);
    if (!r) return null;
    return { resourceId, rootId: '', rootName: '', relPath: '', name: r.title || hostOfSafe(r.url), ext: '', kind: 'file', missing: false, addedAt, sourceKind: 'web', url: r.url };
  }

  // ---------------- 搜索 / 索引边界 ----------------

  /** 标题与网址的文件名式搜索（matchKind 'name'）；不含网页正文（A7：网络正文索引后置） */
  search(query: string, limit = 20): SearchHit[] {
    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return [];
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = this.db
      .prepare("SELECT * FROM web_resources WHERE lower(title) LIKE ? ESCAPE '\\' OR lower(url) LIKE ? ESCAPE '\\' ORDER BY (favorite_at IS NULL), COALESCE(last_opened_at, added_at) DESC LIMIT ?")
      .all(like, like, Math.max(1, Math.min(limit, 200))) as Row[];
    return rows.map((r) => ({ resourceId: r.resource_id, rootId: '', relPath: r.url, name: r.title || hostOfSafe(r.url), kind: 'file' as const, matchKind: 'name' as const, snippet: r.url }));
  }

  /**
   * 交给索引组（E）的边界：已落地缓存的直链文件（PDF / md / txt / 图片），按本地文件做正文索引。
   * 网页（HTML）本身不缓存、不索引。本组只提供列表，不调用 indexer。
   */
  cachedFilesForIndex(): { resourceId: string; url: string; title: string; ext: string; absPath: string; bytes: number; cachedAt: number }[] {
    const rows = this.db.prepare('SELECT * FROM web_resources WHERE cache_file IS NOT NULL ORDER BY cached_at').all() as Row[];
    const out: { resourceId: string; url: string; title: string; ext: string; absPath: string; bytes: number; cachedAt: number }[] = [];
    for (const r of rows) {
      const abs = this.cachePathOf(r.resource_id, r.cache_file!);
      if (fs.existsSync(abs)) out.push({ resourceId: r.resource_id, url: r.url, title: r.title, ext: r.ext, absPath: abs, bytes: r.cache_bytes ?? 0, cachedAt: r.cached_at ?? 0 });
    }
    return out;
  }

  // ---------------- 导出 / 导入（A11）：只带 url / 标题 / 类型；不带 Cookie、授权、query ----------------

  exportRecords(ids?: string[]): { resourceId: string; url: string; title: string; contentType: string | null; adapterId: string; ext: string; favorite: boolean }[] {
    const rows = (ids ? ids.map((id) => this.row(id)).filter((r): r is Row => !!r) : (this.db.prepare('SELECT * FROM web_resources ORDER BY added_at').all() as Row[])) as Row[];
    return rows.map((r) => ({ resourceId: r.resource_id, url: r.url, title: r.title, contentType: r.content_type, adapterId: r.adapter_id, ext: r.ext, favorite: r.favorite_at != null }));
  }

  /** 按 url 重新匹配：返回 旧 resourceId → 本机 resourceId 的映射（本机已有同 url 则复用，否则新建） */
  importRecords(recs: unknown): Map<string, string> {
    const map = new Map<string, string>();
    if (!Array.isArray(recs)) return map;
    for (const x of recs.slice(0, 5000)) {
      if (!x || typeof x !== 'object') continue;
      const o = x as Record<string, unknown>;
      const s = sanitizeWebRef(String(o.url ?? ''));
      if (!s.ok) continue;
      const w = this.add({ url: s.url, title: typeof o.title === 'string' ? o.title : undefined, contentType: typeof o.contentType === 'string' ? o.contentType : null, adapterId: typeof o.adapterId === 'string' ? o.adapterId : undefined, ext: typeof o.ext === 'string' ? o.ext : undefined });
      if (o.favorite === true && !w.favorite) this.update(w.resourceId, { favorite: true });
      if (typeof o.resourceId === 'string') map.set(o.resourceId, w.resourceId);
    }
    return map;
  }
}

/**
 * 受控下载 + 判型 + 缓存（A5）。fetcher 由主进程注入（webPanels.fetchForCache：同一分区、主机检查、手动跟随重定向）。
 * 返回：cached（可交给阅读器）、html（按网页打开）、unknown / conflict（提示“无法识别类型，仍按网页打开 / 取消”）、
 * site-not-granted（先询问）、错误（network / timeout / http 404 … 可重试，引用保留）。
 */
export type Fetcher = (
  url: string,
) => Promise<
  | { ok: true; finalUrl: string; status: number; contentType: string; contentDisposition: string; bytes: Buffer }
  | { ok: false; reason: 'site-not-granted'; host: string; url: string }
  | { ok: false; reason: 'blocked' | 'network' | 'timeout' | 'http' | 'too-large'; status?: number; detail: string }
>;

export async function fetchAndCache(store: WebResourceStore, resourceId: string, fetcher: Fetcher, opts: { force?: boolean } = {}): Promise<FetchCacheResult> {
  const w = store.get(resourceId);
  if (!w) throw new WebResourceError('not-found', `网络资料不存在: ${resourceId}`);
  if (!opts.force && w.cached) return { ok: true, kind: 'cached', resource: w };
  const r = await fetcher(w.url);
  if (!r.ok) {
    if (r.reason === 'site-not-granted') return { ok: false, kind: 'site-not-granted', host: r.host, url: r.url };
    return { ok: false, kind: 'error', reason: r.reason, ...(r.status ? { status: r.status } : {}), detail: r.detail };
  }
  const c: WebClassifyResult = classifyWebContent(r.finalUrl, r.contentType, r.bytes.subarray(0, 64), r.contentDisposition);
  if (c.kind !== 'file') return { ok: false, kind: c.kind, detail: c.detail, contentType: r.contentType };
  const resource = store.writeCache(resourceId, { fileName: c.fileName, ext: c.ext, contentType: r.contentType || WEB_FILE_MIME[c.ext], bytes: r.bytes });
  return { ok: true, kind: 'cached', resource };
}

function cleanTitle(t: unknown): string {
  return typeof t === 'string' ? t.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300) : '';
}
function cleanAdapter(a: unknown): string {
  return typeof a === 'string' && /^[a-z0-9][a-z0-9.-]{1,80}$/.test(a) ? a : 'web.generic';
}
function cleanExt(e: unknown): string {
  return typeof e === 'string' && /^[a-z0-9]{0,8}$/.test(e.toLowerCase()) ? e.toLowerCase() : '';
}
function hostOfSafe(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 80);
  }
}

export type { WebSanitizeResult };
