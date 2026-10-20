import { parseDragPayload, serializeDragPayload } from './mime';
import { peekNativeDragSession } from '../nativeDrag/session';
import { KB_RESOURCE_MIME, type DragPayload, type Modifiers } from './types';

/** 同窗口 HTML5 拖拽时 dragover 读不到 dataTransfer 内容，用这份副本。 */
let current: DragPayload | null = null;

function typesOf(dt: DataTransfer): string[] {
  try { return [...dt.types]; } catch { return []; }
}

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

/**
 * 有 KB_RESOURCE_MIME 就用它。
 * 否则只有 Files、并且原生拖动会话还没过期时，用会话里的应用内载荷。
 * 没有会话的 Files 是外部文件，这里返回 null。
 */
export function readKbPayload(dt: DataTransfer, now = Date.now()): DragPayload | null {
  const types = typesOf(dt);
  if (types.includes(KB_RESOURCE_MIME)) {
    let raw = '';
    try { raw = dt.getData(KB_RESOURCE_MIME); } catch { raw = ''; }
    if (raw) {
      const parsed = parseDragPayload(raw);
      if (parsed) return parsed;
    }
    return current;
  }
  if (types.includes('Files')) {
    return peekNativeDragSession(now)?.kb ?? null;
  }
  return current;
}

export function readKbPayloadJson(dt: DataTransfer, now = Date.now()): string {
  const types = typesOf(dt);
  if (types.includes(KB_RESOURCE_MIME)) {
    try {
      const raw = dt.getData(KB_RESOURCE_MIME);
      if (raw && parseDragPayload(raw)) return raw;
    } catch { /* dragover 读不到内容 */ }
  }
  const payload = readKbPayload(dt, now);
  return payload ? serializeDragPayload(payload) : '';
}

/** 自定义 MIME，或 Files 且会话里有应用内载荷。纯外部文件不是。 */
export function isKbDrag(dt: DataTransfer, now = Date.now()): boolean {
  const types = typesOf(dt);
  if (types.includes(KB_RESOURCE_MIME)) return true;
  if (types.includes('Files')) return peekNativeDragSession(now)?.kb != null;
  return current !== null;
}

export function readDrag(dt: DataTransfer): DragPayload | null {
  return readKbPayload(dt);
}

export function hasOurDrag(dt: DataTransfer): boolean {
  return isKbDrag(dt);
}

export function modifiersOf(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean }): Modifiers {
  return { alt: e.altKey, ctrl: e.ctrlKey || e.metaKey };
}
