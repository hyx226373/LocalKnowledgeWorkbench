/**
 * kb:native-drag-start 的纯逻辑。
 * 校验仍走 nativeDrag controller（根外、符号链接、日志环）。
 * 通过后立刻 startDrag；返回（Windows 上会阻塞到放下）后再通知渲染进程清会话。
 */
import type { NativeDragMode, NativeDragResult } from '../../shared/nativeDragPolicy';

export interface NativeDragIcon {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
}

export interface NativeDragIpcController {
  deny(requested: unknown, reason: string): NativeDragResult;
  startUsing(requested: unknown, mode: NativeDragMode, startDrag: (paths: string[]) => void): NativeDragResult;
}

export interface DragIconSnapshot {
  empty: boolean;
  width: number;
  height: number;
}

export function iconSnapshot(icon: NativeDragIcon): DragIconSnapshot {
  let empty = true;
  let width = 0;
  let height = 0;
  try { empty = icon.isEmpty(); } catch { empty = true; }
  try {
    const size = icon.getSize();
    width = Number.isFinite(size?.width) ? size.width : 0;
    height = Number.isFinite(size?.height) ? size.height : 0;
  } catch {
    width = 0;
    height = 0;
  }
  return { empty, width, height };
}

/** startDrag 失败时把错误原文和图标是否为空、尺寸写进 reason。 */
export function rethrowStartDrag(err: unknown, icon: NativeDragIcon): never {
  const message = err instanceof Error ? err.message : String(err);
  if (message === 'no-window') throw err instanceof Error ? err : new Error('no-window');
  const snap = iconSnapshot(icon);
  throw new Error(`${message}; iconEmpty=${snap.empty}; icon=${snap.width}x${snap.height}`);
}

export function parseNativeDragPayload(payload: unknown): { paths: unknown; mode: NativeDragMode } {
  if (Array.isArray(payload)) return { paths: payload, mode: 'file' };
  if (payload && typeof payload === 'object') {
    const body = payload as { paths?: unknown; mode?: unknown };
    const paths = 'paths' in body ? body.paths : payload;
    return { paths, mode: body.mode === 'path' ? 'path' : 'file' };
  }
  return { paths: payload, mode: 'file' };
}

/** 只有 preload 的 sendSync 带 sync:true。界面用异步 send，不能写 returnValue。 */
export function nativeDragWantsSyncReply(payload: unknown): boolean {
  return !!payload && typeof payload === 'object' && !Array.isArray(payload) && (payload as { sync?: unknown }).sync === true;
}

export function handleNativeDragIpc<T extends NativeDragIcon>(input: {
  payload: unknown;
  allowed: boolean;
  controller: NativeDragIpcController;
  icon: () => T;
  startDrag: (files: string[], icon: T) => void;
  notifyEnded: () => void;
}): NativeDragResult {
  const parsed = parseNativeDragPayload(input.payload);
  if (!input.allowed) {
    const denied = input.controller.deny(parsed.paths, 'no-window');
    if (parsed.mode === 'file') input.notifyEnded();
    return denied;
  }
  if (parsed.mode === 'path') {
    return input.controller.startUsing(parsed.paths, 'path', () => undefined);
  }
  const result = input.controller.startUsing(parsed.paths, 'file', (files) => {
    const icon = input.icon();
    try {
      input.startDrag(files, icon);
    } catch (err) {
      rethrowStartDrag(err, icon);
    }
  });
  input.notifyEnded();
  return result;
}
