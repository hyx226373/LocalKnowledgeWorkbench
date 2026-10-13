/**
 * 拖拽挂钩（第 11 轮 C）。语义（真正移动 / 归类）由拖拽组实现。
 * 本包只负责组 payload、在落点调用 onDropTarget，并用现有 data-drag-over 高亮。
 * `entry` 用来区分「自建目录节点」和「文件条目」：文件夹节点不能落到磁盘，文件条目可以。
 */
import type { DragEvent } from 'react';

export const KB_DRAG_MIME = 'application/x-kb-resource+json';

export type DragEntry = 'file' | 'vfolder-node' | 'dir-entry';

export type DragFrom =
  | { kind: 'root'; rootId: string; relPath: string }
  | { kind: 'vfolder'; folderId: string | null }
  | { kind: 'workspace-refs'; workspaceId: string }
  | { kind: 'roots-list' };

export interface KbDragItem {
  resourceId: string;
  sourceKind: 'file' | 'web';
  from: DragFrom;
  /** 接口变更：官方 from.kind 没有这一维，拖拽组靠它禁止「目录节点 → 磁盘」 */
  entry: DragEntry;
  /** 根列表排序用已登记根的 id。磁盘文件条目可带 rootId / relPath。 */
  rootId?: string;
  relPath?: string;
  name?: string;
  size?: number;
}

export interface KbDragPayload {
  v: 1;
  items: KbDragItem[];
}

export type DropTarget = DragFrom;

export type DropHandler = (target: DropTarget, payload: KbDragPayload, effect: string) => void;

let current: KbDragPayload | null = null;
let getCustom: ((seed: KbDragPayload) => KbDragPayload) | null = null;
let dropHandler: DropHandler | null = null;

/** 拖拽组可替换 payload 的生成。未设置时用调用方给出的种子。 */
export function setGetDragPayload(fn: ((seed: KbDragPayload) => KbDragPayload) | null) {
  getCustom = fn;
}
export function getDragPayload(seed: KbDragPayload): KbDragPayload {
  const built = getCustom ? getCustom(seed) : seed;
  return built && built.v === 1 && Array.isArray(built.items) ? built : seed;
}

/** 拖拽组注册真正的落点行为。未注册时落点只高亮。 */
export function setOnDropTarget(fn: DropHandler | null) {
  dropHandler = fn;
}
export function onDropTarget(target: DropTarget, payload: KbDragPayload, effect: string) {
  dropHandler?.(target, payload, effect);
}

/**
 * 菜单行为挂钩。拖拽组若设置了对应函数，本包只调用它、不再自己改归属。
 * 未设置时：「从该目录移除」只改自建目录归属；「从本工作区移除」走现有移除资料流程。
 * moveTo / addToFolder 未设置时不做事。
 */
export const dirViewActions: {
  removeFromFolder?: (resourceId: string, folderId: string | null) => void;
  removeFromWorkspace?: (resourceId: string, workspaceId: string) => void;
  moveTo?: (payload: KbDragPayload) => void;
  addToFolder?: (payload: KbDragPayload) => void;
} = {};

export function parseDragPayload(raw: string): KbDragPayload | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as KbDragPayload;
    if (!v || v.v !== 1 || !Array.isArray(v.items)) return null;
    return v;
  } catch {
    return null;
  }
}

export function beginDrag(e: DragEvent, seed: KbDragPayload) {
  const payload = getDragPayload(seed);
  current = payload;
  const json = JSON.stringify(payload);
  try {
    e.dataTransfer.setData(KB_DRAG_MIME, json);
  } catch {
    /* 个别环境拒绝自定义 MIME，text/plain 仍在 */
  }
  e.dataTransfer.setData('text/plain', json);
  e.dataTransfer.effectAllowed = 'copyMove';
}

export function endDrag() {
  current = null;
}

/** 同窗口 dragover 读不到 dataTransfer。阅读区落点用这份副本。 */
export function peekDrag(): KbDragPayload | null {
  return current;
}

export function readDrag(e: DragEvent): KbDragPayload | null {
  const raw = e.dataTransfer.getData(KB_DRAG_MIME) || e.dataTransfer.getData('text/plain');
  return parseDragPayload(raw) ?? current;
}

export function dragTypesAccept(e: DragEvent): boolean {
  const types = [...e.dataTransfer.types];
  return types.includes(KB_DRAG_MIME) || types.includes('text/plain') || current != null;
}

/** 落点：阻止默认（否则不能 drop），高亮，然后把 payload 交给挂钩。挂钩为空时只留下高亮。 */
export function bindDrop(target: DropTarget, setOver: (on: boolean) => void) {
  return {
    onDragOver: (e: DragEvent) => {
      if (!dragTypesAccept(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      (e.currentTarget as HTMLElement).setAttribute('data-drag-over', 'true');
      setOver(true);
    },
    onDragLeave: (e: DragEvent) => {
      (e.currentTarget as HTMLElement).removeAttribute('data-drag-over');
      setOver(false);
    },
    onDrop: (e: DragEvent) => {
      if (!dragTypesAccept(e)) return;
      e.preventDefault();
      e.stopPropagation();
      (e.currentTarget as HTMLElement).removeAttribute('data-drag-over');
      setOver(false);
      const payload = readDrag(e);
      if (payload) {
        const flags = [e.altKey ? 'alt' : '', e.ctrlKey || e.metaKey ? 'ctrl' : '', e.dataTransfer.dropEffect || 'move'].filter(Boolean);
        onDropTarget(target, payload, flags.join('+'));
      }
    },
  };
}
