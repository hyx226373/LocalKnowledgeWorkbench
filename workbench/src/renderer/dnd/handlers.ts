import type React from 'react';
import { beginDrag, endDrag, hasOurDrag, modifiersOf, readDrag, readKbPayload } from './drag';
import { setLiveHint } from './hint';
import { runDrop } from './session';
import { onDropTarget } from './resolve';
import { stopDragAutoScroll, updateDragAutoScroll } from './autoScroll';
import type { DragPayload, DropTarget, Modifiers } from './types';

const expandTimers = new Map<string, number>();

export function clearExpandTimer(key: string) {
  const t = expandTimers.get(key);
  if (t !== undefined) window.clearTimeout(t);
  expandTimers.delete(key);
}

/** 折叠目录悬停 600ms 后展开。 */
export function armExpand(key: string, expanded: boolean, expand: () => void) {
  if (expanded || expandTimers.has(key)) return;
  expandTimers.set(
    key,
    window.setTimeout(() => {
      expandTimers.delete(key);
      expand();
    }, 600),
  );
}

export function dragStartProps(payload: DragPayload) {
  return {
    draggable: true as const,
    onDragStart: (e: React.DragEvent) => {
      beginDrag(payload, e.dataTransfer);
      e.stopPropagation();
    },
    onDragEnd: () => {
      stopDragAutoScroll();
      endDrag();
      window.setTimeout(() => setLiveHint(''), 800);
    },
  };
}

export function dropTargetProps(opts: {
  target: (mods: Modifiers, payload: DragPayload | null) => DropTarget;
  hintKey: string;
  onExpand?: () => void;
  expanded?: boolean;
}) {
  return {
    onDragOver: (e: React.DragEvent) => {
      if (!hasOurDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      const payload = readKbPayload(e.dataTransfer);
      const mods = modifiersOf(e);
      const decision = onDropTarget(opts.target(mods, payload), payload, mods);
      e.dataTransfer.dropEffect = decision.dropEffect === 'none' ? 'none' : decision.dropEffect;
      const el = e.currentTarget as HTMLElement;
      el.dataset.dragOver = 'true';
      el.dataset.dndHint = decision.hint;
      setLiveHint(decision.hint);
      if (opts.onExpand) armExpand(opts.hintKey, !!opts.expanded, opts.onExpand);
      updateDragAutoScroll(e.clientX, e.clientY, el);
    },
    onDragLeave: (e: React.DragEvent) => {
      clearExpandTimer(opts.hintKey);
      const el = e.currentTarget as HTMLElement;
      delete el.dataset.dragOver;
      delete el.dataset.dndHint;
    },
    onDrop: (e: React.DragEvent) => {
      stopDragAutoScroll();
      if (!hasOurDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      clearExpandTimer(opts.hintKey);
      const el = e.currentTarget as HTMLElement;
      delete el.dataset.dragOver;
      delete el.dataset.dndHint;
      setLiveHint('');
      const payload = readDrag(e.dataTransfer);
      const mods = modifiersOf(e);
      // 根行要靠载荷决定是调序还是当作磁盘目录。必须在 endDrag 清掉同窗口副本之前算好落点。
      const target = opts.target(mods, payload);
      endDrag();
      void runDrop(target, payload, mods);
    },
  };
}

export function autoScroll(el: HTMLElement, clientY: number, clientX: number = 0) {
  updateDragAutoScroll(clientX, clientY, el);
}
