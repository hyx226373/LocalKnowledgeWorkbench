/**
 * 编排集的纯函数：解析、父链、引用去重、摘要。不读数据库。
 * `library.catalogs` = `{ v:1, sets:[{ id, name, revision, digest, virtualRootName, folders, refs }] }`。
 * `refs[].folderId === null` 表示挂在该编排的虚拟根上。同一 resourceId 可以出现在多个目录下。
 */
import { createHash } from 'node:crypto';
import type { VirtualFolder } from './types';

export const CATALOGS_KEY = 'library.catalogs';
export const DEFAULT_CATALOG_ID = 'default';
export const DEFAULT_CATALOG_NAME = '默认编排';
export const DEFAULT_VIRTUAL_ROOT_NAME = '自建目录';

export interface CatalogRef {
  folderId: string | null;
  resourceId: string;
}

export interface CatalogSet {
  id: string;
  name: string;
  revision: number;
  digest: string;
  virtualRootName: string;
  folders: VirtualFolder[];
  refs: CatalogRef[];
}

export interface CatalogDocument {
  v: 1;
  sets: CatalogSet[];
}

function cleanName(name: unknown, fallback: string): string {
  const n = String(name ?? '').trim();
  if (!n || n.length > 80 || /[\\/]/.test(n) || /^[A-Za-z]:/.test(n)) {
    const repaired = String(name ?? fallback).replace(/[\\/]/g, ' ').trim().slice(0, 80);
    return repaired || fallback;
  }
  return n;
}

/** 与 workspaceRefs.parseVfolders 同一套保留规则：重复 ID 丢掉，断掉的父级改成虚拟根，不拆环。 */
export function normalizeFolders(raw: unknown): VirtualFolder[] {
  const folders: VirtualFolder[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(raw)) return folders;
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue;
    const x = f as Partial<VirtualFolder>;
    if (typeof x.folderId !== 'string' || !x.folderId || seen.has(x.folderId)) continue;
    seen.add(x.folderId);
    folders.push({
      folderId: x.folderId,
      parentId: typeof x.parentId === 'string' && x.parentId && x.parentId !== x.folderId ? x.parentId : null,
      name: cleanName(x.name, '未命名'),
      sort: typeof x.sort === 'number' && Number.isFinite(x.sort) ? x.sort : 0,
      createdAt: typeof x.createdAt === 'number' ? x.createdAt : 0,
    });
  }
  const ids = new Set(folders.map((f) => f.folderId));
  for (const f of folders) if (f.parentId && !ids.has(f.parentId)) f.parentId = null;
  return folders;
}

/** 同一 (folderId, resourceId) 只留第一次。空字符串 folderId 视为虚拟根。 */
export function dedupeRefs(refs: readonly CatalogRef[]): CatalogRef[] {
  const out: CatalogRef[] = [];
  const seen = new Set<string>();
  for (const r of refs) {
    if (!r || typeof r.resourceId !== 'string' || !r.resourceId) continue;
    const folderId = typeof r.folderId === 'string' && r.folderId ? r.folderId : null;
    const key = `${folderId ?? ''}\0${r.resourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ folderId, resourceId: r.resourceId });
  }
  return out;
}

export function refsFromByFolder(byFolder: Record<string, readonly string[]>): CatalogRef[] {
  const refs: CatalogRef[] = [];
  for (const [key, ids] of Object.entries(byFolder)) {
    const folderId = key === '' ? null : key;
    for (const resourceId of ids) refs.push({ folderId, resourceId });
  }
  return dedupeRefs(refs);
}

export function byFolderFromRefs(refs: readonly CatalogRef[]): Record<string, string[]> {
  const byFolder: Record<string, string[]> = {};
  for (const r of dedupeRefs(refs)) {
    const key = r.folderId ?? '';
    const cur = byFolder[key] ?? [];
    cur.push(r.resourceId);
    byFolder[key] = cur;
  }
  return byFolder;
}

/**
 * 从虚拟根走到 folderId 的目录 ID（含自身，不含 null 根）。
 * 父级不存在或成环时停住，不抛错。
 */
export function parentChain(folders: readonly VirtualFolder[], folderId: string | null): string[] {
  if (!folderId) return [];
  const byId = new Map(folders.map((f) => [f.folderId, f]));
  const up: string[] = [];
  const guard = new Set<string>();
  let cur: string | null = folderId;
  while (cur) {
    if (guard.has(cur)) break;
    const f = byId.get(cur);
    if (!f) break;
    guard.add(cur);
    up.push(f.folderId);
    cur = f.parentId;
  }
  up.reverse();
  return up;
}

/** 键名排序、无空白。数字必须有限。 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('编排摘要不能包含非有限数字');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((x) => canonicalJson(x)).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  throw new Error('编排摘要不能包含该类型');
}

/** 除 digest 自身外的规范 JSON 的 sha256。 */
export function catalogDigest(set: Omit<CatalogSet, 'digest'>): string {
  const body = {
    id: set.id,
    name: set.name,
    revision: set.revision,
    virtualRootName: set.virtualRootName,
    folders: set.folders,
    refs: set.refs,
  };
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

export function makeCatalogSet(input: Omit<CatalogSet, 'digest'>): CatalogSet {
  const draft: Omit<CatalogSet, 'digest'> = {
    id: input.id,
    name: cleanName(input.name, input.id === DEFAULT_CATALOG_ID ? DEFAULT_CATALOG_NAME : '未命名'),
    revision: Number.isInteger(input.revision) && input.revision >= 0 ? input.revision : 0,
    virtualRootName: cleanName(input.virtualRootName, DEFAULT_VIRTUAL_ROOT_NAME),
    folders: normalizeFolders(input.folders),
    refs: dedupeRefs(input.refs),
  };
  return { ...draft, digest: catalogDigest(draft) };
}

function asSet(raw: unknown): CatalogSet | null {
  if (!raw || typeof raw !== 'object') return null;
  const x = raw as Partial<CatalogSet>;
  if (typeof x.id !== 'string' || !x.id || /[\\/]/.test(x.id) || x.id.length > 80) return null;
  const revision = typeof x.revision === 'number' && Number.isInteger(x.revision) && x.revision >= 0 ? x.revision : 0;
  const folders = normalizeFolders(x.folders);
  const refs = dedupeRefs(Array.isArray(x.refs) ? (x.refs as CatalogRef[]) : []);
  const name = cleanName(x.name, x.id === DEFAULT_CATALOG_ID ? DEFAULT_CATALOG_NAME : '未命名');
  const virtualRootName = cleanName(x.virtualRootName, DEFAULT_VIRTUAL_ROOT_NAME);
  const digest = typeof x.digest === 'string' ? x.digest : '';
  return { id: x.id, name, revision, digest, virtualRootName, folders, refs };
}

/** `v` 不是 1 时返回 null，调用方不要把它当成权威文档。 */
export function parseCatalogs(raw: unknown): CatalogDocument | null {
  if (!raw || typeof raw !== 'object') return null;
  if ((raw as { v?: unknown }).v !== 1) return null;
  const sets: CatalogSet[] = [];
  const seen = new Set<string>();
  const arr = (raw as { sets?: unknown }).sets;
  if (Array.isArray(arr)) {
    for (const item of arr) {
      const set = asSet(item);
      if (!set || seen.has(set.id)) continue;
      seen.add(set.id);
      sets.push(set);
    }
  }
  return { v: 1, sets };
}

/** 换掉 id 为 default 的那一套，其它套原样留下。没有 default 时插到最前。 */
export function replaceDefaultSet(raw: unknown, set: CatalogSet): { v: 1; sets: unknown[] } {
  const sets: unknown[] = [];
  const arr = raw && typeof raw === 'object' && Array.isArray((raw as { sets?: unknown }).sets) ? (raw as { sets: unknown[] }).sets : [];
  let placed = false;
  for (const item of arr) {
    const id = item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined;
    if (id === DEFAULT_CATALOG_ID) {
      if (!placed) sets.push(set);
      placed = true;
      continue;
    }
    sets.push(item);
  }
  if (!placed) sets.unshift(set);
  return { v: 1, sets };
}
