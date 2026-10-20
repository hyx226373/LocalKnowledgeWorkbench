/**
 * 文件模式原生拖动的应用内载荷。
 * dragstart 里 preventDefault 之后，dataTransfer 不再带 KB MIME。
 * 操作系统拖回本窗口时 types 只有 Files，落点从这里取回原来的载荷。
 */
import type { DragPayload } from '../dnd/types';

export const NATIVE_DRAG_SESSION_MS = 60_000;

export interface NativeDragSession {
  at: number;
  paths: string[];
  /** 目录树 / 工作台资料 / 标签 Alt 拖出。落点按应用内资源移动或引用。 */
  kb: DragPayload | null;
  /** 资料区向外复制。没有 KB 载荷，不能当成目录移动。 */
  copyFiles: string[] | null;
}

let session: NativeDragSession | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let skipNextDragEnd = false;

function uniquePaths(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of values) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function copyPayload(payload: DragPayload | null | undefined): DragPayload | null {
  if (!payload || payload.v !== 1 || !Array.isArray(payload.items)) return null;
  return {
    v: 1,
    items: payload.items.map((item) => ({ ...item, from: { ...item.from } })),
  };
}

export function beginNativeDragSession(input: {
  paths: readonly string[];
  kb?: DragPayload | null;
  copyFiles?: readonly string[] | null;
  now?: number;
}): NativeDragSession {
  const at = input.now ?? Date.now();
  session = {
    at,
    paths: uniquePaths(input.paths),
    kb: copyPayload(input.kb),
    copyFiles: input.copyFiles ? uniquePaths(input.copyFiles) : null,
  };
  skipNextDragEnd = true;
  if (timer != null) clearTimeout(timer);
  const token = session;
  timer = setTimeout(() => {
    timer = null;
    if (session === token) clearNativeDragSession();
  }, NATIVE_DRAG_SESSION_MS);
  return session;
}

export function peekNativeDragSession(now = Date.now()): NativeDragSession | null {
  if (!session) return null;
  if (now - session.at >= NATIVE_DRAG_SESSION_MS) {
    clearNativeDragSession();
    return null;
  }
  return session;
}

export function clearNativeDragSession(): void {
  session = null;
  skipNextDragEnd = false;
  if (timer != null) {
    clearTimeout(timer);
    timer = null;
  }
}

/** preventDefault 取消 HTML5 拖动时，浏览器可能马上派发一次 dragend。这一次不清会话。 */
export function noteNativeDragEnd(): void {
  if (!session) {
    skipNextDragEnd = false;
    return;
  }
  if (skipNextDragEnd) {
    skipNextDragEnd = false;
    return;
  }
  clearNativeDragSession();
}

/** 捕获阶段就会听到 drop。等这一轮事件处理完再清，落点还能读到会话。 */
export function noteNativeDragDrop(): void {
  if (!session) return;
  const token = session;
  setTimeout(() => {
    if (session === token) clearNativeDragSession();
  }, 0);
}

export function nativeSessionClaimsFiles(types: readonly string[], now = Date.now()): boolean {
  return types.includes('Files') && peekNativeDragSession(now) != null;
}
