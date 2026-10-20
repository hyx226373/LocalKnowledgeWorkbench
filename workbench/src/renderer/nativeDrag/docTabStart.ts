/**
 * 文档标签默认保持 application/x-kb-doc-tab，给分栏用。
 * 只有文件模式并且按住 Alt 时，才按原生文件拖出。路径模式一律 HTML5 + text/plain。
 */
import type { DragPayload } from '../dnd/types';
import { type DocTabDragPayload } from '../dnd/docTabDrag';
import { beginFileDrag, writePathDrag, type DragStartEvent } from './start';

export function docTabAsDragPayload(payload: DocTabDragPayload): DragPayload {
  const rel = payload.relPath;
  const sourceId = payload.sourceId || undefined;
  const from = sourceId && rel
    ? { kind: 'root' as const, rootId: sourceId, relPath: rel }
    : { kind: 'workspace-refs' as const, workspaceId: '' };
  return {
    v: 1,
    items: [{
      resourceId: payload.resourceId,
      sourceKind: 'file',
      entry: 'file',
      from,
      ...(payload.name ? { name: payload.name } : {}),
      ...(rel ? { relPath: rel } : {}),
      ...(sourceId ? { rootId: sourceId } : {}),
    }],
  };
}

export function commitDocTabDragStart(args: {
  event: DragStartEvent & { altKey: boolean };
  payload: DocTabDragPayload;
  mode: 'file' | 'path';
  absPath: string | null;
  native: boolean;
  writeTab: (transfer: { setData(type: string, value: string): void }, payload: DocTabDragPayload) => void;
}): 'native' | 'path' | 'html5' {
  if (args.mode === 'path') {
    if (args.event.dataTransfer) {
      args.writeTab(args.event.dataTransfer, args.payload);
      if (args.absPath) writePathDrag(args.event.dataTransfer, [args.absPath]);
    }
    return 'path';
  }
  if (args.event.altKey && args.native && args.absPath) {
    if (beginFileDrag(args.event, [args.absPath], { kb: docTabAsDragPayload(args.payload) })) return 'native';
  }
  if (args.event.dataTransfer) args.writeTab(args.event.dataTransfer, args.payload);
  return 'html5';
}
