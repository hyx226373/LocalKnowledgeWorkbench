/**
 * 工作资料（集合）引用的只读辅助（第 9 轮合并）：引用存在 layout 键值表 `workspace.refs:<工作区 ID>` = `[{id, at}]`
 * （docs/10-日常工作流 B）。迁移组（导出计数、缺失列表、重新定位）与索引器（30 天清理）共用这里，
 * 以后换成 workspace_refs 表时只改本文件与 WorkbenchService 的 refRecords/addWorkspaceRefs/removeWorkspaceRef。
 * 只依赖 better-sqlite3 的 Database 接口，可在索引 worker 中使用。
 */
import type Database from 'better-sqlite3';
import type { VirtualFolder } from '../../shared/types';

export const WS_REFS_PREFIX = 'workspace.refs:';

type DB = Pick<Database.Database, 'prepare'>;

function parseRefs(json: string): { id: string; at: number }[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x) => x && typeof x.id === 'string') : [];
  } catch {
    return [];
  }
}

/** 所有工作区的资料引用：工作区 ID → 引用记录（键值格式坏掉的条目忽略） */
export function allWorkspaceRefs(db: DB): Map<string, { id: string; at: number }[]> {
  const out = new Map<string, { id: string; at: number }[]>();
  const rows = db.prepare(`SELECT key, json FROM layout WHERE substr(key, 1, ${WS_REFS_PREFIX.length}) = ?`).all(WS_REFS_PREFIX) as { key: string; json: string }[];
  for (const r of rows) out.set(r.key.slice(WS_REFS_PREFIX.length), parseRefs(r.json));
  return out;
}

/** 被任一工作区资料引用的资源 ID */
export function referencedResourceIds(db: DB): Set<string> {
  const s = new Set<string>();
  for (const refs of allWorkspaceRefs(db).values()) for (const r of refs) s.add(r.id);
  return s;
}

/** 资源 ID → 引用它的工作区 ID 列表 */
export function workspacesByRef(db: DB): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const [ws, refs] of allWorkspaceRefs(db)) for (const r of refs) m.set(r.id, [...(m.get(r.id) ?? []), ws]);
  return m;
}

/** 把所有工作区资料中对 fromId 的引用改成 toId（去重；重新定位合并重复记录时用）。返回改动的工作区数 */
export function replaceRefId(db: DB, fromId: string, toId: string): number {
  let n = 0;
  const upd = db.prepare('UPDATE layout SET json=?, updated_at=? WHERE key=?');
  for (const [ws, refs] of allWorkspaceRefs(db)) {
    if (!refs.some((r) => r.id === fromId)) continue;
    const seen = new Set<string>();
    const next = refs
      .map((r) => (r.id === fromId ? { ...r, id: toId } : r))
      .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
    upd.run(JSON.stringify(next), Date.now(), WS_REFS_PREFIX + ws);
    n++;
  }
  return n;
}

/**
 * 全局自建目录（第 11 轮 C）。只存在 layout 键值表，不建新表、不写 op_log、不碰磁盘文件。
 * `library.vfolders` = `{ v:1, folders: VirtualFolder[] }`
 * `library.vfolderRefs` = `{ v:1, byFolder: Record<folderId, resourceId[]> }`
 * 空字符串键 `byFolder['']` 是虚拟根上的未归类条目（不是一条 VirtualFolder）。
 */

export const VFOLDERS_KEY = 'library.vfolders';
export const VFOLDER_REFS_KEY = 'library.vfolderRefs';
export const VFOLDER_UNDO_KEY = 'library.vfolderClassifyUndo';
export const WEB_STUBS_KEY = 'library.webStubs';

export interface VfolderStore {
  v: 1;
  folders: VirtualFolder[];
}
export interface VfolderRefs {
  v: 1;
  byFolder: Record<string, string[]>;
}
export interface ClassifyUndo {
  v: 1;
  at: number;
  createdFolderIds: string[];
  /** 资源 → 归类前的目录 ID。空字符串表示当时在虚拟根桶，不是一条目录。 */
  previous: Record<string, string[]>;
}
export interface WebStub {
  resourceId: string;
  url: string;
  title: string;
}
export interface WebStubStore {
  v: 1;
  items: WebStub[];
}
export interface ClassItem {
  resourceId: string;
  ext: string;
  kind: 'file' | 'dir' | 'web';
}

export function emptyVfolders(): VfolderStore {
  return { v: 1, folders: [] };
}
export function emptyVfolderRefs(): VfolderRefs {
  return { v: 1, byFolder: {} };
}

export function cleanFolderName(name: string): string {
  const n = String(name ?? '').trim();
  if (!n) throw new Error('目录名不能为空');
  if (n.length > 80) throw new Error('目录名过长');
  if (/[\\/]/.test(n)) throw new Error('目录名不能包含斜杠');
  if (/^[A-Za-z]:/.test(n)) throw new Error('目录名不能像磁盘路径');
  return n;
}

function asIdList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of v) {
    if (typeof x !== 'string' || !x || seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

export function parseVfolders(raw: unknown): VfolderStore {
  const o = raw && typeof raw === 'object' ? (raw as { folders?: unknown }) : null;
  const folders: VirtualFolder[] = [];
  const seen = new Set<string>();
  if (o && Array.isArray(o.folders)) {
    for (const f of o.folders) {
      if (!f || typeof f !== 'object') continue;
      const x = f as Partial<VirtualFolder>;
      if (typeof x.folderId !== 'string' || !x.folderId || seen.has(x.folderId)) continue;
      seen.add(x.folderId);
      let name = '未命名';
      try {
        name = cleanFolderName(String(x.name ?? ''));
      } catch {
        name = String(x.name ?? '未命名').replace(/[\\/]/g, ' ').trim().slice(0, 80) || '未命名';
      }
      folders.push({
        folderId: x.folderId,
        parentId: typeof x.parentId === 'string' && x.parentId && x.parentId !== x.folderId ? x.parentId : null,
        name,
        sort: typeof x.sort === 'number' && Number.isFinite(x.sort) ? x.sort : 0,
        createdAt: typeof x.createdAt === 'number' ? x.createdAt : 0,
      });
    }
  }
  const ids = new Set(folders.map((f) => f.folderId));
  for (const f of folders) if (f.parentId && !ids.has(f.parentId)) f.parentId = null;
  return { v: 1, folders };
}

export function parseVfolderRefs(raw: unknown): VfolderRefs {
  const o = raw && typeof raw === 'object' ? (raw as { byFolder?: unknown }) : null;
  const byFolder: Record<string, string[]> = {};
  if (o && o.byFolder && typeof o.byFolder === 'object') {
    for (const [k, v] of Object.entries(o.byFolder as Record<string, unknown>)) {
      if (typeof k !== 'string') continue;
      const ids = asIdList(v);
      if (ids.length) byFolder[k] = ids;
    }
  }
  return { v: 1, byFolder };
}

export function parseUndo(raw: unknown): ClassifyUndo | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Partial<ClassifyUndo>;
  if (o.v !== 1 || !o.previous || typeof o.previous !== 'object') return null;
  const previous: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(o.previous)) {
    if (typeof k !== 'string' || !k) continue;
    const ids = asIdList(v);
    // asIdList 会丢掉空字符串；这里把它当作「当时在虚拟根桶」的标记留住。
    if (Array.isArray(v) && v.includes('')) ids.push('');
    previous[k] = ids;
  }
  return { v: 1, at: typeof o.at === 'number' ? o.at : 0, createdFolderIds: asIdList(o.createdFolderIds), previous };
}

export function parseWebStubs(raw: unknown): WebStubStore {
  const o = raw && typeof raw === 'object' ? (raw as { items?: unknown }) : null;
  const items: WebStub[] = [];
  if (o && Array.isArray(o.items)) {
    for (const it of o.items) {
      if (!it || typeof it !== 'object') continue;
      const x = it as Partial<WebStub>;
      if (typeof x.resourceId !== 'string' || !x.resourceId) continue;
      items.push({ resourceId: x.resourceId, url: typeof x.url === 'string' ? x.url : '', title: typeof x.title === 'string' ? x.title : x.resourceId });
    }
  }
  return { v: 1, items };
}

export function createFolder(store: VfolderStore, parentId: string | null, name: string, now: number, id: string): { store: VfolderStore; folder: VirtualFolder } {
  const clean = cleanFolderName(name);
  if (parentId && !store.folders.some((f) => f.folderId === parentId)) throw new Error(`上级目录不存在: ${parentId}`);
  const sort = store.folders.filter((f) => f.parentId === parentId).reduce((m, f) => Math.max(m, f.sort), -1) + 1;
  const folder: VirtualFolder = { folderId: id, parentId, name: clean, sort, createdAt: now };
  return { store: { v: 1, folders: [...store.folders, folder] }, folder };
}

export function renameFolder(store: VfolderStore, folderId: string, name: string): { store: VfolderStore; folder: VirtualFolder } {
  const clean = cleanFolderName(name);
  const cur = store.folders.find((f) => f.folderId === folderId);
  if (!cur) throw new Error(`自建目录不存在: ${folderId}`);
  const folder = { ...cur, name: clean };
  return { store: { v: 1, folders: store.folders.map((f) => (f.folderId === folderId ? folder : f)) }, folder };
}

function descendantOf(folders: VirtualFolder[], id: string, ancestor: string): boolean {
  const byId = new Map(folders.map((f) => [f.folderId, f]));
  let cur = byId.get(id);
  const guard = new Set<string>();
  while (cur?.parentId) {
    if (cur.parentId === ancestor) return true;
    if (guard.has(cur.folderId)) return true;
    guard.add(cur.folderId);
    cur = byId.get(cur.parentId);
  }
  return false;
}

export function moveFolder(store: VfolderStore, folderId: string, newParentId: string | null, sort: number): { store: VfolderStore; folder: VirtualFolder } {
  const cur = store.folders.find((f) => f.folderId === folderId);
  if (!cur) throw new Error(`自建目录不存在: ${folderId}`);
  if (newParentId === folderId) throw new Error('不能把目录移到自己下面');
  if (newParentId && !store.folders.some((f) => f.folderId === newParentId)) throw new Error(`上级目录不存在: ${newParentId}`);
  if (newParentId && descendantOf(store.folders, newParentId, folderId)) throw new Error('不能把目录移到自己的子目录下');
  const nextSort = Number.isFinite(sort) ? sort : cur.sort;
  const folder = { ...cur, parentId: newParentId, sort: nextSort };
  return { store: { v: 1, folders: store.folders.map((f) => (f.folderId === folderId ? folder : f)) }, folder };
}

/** 删除目录：子目录上移一层；成员并入上一级（没有上一级则进入虚拟根桶）。不关闭面板、不改工作区引用。 */
export function deleteFolder(store: VfolderStore, refs: VfolderRefs, folderId: string): { store: VfolderStore; refs: VfolderRefs; parentId: string | null } {
  const folder = store.folders.find((f) => f.folderId === folderId);
  if (!folder) throw new Error(`自建目录不存在: ${folderId}`);
  const parentId = folder.parentId;
  const folders = store.folders.filter((f) => f.folderId !== folderId).map((f) => (f.parentId === folderId ? { ...f, parentId } : f));
  const byFolder: Record<string, string[]> = {};
  for (const [k, arr] of Object.entries(refs.byFolder)) {
    if (k === folderId) continue;
    const ids = asIdList(arr);
    if (ids.length) byFolder[k] = ids;
  }
  const dest = parentId ?? '';
  const incoming = asIdList(refs.byFolder[folderId]);
  const base = byFolder[dest] ?? [];
  const seen = new Set(base);
  const merged = base.slice();
  for (const id of incoming) {
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(id);
  }
  if (merged.length) byFolder[dest] = merged;
  return { store: { v: 1, folders }, refs: { v: 1, byFolder }, parentId };
}

export function foldersOf(refs: VfolderRefs, resourceId: string): string[] {
  const out: string[] = [];
  for (const [k, arr] of Object.entries(refs.byFolder)) {
    if (!k) continue;
    if (arr.includes(resourceId)) out.push(k);
  }
  return out;
}

/** 替换该资源所属的自建目录集合。空数组表示不在任何自建目录（并从虚拟根桶拿掉）。未知目录 ID 忽略。 */
export function setMembership(refs: VfolderRefs, knownFolderIds: Set<string>, resourceId: string, folderIds: string[]): VfolderRefs {
  if (!resourceId) throw new Error('资源 ID 无效');
  const wanted = [...new Set(folderIds.filter((id) => knownFolderIds.has(id)))];
  const byFolder: Record<string, string[]> = {};
  for (const [k, arr] of Object.entries(refs.byFolder)) {
    const next = arr.filter((id) => id !== resourceId);
    if (next.length) byFolder[k] = next;
  }
  for (const fid of wanted) {
    const cur = byFolder[fid] ?? [];
    if (!cur.includes(resourceId)) byFolder[fid] = [...cur, resourceId];
  }
  return { v: 1, byFolder };
}

/** 只从某一个目录拿掉。若此后不在任何自建目录里，则放到虚拟根桶，避免条目消失。 */
export function removeFromOneFolder(refs: VfolderRefs, resourceId: string, folderId: string | null): VfolderRefs {
  const key = folderId ?? '';
  const byFolder: Record<string, string[]> = {};
  for (const [k, arr] of Object.entries(refs.byFolder)) {
    const next = k === key ? arr.filter((id) => id !== resourceId) : arr.slice();
    if (next.length) byFolder[k] = next;
  }
  const still = foldersOf({ v: 1, byFolder }, resourceId);
  if (still.length === 0 && key !== '') {
    const root = byFolder[''] ?? [];
    if (!root.includes(resourceId)) byFolder[''] = [...root, resourceId];
  }
  return { v: 1, byFolder };
}

const EXT_BUCKETS: [string, string[]][] = [
  ['笔记', ['md', 'markdown']],
  ['文本', ['txt', 'log']],
  ['PDF', ['pdf']],
  ['图片', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']],
  ['表格', ['csv', 'tsv']],
  ['数据', ['json', 'xml', 'yaml', 'yml', 'toml', 'ini']],
  ['代码', ['js', 'ts', 'tsx', 'jsx', 'py', 'java', 'c', 'h', 'cpp', 'cs', 'go', 'rs', 'sh', 'ps1', 'bat', 'sql']],
  ['网页', ['html', 'htm', 'css']],
];

export function bucketName(item: ClassItem): string {
  if (item.kind === 'web') return '网络资料';
  if (item.kind === 'dir') return '文件夹';
  const ext = (item.ext || '').toLowerCase();
  for (const [name, exts] of EXT_BUCKETS) if (exts.includes(ext)) return name;
  return '其他';
}

export function classifyInto(
  store: VfolderStore,
  refs: VfolderRefs,
  items: ClassItem[],
  now: number,
  newId: () => string,
): { store: VfolderStore; refs: VfolderRefs; undo: ClassifyUndo | null; added: number; createdFolderIds: string[] } {
  let nextStore = store;
  let nextRefs = refs;
  const createdFolderIds: string[] = [];
  const previous: Record<string, string[]> = {};
  let added = 0;
  const seenRes = new Set<string>();
  for (const item of items) {
    if (!item.resourceId || seenRes.has(item.resourceId)) continue;
    seenRes.add(item.resourceId);
    const name = bucketName(item);
    let folder = nextStore.folders.find((f) => f.parentId === null && f.name === name);
    if (!folder) {
      const created = createFolder(nextStore, null, name, now, newId());
      nextStore = created.store;
      folder = created.folder;
      createdFolderIds.push(folder.folderId);
    }
    if (!(item.resourceId in previous)) {
      const named = foldersOf(nextRefs, item.resourceId);
      const inRoot = (nextRefs.byFolder[''] ?? []).includes(item.resourceId);
      // '' 不是目录 ID，只用来记住「当时在虚拟根桶」，撤销时放回去。
      previous[item.resourceId] = inRoot ? [...named, ''] : named;
    }
    const have = new Set(foldersOf(nextRefs, item.resourceId));
    if (!have.has(folder.folderId)) {
      have.add(folder.folderId);
      added++;
    }
    nextRefs = setMembership(nextRefs, new Set(nextStore.folders.map((f) => f.folderId)), item.resourceId, [...have]);
  }
  if (added === 0 && createdFolderIds.length === 0) return { store, refs, undo: null, added: 0, createdFolderIds: [] };
  return { store: nextStore, refs: nextRefs, undo: { v: 1, at: now, createdFolderIds, previous }, added, createdFolderIds };
}

export function undoClassify(store: VfolderStore, refs: VfolderRefs, undo: ClassifyUndo): { store: VfolderStore; refs: VfolderRefs; removedFolders: number } {
  let nextRefs = refs;
  const known = new Set(store.folders.map((f) => f.folderId));
  for (const [resourceId, folderIds] of Object.entries(undo.previous)) {
    const named = folderIds.filter((id) => known.has(id));
    nextRefs = setMembership(nextRefs, known, resourceId, named);
    if (folderIds.includes('')) {
      const root = nextRefs.byFolder[''] ?? [];
      if (!root.includes(resourceId)) nextRefs = { v: 1, byFolder: { ...nextRefs.byFolder, '': [...root, resourceId] } };
    }
  }
  let nextStore = store;
  let removedFolders = 0;
  for (const id of undo.createdFolderIds) {
    const hasChild = nextStore.folders.some((f) => f.parentId === id);
    const members = nextRefs.byFolder[id] ?? [];
    if (hasChild || members.length) continue;
    if (!nextStore.folders.some((f) => f.folderId === id)) continue;
    nextStore = { v: 1, folders: nextStore.folders.filter((f) => f.folderId !== id) };
    if (nextRefs.byFolder[id]) {
      const byFolder = { ...nextRefs.byFolder };
      delete byFolder[id];
      nextRefs = { v: 1, byFolder };
    }
    removedFolders++;
  }
  return { store: nextStore, refs: nextRefs, removedFolders };
}
