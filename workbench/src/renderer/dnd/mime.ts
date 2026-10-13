import { KB_RESOURCE_MIME, type DragEntry, type DragFrom, type DragItem, type DragPayload } from './types';

export { KB_RESOURCE_MIME };

function isFrom(v: unknown): v is DragFrom {
  if (!v || typeof v !== 'object') return false;
  const k = (v as { kind?: unknown }).kind;
  if (k === 'root') return typeof (v as { rootId?: unknown }).rootId === 'string' && typeof (v as { relPath?: unknown }).relPath === 'string';
  if (k === 'vfolder') return (v as { folderId?: unknown }).folderId === null || typeof (v as { folderId?: unknown }).folderId === 'string';
  if (k === 'workspace-refs') return typeof (v as { workspaceId?: unknown }).workspaceId === 'string';
  return k === 'roots-list';
}

const ENTRIES: DragEntry[] = ['file', 'vfolder-node', 'dir-entry'];

export function parseDragPayload(raw: string): DragPayload | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as { v?: unknown; items?: unknown };
  if (o.v !== 1 || !Array.isArray(o.items)) return null;
  const items: DragItem[] = [];
  for (const it of o.items) {
    if (!it || typeof it !== 'object') return null;
    const x = it as DragItem;
    if (typeof x.resourceId !== 'string') return null;
    if (x.sourceKind !== 'file' && x.sourceKind !== 'web') return null;
    if (!isFrom(x.from)) return null;
    const entry = (x as { entry?: unknown }).entry;
    if (entry !== undefined && (typeof entry !== 'string' || !ENTRIES.includes(entry as DragEntry))) {
      items.push({ ...x, entry: undefined });
      continue;
    }
    items.push(x);
  }
  return { v: 1, items };
}

export function serializeDragPayload(p: DragPayload): string {
  return JSON.stringify(p);
}

/** 只认 C 的三值。缺省、未知都不当成 file。 */
export function entryOf(it: DragItem): DragEntry | null {
  if (it.entry === 'file' || it.entry === 'vfolder-node' || it.entry === 'dir-entry') return it.entry;
  return null;
}

/** 资源记录上的磁盘位置。没有 rootId 时不编造。 */
export function attachDisk(it: DragItem, resource: { rootId?: string; relPath?: string; name?: string; size?: number } | null): DragItem {
  if (!resource?.rootId || typeof resource.relPath !== 'string') return it;
  return {
    ...it,
    rootId: it.rootId || resource.rootId,
    relPath: typeof it.relPath === 'string' ? it.relPath : resource.relPath,
    name: it.name || resource.name,
    size: it.size ?? resource.size,
  };
}

export function diskOf(it: DragItem): { rootId: string; relPath: string } | null {
  if (it.rootId && typeof it.relPath === 'string') return { rootId: it.rootId, relPath: it.relPath };
  if (it.from.kind === 'root') return { rootId: it.from.rootId, relPath: it.from.relPath };
  return null;
}

export function baseName(relPath: string, fallback: string): string {
  if (fallback) return fallback;
  const i = relPath.lastIndexOf('/');
  return (i >= 0 ? relPath.slice(i + 1) : relPath) || fallback;
}
