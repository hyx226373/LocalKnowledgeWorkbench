import {
  HINT_ALREADY,
  HINT_BAD_ENTRY,
  HINT_CLASSIFY,
  HINT_CLASSIFY_ALT,
  HINT_CLASSIFY_COPY,
  HINT_CLASSIFY_SHIFT,
  HINT_DIR_OPEN,
  HINT_FLOAT,
  HINT_INVALID,
  HINT_NO_ORIGIN,
  HINT_NOT_ROOT,
  HINT_REF,
  HINT_REORDER,
  HINT_SELF,
  HINT_SPLIT,
  HINT_TAB,
  HINT_VFOLDER_NODE,
  HINT_WEB_DISK,
  WILL_MOVE_FILE,
} from './copy';
import { diskOf, entryOf } from './mime';
import { isInside, joinRel, parentRel } from './names';
import { extensionOfName, inAccessScope, OUT_OF_SCOPE_MESSAGE } from '../../shared/sourceFilter';
import type { DragItem, DragPayload, DropDecision, DropEffect, DropTarget, Modifiers, MoveOp } from './types';

/**
 * 落点语义（13 §2.5 + Amy 裁定）。纯函数：不写盘、不改归类。
 * 自建目录里的文件条目拖到真实文件夹 = 真移动；只有目录节点本身禁止。
 */
/** 没带 scope 的条目保持原行为。带了范围快照的，范围外文件不进入后续载荷。 */
function dragItemInScope(it: DragItem): boolean {
  if (!it.scope) return true;
  const entry = entryOf(it);
  const kind = entry === 'file' ? 'file' : 'dir';
  const relPath = typeof it.relPath === 'string' ? it.relPath : it.from.kind === 'root' ? it.from.relPath : '';
  const name = it.name || (relPath ? relPath.split('/').pop() ?? '' : '');
  return inAccessScope(
    { sourceKind: it.scope.sourceKind, extensions: it.scope.extensions },
    { kind, relPath, ext: it.ext ?? extensionOfName(name), outOfScope: it.scope.outOfScope },
  );
}

export function onDropTarget(target: DropTarget, payload: DragPayload | null, effect: Modifiers = {}): DropDecision {
  if (!payload || payload.v !== 1 || payload.items.length === 0 || target.kind === 'invalid') {
    return reject(HINT_INVALID);
  }
  const raw = payload.items;
  if (raw.some((it) => entryOf(it) == null)) return reject(HINT_BAD_ENTRY);
  const items = raw.filter(dragItemInScope);
  if (items.length === 0) return reject(OUT_OF_SCOPE_MESSAGE);
  switch (target.kind) {
    case 'roots-list':
      return reorder(target, items);
    case 'reader':
      return openReader(target.zone, items);
    case 'workbench-blank':
      return openReader('float', items);
    case 'workspace-refs':
      return addRefs(target.workspaceId, items);
    case 'vfolder':
      return classify(target.folderId, items, effect);
    case 'disk-dir':
      return moveToDisk(target, items);
    default:
      return reject(HINT_INVALID);
  }
}

function reject(reason: string, effect: DropEffect = 'none'): DropDecision {
  return { action: { type: 'reject', reason }, dropEffect: effect, hint: reason };
}

function ok(action: DropDecision['action'], dropEffect: DropEffect, hint: string): DropDecision {
  return { action, dropEffect, hint };
}

function reorder(target: Extract<DropTarget, { kind: 'roots-list' }>, items: DragItem[]): DropDecision {
  if (items.some((it) => entryOf(it) !== 'dir-entry' || it.from.kind !== 'roots-list')) return reject(HINT_NOT_ROOT);
  const moving = items.map((it) => it.rootId).filter((id): id is string => !!id);
  if (moving.length !== items.length) return reject(HINT_INVALID);
  const rest = target.rootIds.filter((id) => !moving.includes(id));
  const index = Math.max(0, Math.min(target.index, rest.length));
  const ids = [...rest.slice(0, index), ...moving, ...rest.slice(index)];
  return ok({ type: 'reorder-roots', ids }, 'move', HINT_REORDER);
}

function openReader(zone: 'center' | 'left' | 'right' | 'up' | 'down' | 'float', items: DragItem[]): DropDecision {
  if (items.some((it) => entryOf(it) === 'vfolder-node')) return reject(HINT_INVALID);
  if (items.some((it) => entryOf(it) === 'dir-entry')) return reject(HINT_DIR_OPEN);
  const resourceIds = items.map((it) => it.resourceId).filter(Boolean);
  if (resourceIds.length !== items.length) return reject(HINT_INVALID);
  if (zone === 'float') return ok({ type: 'open', place: 'float', resourceIds }, 'copy', HINT_FLOAT);
  if (zone === 'center') return ok({ type: 'open', place: 'tab', resourceIds }, 'copy', HINT_TAB);
  const edge = zone === 'left' ? '左侧' : zone === 'right' ? '右侧' : zone === 'up' ? '上方' : '下方';
  return ok({ type: 'open', place: zone, resourceIds }, 'copy', `${HINT_SPLIT}（${edge}）`);
}

function addRefs(workspaceId: string, items: DragItem[]): DropDecision {
  if (!workspaceId) return reject(HINT_INVALID);
  if (items.some((it) => entryOf(it) === 'vfolder-node')) return reject(HINT_INVALID);
  if (items.some((it) => entryOf(it) === 'dir-entry')) return reject('文件夹不能加入本工作的资料');
  const resourceIds = items.map((it) => it.resourceId).filter(Boolean);
  if (resourceIds.length !== items.length) return reject(HINT_INVALID);
  return ok({ type: 'add-ref', workspaceId, resourceIds }, 'link', HINT_REF);
}

function classify(folderId: string, items: DragItem[], effect: Modifiers): DropDecision {
  if (!folderId) return reject(HINT_INVALID);
  if (items.some((it) => entryOf(it) !== 'file')) return reject(HINT_INVALID);
  const resourceIds = items.map((it) => it.resourceId).filter(Boolean);
  if (resourceIds.length !== items.length) return reject(HINT_INVALID);
  const fromFolders = items.every((it) => it.from.kind === 'vfolder');
  if (fromFolders) {
    const sourceFolderIds = items.map((it) => (it.from.kind === 'vfolder' ? it.from.folderId : null));
    if (!effect.ctrl && sourceFolderIds.every((id) => id === folderId)) return reject(HINT_ALREADY);
    return ok(
      { type: 'classify-shift', folderId, resourceIds, sourceFolderIds, copy: !!effect.ctrl },
      effect.ctrl ? 'copy' : 'link',
      effect.ctrl ? HINT_CLASSIFY_COPY : HINT_CLASSIFY_SHIFT,
    );
  }
  return ok(
    { type: 'classify-add', folderId, resourceIds, alsoRemoveOtherFolders: !!effect.alt },
    'link',
    effect.alt ? HINT_CLASSIFY_ALT : HINT_CLASSIFY,
  );
}

function moveToDisk(target: Extract<DropTarget, { kind: 'disk-dir' }>, items: DragItem[]): DropDecision {
  if (items.some((it) => entryOf(it) === 'vfolder-node')) return reject(HINT_VFOLDER_NODE);
  if (items.some((it) => it.from.kind === 'roots-list')) return reject(HINT_INVALID);
  if (items.some((it) => it.sourceKind === 'web')) return reject(HINT_WEB_DISK);
  const ops: MoveOp[] = [];
  let crossRoot = false;
  let nameClash = false;
  const taken = new Set(target.childNames ?? []);
  for (const it of items) {
    const kind = entryOf(it);
    if (kind !== 'file' && kind !== 'dir-entry') return reject(HINT_INVALID);
    const disk = diskOf(it);
    if (!disk) return reject(HINT_NO_ORIGIN);
    if (disk.rootId === target.rootId && (disk.relPath === target.relPath || isInside(target.relPath, disk.relPath))) {
      return reject(HINT_SELF);
    }
    if (disk.rootId === target.rootId && parentRel(disk.relPath) === target.relPath) return reject(HINT_ALREADY);
    const name = it.name || disk.relPath.slice(disk.relPath.lastIndexOf('/') + 1);
    if (!name) return reject(HINT_INVALID);
    if (taken.has(name)) nameClash = true;
    taken.add(name);
    if (disk.rootId !== target.rootId) crossRoot = true;
    ops.push({
      resourceId: it.resourceId,
      name,
      fromRootId: disk.rootId,
      fromRelPath: disk.relPath,
      toRootId: target.rootId,
      toRelPath: joinRel(target.relPath, name),
      size: it.size ?? 0,
      entryKind: kind === 'dir-entry' ? 'dir' : 'file',
    });
  }
  const where = crossRoot ? '跨根' : '此文件夹';
  return ok(
    { type: 'move', ops, crossRoot, nameClash },
    'move',
    `${WILL_MOVE_FILE}到${where}${nameClash ? '（有同名，需改名或取消）' : ''}`,
  );
}
