import {
  HINT_ADD_ROOT,
  HINT_AGENT_REF,
  HINT_AGENT_REPO,
  HINT_ALREADY,
  HINT_BAD_ENTRY,
  HINT_CATEGORY_ADD,
  HINT_CATEGORY_ALREADY,
  HINT_CATEGORY_DENY,
  HINT_CLASSIFY,
  HINT_CLASSIFY_ALT,
  HINT_CLASSIFY_COPY,
  HINT_CLASSIFY_SHIFT,
  HINT_COPY_REVIEW,
  HINT_DIR_OPEN,
  HINT_FLOAT,
  HINT_INVALID,
  HINT_NO_ORIGIN,
  HINT_NOT_ROOT,
  HINT_OPEN_RO,
  HINT_REF,
  HINT_REORDER,
  HINT_REORDER_REFS,
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
import type {
  AgentRefDrop,
  CopyReviewOp,
  DragItem,
  DragPayload,
  DropDecision,
  DropEffect,
  DropTarget,
  Modifiers,
  MoveOp,
} from './types';

/**
 * 落点语义（13 §2.5 + Amy 裁定）。纯函数：不写盘、不改归类。
 * 同区目录间 = 真移动；跨区 = 复制或加引用，永不移动。
 * Agent 仓库对外只读，外来载荷一律拒绝。
 */
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
      return addWorkspaceRefs(target.workspaceId, items);
    case 'agent-materials':
      return addAgentMaterials(target.workspaceId, items);
    case 'drawer-card':
      return drawerCard(target, items);
    case 'vfolder':
      return classify(target.folderId, items, effect);
    case 'disk-dir':
      return dropToDisk(target, items);
    case 'agent-repo':
      return dropAgentRepo(target, items);
    case 'category-card':
      return dropCategoryCard(target, items);
    case 'category':
      return dropCategory(target, items);
    case 'workbench-order':
      return reorderWorkbench(target, items);
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
  if (resourceIds.length === items.length) {
    if (zone === 'float') return ok({ type: 'open', place: 'float', resourceIds }, 'copy', HINT_FLOAT);
    if (zone === 'center') return ok({ type: 'open', place: 'tab', resourceIds }, 'copy', HINT_TAB);
    const edge = zone === 'left' ? '左侧' : zone === 'right' ? '右侧' : zone === 'up' ? '上方' : '下方';
    return ok({ type: 'open', place: zone, resourceIds }, 'copy', `${HINT_SPLIT}（${edge}）`);
  }
  const paths = items.map((it) => it.absPath).filter((p): p is string => Boolean(p));
  if (paths.length === items.length) {
    return ok({ type: 'open-readonly', paths }, 'copy', HINT_OPEN_RO);
  }
  return reject(HINT_INVALID);
}

function addWorkspaceRefs(workspaceId: string, items: DragItem[]): DropDecision {
  if (!workspaceId) return reject(HINT_INVALID);
  if (items.some((it) => entryOf(it) === 'vfolder-node')) return reject(HINT_INVALID);
  if (items.some((it) => entryOf(it) === 'dir-entry')) return reject('文件夹不能加入本工作的资料');

  // 资源管理器拖进工作台资料：根内加引用，根外提示先加根
  if (items.some((it) => it.from.kind === 'explorer')) {
    const outOfRoot = items.find((it) => !it.rootId);
    if (outOfRoot) {
      return reject(HINT_ADD_ROOT, 'none');
    }
  }

  const resourceIds = items.map((it) => it.resourceId).filter(Boolean);
  if (resourceIds.length === items.length) {
    return ok({ type: 'add-ref', workspaceId, resourceIds }, 'link', HINT_REF);
  }
  const paths = items.map((it) => it.absPath).filter((p): p is string => Boolean(p));
  if (paths.length === items.length) {
    return ok({ type: 'link-paths', workspaceId, paths }, 'link', HINT_REF);
  }
  return reject(HINT_INVALID);
}

function addAgentMaterials(workspaceId: string, items: DragItem[]): DropDecision {
  if (!workspaceId) return reject(HINT_INVALID);
  if (items.some((it) => entryOf(it) === 'vfolder-node')) return reject(HINT_INVALID);
  const refs: AgentRefDrop[] = items.map((it) => ({
    resourceId: it.resourceId,
    absPath: it.absPath,
    name: it.name,
    relPath: it.relPath,
    kind: entryOf(it) === 'dir-entry' ? 'dir' : 'file',
  }));
  return ok({ type: 'add-agent', workspaceId, refs }, 'link', HINT_AGENT_REF);
}

function drawerCard(target: Extract<DropTarget, { kind: 'drawer-card' }>, items: DragItem[]): DropDecision {
  if (target.module === 'bench') {
    return addWorkspaceRefs(target.workspaceId, items);
  }
  if (target.module === 'agent') {
    return addAgentMaterials(target.workspaceId, items);
  }
  return reject(HINT_INVALID);
}

function dropCategoryCard(target: Extract<DropTarget, { kind: 'category-card' }>, items: DragItem[]): DropDecision {
  return addWorkspaceRefs(target.workspaceId, items);
}

function dropCategory(target: Extract<DropTarget, { kind: 'category' }>, items: DragItem[]): DropDecision {
  const first = items[0];
  if (!first || first.from.kind !== 'category-card' || !first.from.workspaceId) {
    return reject(HINT_CATEGORY_DENY, 'none');
  }
  const wsId = first.from.workspaceId;
  const already = target.workspaceIds.includes(wsId);
  return ok(
    { type: 'add-category', categoryId: target.categoryId, workspaceId: wsId, already },
    'link',
    already ? HINT_CATEGORY_ALREADY : HINT_CATEGORY_ADD,
  );
}

function reorderWorkbench(target: Extract<DropTarget, { kind: 'workbench-order' }>, items: DragItem[]): DropDecision {
  const moving = items.map((it) => it.resourceId).filter(Boolean);
  if (moving.length !== items.length) return reject(HINT_INVALID);
  const rest = target.ids.filter((id) => !moving.includes(id));
  const index = Math.max(0, Math.min(target.index, rest.length));
  const ids = [...rest.slice(0, index), ...moving, ...rest.slice(index)];
  return ok({ type: 'reorder-materials', workspaceId: target.workspaceId, ids }, 'move', HINT_REORDER_REFS);
}

function dropAgentRepo(target: Extract<DropTarget, { kind: 'agent-repo' }>, items: DragItem[]): DropDecision {
  const allInternal = items.length > 0 && items.every((it) => it.from.kind === 'agent-repo');
  if (!allInternal) {
    return reject(HINT_AGENT_REPO, 'none');
  }
  return ok({ type: 'agent-repo-move', to: target.to ?? '' }, 'move', '整理 Agent 仓库');
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

function dropToDisk(target: Extract<DropTarget, { kind: 'disk-dir' }>, items: DragItem[]): DropDecision {
  if (items.some((it) => entryOf(it) === 'vfolder-node')) return reject(HINT_VFOLDER_NODE);
  if (items.some((it) => it.from.kind === 'roots-list')) return reject(HINT_INVALID);
  if (items.some((it) => it.sourceKind === 'web')) return reject(HINT_WEB_DISK);

  // 同区（都在左侧树里）：root 或 vfolder 条目。
  const isTreeItem = (it: DragItem) => it.from.kind === 'root' || it.from.kind === 'vfolder';
  const isSameZone = items.every(isTreeItem);

  if (isSameZone) {
    return moveToDisk(target, items);
  }
  // 跨区（工作台资料、Agent 资料、资源管理器等）：走审核计划，不直接移动
  return copyToDiskReview(target, items);
}

function moveToDisk(target: Extract<DropTarget, { kind: 'disk-dir' }>, items: DragItem[]): DropDecision {
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

function copyToDiskReview(target: Extract<DropTarget, { kind: 'disk-dir' }>, items: DragItem[]): DropDecision {
  const ops: CopyReviewOp[] = [];
  const taken = new Set(target.childNames ?? []);
  let nameClash = false;
  for (const it of items) {
    const kind = entryOf(it);
    if (kind !== 'file' && kind !== 'dir-entry') return reject(HINT_INVALID);
    const disk = diskOf(it);
    const name =
      it.name ||
      (disk?.relPath ? disk.relPath.slice(disk.relPath.lastIndexOf('/') + 1) : '') ||
      (it.absPath ? it.absPath.split(/[/\\]/).pop() ?? '' : '');
    if (!name) return reject(HINT_INVALID);
    if (taken.has(name)) nameClash = true;
    taken.add(name);
    ops.push({
      name,
      sourceAbs: it.absPath,
      resourceId: it.resourceId,
      toRootId: target.rootId,
      toRelPath: joinRel(target.relPath, name),
      entryKind: kind === 'dir-entry' ? 'dir' : 'file',
    });
  }
  return ok(
    { type: 'copy-review', ops, nameClash },
    'copy',
    `${HINT_COPY_REVIEW}${nameClash ? '（目标已有同名，批准前不会覆盖）' : ''}`,
  );
}
