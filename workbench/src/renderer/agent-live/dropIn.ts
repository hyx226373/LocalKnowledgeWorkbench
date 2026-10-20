import type { MaterialRef } from '../../shared/agentLive/types';
import { readKbPayload } from '../dnd/drag';
import { KB_RESOURCE_MIME, parseDragPayload } from '../dnd/mime';
import type { DragItem, DragPayload } from '../dnd/types';
import { peekNativeDragSession } from '../nativeDrag/session';
import { fileUriToPath } from './paths';

export type DropReject = 'web' | 'dir' | 'fragment' | 'unknown';

export interface DropPiece {
  ref?: MaterialRef;
  reject?: DropReject;
  /** 真实文件夹 / 虚拟目录节点 */
  kind?: 'dir';
}

function fromItem(item: DragItem): DropPiece {
  if (item.sourceKind === 'web') {
    return {
      ref: {
        resourceId: item.resourceId,
        name: item.name,
        absPath: item.absPath || '',
        ...(typeof item.relPath === 'string' ? { relPath: item.relPath } : {}),
      },
    };
  }
  if (item.entry === 'dir-entry') {
    const relPath = item.relPath;
    const fromRoot = item.from.kind === 'root' ? item.from.relPath : undefined;
    return {
      ref: {
        resourceId: item.resourceId,
        relPath: relPath || fromRoot,
        name: item.name,
        absPath: item.absPath || '',
      },
      kind: 'dir',
    };
  }
    if (item.entry === 'vfolder-node') {
    return {
      ref: {
        resourceId: item.resourceId,
        name: item.name,
        absPath: item.absPath || '',
        ...(typeof item.folderId === 'string' && item.folderId ? { relPath: 'vfolder:' + item.folderId } : {}),
      },
      kind: 'dir',
    };
  }
  if (item.entry !== 'file') return { reject: 'unknown' };
  const relPath = item.relPath;
  const fromRoot = item.from.kind === 'root' ? item.from.relPath : undefined;
  return {
    ref: {
      resourceId: item.resourceId,
      relPath: relPath || fromRoot,
      name: item.name,
      absPath: item.absPath || '',
    },
  };
}

/** 操作系统拖入的文件。目录标成 dir，没有路径的目录记为拒绝。Agent 资料和上下文底座共用。 */
export function osDropPieces(data: DataTransfer): DropPiece[] {
  const pieces: DropPiece[] = [];
  const items = data.items;
  if (!items) return pieces;
  for (const item of items) {
    const entry = item.webkitGetAsEntry?.();
    if (entry?.isDirectory) {
      const file = item.getAsFile?.();
      const dirPath = (file as (File & { path?: string }) | null)?.path;
      if (dirPath) pieces.push({ ref: { absPath: dirPath, name: file?.name || dirPath }, kind: 'dir' });
      else pieces.push({ reject: 'dir' });
      continue;
    }
    const file = item.getAsFile?.();
    const filePath = (file as (File & { path?: string }) | null)?.path;
    if (filePath) pieces.push({ ref: { absPath: filePath, name: file?.name || filePath } });
  }
  return pieces;
}

export function piecesFromPayload(payload: DragPayload | null): DropPiece[] {
  if (!payload) return [];
  return payload.items.map(fromItem);
}

function copyPieces(files: readonly string[] | null | undefined): DropPiece[] {
  if (!files) return [];
  return files.map((absPath) => ({ ref: { absPath, name: absPath.split(/[\\/]/).pop() || absPath } }));
}

export function piecesFromTransfer(types: readonly string[], getData: (type: string) => string, dt?: DataTransfer | null): DropPiece[] {
  if (dt) {
    const payload = readKbPayload(dt);
    if (payload) return piecesFromPayload(payload);
    if (types.includes('Files') && peekNativeDragSession()) return copyPieces(peekNativeDragSession()?.copyFiles);
  }
  const pieces: DropPiece[] = [];
  if (types.includes(KB_RESOURCE_MIME) || types.includes('text/plain')) {
    const raw = getData(KB_RESOURCE_MIME) || getData('text/plain');
    pieces.push(...piecesFromPayload(parseDragPayload(raw)));
  }
  if (types.includes('text/uri-list')) {
    for (const line of getData('text/uri-list').split(/\r?\n/)) {
      const path = fileUriToPath(line);
      if (!path) continue;
      pieces.push({ ref: { absPath: path, name: path.split('\\').pop() } });
    }
  }
  return pieces;
}

export function partitionPieces(pieces: readonly DropPiece[]): { refs: MaterialRef[]; reject: DropReject | null } {
  const refs: MaterialRef[] = [];
  let reject: DropReject | null = null;
  for (const piece of pieces) {
    if (piece.reject) {
      reject = piece.reject;
      continue;
    }
    if (piece.ref) refs.push(piece.ref);
  }
  return { refs, reject };
}
