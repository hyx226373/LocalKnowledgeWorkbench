/**
 * 文件模式：dragstart 里 preventDefault，载荷放进会话，异步通知主进程 startDrag。
 * 不写 dataTransfer。路径模式只写 text/plain，不发 IPC。
 */
import type { DragPayload } from '../dnd/types';
import { kb } from '../kb';
import { applyFileDragOut, planFileDragOut, type DragOutTransfer } from './mode';
import { beginNativeDragSession } from './session';

export interface DragStartEvent {
  preventDefault(): void;
  dataTransfer: DragOutTransfer | null;
}

let senderOverride: ((paths: readonly string[]) => void) | null = null;

/** 单测注入发送函数。传 null 恢复走 preload。 */
export function setNativeDragSender(send: ((paths: readonly string[]) => void) | null): void {
  senderOverride = send;
}

export function nativeFileDragAvailable(): boolean {
  if (senderOverride) return true;
  try {
    return typeof kb?.postNativeFileDrag === 'function';
  } catch {
    return false;
  }
}

export function postFileDrag(paths: readonly string[]): void {
  if (senderOverride) {
    senderOverride(paths);
    return;
  }
  try { kb?.postNativeFileDrag?.(paths); } catch { /* 预加载还没挂上 */ }
}

/**
 * 有可拖路径时：preventDefault、记下会话、默认发出异步 IPC。
 * 没有路径时返回 false，调用方继续原来的 HTML5 拖动。
 */
export function beginFileDrag(
  event: { preventDefault(): void },
  paths: readonly string[],
  payload: { kb?: DragPayload | null; copyFiles?: readonly string[] | null },
  opts?: { send?: boolean },
): boolean {
  const plan = planFileDragOut('file', paths);
  if (!plan.arm) return false;
  event.preventDefault();
  beginNativeDragSession({
    paths: plan.paths,
    kb: payload.kb ?? null,
    copyFiles: payload.copyFiles ?? null,
  });
  if (opts?.send !== false) postFileDrag(plan.paths);
  return true;
}

/** 路径模式。不调用 startDrag，也不发 kb:native-drag-start。 */
export function writePathDrag(transfer: DragOutTransfer | null, paths: readonly string[]): void {
  applyFileDragOut(transfer, paths, 'path', {
    armNative() { /* 路径模式不登记原生拖出 */ },
    notePath() { /* 不发 IPC */ },
  });
}

export function dragAgentMaterial(args: {
  event: { preventDefault(): void; dataTransfer: (DragOutTransfer & { effectAllowed: string }) | null };
  mode: 'file' | 'path';
  absPath: string;
  native: boolean;
  writeCopy: (transfer: DragOutTransfer & { effectAllowed: string }) => void;
  sendNative: (files: string[]) => void;
}): 'file' | 'path' | 'html5' {
  if (args.mode !== 'path' && args.native && args.absPath) {
    const started = beginFileDrag(args.event, [args.absPath], { kb: null, copyFiles: [args.absPath] }, { send: false });
    if (started) {
      args.sendNative([args.absPath]);
      return 'file';
    }
  }
  if (args.event.dataTransfer) {
    args.writeCopy(args.event.dataTransfer);
    if (args.mode === 'path' && args.absPath) {
      try { args.event.dataTransfer.setData('text/plain', args.absPath); } catch { /* 个别环境拒绝 text/plain */ }
    }
  }
  return args.mode === 'path' ? 'path' : 'html5';
}
