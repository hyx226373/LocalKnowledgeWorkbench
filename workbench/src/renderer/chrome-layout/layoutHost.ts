/**
 * 布局宿主：chrome / 内容区变化后唯一调用 host.setBounds / setVisible / activate，
 * 再广播 layout.* 事件（进程内 handler + 可替换 LayoutEventTransport；
 * 默认 window CustomEvent，阶段 B 临时定案）。插件只消费，禁止双路径。
 *
 * D-L1：停靠 chrome 不 occlusion；仅浮动 overlay 相交才 setVisible(false)
 * D-L3/D-L3a：host 调用经队列串行，同 op+panel latest-wins；
 *   仅实际执行的调用在完成后发对应 layout.*（被 coalesce 的不发）
 * OPEN-1：唯一响应 layout.requestActivate → host.activate
 */
import type {
  ChromeStateSnapshot,
  ChromeVisibilityMap,
  ContentBounds,
  LayoutChangeReason,
  LayoutChromeVisibilityChangedPayload,
  LayoutContentBoundsChangedPayload,
  LayoutEditModeChangedPayload,
  LayoutEventName,
  LayoutHostOcclusionChangedPayload,
  LayoutRequestActivatePayload,
} from '../../shared/chromeLayout';
import { LAYOUT_EVENTS, LAYOUT_REQUEST_EVENTS } from '../../shared/chromeLayout';
import type { ChromeController } from './controller';
import {
  contentBoundsToHostRect,
  type LayoutNativeHostClient,
} from './hostClient';
import {
  createWindowCustomEventTransport,
  type LayoutEventTransport,
} from './eventTransport';
import {
  applyPanelScaleFactorAttr,
  getDisplayListStore,
  type DisplayListStore,
} from './displayList';
import { HostCallQueue } from './hostCallQueue';
import {
  defaultOverlayRegistry,
  isOccludedByOverlays,
  type FloatingOverlay,
  type OverlayRegistry,
  type ScreenRect,
} from './overlayRegistry';

export interface NativeHostPanelRef {
  id: string;
  /** 面板在工作区内的相对几何（逻辑像素） */
  layout: { x: number; y: number; w: number; h: number };
  attached: boolean;
  /** 是否应显示原生内容（非用户主动隐藏） */
  shouldShow?: boolean;
}

export interface LayoutViewport {
  x: number;
  y: number;
  w: number;
  h: number;
  scaleFactor?: number;
}

export interface ChromeChromeInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface ChromeInsetSizes {
  menuHeight?: number;
  toolbarHeight?: number;
  sidebarWidth?: number;
  statusHeight?: number;
  tabsHeight?: number;
  consoleHeight?: number;
  agentHeight?: number;
}

const DEFAULT_INSET_SIZES: Required<ChromeInsetSizes> = {
  menuHeight: 40,
  toolbarHeight: 36,
  sidebarWidth: 280,
  statusHeight: 24,
  tabsHeight: 32,
  consoleHeight: 160,
  agentHeight: 40,
};

/** 按有效显隐估算 chrome 占位（真隐藏 → 0）。优先用实测 sizes（D-L5）。 */
export function computeChromeInsets(
  visibility: ChromeVisibilityMap,
  sizes?: ChromeInsetSizes,
): ChromeChromeInsets {
  const s = { ...DEFAULT_INSET_SIZES, ...sizes };
  return {
    top:
      (visibility['chrome.menu'] ? s.menuHeight : 0) +
      (visibility['chrome.toolbar'] ? s.toolbarHeight : 0) +
      (visibility['chrome.tabs'] ? s.tabsHeight : 0),
    right: 0,
    bottom:
      (visibility['chrome.status'] ? s.statusHeight : 0) +
      (visibility['chrome.console'] ? s.consoleHeight : 0) +
      (visibility['chrome.agent'] ? s.agentHeight : 0),
    left: visibility['chrome.sidebar'] ? s.sidebarWidth : 0,
  };
}

/**
 * 从 DOM 实测 chrome 尺寸（D-L5）。无 DOM / 找不到节点时回退默认。
 * 选择器约定：data-chrome-id / 常见 class。
 */
export function measureChromeInsetSizes(
  root?: ParentNode | null,
  fallbackSidebarWidth = 280,
): ChromeInsetSizes {
  const doc =
    root ??
    (typeof document !== 'undefined' ? document : null);
  if (!doc || typeof (doc as Document).querySelector !== 'function') {
    return { sidebarWidth: fallbackSidebarWidth };
  }
  const q = (sel: string) => {
    try {
      const el = (doc as Document).querySelector(sel) as HTMLElement | null;
      if (!el) return undefined;
      // 隐藏槽位：宽高为 0
      const r = el.getBoundingClientRect?.();
      if (!r) return undefined;
      return { w: r.width, h: r.height };
    } catch {
      return undefined;
    }
  };
  const menu = q('[data-chrome-id="chrome.menu"]') ?? q('.kb-topbar');
  const sidebar = q('[data-chrome-id="chrome.sidebar"]') ?? q('.kb-sidebar');
  const status = q('[data-chrome-id="chrome.status"]') ?? q('.kb-statusbar');
  const tabs = q('.kb-dock .dv-tabs-and-actions-container');
  const out: ChromeInsetSizes = { sidebarWidth: fallbackSidebarWidth };
  if (menu && menu.h > 0) out.menuHeight = menu.h;
  if (sidebar && sidebar.w > 0) out.sidebarWidth = sidebar.w;
  if (status && status.h > 0) out.statusHeight = status.h;
  if (tabs && tabs.h > 0) out.tabsHeight = tabs.h;
  return out;
}

export function computeContentBounds(
  viewport: LayoutViewport,
  insets: ChromeChromeInsets,
  panelLayout: { x: number; y: number; w: number; h: number },
): ContentBounds {
  const contentX = viewport.x + insets.left;
  const contentY = viewport.y + insets.top;
  const contentW = Math.max(0, viewport.w - insets.left - insets.right);
  const contentH = Math.max(0, viewport.h - insets.top - insets.bottom);
  return {
    x: contentX + panelLayout.x,
    y: contentY + panelLayout.y,
    w: Math.min(panelLayout.w, Math.max(0, contentW - panelLayout.x)),
    h: Math.min(panelLayout.h, Math.max(0, contentH - panelLayout.y)),
  };
}

/**
 * @deprecated D-L1：停靠 chrome 永不 occlusion。保留导出但恒返回 false。
 * 请用 isOccludedByOverlays + OverlayRegistry。
 */
export function isOccludedByChrome(
  _visibility: ChromeVisibilityMap,
  _panel: NativeHostPanelRef,
  _opts?: { occludeWhenMenuShown?: boolean },
): boolean {
  return false;
}

export type LayoutEventHandler = (name: LayoutEventName, payload: unknown) => void;

export interface LayoutHostOptions {
  controller: ChromeController;
  host: LayoutNativeHostClient;
  getPanels: () => NativeHostPanelRef[];
  getViewport: () => LayoutViewport;
  getSidebarWidth?: () => number;
  /** 实测 inset；缺省用 measureChromeInsetSizes / 硬编码回退 */
  getInsetSizes?: () => ChromeInsetSizes;
  onEvent?: LayoutEventHandler;
  callerTag?: string;
  transport?: LayoutEventTransport;
  overlays?: OverlayRegistry;
  /** 是否监听 layout.requestActivate（默认 true；非 DOM 跳过） */
  listenRequestActivate?: boolean;
  /** 请求事件目标（默认 window；测试可注入 EventTarget） */
  requestActivateTarget?: { addEventListener: Function; removeEventListener: Function; dispatchEvent?: Function } | null;
  /** sync 防抖 ms（D-L5）；0=立即 */
  syncDebounceMs?: number;
  /** 外部注入队列（测试） */
  queue?: HostCallQueue;
  /** L2：显示器列表（缺省用单例 getDisplayListStore） */
  displayList?: DisplayListStore;
}

const hostCallerLog: { tag: string; op: string; at: number }[] = [];

export function getHostCallerLog() {
  return hostCallerLog.slice();
}
export function clearHostCallerLog() {
  hostCallerLog.length = 0;
}

export class LayoutHost {
  readonly callerTag: string;
  readonly queue: HostCallQueue;
  private readonly controller: ChromeController;
  private readonly host: LayoutNativeHostClient;
  private readonly getPanels: () => NativeHostPanelRef[];
  private readonly getViewport: () => LayoutViewport;
  private readonly getSidebarWidth?: () => number;
  private readonly getInsetSizes?: () => ChromeInsetSizes;
  private readonly handlers = new Set<LayoutEventHandler>();
  private readonly transport: LayoutEventTransport;
  private readonly overlays: OverlayRegistry;
  private unsub: (() => void) | null = null;
  private unsubOverlay: (() => void) | null = null;
  private lastOcclusion = new Map<string, boolean>();
  private requestActivateHandler: ((ev: Event) => void) | null = null;
  private readonly requestActivateTarget: { addEventListener: Function; removeEventListener: Function } | null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly syncDebounceMs: number;
  private syncGeneration = 0;
  private readonly displayList: DisplayListStore;

  constructor(opts: LayoutHostOptions) {
    this.controller = opts.controller;
    this.host = opts.host;
    this.getPanels = opts.getPanels;
    this.getViewport = opts.getViewport;
    this.getSidebarWidth = opts.getSidebarWidth;
    this.getInsetSizes = opts.getInsetSizes;
    this.callerTag = opts.callerTag ?? 'layout-host';
    this.transport = opts.transport ?? createWindowCustomEventTransport();
    this.overlays = opts.overlays ?? defaultOverlayRegistry;
    this.queue = opts.queue ?? new HostCallQueue();
    this.syncDebounceMs = opts.syncDebounceMs ?? 0;
    this.displayList = opts.displayList ?? getDisplayListStore();
    this.requestActivateTarget =
      opts.requestActivateTarget !== undefined
        ? (opts.requestActivateTarget as { addEventListener: Function; removeEventListener: Function } | null)
        : typeof window !== 'undefined'
          ? window
          : null;
    if (opts.onEvent) this.handlers.add(opts.onEvent);
    this.unsub = this.controller.subscribe((_snap, reason) => {
      this.scheduleSync(mapReason(reason));
    });
    this.unsubOverlay = this.overlays.subscribe(() => {
      this.scheduleSync('layout-adjust');
    });
    if (opts.listenRequestActivate !== false) {
      this.attachRequestActivateListener();
    }
  }

  on(handler: LayoutEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  dispose() {
    this.unsub?.();
    this.unsub = null;
    this.unsubOverlay?.();
    this.unsubOverlay = null;
    this.handlers.clear();
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    this.detachRequestActivateListener();
  }

  /** 面板获得焦点时由 UI 调用 → 唯一路径 activate */
  async notifyPanelFocused(panelId: string): Promise<void> {
    await this.activatePanel(panelId, 'panel-focus');
  }

  private attachRequestActivateListener() {
    const target = this.requestActivateTarget;
    if (!target || typeof target.addEventListener !== 'function') return;
    this.requestActivateHandler = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as LayoutRequestActivatePayload | undefined;
      if (!detail || typeof detail.panelId !== 'string') return;
      if (detail.reason !== 'user-enter' && detail.reason !== 'panel-focus') return;
      void this.handleRequestActivate(detail);
    };
    target.addEventListener(LAYOUT_REQUEST_EVENTS.requestActivate, this.requestActivateHandler);
  }

  private detachRequestActivateListener() {
    if (!this.requestActivateHandler) return;
    const target = this.requestActivateTarget;
    if (target && typeof target.removeEventListener === 'function') {
      target.removeEventListener(LAYOUT_REQUEST_EVENTS.requestActivate, this.requestActivateHandler);
    }
    this.requestActivateHandler = null;
  }

  /** 公开：处理插件反向请求（测试 / 非 CustomEvent 路径） */
  async handleRequestActivate(req: LayoutRequestActivatePayload): Promise<void> {
    const panels = this.getPanels();
    if (!panels.some((p) => p.id === req.panelId && p.attached)) {
      return; // 未知 / 未 attach：忽略
    }
    await this.activatePanel(req.panelId, req.reason);
  }

  private async activatePanel(
    panelId: string,
    _reason: LayoutRequestActivatePayload['reason'] | 'content-only' | 'yield-console',
    focusHost = true,
  ): Promise<void> {
    await this.enqueueHost('activate', panelId, () =>
      this.host.activate({ panelId, focusHost }),
    );
  }

  /**
   * 03：退出只看内容 / 恢复界面 → 退出托管交互，焦点交还控制台。
   * 唯一路径调 host.activate({ focusHost: false })。
   */
  async yieldFocusToConsole(): Promise<void> {
    for (const panel of this.getPanels()) {
      if (!panel.attached) continue;
      await this.activatePanel(panel.id, 'yield-console', false);
    }
  }

  scheduleSync(reason: LayoutChangeReason = 'layout-adjust'): void {
    if (this.syncDebounceMs <= 0) {
      void this.sync(reason);
      return;
    }
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      void this.sync(reason);
    }, this.syncDebounceMs);
  }

  /** 手动触发（workspace-open / dpi-change / resize 等） */
  async sync(reason: LayoutChangeReason = 'layout-adjust'): Promise<void> {
    const gen = ++this.syncGeneration;
    const snap = this.controller.getVisibility();
    const viewport = this.getViewport();
    const insetSizes =
      this.getInsetSizes?.() ??
      measureChromeInsetSizes(undefined, this.getSidebarWidth?.() ?? 280);
    if (this.getSidebarWidth && insetSizes.sidebarWidth === undefined) {
      insetSizes.sidebarWidth = this.getSidebarWidth();
    }
    const insets = computeChromeInsets(snap.visibility, insetSizes);
    const overlays = this.overlays.list();

    // 无对应 host 调用的事件：在本轮 host 队列之前发出（状态广播）
    this.emit(LAYOUT_EVENTS.chromeVisibilityChanged, {
      visibility: snap.visibility,
      contentOnly: snap.contentOnly,
      reason,
    } satisfies LayoutChromeVisibilityChangedPayload);

    this.emit(LAYOUT_EVENTS.editModeChanged, {
      editMode: snap.editMode,
      dirty: snap.dirty,
    } satisfies LayoutEditModeChangedPayload);

    // L2：scaleFactor 来自 DisplayListStore（getDisplays 保证非空；禁止硬编码 1/96DPI）
    void this.displayList.getDisplays();
    for (const panel of this.getPanels()) {
      if (gen !== this.syncGeneration) return; // 被更新一轮取代
      const bounds = computeContentBounds(viewport, insets, panel.layout);
      const scaleFactor = this.displayList.scaleFactorForPanel(bounds);
      const boundsWithScale: ContentBounds = { ...bounds, scaleFactor };
      const contentRect: ScreenRect = { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h };

      // D-L3a：layout.* 仅在「实际执行」的 host 调用完成后发出（挂在 run 内；被 coalesce 的 run 不发）
      await this.enqueueHost('setBounds', panel.id, async () => {
        await this.host.setBounds({
          panelId: panel.id,
          bounds: contentBoundsToHostRect(boundsWithScale),
        });
        applyPanelScaleFactorAttr(panel.id, scaleFactor);
        this.emit(LAYOUT_EVENTS.contentBoundsChanged, {
          panelId: panel.id,
          bounds: boundsWithScale,
          reason,
        } satisfies LayoutContentBoundsChangedPayload);
      });
      if (gen !== this.syncGeneration) return;

      // D-L1：仅浮动 overlay 相交 → occluded；停靠 chrome 永不
      // D-L3a：occlusion 事件仅在实际执行的 setVisible run 内、相对 lastOcclusion 去重后发出
      const occluded = isOccludedByOverlays(contentRect, overlays);

      const emitOcclusionIfChanged = () => {
        const prev = this.lastOcclusion.get(panel.id);
        if (prev === occluded) return;
        this.lastOcclusion.set(panel.id, occluded);
        this.emit(LAYOUT_EVENTS.hostOcclusionChanged, {
          panelId: panel.id,
          occluded,
        } satisfies LayoutHostOcclusionChangedPayload);
      };

      if (occluded) {
        await this.enqueueHost('setVisible', panel.id, async () => {
          await this.host.setVisible({ panelId: panel.id, visible: false });
          emitOcclusionIfChanged();
        });
      } else if (panel.attached && panel.shouldShow !== false) {
        await this.enqueueHost('setVisible', panel.id, async () => {
          await this.host.setVisible({ panelId: panel.id, visible: true });
          emitOcclusionIfChanged();
        });
      }
      if (gen !== this.syncGeneration) return;

      // 进入只看内容：布局宿主自行 activate（OPEN-1）
      if (reason === 'content-only' && snap.contentOnly && panel.attached) {
        await this.activatePanel(panel.id, 'content-only');
      }
    }

    await this.queue.flush();
  }

  private enqueueHost(
    op: 'setBounds' | 'setVisible' | 'activate',
    panelId: string,
    fn: () => Promise<unknown>,
  ) {
    return this.queue.enqueue(op, panelId, async () => {
      hostCallerLog.push({ tag: this.callerTag, op, at: Date.now() });
      await fn();
    });
  }

  private emit(name: LayoutEventName, payload: unknown) {
    for (const h of this.handlers) h(name, payload);
    this.transport.emit(name, payload);
  }

  getSnapshot(): ChromeStateSnapshot {
    return this.controller.getVisibility();
  }

  /** 测试/插件辅助：当前浮动层 */
  listOverlays(): FloatingOverlay[] {
    return this.overlays.list();
  }
}

function mapReason(reason: string): LayoutChangeReason {
  switch (reason) {
    case 'chrome-toggle':
    case 'chrome-toggle-while-content-only':
      return 'chrome-toggle';
    case 'content-only':
      return 'content-only';
    case 'edit-drag':
      return 'edit-drag';
    case 'restore':
      return 'restore';
    case 'workspace-open':
      return 'workspace-open';
    case 'commit-edit':
    case 'cancel-edit':
    case 'edit-mode':
      return 'layout-adjust';
    default:
      return 'layout-adjust';
  }
}

export function assertSingleHostCaller(
  expectedTag = 'layout-host',
  log = getHostCallerLog(),
): void {
  const strangers = log.filter((e) => e.tag !== expectedTag);
  if (strangers.length) {
    throw new Error(
      `host.* 出现非布局宿主调用方: ${strangers.map((s) => s.tag + ':' + s.op).join(', ')}`,
    );
  }
}

/**
 * 派发 layout.requestActivate（插件侧用；布局宿主监听并唯一调 host.activate）
 * 非 DOM 环境 no-op。
 */
export function dispatchRequestActivate(
  payload: LayoutRequestActivatePayload,
  target?: { dispatchEvent: (ev: Event) => boolean } | null,
): void {
  try {
    const CE = typeof CustomEvent === 'function' ? CustomEvent : null;
    if (!CE) return;
    const t =
      target ??
      (typeof window !== 'undefined' ? window : null);
    if (!t || typeof t.dispatchEvent !== 'function') return;
    t.dispatchEvent(new CE(LAYOUT_REQUEST_EVENTS.requestActivate, { detail: payload }));
  } catch {
    /* no-op */
  }
}
