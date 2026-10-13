import { entryOf } from './mime';
import type { DragFrom, DragItem, DropTarget } from './types';

/**
 * 把 C 的落点（DragFrom）译成拖拽语义。
 * 根行的落点形状和磁盘根目录一样，要靠载荷区分「调序」和「移进该根」。
 * 文件行和目录行的落点形状也一样，只有目录才是磁盘落点。
 */
export function interpretDirTarget(
  target: DragFrom,
  items: DragItem[],
  rootIds: string[],
  hit: { kind: 'file' | 'dir' } | null,
  childNames: string[],
): DropTarget {
  const allRoots = items.length > 0 && items.every((it) => it.from.kind === 'roots-list' && entryOf(it) === 'dir-entry');
  if (target.kind === 'roots-list' || (allRoots && target.kind === 'root' && target.relPath === '')) {
    let index = rootIds.length;
    if (target.kind === 'root') {
      const at = rootIds.indexOf(target.rootId);
      if (at >= 0) index = at;
    }
    return { kind: 'roots-list', rootIds, index };
  }
  if (allRoots) return { kind: 'invalid' };
  if (target.kind === 'vfolder') {
    if (!target.folderId) return { kind: 'invalid' };
    return { kind: 'vfolder', folderId: target.folderId };
  }
  if (target.kind === 'workspace-refs') {
    if (!target.workspaceId) return { kind: 'invalid' };
    return { kind: 'workspace-refs', workspaceId: target.workspaceId };
  }
  if (target.kind === 'root') {
    if (target.relPath === '') return { kind: 'disk-dir', rootId: target.rootId, relPath: '', childNames };
    if (!hit || hit.kind !== 'dir') return { kind: 'invalid' };
    return { kind: 'disk-dir', rootId: target.rootId, relPath: target.relPath, childNames };
  }
  return { kind: 'invalid' };
}
