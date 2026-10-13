import type { MaterialRef } from '../../shared/agentLive/types';
import { KB_RESOURCE_MIME, parseDragPayload } from '../dnd/mime';
import type { DragItem, DragPayload } from '../dnd/types';
import { fileUriToPath } from './paths';

export type DropReject = 'web' | 'dir' | 'fragment' | 'unknown';

export interface DropPiece {
  ref?: MaterialRef;
  reject?: DropReject;
}

function fromItem(item: DragItem): DropPiece {
  if (item.sourceKind === 'web') {
    return {
      ref: {
        resourceId: item.resourceId,
        name: item.name,
        absPath: '',
        ...(typeof item.relPath === 'string' ? { relPath: item.relPath } : {}),
      },
    };
  }
  if (item.entry === 'dir-entry' || item.entry === 'vfolder-node') return { reject: 'dir' };
  if (item.entry !== 'file') return { reject: 'unknown' };
  const relPath = item.relPath;
  const fromRoot = item.from.kind === 'root' ? item.from.relPath : undefined;
  return {
    ref: {
      resourceId: item.resourceId,
      relPath: relPath || fromRoot,
      name: item.name,
      absPath: '',
    },
  };
}

export function piecesFromPayload(payload: DragPayload | null): DropPiece[] {
  if (!payload) return [];
  return payload.items.map(fromItem);
}

export function piecesFromTransfer(types: readonly string[], getData: (type: string) => string): DropPiece[] {
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
