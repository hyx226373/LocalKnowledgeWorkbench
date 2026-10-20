/**
 * 从拖放里取出要放进链接区的文件夹或文件。虚拟目录和网页不收。
 */
import { readKbPayload } from '../dnd/drag';
import type { DragItem, DragPayload } from '../dnd/types';
import { osDropPieces, piecesFromTransfer, type DropPiece } from '../agent-live/dropIn';
import { fileUriToPath } from '../agent-live/paths';
import { nativeNodePath } from '../nativeDrag/paths';

export interface LinkTarget {
  path: string;
  name: string;
  kind: 'dir' | 'file';
}

function push(out: LinkTarget[], seen: Set<string>, target: LinkTarget | null): void {
  if (!target?.path.trim()) return;
  const key = target.path.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ path: target.path, name: target.name.trim() || target.path.split(/[\\/]/).pop() || target.path, kind: target.kind });
}

export function linkTargetFromDragItem(item: DragItem): LinkTarget | null {
  if (item.sourceKind === 'web' || item.entry === 'vfolder-node') return null;
  const kind = item.entry === 'dir-entry' ? 'dir' : item.entry === 'file' ? 'file' : null;
  if (!kind) return null;
  const rootId = item.rootId || (item.from.kind === 'root' ? item.from.rootId : '');
  const rel = item.relPath || (item.from.kind === 'root' ? item.from.relPath : '');
  const abs = nativeNodePath(rootId, rel || '', kind);
  if (!abs) return null;
  return { path: abs, name: item.name?.trim() || abs.split(/[\\/]/).pop() || abs, kind };
}

export function linkTargetsFromPayload(payload: DragPayload | null): LinkTarget[] {
  if (!payload) return [];
  const out: LinkTarget[] = [];
  const seen = new Set<string>();
  for (const item of payload.items) push(out, seen, linkTargetFromDragItem(item));
  return out;
}

export function linkTargetsFromPieces(pieces: readonly DropPiece[]): LinkTarget[] {
  const out: LinkTarget[] = [];
  const seen = new Set<string>();
  for (const piece of pieces) {
    if (piece.reject || !piece.ref?.absPath) continue;
    push(out, seen, {
      path: piece.ref.absPath,
      name: piece.ref.name || piece.ref.absPath,
      kind: piece.kind === 'dir' ? 'dir' : 'file',
    });
  }
  return out;
}

export function linkTargetsFromTransfer(data: DataTransfer): LinkTarget[] {
  const types = [...data.types];
  const out: LinkTarget[] = [];
  const seen = new Set<string>();
  const take = (targets: readonly LinkTarget[]) => {
    for (const target of targets) push(out, seen, target);
  };
  take(linkTargetsFromPayload(readKbPayload(data)));
  take(linkTargetsFromPieces(piecesFromTransfer(types, (type) => data.getData(type), data)));
  take(linkTargetsFromPieces(osDropPieces(data)));
  if (types.includes('text/uri-list')) {
    const uris: LinkTarget[] = [];
    for (const line of data.getData('text/uri-list').split(/\r?\n/)) {
      const abs = fileUriToPath(line);
      if (!abs) continue;
      uris.push({ path: abs, name: abs.split(/[\\/]/).pop() || abs, kind: 'file' });
    }
    take(uris);
  }
  return out;
}
