import { parseDragPayload, serializeDragPayload } from './mime';
import { KB_RESOURCE_MIME, type DragPayload, type Modifiers } from './types';

/** 同窗口拖拽时 dragover 读不到 dataTransfer 内容，用这份副本。 */
let current: DragPayload | null = null;

export function beginDrag(payload: DragPayload, dt: DataTransfer) {
  current = payload;
  dt.setData(KB_RESOURCE_MIME, serializeDragPayload(payload));
  // copyMove 不含 link。归类和工作区引用的 dropEffect 是 link，设成 copyMove 时浏览器会把落点当成 none，drop 不会发生。
  dt.effectAllowed = 'all';
}

export function endDrag() {
  current = null;
}

export function peekDrag(): DragPayload | null {
  return current;
}

export function readDrag(dt: DataTransfer): DragPayload | null {
  const raw = dt.getData(KB_RESOURCE_MIME);
  if (raw) return parseDragPayload(raw);
  return current;
}

export function hasOurDrag(dt: DataTransfer): boolean {
  return current !== null || [...dt.types].includes(KB_RESOURCE_MIME);
}

export function modifiersOf(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean }): Modifiers {
  return { alt: e.altKey, ctrl: e.ctrlKey || e.metaKey };
}
