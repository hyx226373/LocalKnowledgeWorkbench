/**
 * 阅读区文档标签拖进侧栏。只追加 application/x-kb-doc-tab，不改 dockview 已经写入的类型。
 * 落点只认这个 MIME。Agent 走 addRefs，工作台资料走 workspace-refs 的既有判定。
 */
import type { MaterialRef } from '../../shared/agentLive/types';
import type { LiveBinding } from '../agent-live/actions';
import { addRefs } from '../agent-live/actions';
import type { DragPayload } from './types';
import { onDropTarget as resolveDrop } from './resolve';

export const DOC_TAB_MIME = 'application/x-kb-doc-tab';

export type DocTabDropTarget = 'agent' | 'bench';

export interface DocTabDragPayload {
  v: 1;
  resourceId: string;
  panelId: string;
  itemId: string;
  name?: string;
  absPath?: string;
  relPath?: string;
  sourceId?: string | null;
}

export interface DocTabPanelSource {
  panelId: string;
  itemId?: string;
  title?: string;
  item?: { sourceKind?: string; ref?: string; title?: string } | null;
  reading?: { absPath?: string; name?: string; relPath?: string; sourceId?: string | null } | null;
}

export interface DocTabDropHost {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

interface DocTabDragEvent {
  dataTransfer: { types: ArrayLike<string>; dropEffect?: string };
  preventDefault(): void;
  stopPropagation(): void;
  currentTarget: DocTabDropHost;
}

interface DocTabDropEvent extends DocTabDragEvent {
  dataTransfer: { types: ArrayLike<string>; getData(type: string): string };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function docTabDropTarget(id: string): DocTabDropTarget | null {
  return id === 'agent' || id === 'bench' ? id : null;
}

/** 文件面板才带载荷。网页、外部应用和没有 resourceId 的标签不写入 MIME。 */
export function docTabDragFromPanel(source: DocTabPanelSource): DocTabDragPayload | null {
  const item = source.item;
  if (!item || item.sourceKind !== 'file') return null;
  const resourceId = text(item.ref);
  if (!resourceId) return null;
  const panelId = text(source.panelId);
  const itemId = text(source.itemId) || panelId;
  if (!panelId || !itemId) return null;
  const payload: DocTabDragPayload = { v: 1, resourceId, panelId, itemId };
  const name = text(source.reading?.name) || text(source.title) || text(item.title);
  const absPath = text(source.reading?.absPath);
  const relPath = text(source.reading?.relPath);
  if (name) payload.name = name;
  if (absPath) payload.absPath = absPath;
  if (relPath) payload.relPath = relPath;
  if (source.reading && source.reading.sourceId !== undefined) payload.sourceId = source.reading.sourceId;
  return payload;
}

export function parseDocTabDrag(raw: string): DocTabDragPayload | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (row.v !== 1) return null;
  const resourceId = text(row.resourceId);
  const panelId = text(row.panelId);
  const itemId = text(row.itemId) || panelId;
  if (!resourceId || !panelId || !itemId) return null;
  const payload: DocTabDragPayload = { v: 1, resourceId, panelId, itemId };
  const name = text(row.name);
  const absPath = text(row.absPath);
  const relPath = text(row.relPath);
  if (name) payload.name = name;
  if (absPath) payload.absPath = absPath;
  if (relPath) payload.relPath = relPath;
  if (row.sourceId === null) payload.sourceId = null;
  else {
    const sourceId = text(row.sourceId);
    if (sourceId) payload.sourceId = sourceId;
  }
  return payload;
}

export function hasDocTabMime(types: ArrayLike<string>): boolean {
  for (let i = 0; i < types.length; i += 1) if (types[i] === DOC_TAB_MIME) return true;
  return false;
}

/** 只追加自定义类型。不调用 clearData，也不改 effectAllowed。 */
export function applyDocTabDrag(transfer: { setData(type: string, value: string): void }, payload: DocTabDragPayload): void {
  try {
    transfer.setData(DOC_TAB_MIME, JSON.stringify(payload));
  } catch {
    /* dockview 的拖拽已经开始；写不进自定义类型时不打断分屏 */
  }
}

export function interceptDocTabDrop(types: ArrayLike<string>, getData: (type: string) => string): { claimed: boolean; payload: DocTabDragPayload | null } {
  if (!hasDocTabMime(types)) return { claimed: false, payload: null };
  return { claimed: true, payload: parseDocTabDrag(getData(DOC_TAB_MIME)) };
}

export function markDocTabDrop(el: DocTabDropHost, on: boolean): void {
  if (on) el.setAttribute('data-drop-active', 'true');
  else el.removeAttribute('data-drop-active');
}

/** 认到自定义 MIME 才 preventDefault 并打上 data-drop-active。其它类型原样放过。 */
export function handleDocTabDragOver(event: DocTabDragEvent): boolean {
  if (!hasDocTabMime(event.dataTransfer.types)) return false;
  event.preventDefault();
  event.stopPropagation();
  // dockview 把 effectAllowed 设成 move。落点用 move，浏览器才会把 drop 送过来。
  event.dataTransfer.dropEffect = 'move';
  markDocTabDrop(event.currentTarget, true);
  return true;
}

export function handleDocTabDrop(event: DocTabDropEvent): { claimed: boolean; payload: DocTabDragPayload | null } {
  const hit = interceptDocTabDrop(event.dataTransfer.types, (type) => event.dataTransfer.getData(type));
  if (!hit.claimed) return hit;
  event.preventDefault();
  event.stopPropagation();
  markDocTabDrop(event.currentTarget, false);
  return hit;
}

export function materialRefFromDocTab(payload: DocTabDragPayload): MaterialRef {
  const ref: MaterialRef = { resourceId: payload.resourceId, absPath: payload.absPath ?? '' };
  if (payload.name) ref.name = payload.name;
  if (payload.relPath) ref.relPath = payload.relPath;
  if (payload.sourceId !== undefined) ref.sourceId = payload.sourceId;
  return ref;
}

export function workspaceRefDragFromDocTab(payload: DocTabDragPayload, workspaceId: string): DragPayload {
  return {
    v: 1,
    items: [{
      resourceId: payload.resourceId,
      sourceKind: 'file',
      entry: 'file',
      from: { kind: 'workspace-refs', workspaceId },
      ...(payload.name ? { name: payload.name } : {}),
      ...(payload.relPath ? { relPath: payload.relPath } : {}),
    }],
  };
}

export async function commitDocTabDrop(
  target: DocTabDropTarget,
  payload: DocTabDragPayload | null,
  ctx: {
    workspaceId: string;
    binding: LiveBinding | null;
    addWorkspaceRefs: (workspaceId: string, resourceIds: string[]) => Promise<unknown>;
  },
): Promise<'agent' | 'bench' | 'skip'> {
  if (!payload?.resourceId) return 'skip';
  if (target === 'agent') {
    if (!ctx.binding) return 'skip';
    await addRefs(ctx.binding, [materialRefFromDocTab(payload)]);
    return 'agent';
  }
  const decision = resolveDrop(
    { kind: 'workspace-refs', workspaceId: ctx.workspaceId },
    workspaceRefDragFromDocTab(payload, ctx.workspaceId),
  );
  if (decision.action.type !== 'add-ref') return 'skip';
  await ctx.addWorkspaceRefs(decision.action.workspaceId, decision.action.resourceIds);
  return 'bench';
}

/** 运行时再取 kb，避免分类卡片的静态渲染去读 window.kb。失败时沿用拖拽落点的提示。 */
export function kbAddWorkspaceRefs(workspaceId: string, resourceIds: string[]): Promise<unknown> {
  return import('../kb').then(async ({ kb }) => {
    try {
      return await kb.addWorkspaceRefs(workspaceId, resourceIds);
    } catch (error) {
      const { dialogs } = await import('../ui/dialogs');
      const message = error instanceof Error ? error.message : String(error);
      await dialogs.alert({ title: '没有完成', body: message });
      return undefined;
    }
  });
}
