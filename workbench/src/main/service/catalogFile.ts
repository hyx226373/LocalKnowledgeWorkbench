/**
 * 编排集可读文件（.kbcatalog.json）。
 * 权威副本是 library.catalogs。本文件只用于手改、agent、备份、迁移。
 * digest 用 P1 `catalogDigest`（内部 `canonicalJson`）：除 digest 外的规范 JSON sha256，
 * 正文是 id、name、revision、virtualRootName、folders、refs（refs 不含 pending）。
 * 目录增删改走 catalogStore.saveDefaultCatalog，这里不再 mirror，避免 revision 加两次。
 */
import type { DB } from './db';
import type { VirtualFolder } from '../../shared/types';
import { canonicalJson, catalogDigest, makeCatalogSet } from '../../shared/catalog';
import { sanitizeWebRef } from '../../shared/webResources';
import { migrateWebSources } from './webSources';
import {
  VFOLDER_REFS_KEY,
  VFOLDERS_KEY,
  WEB_STUBS_KEY,
  parseVfolderRefs,
  parseVfolders,
  parseWebStubs,
} from './workspaceRefs';

export const CATALOGS_KEY = 'library.catalogs';
export const CATALOG_FILE_FORMAT = 'kb-workbench.catalog' as const;
export const CATALOG_FILE_VERSION = 1;
export const CATALOG_FILE_EXT = '.kbcatalog.json';
export const CATALOG_SCHEMA_PATH = 'src/shared/catalog.schema.json';

const DEFAULT_CATALOG_ID = 'default';
const DEFAULT_CATALOG_NAME = '默认编排';
const DEFAULT_VIRTUAL_ROOT_NAME = '自建目录';
const WEB_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type CatalogSourceKind = 'folder' | 'file' | 'web';

export interface CatalogSource {
  sourceId: string;
  kind: CatalogSourceKind;
  name: string;
  extensions: string[];
  url?: string;
}

export interface CatalogFileRef {
  folderId: string | null;
  resourceId: string;
  pending?: boolean;
}

export interface CatalogFile {
  format: typeof CATALOG_FILE_FORMAT;
  formatVersion: typeof CATALOG_FILE_VERSION;
  id: string;
  name: string;
  revision: number;
  digest: string;
  baseDigest?: string;
  virtualRootName: string;
  folders: VirtualFolder[];
  refs: CatalogFileRef[];
  sources: CatalogSource[];
}

interface CatalogBody {
  id: string;
  name: string;
  revision: number;
  virtualRootName: string;
  folders: VirtualFolder[];
  refs: { folderId: string | null; resourceId: string }[];
}

export type LayoutWrite = (key: string, value: unknown) => void;

export class CatalogFileError extends Error {
  readonly code: 'invalid' | 'conflict';
  readonly libraryDigest?: string;
  readonly fileBaseDigest?: string;
  constructor(message: string, code: 'invalid' | 'conflict' = 'invalid', extra?: { libraryDigest?: string; fileBaseDigest?: string }) {
    super(message);
    this.name = 'CatalogFileError';
    this.code = code;
    this.libraryDigest = extra?.libraryDigest;
    this.fileBaseDigest = extra?.fileBaseDigest;
  }
}

function invalid(msg: string): CatalogFileError {
  return new CatalogFileError(msg, 'invalid');
}

/** 与 WorkbenchService.setLayout 同一条：JSON 文本里出现盘符、UNC 或常见 Unix 绝对路径。 */
export function catalogJsonHasAbsolutePath(json: string): boolean {
  return /"(?:[A-Za-z]:\\\\|\\\\\\\\|\/(?:home|Users|mnt|media|workspace|tmp|var)\/)/.test(json);
}

export function looksLikeForbiddenPath(s: string): boolean {
  const t = String(s ?? '');
  if (/^[A-Za-z]:[\\/]/.test(t)) return true;
  if (/^\\\\/.test(t) || /^\/\//.test(t)) return true;
  if (/^\/(?:home|Users|mnt|media|workspace|tmp|var)\//.test(t)) return true;
  if (/^file:/i.test(t)) return true;
  return false;
}

function walkStrings(value: unknown, visit: (s: string) => void): void {
  if (typeof value === 'string') visit(value);
  else if (Array.isArray(value)) for (const x of value) walkStrings(x, visit);
  else if (value && typeof value === 'object') for (const x of Object.values(value as Record<string, unknown>)) walkStrings(x, visit);
}

function rejectForbiddenPaths(value: unknown): void {
  const json = JSON.stringify(value);
  if (catalogJsonHasAbsolutePath(json)) throw invalid('编排文件不能包含本机绝对路径');
  walkStrings(value, (s) => {
    if (looksLikeForbiddenPath(s)) throw invalid('编排文件不能包含本机绝对路径');
  });
}

/** 用 P1 canonicalJson / catalogDigest。pending 不进入正文。 */
function digestOf(body: CatalogBody): string {
  const projected = {
    id: body.id,
    name: body.name,
    revision: body.revision,
    virtualRootName: body.virtualRootName,
    folders: body.folders.map((f) => ({
      folderId: f.folderId,
      parentId: f.parentId,
      name: f.name,
      sort: f.sort,
      createdAt: f.createdAt,
    })),
    refs: body.refs.map((r) => ({ folderId: r.folderId, resourceId: r.resourceId })),
  };
  try {
    canonicalJson(projected);
    return catalogDigest(projected);
  } catch (e) {
    throw invalid(e instanceof Error ? e.message : '编排摘要失败');
  }
}

function requireId(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || !raw || raw.length > 80 || /[\\/]/.test(raw)) throw invalid(`${label} 无效`);
  if (looksLikeForbiddenPath(raw) || /^[A-Za-z]:/.test(raw)) throw invalid(`${label} 不能像磁盘路径`);
  return raw;
}

function requireName(raw: unknown, label: string): string {
  if (typeof raw !== 'string') throw invalid(`${label} 无效`);
  if (raw !== raw.trim() || !raw.trim()) throw invalid(`${label} 不能为空`);
  if (raw.length > 80) throw invalid(`${label} 过长`);
  if (/[\\/]/.test(raw)) throw invalid(`${label} 不能包含斜杠`);
  if (/^[A-Za-z]:/.test(raw) || looksLikeForbiddenPath(raw)) throw invalid(`${label} 不能像磁盘路径`);
  return raw;
}

function foldersHaveCycle(folders: readonly VirtualFolder[]): boolean {
  const parent = new Map(folders.map((f) => [f.folderId, f.parentId]));
  for (const start of parent.keys()) {
    const seen = new Set<string>();
    let cur: string | null = start;
    while (cur) {
      if (seen.has(cur)) return true;
      seen.add(cur);
      const next = parent.get(cur);
      if (!next) break;
      cur = next;
    }
  }
  return false;
}

function parseFoldersStrict(raw: unknown): VirtualFolder[] {
  if (!Array.isArray(raw)) throw invalid('folders 必须是数组');
  const folders: VirtualFolder[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalid('目录项无效');
    const x = item as Record<string, unknown>;
    const folderId = requireId(x.folderId, 'folderId');
    if (seen.has(folderId)) throw invalid(`重复 folderId: ${folderId}`);
    seen.add(folderId);
    let parentId: string | null = null;
    if (x.parentId != null) {
      if (typeof x.parentId !== 'string' || !x.parentId) throw invalid('parentId 无效');
      parentId = requireId(x.parentId, 'parentId');
    }
    if (typeof x.sort !== 'number' || !Number.isFinite(x.sort)) throw invalid('sort 无效');
    if (typeof x.createdAt !== 'number' || !Number.isFinite(x.createdAt)) throw invalid('createdAt 无效');
    folders.push({ folderId, parentId, name: requireName(x.name, '目录名'), sort: x.sort, createdAt: x.createdAt });
  }
  const ids = new Set(folders.map((f) => f.folderId));
  for (const f of folders) if (f.parentId && !ids.has(f.parentId)) throw invalid(`未知 folderId: ${f.parentId}`);
  if (foldersHaveCycle(folders)) throw invalid('目录成环');
  return folders;
}

function parseRefsStrict(raw: unknown, folderIds: Set<string>): CatalogFileRef[] {
  if (!Array.isArray(raw)) throw invalid('refs 必须是数组');
  const refs: CatalogFileRef[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalid('引用项无效');
    const x = item as Record<string, unknown>;
    let folderId: string | null = null;
    if (x.folderId != null && x.folderId !== '') {
      if (typeof x.folderId !== 'string') throw invalid('引用 folderId 无效');
      folderId = requireId(x.folderId, '引用 folderId');
      if (!folderIds.has(folderId)) throw invalid(`未知 folderId: ${folderId}`);
    }
    if (typeof x.resourceId !== 'string' || !x.resourceId || x.resourceId.length > 80 || /[\\/]/.test(x.resourceId)) throw invalid('resourceId 无效');
    if (x.pending != null && typeof x.pending !== 'boolean') throw invalid('pending 无效');
    const key = `${folderId ?? ''}\0${x.resourceId}`;
    if (seen.has(key)) throw invalid(`重复引用: ${x.resourceId}`);
    seen.add(key);
    const rec: CatalogFileRef = { folderId, resourceId: x.resourceId };
    if (x.pending === true) rec.pending = true;
    refs.push(rec);
  }
  return refs;
}

function parseExtensions(raw: unknown): string[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw invalid('extensions 必须是数组');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of raw) {
    if (typeof x !== 'string' || !x) throw invalid('扩展名无效');
    const e = x.toLowerCase().replace(/^\./, '');
    if (!/^[a-z0-9]+$/.test(e)) throw invalid(`扩展名无效: ${x}`);
    if (seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return out;
}

function parseSourcesStrict(raw: unknown): CatalogSource[] {
  if (!Array.isArray(raw)) throw invalid('sources 必须是数组');
  const sources: CatalogSource[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalid('来源项无效');
    const x = item as Record<string, unknown>;
    const sourceId = requireId(x.sourceId, 'sourceId');
    if (seen.has(sourceId)) throw invalid(`重复 sourceId: ${sourceId}`);
    seen.add(sourceId);
    if (x.kind !== 'folder' && x.kind !== 'file' && x.kind !== 'web') throw invalid('来源 kind 无效');
    const rec: CatalogSource = { sourceId, kind: x.kind, name: requireName(x.name, '来源名'), extensions: parseExtensions(x.extensions) };
    if (x.kind === 'web') {
      if (typeof x.url !== 'string' || !x.url) throw invalid('网络来源缺少 url');
      const s = sanitizeWebRef(x.url);
      if (!s.ok || s.url !== x.url) throw invalid(s.ok ? '网络来源网址必须是去掉 query 与 fragment 后的形式' : `网络来源网址无效: ${s.reason}`);
      if (!WEB_UUID.test(sourceId)) throw invalid(`网络来源 ID 必须是 UUID，导入不换 ID: ${sourceId}`);
      rec.url = s.url;
    } else if (x.url != null && x.url !== '') throw invalid('文件夹或单文件来源不能带 url');
    sources.push(rec);
  }
  return sources;
}

function bodyFrom(file: Pick<CatalogFile, 'id' | 'name' | 'revision' | 'virtualRootName' | 'folders' | 'refs'>): CatalogBody {
  return {
    id: file.id,
    name: file.name,
    revision: file.revision,
    virtualRootName: file.virtualRootName,
    folders: file.folders,
    refs: file.refs.map((r) => ({ folderId: r.folderId, resourceId: r.resourceId })),
  };
}

/** 校验并规范化编排文件。不写库。digest 不符则拒绝，不按内容改写摘要。 */
export function parseCatalogFile(raw: unknown): CatalogFile {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      throw invalid('不是合法 JSON');
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('不是编排文件');
  rejectForbiddenPaths(value);
  const x = value as Record<string, unknown>;
  if (x.format !== CATALOG_FILE_FORMAT) throw invalid('不是工作台编排文件（format 不匹配）');
  if (x.formatVersion !== CATALOG_FILE_VERSION) throw invalid(`不支持的编排文件版本 ${String(x.formatVersion)}`);
  const id = requireId(x.id, 'id');
  const name = requireName(x.name, '编排名');
  if (typeof x.revision !== 'number' || !Number.isInteger(x.revision) || x.revision < 0) throw invalid('revision 无效');
  if (typeof x.digest !== 'string' || !/^[0-9a-f]{64}$/.test(x.digest)) throw invalid('digest 无效');
  if (x.baseDigest != null && (typeof x.baseDigest !== 'string' || !/^[0-9a-f]{64}$/.test(x.baseDigest))) throw invalid('baseDigest 无效');
  const virtualRootName = requireName(x.virtualRootName, '虚拟根名');
  const folders = parseFoldersStrict(x.folders);
  const refs = parseRefsStrict(x.refs, new Set(folders.map((f) => f.folderId)));
  const sources = parseSourcesStrict(x.sources);
  const digest = digestOf({ id, name, revision: x.revision, virtualRootName, folders, refs });
  if (digest !== x.digest) throw invalid('digest 与编排内容不符');
  return {
    format: CATALOG_FILE_FORMAT,
    formatVersion: CATALOG_FILE_VERSION,
    id,
    name,
    revision: x.revision,
    digest,
    ...(typeof x.baseDigest === 'string' ? { baseDigest: x.baseDigest } : {}),
    virtualRootName,
    folders,
    refs,
    sources,
  };
}

/** 按当前 folders/refs 重算 digest，保留 baseDigest。 */
export function sealCatalogFile(file: CatalogFile): CatalogFile {
  const digest = digestOf(bodyFrom(file));
  return { ...file, digest };
}

export function stringifyCatalogFile(file: CatalogFile): string {
  const body: CatalogFile = {
    format: CATALOG_FILE_FORMAT,
    formatVersion: CATALOG_FILE_VERSION,
    id: file.id,
    name: file.name,
    revision: file.revision,
    digest: file.digest,
    ...(file.baseDigest ? { baseDigest: file.baseDigest } : {}),
    virtualRootName: file.virtualRootName,
    folders: file.folders.map((f) => ({ folderId: f.folderId, parentId: f.parentId, name: f.name, sort: f.sort, createdAt: f.createdAt })),
    refs: file.refs.map((r) => {
      const rec: CatalogFileRef = { folderId: r.folderId, resourceId: r.resourceId };
      if (r.pending) rec.pending = true;
      return rec;
    }),
    sources: file.sources.map((s) => {
      const rec: CatalogSource = { sourceId: s.sourceId, kind: s.kind, name: s.name, extensions: s.extensions.slice() };
      if (s.kind === 'web' && s.url) rec.url = s.url;
      return rec;
    }),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

interface LayoutCell {
  missing: boolean;
  bad: boolean;
  value: unknown;
}

function readLayout(db: DB, key: string): LayoutCell {
  const row = db.prepare('SELECT json FROM layout WHERE key = ?').get(key) as { json: string } | undefined;
  if (!row) return { missing: true, bad: false, value: null };
  try {
    return { missing: false, bad: false, value: JSON.parse(row.json) };
  } catch {
    return { missing: false, bad: true, value: null };
  }
}

function refsFromByFolder(byFolder: Record<string, readonly string[]>): { folderId: string | null; resourceId: string }[] {
  const refs: { folderId: string | null; resourceId: string }[] = [];
  const seen = new Set<string>();
  for (const [key, ids] of Object.entries(byFolder)) {
    const folderId = key === '' ? null : key;
    for (const resourceId of ids) {
      if (!resourceId) continue;
      const mark = `${folderId ?? ''}\0${resourceId}`;
      if (seen.has(mark)) continue;
      seen.add(mark);
      refs.push({ folderId, resourceId });
    }
  }
  return refs;
}

function byFolderFromRefs(refs: readonly { folderId: string | null; resourceId: string }[]): Record<string, string[]> {
  const byFolder: Record<string, string[]> = {};
  for (const r of refs) {
    const key = r.folderId ?? '';
    const cur = byFolder[key] ?? [];
    if (!cur.includes(r.resourceId)) cur.push(r.resourceId);
    byFolder[key] = cur;
  }
  return byFolder;
}

function storedSets(db: DB): { missing: boolean; bad: boolean; sets: unknown[] } {
  const cell = readLayout(db, CATALOGS_KEY);
  if (cell.missing) return { missing: true, bad: false, sets: [] };
  if (cell.bad || !cell.value || typeof cell.value !== 'object' || (cell.value as { v?: unknown }).v !== 1) return { missing: false, bad: true, sets: [] };
  const sets = (cell.value as { sets?: unknown }).sets;
  if (!Array.isArray(sets)) return { missing: false, bad: true, sets: [] };
  return { missing: false, bad: false, sets };
}

function asStoredBody(raw: unknown): CatalogBody | null {
  if (!raw || typeof raw !== 'object') return null;
  const x = raw as Record<string, unknown>;
  if (typeof x.id !== 'string' || !x.id) return null;
  if (typeof x.name !== 'string' || typeof x.virtualRootName !== 'string') return null;
  if (typeof x.revision !== 'number' || !Number.isInteger(x.revision) || x.revision < 0) return null;
  if (!Array.isArray(x.folders) || !Array.isArray(x.refs)) return null;
  try {
    const folders = parseFoldersStrict(x.folders);
    const refs = parseRefsStrict(x.refs, new Set(folders.map((f) => f.folderId)));
    return { id: x.id, name: x.name, revision: x.revision, virtualRootName: x.virtualRootName, folders, refs };
  } catch {
    return null;
  }
}

function legacyDefaultBody(db: DB): CatalogBody {
  const folders = readLayout(db, VFOLDERS_KEY);
  const refs = readLayout(db, VFOLDER_REFS_KEY);
  if (folders.bad || refs.bad) throw invalid('旧自建目录无法解析，已停止，未改库');
  const store = folders.missing ? { v: 1 as const, folders: [] } : parseVfolders(folders.value);
  const refStore = refs.missing ? { v: 1 as const, byFolder: {} } : parseVfolderRefs(refs.value);
  return {
    id: DEFAULT_CATALOG_ID,
    name: DEFAULT_CATALOG_NAME,
    revision: 1,
    virtualRootName: DEFAULT_VIRTUAL_ROOT_NAME,
    folders: store.folders,
    refs: refsFromByFolder(refStore.byFolder),
  };
}

/** 库内当前这一套。没有 library.catalogs 时，default 按旧键现算，不写入。 */
export function currentCatalogBody(db: DB, catalogId: string): CatalogBody {
  const doc = storedSets(db);
  if (doc.bad) throw invalid('库内编排已损坏，已停止，未改这份文件对应的写入');
  if (!doc.missing) {
    const raw = doc.sets.find((s) => s && typeof s === 'object' && (s as { id?: unknown }).id === catalogId);
    if (!raw) throw invalid(`编排不存在: ${catalogId}`);
    const body = asStoredBody(raw);
    if (!body) throw invalid(`库内编排 ${catalogId} 无法解析`);
    return body;
  }
  if (catalogId !== DEFAULT_CATALOG_ID) throw invalid(`编排不存在: ${catalogId}`);
  return legacyDefaultBody(db);
}

function replaceSet(sets: unknown[], set: unknown, id: string): unknown[] {
  const next: unknown[] = [];
  let placed = false;
  for (const item of sets) {
    const sid = item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined;
    if (sid === id) {
      if (!placed) next.push(set);
      placed = true;
      continue;
    }
    next.push(item);
  }
  if (!placed) {
    if (id === DEFAULT_CATALOG_ID) next.unshift(set);
    else next.push(set);
  }
  return next;
}

function knownResourceIds(db: DB): Set<string> {
  const ids = new Set<string>();
  for (const r of db.prepare('SELECT id FROM resources').all() as { id: string }[]) ids.add(r.id);
  try {
    for (const r of db.prepare('SELECT resource_id AS id FROM web_resources').all() as { id: string }[]) ids.add(r.id);
  } catch {
    /* 表尚未建立 */
  }
  for (const s of parseWebStubs(readLayout(db, WEB_STUBS_KEY).value).items) ids.add(s.resourceId);
  return ids;
}

function sourceLabel(name: string, fallback: string): string {
  const n = String(name ?? '').trim();
  if (!n || n.length > 80 || /[\\/]/.test(n) || /^[A-Za-z]:/.test(n) || looksLikeForbiddenPath(n)) return fallback.slice(0, 80) || '未命名';
  return n;
}

function rootColumns(db: DB): Set<string> {
  return new Set((db.prepare('PRAGMA table_info(roots)').all() as { name: string }[]).map((c) => c.name));
}

function collectSources(db: DB): CatalogSource[] {
  const sources: CatalogSource[] = [];
  const cols = rootColumns(db);
  const fields = ['id', 'name'];
  if (cols.has('kind')) fields.push('kind');
  if (cols.has('filter_json')) fields.push('filter_json');
  if (cols.has('created_at')) fields.push('created_at');
  const rows = db.prepare(`SELECT ${fields.join(', ')} FROM roots`).all() as {
    id: string;
    name: string;
    kind?: string;
    filter_json?: string | null;
    created_at?: number;
  }[];
  rows.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0) || a.id.localeCompare(b.id));
  for (const r of rows) {
    let extensions: string[] = [];
    if (typeof r.filter_json === 'string' && r.filter_json) {
      try {
        const j = JSON.parse(r.filter_json) as { extensions?: unknown };
        if (Array.isArray(j.extensions)) extensions = parseExtensions(j.extensions);
      } catch {
        extensions = [];
      }
    }
    const kind: CatalogSourceKind = r.kind === 'file' ? 'file' : 'folder';
    sources.push({ sourceId: r.id, kind, name: sourceLabel(r.name, r.id), extensions });
  }
  try {
    const webs = db.prepare('SELECT resource_id AS id, url, title, added_at FROM web_resources').all() as {
      id: string;
      url: string;
      title: string;
      added_at: number;
    }[];
    webs.sort((a, b) => a.added_at - b.added_at || a.id.localeCompare(b.id));
    for (const w of webs) {
      if (!WEB_UUID.test(w.id)) continue;
      const s = sanitizeWebRef(w.url);
      if (!s.ok) continue;
      sources.push({ sourceId: w.id, kind: 'web', name: sourceLabel(w.title, s.host || w.id), extensions: [], url: s.url });
    }
  } catch {
    /* 无 web_resources */
  }
  return sources;
}

function withPending(refs: readonly { folderId: string | null; resourceId: string }[], known: Set<string>): CatalogFileRef[] {
  return refs.map((r) => {
    const rec: CatalogFileRef = { folderId: r.folderId, resourceId: r.resourceId };
    if (!known.has(r.resourceId)) rec.pending = true;
    return rec;
  });
}

/** 把 UUID 形态的 library.webStubs 迁入 web_resources。ID 不变。不删旧键，不进全文索引。 */
export function migrateWebStubsIntoWebSources(db: DB): void {
  migrateWebSources(db);
  const cell = readLayout(db, WEB_STUBS_KEY);
  if (cell.missing || cell.bad) return;
  const stubs = parseWebStubs(cell.value);
  const now = Date.now();
  const byId = db.prepare('SELECT resource_id FROM web_resources WHERE resource_id=?');
  const byUrl = db.prepare('SELECT resource_id FROM web_resources WHERE url=?');
  const ins = db.prepare(
    `INSERT INTO web_resources(resource_id, url, title, content_type, adapter_id, ext, added_at, last_opened_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  for (const s of stubs.items) {
    if (!WEB_UUID.test(s.resourceId)) continue;
    const parsed = sanitizeWebRef(s.url);
    if (!parsed.ok) continue;
    if (byId.get(s.resourceId)) continue;
    if (byUrl.get(parsed.url)) continue;
    const title = sourceLabel(s.title, parsed.host || s.resourceId);
    ins.run(s.resourceId, parsed.url, title, null, 'web.generic', '', now, null);
  }
}

function upsertWebSource(db: DB, source: CatalogSource): void {
  if (source.kind !== 'web' || !source.url) return;
  if (!WEB_UUID.test(source.sourceId)) throw invalid(`网络来源 ID 必须是 UUID，导入不换 ID: ${source.sourceId}`);
  const parsed = sanitizeWebRef(source.url);
  if (!parsed.ok || parsed.url !== source.url) throw invalid('网络来源网址无效');
  const id = source.sourceId;
  const byId = db.prepare('SELECT resource_id, url, title FROM web_resources WHERE resource_id=?').get(id) as
    | { resource_id: string; url: string; title: string }
    | undefined;
  const byUrl = db.prepare('SELECT resource_id FROM web_resources WHERE url=?').get(parsed.url) as { resource_id: string } | undefined;
  if (byUrl && byUrl.resource_id !== id) throw invalid(`网络来源 url 已由 ${byUrl.resource_id} 占用，导入不能换 ID`);
  if (byId) {
    if (byId.url !== parsed.url || byId.title !== source.name) {
      db.prepare('UPDATE web_resources SET url=?, title=? WHERE resource_id=?').run(parsed.url, source.name, id);
    }
    return;
  }
  db.prepare(
    `INSERT INTO web_resources(resource_id, url, title, content_type, adapter_id, ext, added_at, last_opened_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(id, parsed.url, source.name, null, 'web.generic', '', Date.now(), null);
}

function buildFile(body: CatalogBody, sources: CatalogSource[], known: Set<string>): CatalogFile {
  const digest = digestOf(body);
  const file: CatalogFile = {
    format: CATALOG_FILE_FORMAT,
    formatVersion: CATALOG_FILE_VERSION,
    id: body.id,
    name: body.name,
    revision: body.revision,
    digest,
    baseDigest: digest,
    virtualRootName: body.virtualRootName,
    folders: body.folders,
    refs: withPending(body.refs, known),
    sources,
  };
  rejectForbiddenPaths(file);
  return file;
}

/** 导出。不写 library.catalogs。可能把尚未迁入的 web stub 写入 web_resources。 */
export function exportCatalogFromDb(db: DB, catalogId = DEFAULT_CATALOG_ID): CatalogFile {
  const body = currentCatalogBody(db, catalogId);
  migrateWebStubsIntoWebSources(db);
  const known = knownResourceIds(db);
  return buildFile(body, collectSources(db), known);
}

export interface ImportCatalogResult {
  id: string;
  digest: string;
  pendingResourceIds: string[];
}

function applyImport(db: DB, write: LayoutWrite, file: CatalogFile): ImportCatalogResult {
  const current = currentCatalogBody(db, file.id);
  const libraryDigest = digestOf(current);
  if (file.baseDigest !== libraryDigest) {
    throw new CatalogFileError(`编排文件与库内冲突：file.baseDigest=${file.baseDigest ?? ''} library.digest=${libraryDigest}`, 'conflict', {
      libraryDigest,
      fileBaseDigest: file.baseDigest,
    });
  }
  migrateWebStubsIntoWebSources(db);
  for (const s of file.sources) if (s.kind === 'web') upsertWebSource(db, s);
  const known = knownResourceIds(db);
  for (const s of file.sources) if (s.kind === 'web') known.add(s.sourceId);
  const pendingResourceIds: string[] = [];
  const refs = file.refs.map((r) => {
    if (!known.has(r.resourceId)) pendingResourceIds.push(r.resourceId);
    return { folderId: r.folderId, resourceId: r.resourceId };
  });
  const set = makeCatalogSet({
    id: file.id,
    name: file.name,
    revision: file.revision,
    virtualRootName: file.virtualRootName,
    folders: file.folders,
    refs,
  });
  if (set.digest !== file.digest) throw invalid('digest 与编排内容不符');
  const doc = storedSets(db);
  if (doc.bad) throw invalid('库内编排已损坏，已停止写入');
  write(CATALOGS_KEY, { v: 1, sets: replaceSet(doc.sets, set, file.id) });
  if (file.id === DEFAULT_CATALOG_ID) {
    write(VFOLDERS_KEY, { v: 1, folders: set.folders });
    write(VFOLDER_REFS_KEY, { v: 1, byFolder: byFolderFromRefs(set.refs) });
  }
  return { id: file.id, digest: set.digest, pendingResourceIds };
}

/** 校验失败或 baseDigest 不一致时抛错，事务回滚，不留半份写入。 */
export function importCatalogIntoDb(db: DB, write: LayoutWrite, raw: unknown): ImportCatalogResult {
  const file = parseCatalogFile(raw);
  const run = db.transaction(() => applyImport(db, write, file));
  return run.immediate();
}
