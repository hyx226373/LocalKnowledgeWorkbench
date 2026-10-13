/**
 * 按面板登记内容缩放。阶段①不注册命令、不改 App / keybindings。
 * 阶段②把 view.contentZoom* 接到 B 的命令表，when 用 global，滚轮触发器读有效绑定。
 */
import { useEffect, useRef } from 'react';
import { createCoalescer, type ZoomClock } from './coalesce';
import { stepScale, type Point } from './math';

export type ZoomAction = 'in' | 'out' | 'reset' | 'fit' | 'set' | 'wheel';
export type ZoomAnchorKind = 'exact' | 'page' | 'reflow' | 'approx';

export interface ZoomHandlers {
  actions(): readonly ZoomAction[];
  anchor(): ZoomAnchorKind;
  getScale(): number;
  getBounds(): { min: number; max: number };
  applyFactor(factor: number, anchor: Point | null): void;
  setScale(scale: number, anchor: Point | null): void;
  reset(anchor: Point | null): void;
  fit(anchor: Point | null): void;
  commit(): void;
  acceptWheel?(anchor: Point, target: EventTarget | null): boolean;
}

export interface ZoomController {
  actions(): readonly ZoomAction[];
  anchor(): ZoomAnchorKind;
  getScale(): number;
  getBounds(): { min: number; max: number };
  applyFactor(factor: number, anchor: Point | null): void;
  setScale(scale: number, anchor: Point | null): void;
  reset(anchor: Point | null): void;
  fit(anchor: Point | null): void;
  commit(): void;
  acceptWheel(anchor: Point, target: EventTarget | null): boolean;
  pushWheel(deltaPx: number, anchor: Point): void;
}

const controllers = new Map<string, ZoomController>();

interface ActiveRoot {
  querySelector(sel: string): { querySelectorAll(sel: string): ArrayLike<{ getAttribute(name: string): string | null; offsetParent?: unknown }> } | null;
}

/** 活动组里第一个可见的 `.view-root[data-item-id]`。 */
export function readActiveItemId(root: ActiveRoot): string | null {
  const group = root.querySelector('.dv-groupview.dv-active-group');
  if (!group || typeof group.querySelectorAll !== 'function') return null;
  const nodes = group.querySelectorAll('.view-root[data-item-id]');
  let fallback: string | null = null;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const id = n?.getAttribute('data-item-id');
    if (!id) continue;
    if (fallback == null) fallback = id;
    if (typeof n.offsetParent === 'undefined' || n.offsetParent !== null) return id;
  }
  return fallback;
}

export function getZoomController(itemId: string): ZoomController | undefined {
  return controllers.get(itemId);
}

export function bindContentZoom(itemId: string, handlers: ZoomHandlers, clock?: ZoomClock): () => void {
  const coal = createCoalescer(
    {
      onFrame: (factor, anchor) => handlers.applyFactor(factor, anchor),
      onCommit: () => handlers.commit(),
    },
    clock,
  );
  const controller: ZoomController = {
    actions: () => handlers.actions(),
    anchor: () => handlers.anchor(),
    getScale: () => handlers.getScale(),
    getBounds: () => handlers.getBounds(),
    applyFactor: (factor, anchor) => handlers.applyFactor(factor, anchor),
    setScale: (scale, anchor) => handlers.setScale(scale, anchor),
    reset: (anchor) => handlers.reset(anchor),
    fit: (anchor) => handlers.fit(anchor),
    commit: () => handlers.commit(),
    acceptWheel: (anchor, target) => (handlers.acceptWheel ? handlers.acceptWheel(anchor, target) : true),
    pushWheel: (deltaPx, anchor) => coal.push(deltaPx, anchor),
  };
  controllers.set(itemId, controller);
  return () => {
    coal.dispose();
    if (controllers.get(itemId) === controller) controllers.delete(itemId);
  };
}

export function useContentZoom(itemId: string, handlers: ZoomHandlers) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const proxy: ZoomHandlers = {
      actions: () => ref.current.actions(),
      anchor: () => ref.current.anchor(),
      getScale: () => ref.current.getScale(),
      getBounds: () => ref.current.getBounds(),
      applyFactor: (factor, anchor) => ref.current.applyFactor(factor, anchor),
      setScale: (scale, anchor) => ref.current.setScale(scale, anchor),
      reset: (anchor) => ref.current.reset(anchor),
      fit: (anchor) => ref.current.fit(anchor),
      commit: () => ref.current.commit(),
      acceptWheel: (anchor, target) => ref.current.acceptWheel?.(anchor, target) ?? true,
    };
    return bindContentZoom(itemId, proxy);
  }, [itemId]);
}

export function pushContentZoomWheel(itemId: string, deltaPx: number, anchor: Point): boolean {
  const c = controllers.get(itemId);
  if (!c || !c.actions().includes('wheel')) return false;
  c.pushWheel(deltaPx, anchor);
  return true;
}

let resolveActive = (): string | null => {
  if (typeof document === 'undefined') return null;
  return readActiveItemId(document);
};

/** 阶段②由 App 换成 dockview 的活动面板。默认读 `.dv-active-group` 里可见的 view-root。 */
export function setActiveItemResolver(fn: () => string | null): () => void {
  const prev = resolveActive;
  resolveActive = fn;
  return () => {
    if (resolveActive === fn) resolveActive = prev;
  };
}

export interface ZoomRunArgs {
  itemId?: string;
  scale?: number;
  anchor?: Point | null;
}

/**
 * itemId 为空时用活动面板。args.itemId 优先。
 * wheel 不走这里（没有滚轮量）；由 wheelTrigger 送进该面板的 coalescer。
 */
export function runContentZoom(itemId: string | null, action: ZoomAction, args?: ZoomRunArgs): boolean {
  const fromArgs = args && typeof args.itemId === 'string' && args.itemId ? args.itemId : '';
  const id = fromArgs || itemId || resolveActive();
  if (!id) return false;
  const c = controllers.get(id);
  if (!c || !c.actions().includes(action) || action === 'wheel') return false;
  const anchor = args?.anchor ?? null;
  if (action === 'in' || action === 'out') {
    const bounds = c.getBounds();
    c.setScale(stepScale(c.getScale(), action === 'in' ? 1 : -1, bounds.min, bounds.max), anchor);
  } else if (action === 'reset') c.reset(anchor);
  else if (action === 'fit') c.fit(anchor);
  else if (action === 'set') {
    if (typeof args?.scale !== 'number' || !Number.isFinite(args.scale)) return false;
    c.setScale(args.scale, anchor);
  } else return false;
  c.commit();
  return true;
}

export interface ActionRegistration {
  actionId: string;
  title: string;
  source: string;
  bridgeInvokable: boolean;
  approvalRequired: false;
  argsSchema?: Record<string, unknown>;
  /** P-bridge 合入并登记白名单之前都是待接入。wheel 最终只给界面。 */
  access: 'pending';
  intended: 'bridge' | 'ui' | 'name-only';
}

const ZOOM_ARGS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    itemId: { type: 'string' },
    scale: { type: 'number' },
  },
} as const;

/** 与 B 已有的 view.contentZoomIn/Out/Reset 同 id，阶段①不 register，避免日后重复注册。 */
export const CONTENT_ZOOM_ACTIONS: ActionRegistration[] = [
  { actionId: 'view.contentZoomIn', title: '放大阅读内容', source: 'zoom', bridgeInvokable: false, approvalRequired: false, access: 'pending', intended: 'bridge' },
  { actionId: 'view.contentZoomOut', title: '缩小阅读内容', source: 'zoom', bridgeInvokable: false, approvalRequired: false, access: 'pending', intended: 'bridge' },
  { actionId: 'view.contentZoomReset', title: '阅读内容重置为 100%', source: 'zoom', bridgeInvokable: false, approvalRequired: false, access: 'pending', intended: 'bridge' },
  { actionId: 'view.contentZoomFit', title: '阅读内容适应窗口', source: 'zoom', bridgeInvokable: false, approvalRequired: false, access: 'pending', intended: 'bridge' },
  {
    actionId: 'view.contentZoomSet',
    title: '设置阅读内容比例',
    source: 'zoom',
    bridgeInvokable: false,
    approvalRequired: false,
    argsSchema: { ...ZOOM_ARGS, required: ['scale'] },
    access: 'pending',
    intended: 'bridge',
  },
  { actionId: 'view.contentZoomWheel', title: '按滚轮缩放鼠标所在阅读内容', source: 'zoom', bridgeInvokable: false, approvalRequired: false, access: 'pending', intended: 'ui' },
];

/** 没有画布模式，只留名字，不注册。 */
export const CANVAS_ZOOM_ACTIONS = ['workspace.canvas.zoomIn', 'workspace.canvas.zoomOut', 'workspace.canvas.zoomReset'] as const;
