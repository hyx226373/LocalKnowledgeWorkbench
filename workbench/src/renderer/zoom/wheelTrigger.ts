/**
 * Ctrl+滚轮（阶段②起改为 view.contentZoomWheel 的有效绑定）缩放鼠标所在面板。
 * 捕获阶段、passive:false，preventDefault，避免 Electron 整页缩放。
 * 阶段①的默认绑定是 Ctrl+Wheel。Shift+Wheel、单独 Wheel 不缩放。
 */
import { normalizeDelta } from './math';
import { getZoomController } from './registry';

export interface WheelBinding {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export const DEFAULT_WHEEL_BINDING: WheelBinding = { ctrl: true, alt: false, shift: false, meta: false };

let bindingOf = (): WheelBinding => DEFAULT_WHEEL_BINDING;
let wheelSuspended = 0;

/** 设置页录滚轮时暂停缩放，避免录制本身把内容放大。 */
export function suspendContentZoomWheel(): () => void {
  wheelSuspended += 1;
  return () => {
    wheelSuspended = Math.max(0, wheelSuspended - 1);
  };
}

export function wheelBindingFromAccel(key: string | null | undefined): WheelBinding {
  const raw = (key ?? '').trim();
  if (!raw) return DEFAULT_WHEEL_BINDING;
  const parts = raw.split('+').filter(Boolean);
  return {
    ctrl: parts.includes('Ctrl'),
    alt: parts.includes('Alt'),
    shift: parts.includes('Shift'),
    meta: parts.includes('Meta'),
  };
}

/** 阶段②换成 keybindings 里 view.contentZoomWheel 的有效绑定。 */
export function setContentZoomWheelBinding(fn: () => WheelBinding): () => void {
  const prev = bindingOf;
  bindingOf = fn;
  return () => {
    if (bindingOf === fn) bindingOf = prev;
  };
}

export function contentZoomWheelBinding(): WheelBinding {
  try {
    return bindingOf() ?? DEFAULT_WHEEL_BINDING;
  } catch {
    return DEFAULT_WHEEL_BINDING;
  }
}

export function sameWheelBinding(e: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }, binding: WheelBinding): boolean {
  return !!e.ctrlKey === binding.ctrl && !!e.altKey === binding.alt && !!e.shiftKey === binding.shift && !!e.metaKey === binding.meta;
}

export type WheelDecision = { kind: 'ignore' } | { kind: 'swallow' } | { kind: 'zoom'; itemId: string; deltaPx: number };

export function decideWheel(input: {
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  buttons: number;
  dragging: boolean;
  onToolbar: boolean;
  itemId: string | null;
  binding: WheelBinding;
  deltaY: number;
  deltaMode: number;
  pageH: number;
}): WheelDecision {
  if (!sameWheelBinding(input, input.binding)) return { kind: 'ignore' };
  if (input.buttons !== 0 || input.dragging || input.onToolbar || !input.itemId) return { kind: 'swallow' };
  return {
    kind: 'zoom',
    itemId: input.itemId,
    deltaPx: normalizeDelta(input.deltaY, input.deltaMode, input.pageH),
  };
}

let dragDepth = 0;

export function isZoomDragBlocked(): boolean {
  // Only block while an active native drag is in progress.
  // A stale peekDrag() latch must not kill Ctrl+wheel forever.
  return dragDepth > 0;
}

type ClosestEl = {
  closest(sel: string): ClosestEl | null;
  getAttribute(name: string): string | null;
  clientHeight?: number;
};

/** Resolve EventTarget that may be a Text node to an Element with closest(). */
export function eventTargetElement(target: EventTarget | null): ClosestEl | null {
  if (!target) return null;
  if (typeof (target as { closest?: unknown }).closest === 'function') {
    return target as unknown as ClosestEl;
  }
  const parent = (target as { parentElement?: ClosestEl | null }).parentElement ?? null;
  if (parent && typeof parent.closest === 'function') return parent;
  return null;
}

/** Prefer elementFromPoint under the mouse, then fall back to event target ancestry. */
export function resolveZoomPanel(input: {
  target: EventTarget | null;
  clientX?: number;
  clientY?: number;
}): ClosestEl | null {
  try {
    const doc = typeof document !== 'undefined' ? document : null;
    if (doc && typeof doc.elementFromPoint === 'function') {
      const under = doc.elementFromPoint(input.clientX || 0, input.clientY || 0);
      const fromPoint = under && typeof (under as { closest?: unknown }).closest === 'function'
        ? (under as unknown as ClosestEl).closest('.view-root[data-item-id]')
        : null;
      if (fromPoint) return fromPoint;
    }
  } catch {
    /* ignore */
  }
  const el = eventTargetElement(input.target);
  return el?.closest('.view-root[data-item-id]') ?? null;
}

export function onContentZoomWheel(e: Event) {
  const w = e as WheelEvent;
  const target = eventTargetElement(w.target);
  const panel = resolveZoomPanel({ target: w.target, clientX: w.clientX, clientY: w.clientY });
  const itemId = panel?.getAttribute('data-item-id') ?? null;
  const pageH = panel && typeof panel.clientHeight === 'number' && panel.clientHeight > 0 ? panel.clientHeight : 800;
  const decision = decideWheel({
    ctrlKey: !!w.ctrlKey,
    altKey: !!w.altKey,
    shiftKey: !!w.shiftKey,
    metaKey: !!w.metaKey,
    buttons: w.buttons || 0,
    dragging: isZoomDragBlocked(),
    onToolbar: !!target?.closest('.kb-view-toolbar'),
    itemId,
    binding: contentZoomWheelBinding(),
    deltaY: w.deltaY || 0,
    deltaMode: w.deltaMode || 0,
    pageH,
  });
  if (wheelSuspended > 0 || decision.kind === 'ignore') return;
  w.preventDefault?.();
  w.stopPropagation?.();
  if (decision.kind !== 'zoom' || decision.deltaPx === 0) return;
  const controller = getZoomController(decision.itemId);
  if (!controller) return;
  const anchor = { x: w.clientX || 0, y: w.clientY || 0 };
  if (!controller.acceptWheel(anchor, w.target)) return;
  controller.pushWheel(decision.deltaPx, anchor);
}

export interface ZoomEventTarget {
  addEventListener(type: string, listener: (ev: Event) => void, options?: boolean | AddEventListenerOptions): void;
  removeEventListener(type: string, listener: (ev: Event) => void, options?: boolean | EventListenerOptions): void;
}

export function installWheelTrigger(target: ZoomEventTarget): () => void {
  const wheel = (ev: Event) => onContentZoomWheel(ev);
  const start = () => {
    dragDepth += 1;
  };
  const end = () => {
    dragDepth = Math.max(0, dragDepth - 1);
  };
  const resetDrag = () => {
    dragDepth = 0;
  };
  target.addEventListener('wheel', wheel, { capture: true, passive: false });
  target.addEventListener('dragstart', start, true);
  target.addEventListener('dragend', end, true);
  target.addEventListener('drop', end, true);
  target.addEventListener('blur', resetDrag, true);
  target.addEventListener('mouseup', resetDrag, true);
  return () => {
    target.removeEventListener('wheel', wheel, { capture: true });
    target.removeEventListener('dragstart', start, true);
    target.removeEventListener('dragend', end, true);
    target.removeEventListener('drop', end, true);
    target.removeEventListener('blur', resetDrag, true);
    target.removeEventListener('mouseup', resetDrag, true);
  };
}

let installed: (() => void) | null = null;

export function ensureWheelTrigger(): void {
  if (installed || typeof window === 'undefined') return;
  installed = installWheelTrigger(window);
}
