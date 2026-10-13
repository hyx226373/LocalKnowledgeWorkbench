/** 消费 C 规定的全局自建目录 KV。只改归类，不碰磁盘，不改字段名。本轮不写 op_log。 */

export const VFOLDERS_KEY = 'library.vfolders';
export const VFOLDER_REFS_KEY = 'library.vfolderRefs';

export interface VirtualFolder {
  folderId: string;
  parentId: string | null;
  name: string;
  sort: number;
  createdAt: number;
}

export interface VfolderTree {
  v: 1;
  folders: VirtualFolder[];
}

export interface VfolderRefs {
  v: 1;
  byFolder: Record<string, string[]>;
}

export function emptyRefs(): VfolderRefs {
  return { v: 1, byFolder: {} };
}

export function parseVfolderRefs(raw: unknown): VfolderRefs {
  if (!raw || typeof raw !== 'object') return emptyRefs();
  const by = (raw as { byFolder?: unknown }).byFolder;
  if (!by || typeof by !== 'object') return emptyRefs();
  const byFolder: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(by)) {
    if (!Array.isArray(v)) continue;
    byFolder[k] = [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0))];
  }
  return { v: 1, byFolder };
}

export function parseVfolderTree(raw: unknown): VfolderTree {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { folders?: unknown }).folders)) return { v: 1, folders: [] };
  const folders: VirtualFolder[] = [];
  for (const f of (raw as { folders: unknown[] }).folders) {
    if (!f || typeof f !== 'object') continue;
    const x = f as VirtualFolder;
    if (typeof x.folderId !== 'string' || typeof x.name !== 'string') continue;
    folders.push({
      folderId: x.folderId,
      parentId: x.parentId === null || typeof x.parentId === 'string' ? x.parentId : null,
      name: x.name,
      sort: typeof x.sort === 'number' ? x.sort : 0,
      createdAt: typeof x.createdAt === 'number' ? x.createdAt : 0,
    });
  }
  return { v: 1, folders };
}

function uniqPush(list: string[] | undefined, ids: string[]): string[] {
  return [...new Set([...(list ?? []), ...ids])];
}

export function addToFolder(refs: VfolderRefs, folderId: string, resourceIds: string[]): VfolderRefs {
  return { v: 1, byFolder: { ...refs.byFolder, [folderId]: uniqPush(refs.byFolder[folderId], resourceIds) } };
}

export function removeFromFolder(refs: VfolderRefs, folderId: string, resourceIds: string[]): VfolderRefs {
  const drop = new Set(resourceIds);
  const next = (refs.byFolder[folderId] ?? []).filter((id) => !drop.has(id));
  const byFolder = { ...refs.byFolder, [folderId]: next };
  return { v: 1, byFolder };
}

export function removeFromAllFolders(refs: VfolderRefs, resourceIds: string[]): VfolderRefs {
  let next = refs;
  for (const folderId of Object.keys(refs.byFolder)) next = removeFromFolder(next, folderId, resourceIds);
  return next;
}

export function foldersOf(refs: VfolderRefs, resourceId: string): string[] {
  return Object.entries(refs.byFolder)
    .filter(([, ids]) => ids.includes(resourceId))
    .map(([id]) => id);
}

/** 从若干来源目录移出（null = 不移出）再加入目标。copy 时不移出。 */
export function shiftInto(
  refs: VfolderRefs,
  folderId: string,
  resourceIds: string[],
  sourceFolderIds: (string | null)[],
  copy: boolean,
): VfolderRefs {
  let next = refs;
  if (!copy) {
    const pairs = resourceIds.map((id, i) => ({ id, from: sourceFolderIds[i] ?? null }));
    for (const folder of new Set(pairs.map((p) => p.from).filter((x): x is string => !!x && x !== folderId))) {
      const ids = pairs.filter((p) => p.from === folder).map((p) => p.id);
      next = removeFromFolder(next, folder, ids);
    }
  }
  return addToFolder(next, folderId, resourceIds);
}
