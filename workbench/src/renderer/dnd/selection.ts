import type { DragItem, DragPayload } from './types';

/** 多选只存在于这次拖拽。Ctrl/⌘ 点选，拖其中一项时合成一个载荷。 */
const selected = new Set<string>();
const known = new Map<string, DragItem>();
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function selectedIds(): string[] {
  return [...selected];
}

export function isSelected(id: string): boolean {
  return selected.has(id);
}

export function subscribeSelection(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function toggleSelected(id: string) {
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  emit();
}

export function rememberDragItem(item: DragItem) {
  known.set(item.resourceId, item);
}

/** 拖到的那一项在多选里时，带上同一种条目；否则只拖这一项。 */
export function payloadFor(item: DragItem): DragPayload {
  if (!selected.has(item.resourceId)) return { v: 1, items: [item] };
  const items = selectedIds()
    .map((id) => known.get(id))
    .filter((x): x is DragItem => !!x && (x.entry ?? '') === (item.entry ?? ''));
  return { v: 1, items: items.length ? items : [item] };
}

export function clearSelection() {
  if (selected.size === 0) {
    known.clear();
    return;
  }
  selected.clear();
  known.clear();
  emit();
}

function isDiskDragItem(item: DragItem): boolean {
  return item.sourceKind !== 'web' && (item.entry === 'file' || item.entry === 'dir-entry');
}

/**
 * 拖到的那一项已多选时，带上所有已记住的文件和文件夹，被拖的那一项排在最前。
 * 未选中则只拖这一项。虚拟目录和网络资料不进 startDrag 的 files。
 */
export function selectedDiskItems(anchor: DragItem): DragItem[] {
  if (!isDiskDragItem(anchor)) return [];
  if (!selected.has(anchor.resourceId)) return [anchor];
  const rest = selectedIds()
    .filter((id) => id !== anchor.resourceId)
    .map((id) => known.get(id))
    .filter((item): item is DragItem => !!item && isDiskDragItem(item));
  const stored = known.get(anchor.resourceId);
  const head = stored && isDiskDragItem(stored) ? stored : anchor;
  return [head, ...rest];
}
