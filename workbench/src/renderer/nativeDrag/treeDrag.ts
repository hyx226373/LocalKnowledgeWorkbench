/**
 * 目录树拖出：文件、根目录、子文件夹都变成绝对路径。
 * 多选时被拖的那一项在前，其余已选的文件和文件夹跟在后面，交给同一次 startDrag。
 */
import type { DragItem } from '../dnd/types';
import { clearSelection, isSelected, rememberDragItem, selectedDiskItems, subscribeSelection, toggleSelected } from '../dnd/selection';
import type { KbDragItem, KbDragPayload } from '../dir-view/dnd';
import { nativeDirPath, nativeFilePath } from './paths';

export function cleanDragPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('\0')) return '';
  const stripped = trimmed.replace(/[\\/]+$/, '');
  if (!stripped || /^[A-Za-z]:$/.test(stripped)) return trimmed;
  return stripped;
}

export function kbItemToDrag(item: KbDragItem): DragItem {
  const rootId = item.rootId ?? (item.from.kind === 'root' ? item.from.rootId : undefined);
  const relPath = typeof item.relPath === 'string'
    ? item.relPath
    : item.from.kind === 'root'
      ? item.from.relPath
      : item.from.kind === 'roots-list'
        ? ''
        : undefined;
  return {
    resourceId: item.resourceId,
    sourceKind: item.sourceKind,
    from: item.from,
    entry: item.entry,
    name: item.name,
    ...(item.size != null ? { size: item.size } : {}),
    ...(rootId ? { rootId } : {}),
    ...(relPath !== undefined ? { relPath } : {}),
  };
}

function dragItemToKb(item: DragItem): KbDragItem {
  const entry = item.entry === 'dir-entry' || item.entry === 'vfolder-node' ? item.entry : 'file';
  return {
    resourceId: item.resourceId,
    sourceKind: item.sourceKind,
    from: item.from,
    entry,
    ...(item.name ? { name: item.name } : {}),
    ...(item.size != null ? { size: item.size } : {}),
    ...(item.rootId ? { rootId: item.rootId } : {}),
    ...(typeof item.relPath === 'string' ? { relPath: item.relPath } : {}),
  };
}

/** 文件或目录的绝对路径。拼不出（虚拟目录、网络资料、`..`）返回 null。 */
export function absoluteTreePath(item: DragItem): string | null {
  if (item.sourceKind === 'web' || item.entry === 'vfolder-node') return null;
  const rootId = item.rootId ?? (item.from.kind === 'root' ? item.from.rootId : undefined);
  if (!rootId) return null;
  const rel = typeof item.relPath === 'string' ? item.relPath : item.from.kind === 'root' ? item.from.relPath : '';
  if (item.entry === 'dir-entry') return nativeDirPath(rootId, rel);
  if (item.entry === 'file') return nativeFilePath(rootId, rel, 'file');
  return null;
}

export function mergeDragPaths(payload: KbDragPayload, extra: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: string | null | undefined) => {
    if (typeof value !== 'string') return;
    const cleaned = cleanDragPath(value);
    if (!cleaned) return;
    const key = cleaned.replace(/\\/g, '/');
    if (seen.has(key)) return;
    seen.add(key);
    out.push(cleaned);
  };
  for (const item of payload.items) push(absoluteTreePath(kbItemToDrag(item)));
  for (const item of extra) push(item);
  return out;
}

/** Ctrl/⌘ 点选。记住条目后再切换，拖的时候才能带上绝对路径。 */
export function toggleTreeMulti(seed: KbDragPayload): void {
  const item = seed.items[0];
  if (!item?.resourceId) return;
  rememberDragItem(kbItemToDrag(item));
  toggleSelected(item.resourceId);
}

export function clearTreeMulti(): void {
  clearSelection();
}

export function treeItemSelected(resourceId: string): boolean {
  return isSelected(resourceId);
}

export function subscribeTreeMulti(cb: () => void): () => void {
  return subscribeSelection(cb);
}

/**
 * 种子里的第一项若在多选中，载荷改成全部已选的文件和文件夹（被拖的那一项在前）。
 * 否则保持种子。paths 是要交给 startDrag 的绝对路径。
 */
export function prepareTreeDrag(seed: KbDragPayload, extra: readonly string[] = []): { payload: KbDragPayload; paths: string[] } {
  const first = seed.items[0];
  if (!first) return { payload: seed, paths: mergeDragPaths(seed, extra) };
  const anchor = kbItemToDrag(first);
  rememberDragItem(anchor);
  const picked = selectedDiskItems(anchor);
  const multi = isSelected(anchor.resourceId) && picked.some((item) => item.resourceId !== anchor.resourceId);
  const payload: KbDragPayload = multi ? { v: 1, items: picked.map(dragItemToKb) } : seed;
  return { payload, paths: mergeDragPaths(payload, extra) };
}
