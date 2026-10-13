/**
 * 读 library.catalogs。键不存在时，用 library.vfolders 与 library.vfolderRefs 生成 id=default。
 * 文件夹数和引用数与旧键一致才写入新键；旧键字节不动。新键已在时不以旧键覆盖。
 * 新键缺失或无法解析时，读路径仍用旧键。
 * 非 default 的套只替换 library.catalogs 里的那一套，不写旧键。
 */
import type Database from 'better-sqlite3';
import {
  CATALOGS_KEY,
  DEFAULT_CATALOG_ID,
  DEFAULT_CATALOG_NAME,
  DEFAULT_VIRTUAL_ROOT_NAME,
  byFolderFromRefs,
  makeCatalogSet,
  parseCatalogs,
  refsFromByFolder,
  replaceDefaultSet,
  type CatalogSet,
} from '../../shared/catalog';
import {
  VFOLDER_REFS_KEY,
  VFOLDERS_KEY,
  emptyVfolderRefs,
  emptyVfolders,
  parseVfolderRefs,
  parseVfolders,
  type VfolderRefs,
  type VfolderStore,
} from './workspaceRefs';

type DB = Pick<Database.Database, 'prepare' | 'transaction'>;
export type LayoutWrite = (key: string, value: unknown) => void;

export interface DefaultCatalogView {
  store: VfolderStore;
  refs: VfolderRefs;
  virtualRootName: string;
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

/** 旧键文件夹数组里每一项都是带唯一 folderId 的对象时返回长度，否则 null。键不存在由调用方计 0。 */
export function legacyFolderCount(raw: unknown): number | null {
  if (raw == null || typeof raw !== 'object') return null;
  const folders = (raw as { folders?: unknown }).folders;
  if (folders == null) return 0;
  if (!Array.isArray(folders)) return null;
  const seen = new Set<string>();
  for (const f of folders) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) return null;
    const id = (f as { folderId?: unknown }).folderId;
    if (typeof id !== 'string' || !id || seen.has(id)) return null;
    seen.add(id);
  }
  return folders.length;
}

/** 旧键 byFolder 每个值都是无重复、非空字符串数组时返回引用条数，否则 null。 */
export function legacyRefCount(raw: unknown): number | null {
  if (raw == null || typeof raw !== 'object') return null;
  const byFolder = (raw as { byFolder?: unknown }).byFolder;
  if (byFolder == null) return 0;
  if (typeof byFolder !== 'object' || Array.isArray(byFolder)) return null;
  let n = 0;
  for (const v of Object.values(byFolder as Record<string, unknown>)) {
    if (!Array.isArray(v)) return null;
    const seen = new Set<string>();
    for (const id of v) {
      if (typeof id !== 'string' || !id || seen.has(id)) return null;
      seen.add(id);
      n++;
    }
  }
  return n;
}

function legacyView(db: DB): DefaultCatalogView {
  const folders = readLayout(db, VFOLDERS_KEY);
  const refs = readLayout(db, VFOLDER_REFS_KEY);
  return {
    store: folders.missing || folders.bad ? emptyVfolders() : parseVfolders(folders.value),
    refs: refs.missing || refs.bad ? emptyVfolderRefs() : parseVfolderRefs(refs.value),
    virtualRootName: DEFAULT_VIRTUAL_ROOT_NAME,
  };
}

function viewFromSet(set: CatalogSet | undefined): DefaultCatalogView {
  if (!set) return { store: emptyVfolders(), refs: emptyVfolderRefs(), virtualRootName: DEFAULT_VIRTUAL_ROOT_NAME };
  return {
    store: { v: 1, folders: set.folders },
    refs: { v: 1, byFolder: byFolderFromRefs(set.refs) },
    virtualRootName: set.virtualRootName || DEFAULT_VIRTUAL_ROOT_NAME,
  };
}

/** 新键可用时返回视图。键不存在返回 null，让调用方迁移。键损坏时退回旧键且不写。 */
function peek(db: DB): DefaultCatalogView | null {
  const cell = readLayout(db, CATALOGS_KEY);
  if (cell.missing) return null;
  if (cell.bad) return legacyView(db);
  const doc = parseCatalogs(cell.value);
  if (!doc) return legacyView(db);
  return viewFromSet(doc.sets.find((s) => s.id === DEFAULT_CATALOG_ID));
}

function migrateMissing(db: DB, write: LayoutWrite): DefaultCatalogView {
  const folders = readLayout(db, VFOLDERS_KEY);
  const refs = readLayout(db, VFOLDER_REFS_KEY);
  const folderCount = folders.missing ? 0 : folders.bad ? null : legacyFolderCount(folders.value);
  const refCount = refs.missing ? 0 : refs.bad ? null : legacyRefCount(refs.value);
  const view = legacyView(db);
  if (folderCount == null || refCount == null) return view;
  const set = makeCatalogSet({
    id: DEFAULT_CATALOG_ID,
    name: DEFAULT_CATALOG_NAME,
    revision: 1,
    virtualRootName: DEFAULT_VIRTUAL_ROOT_NAME,
    folders: view.store.folders,
    refs: refsFromByFolder(view.refs.byFolder),
  });
  if (set.folders.length !== folderCount || set.refs.length !== refCount) return view;
  write(CATALOGS_KEY, replaceDefaultSet(null, set));
  return viewFromSet(set);
}

export function ensureDefaultCatalog(db: DB, write: LayoutWrite): DefaultCatalogView {
  const ready = peek(db);
  if (ready) return ready;
  const run = db.transaction(() => {
    const again = peek(db);
    if (again) return again;
    return migrateMissing(db, write);
  });
  return run.immediate();
}

/** 已解析文档里有这一套才返回视图。键缺失、损坏或没有该 id 时返回 null，不写库。 */
export function readCatalogView(db: DB, catalogId: string): DefaultCatalogView | null {
  const cell = readLayout(db, CATALOGS_KEY);
  if (cell.missing || cell.bad) return null;
  const doc = parseCatalogs(cell.value);
  if (!doc) return null;
  const set = doc.sets.find((s) => s.id === catalogId);
  return set ? viewFromSet(set) : null;
}

/** default 始终可选（空列与尚未迁入的旧键都算它）。其它 id 必须已经在库内。 */
export function catalogSelectable(db: DB, catalogId: string): boolean {
  if (catalogId === DEFAULT_CATALOG_ID) return true;
  return readCatalogView(db, catalogId) != null;
}

function replaceNamedSet(raw: unknown, set: CatalogSet): { v: 1; sets: unknown[] } {
  const sets: unknown[] = [];
  const arr = raw && typeof raw === 'object' && Array.isArray((raw as { sets?: unknown }).sets) ? (raw as { sets: unknown[] }).sets : [];
  let placed = false;
  for (const item of arr) {
    const id = item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined;
    if (id === set.id) {
      if (!placed) sets.push(set);
      placed = true;
      continue;
    }
    sets.push(item);
  }
  if (!placed) sets.push(set);
  return { v: 1, sets };
}

/** 把当前默认编排写进 library.catalogs。其它套保留。revision 在上一套上加一。不写旧键。 */
export function saveDefaultCatalog(db: DB, store: VfolderStore, refs: VfolderRefs, write: LayoutWrite): void {
  saveCatalog(db, DEFAULT_CATALOG_ID, store, refs, write);
}

/**
 * 替换 library.catalogs 中的一套。其它套原样留下。revision 在上一套上加一。
 * default 可以在键还不存在时创建。其它 id 不存在则抛错，避免顺手新建编排。不写旧键。
 */
export function saveCatalog(db: DB, catalogId: string, store: VfolderStore, refs: VfolderRefs, write: LayoutWrite): void {
  const cell = readLayout(db, CATALOGS_KEY);
  let prev: CatalogSet | undefined;
  let raw: unknown = null;
  if (!cell.missing && !cell.bad) {
    const doc = parseCatalogs(cell.value);
    if (doc) {
      prev = doc.sets.find((s) => s.id === catalogId);
      raw = cell.value;
    }
  }
  if (catalogId !== DEFAULT_CATALOG_ID && !prev) throw new Error(`编排不存在: ${catalogId}`);
  const set = makeCatalogSet({
    id: catalogId,
    name: prev?.name || (catalogId === DEFAULT_CATALOG_ID ? DEFAULT_CATALOG_NAME : '未命名'),
    revision: (prev?.revision ?? 0) + 1,
    virtualRootName: prev?.virtualRootName || DEFAULT_VIRTUAL_ROOT_NAME,
    folders: store.folders,
    refs: refsFromByFolder(refs.byFolder),
  });
  write(CATALOGS_KEY, catalogId === DEFAULT_CATALOG_ID ? replaceDefaultSet(raw, set) : replaceNamedSet(raw, set));
}
