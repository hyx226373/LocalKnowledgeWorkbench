/**
 * 统一面板管理层：把“自由窗口 + 吸附分屏”的所有操作收拢到一个 API（PanelManagerApi），
 * 底层用 dockview 的分屏（grid）、浮动组（floating groups）、原生最大化与 Smart Guides 吸附；
 * dockview 没有的能力在这里补齐：收起成气泡、侧栏浮动、浮动窗口最大化、层级持久化、屏幕变化后找回。
 * 详见 docs/11-自由窗口布局.md。
 */
import type { DockviewApi, DockviewGroupPanel, IDockviewPanel } from 'dockview-react';
import { pruneDock, type SerializedDock } from '../../shared/items';
import { registerWebCoverProbe } from '../sandbox/WebSurface';
import { bridge, type DockviewBridge, type FloatingWindowLike } from './dockviewBridge';
import { cascadeBox, GRAB_VISIBLE, keepGrabbable, maximizedBox, MIN_FLOAT, rescueBox, sameBox, snapBox } from './geometry';
import { defaultPanelLayout, finalizePanelLayout, migratePanelLayout } from './serialize';
import { SIDEBAR_COMPONENT, SIDEBAR_ID, type Box, type BubbleKind, type CollapsedInfo, type DockDirection, type FloatMeta, type PanelLayout, type PanelManagerApi, type SidebarWindowState, type Size, type WindowInfo } from './types';
import { windowCoverProbe } from './webOcclusion';

/** 吸附阈值（px）：鼠标拖动（dockview Smart Guides）与 API move 共用 */
export const SNAP_DISTANCE = 8;

export interface PanelManagerHost {
  /** 本层状态变化但 dockview 没有触发 onDidLayoutChange 时（侧栏停靠/收起、找回）请求保存 */
  persist(): void;
  /** 停靠侧栏的宽度（App 的 shell.sidebarWidth） */
  sidebarWidth(): number;
  setSidebarWidth?(w: number): void;
  /** 条目上的显示名和类型。标题不是 unknown，类型未知时省略。 */
  panelMeta?(id: string): { title?: string; kind?: BubbleKind };
  /** 布局里有气泡、dockview 里没有这块面板时补一块，避免恢复时直接 return。 */
  ensurePanel?(id: string, info: CollapsedInfo): void;
}

function usableTitle(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim();
  if (!t || t === 'unknown') return undefined;
  return t;
}

type ScrollSnap = { el: Element; top: number; left: number; ratio: number; sh: number; cw: number }[];
const DIR_TO_POS: Record<DockDirection, 'left' | 'right' | 'top' | 'bottom' | 'center'> = { left: 'left', right: 'right', above: 'top', below: 'bottom', within: 'center' };

export class PanelManager implements PanelManagerApi {
  private api: DockviewApi | null = null;
  private br: DockviewBridge | null = null;
  private host: PanelManagerHost = { persist: () => {}, sidebarWidth: () => 280 };
  private collapsed = new Map<string, CollapsedInfo>();
  private floatMeta = new Map<string, FloatMeta>(); // 键：groupId
  private sidebar: SidebarWindowState = { mode: 'docked' };
  private sidebarTarget: HTMLElement | null = null;
  private internal = 0;
  private seq = 1;
  private version = 0;
  private listeners = new Set<() => void>();
  private scrolls = new Map<string, ScrollSnap>();
  private pendingScroll: Map<string, ScrollSnap> | null = null;
  private pendingRestore = new WeakMap<Element, { top: number; left: number; ratio: number; sh: number; cw: number; token: object }>();
  /** 每个可滚动元素最近一次滚动事件时的位置：DOM 被重挂载时浏览器会静默清零（不发 scroll 事件），以此为准 */
  private lastScroll = new WeakMap<Element, { top: number; left: number; ratio: number; sh: number; cw: number }>();
  private onAnyScroll = (e: Event) => {
    const el = e.target;
    if (!(el instanceof Element) || !el.isConnected || el.clientWidth === 0) return;
    this.lastScroll.set(el, { top: el.scrollTop, left: el.scrollLeft, ratio: el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight), sh: el.scrollHeight, cw: el.clientWidth });
  };
  private lastGridGroup: DockviewGroupPanel | null = null;
  /** 只藏停靠（grid）组的标签条；浮动窗口标题不跟这个开关走 */
  private dockedTabsHiddenFlag = false;
  private disposers: (() => void)[] = [];
  private rescueRaf = 0;
  /** e2e/诊断：找回次数、被遮挡次数 */
  readonly stats = { rescued: 0, relocated: 0, snapped: 0 };

  // ------------------------------------------------------------------ 生命周期

  setHost(h: PanelManagerHost) {
    this.host = h;
  }

  attach(api: DockviewApi) {
    this.detach();
    this.api = api;
    this.br = bridge(api);
    // 拖动把手 = 标签栏空白处（不再单独渲染一条空白标题栏）；
    // 窗口可以部分移出可见区域，但顶部（标签栏）至少 GRAB_VISIBLE 像素留在可见区域内；
    // 拖动中吸附（8px，四条边，贴容器边与其他浮动窗口的边）：dockview 的 Smart Guides 属于 enterprise，
    // 这里用社区版公开的 transformFloatingGroupDrag 自己实现
    api.updateOptions({
      floatingGroupDragHandle: 'tabbar',
      floatingGroupBounds: { minimumWidthWithinViewport: GRAB_VISIBLE, minimumHeightWithinViewport: GRAB_VISIBLE },
      transformFloatingGroupDrag: (ctx) => {
        const p = { left: ctx.proposed.left, top: ctx.proposed.top, width: ctx.proposed.width, height: ctx.proposed.height };
        const s = snapBox(p, ctx.container, ctx.others.map((o) => ({ left: o.left, top: o.top, width: o.width, height: o.height })), SNAP_DISTANCE);
        const b = keepGrabbable({ ...s, width: p.width, height: p.height }, ctx.container);
        if (b.left !== Math.round(p.left) || b.top !== Math.round(p.top)) this.stats.snapped++;
        return { left: b.left, top: b.top };
      },
    });
    const d = this.disposers;
    // 从标签栏空白处开始拖动浮动窗口时，窗口跟着鼠标移动；浏览器到达拖放阈值时按“按下位置”重新命中，
    // 快速移动时那里可能已经是（跟着移过来的）标签，于是误启动标签的 HTML5 拖放、把面板停靠进分屏。
    // 记下按下目标：从空白处开始的手势里，拦掉任何其他元素的 dragstart（按住 Shift 拖空白处停靠仍是 dockview 原生行为）
    let downOnVoid: Element | null = null;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      downOnVoid = !e.shiftKey && t?.closest('.dv-groupview-floating .dv-void-container') ? t : null;
    };
    const onDragStart = (e: DragEvent) => {
      if (downOnVoid && e.target !== downOnVoid) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    const onUp = () => (downOnVoid = null);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('dragstart', onDragStart, true);
    window.addEventListener('pointerup', onUp, true);
    d.push(() => (window.removeEventListener('pointerdown', onDown, true), window.removeEventListener('dragstart', onDragStart, true), window.removeEventListener('pointerup', onUp, true)));
    d.push(registerWebCoverProbe(windowCoverProbe));
    d.push(api.onDidRemovePanel((p) => this.onRemoved(p)).dispose);
    d.push(api.onDidAddPanel((p) => queueMicrotask(() => this.relocateIfMisplaced(p))).dispose);
    d.push(api.onDidMovePanel((e) => queueMicrotask(() => this.onMoved(e.panel))).dispose);
    d.push(
      api.onDidActiveGroupChange((g) => {
        if (g && g.api.location.type === 'grid') this.lastGridGroup = g;
        this.bump();
      }).dispose,
    );
    d.push(api.onDidLayoutChange(() => this.bump()).dispose);
    // dockview 每次结构变化（浮动、停靠、拖放、最大化…）都可能把面板内容 DOM 重新挂载，浏览器会把滚动位置清零：
    // 变化前给所有面板拍滚动快照，变化后写回（用户拖放与本层 API 走同一路径）
    d.push(
      api.onWillMutateLayout((e) => {
        if (e.kind === 'load' || e.kind === 'clear' || this.pendingScroll) return;
        this.pendingScroll = this.snapAll();
      }).dispose,
    );
    d.push(
      api.onDidMutateLayout(() => {
        const m = this.pendingScroll;
        this.pendingScroll = null;
        if (m) this.restoreAll(m);
      }).dispose,
    );
    d.push(api.onDidMaximizedGroupChange(() => this.bump()).dispose);
    const ro = new ResizeObserver(() => this.scheduleRescue());
    ro.observe(this.br.container());
    d.push(() => ro.disconnect());
    const onWin = () => this.scheduleRescue();
    window.addEventListener('resize', onWin);
    d.push(() => window.removeEventListener('resize', onWin));
    document.addEventListener('scroll', this.onAnyScroll, { capture: true, passive: true });
    d.push(() => document.removeEventListener('scroll', this.onAnyScroll, { capture: true }));
    this.bump();
  }

  detach() {
    for (const f of this.disposers.splice(0)) f();
    this.api = null;
    this.br = null;
  }

  subscribe = (cb: () => void) => {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  };
  getVersion = () => this.version;
  private bump() {
    this.applyDockedTabVisibility();
    this.version++;
    for (const l of this.listeners) l();
  }
  private changed() {
    this.bump();
    this.host.persist();
  }

  // ------------------------------------------------------------------ 查询

  private need(): { api: DockviewApi; br: DockviewBridge } {
    if (!this.api || !this.br) throw new Error('面板管理层尚未连接 dockview');
    return { api: this.api, br: this.br };
  }
  containerSize(): Size {
    const r = this.br?.container().getBoundingClientRect();
    return { width: Math.floor(r?.width ?? 0), height: Math.floor(r?.height ?? 0) };
  }
  private rel(el: Element): Box {
    const c = this.need().br.container().getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left - c.left), top: Math.round(r.top - c.top), width: Math.round(r.width), height: Math.round(r.height) };
  }
  private panel(id: string): IDockviewPanel | undefined {
    return this.api?.getPanel(id);
  }
  private win(g: DockviewGroupPanel | undefined): FloatingWindowLike | undefined {
    return g && g.api.location.type === 'floating' ? this.br?.windowOf(g) : undefined;
  }
  private sidebarWin(): FloatingWindowLike | undefined {
    return this.win(this.panel(SIDEBAR_ID)?.group);
  }
  private firstPanelId(w: FloatingWindowLike): string | undefined {
    const groups = [...this.need().api.groups].filter((g) => this.br!.windowOf(g) === w);
    return (groups.flatMap((g) => g.panels.map((p) => p.id))[0] as string | undefined) ?? w.group.panels[0]?.id;
  }
  private level(w: FloatingWindowLike): number {
    const n = Number(w.overlay.element.getAttribute('aria-level'));
    return Number.isFinite(n) ? n : 0;
  }
  sidebarState(): Readonly<SidebarWindowState> {
    return this.sidebar;
  }
  getSidebarTarget() {
    return this.sidebarTarget;
  }
  setSidebarTarget(el: HTMLElement | null) {
    if (this.sidebarTarget === el) return;
    this.sidebarTarget = el;
    this.bump();
  }

  list(): WindowInfo[] {
    if (!this.api) return [];
    const out: WindowInfo[] = [];
    const c = this.containerSize();
    for (const p of this.api.panels) {
      if (p.id === SIDEBAR_ID) continue;
      out.push(this.info(p, c));
    }
    out.push(this.sidebarInfo());
    return out;
  }
  get(id: string): WindowInfo | undefined {
    if (id === SIDEBAR_ID) return this.sidebarInfo();
    const p = this.panel(id);
    return p ? this.info(p, this.containerSize()) : undefined;
  }
  private info(p: IDockviewPanel, c: Size): WindowInfo {
    const g = p.group;
    const w = this.win(g);
    const collapsed = this.collapsed.has(p.id);
    const mode = collapsed ? 'collapsed' : w ? 'floating' : 'docked';
    const bounds = collapsed ? null : w ? this.rel(w.overlay.element) : this.rel(g.element);
    const fm = this.floatMeta.get(g.id);
    const maximized = collapsed ? false : w ? !!fm?.maximized && !!bounds && sameBox(bounds, maximizedBox(c), 2) : g.api.isMaximized();
    return { id: p.id, title: p.title ?? p.id, kind: 'panel', mode, bounds, z: w && !collapsed ? this.level(w) : -1, maximized, groupId: g.id };
  }
  private sidebarInfo(): WindowInfo {
    const w = this.sidebarWin();
    const s = this.sidebar;
    if (s.collapsed) return { id: SIDEBAR_ID, title: '侧栏', kind: 'sidebar', mode: 'collapsed', bounds: null, z: -1, maximized: false, groupId: null };
    if (w) {
      const b = this.rel(w.overlay.element);
      return { id: SIDEBAR_ID, title: '侧栏', kind: 'sidebar', mode: 'floating', bounds: b, z: this.level(w), maximized: !!s.maximized && sameBox(b, maximizedBox(this.containerSize()), 2), groupId: w.group.id };
    }
    const aside = document.querySelector('aside[data-testid="sidebar"]');
    return { id: SIDEBAR_ID, title: '侧栏', kind: 'sidebar', mode: 'docked', bounds: aside && this.br ? this.rel(aside) : null, z: -1, maximized: false, groupId: null };
  }
  bubbles(): { id: string; title: string; kind: BubbleKind | 'panel'; seq: number; tray?: { left: number; top: number } }[] {
    // 侧栏收起只是隐藏，不进气泡托盘，也不为它留托盘高度
    const out = [...this.collapsed.entries()]
      .filter(([id]) => id !== SIDEBAR_ID)
      .map(([id, c]) => ({ id, title: this.bubbleTitle(id, c), kind: this.bubbleKind(id, c), seq: c.seq, tray: c.tray }));
    return out.sort((a, b) => a.seq - b.seq);
  }
  private bubbleTitle(id: string, info: CollapsedInfo): string {
    const stored = usableTitle(info.title);
    const live = usableTitle(this.panel(id)?.title);
    const meta = usableTitle(this.host.panelMeta?.(id)?.title);
    if (id === SIDEBAR_ID) return stored ?? meta ?? '侧栏';
    return stored ?? live ?? meta ?? id;
  }
  private bubbleKind(id: string, info: CollapsedInfo): BubbleKind | 'panel' {
    if (id === SIDEBAR_ID) return 'sidebar';
    if (info.kind && info.kind !== 'unknown') return info.kind;
    const meta = this.host.panelMeta?.(id)?.kind;
    if (meta && meta !== 'unknown') return meta;
    return 'panel';
  }
  /** 收起或读回时补上标题和类型。不把占位词 unknown 写进标题。 */
  private enrichCollapsed(id: string, info: CollapsedInfo): CollapsedInfo {
    const meta = this.host.panelMeta?.(id);
    const out: CollapsedInfo = { ...info };
    const title = usableTitle(out.title) ?? usableTitle(this.panel(id)?.title) ?? usableTitle(meta?.title) ?? (id === SIDEBAR_ID ? '侧栏' : undefined);
    if (title) out.title = title;
    else delete out.title;
    const metaKind = meta?.kind && meta.kind !== 'unknown' ? meta.kind : undefined;
    const kind = out.kind && out.kind !== 'unknown' ? out.kind : metaKind ?? (id === SIDEBAR_ID ? 'sidebar' : out.kind);
    if (kind) out.kind = kind;
    else delete out.kind;
    return out;
  }

  // ------------------------------------------------------------------ 操作

  move(id: string, pos: { left: number; top: number }) {
    if (this.isCollapsed(id)) this.restoreFromBubble(id);
    let w = this.windowFor(id);
    if (!w) {
      this.float(id, { left: pos.left, top: pos.top });
      w = this.windowFor(id);
      if (!w) return;
    }
    const cur = this.rel(w.overlay.element);
    const c = this.containerSize();
    const others = this.need().br.floats().filter((x) => x !== w && !this.isHidden(x)).map((x) => this.rel(x.overlay.element));
    // 用户移动：允许部分移出，但标签栏至少 40px 留在可见区域
    const next = keepGrabbable(snapBox({ ...cur, left: Math.round(pos.left), top: Math.round(pos.top) }, c, others, SNAP_DISTANCE), c);
    this.clearMax(id, w);
    w.overlay.setBounds(next);
    if (id === SIDEBAR_ID) this.sidebar = { ...this.sidebar, bounds: next };
    this.changed();
  }

  resize(id: string, size: Partial<Size>, opts?: { commit?: boolean }) {
    const commit = opts?.commit !== false;
    if (this.isCollapsed(id)) this.restoreFromBubble(id);
    const w = this.windowFor(id);
    if (w) {
      const cur = this.rel(w.overlay.element);
      const next = rescueBox({ ...cur, width: size.width ?? cur.width, height: size.height ?? cur.height }, this.containerSize());
      this.clearMax(id, w);
      w.overlay.setBounds(next);
      if (id === SIDEBAR_ID) this.sidebar = { ...this.sidebar, bounds: next };
      if (commit) this.changed();
      return;
    }
    if (id === SIDEBAR_ID) {
      if (size.width && this.host.setSidebarWidth) this.host.setSidebarWidth(size.width);
      if (commit) this.changed();
      return;
    }
    const p = this.panel(id);
    if (!p) return;
    p.group.api.setSize({ ...(size.width ? { width: size.width } : {}), ...(size.height ? { height: size.height } : {}) });
    if (commit) this.changed();
  }

  /** 浮动窗口宿主。resize-grip 挂到现有 overlay，不另建窗口状态。 */
  floatingFrames(): { id: string; element: HTMLElement }[] {
    if (!this.api || !this.br) return [];
    const out: { id: string; element: HTMLElement }[] = [];
    const seen = new Set<HTMLElement>();
    for (const w of this.br.floats()) {
      const el = w.overlay.element;
      if (!el || seen.has(el) || !w.overlay.isVisible || el.hasAttribute('data-pm-collapsed')) continue;
      const id = this.firstPanelId(w);
      if (!id || this.isCollapsed(id)) continue;
      seen.add(el);
      out.push({ id, element: el });
    }
    return out;
  }

  bringToFront(id: string) {
    const w = this.windowFor(id);
    if (!w) return;
    w.overlay.bringToFront();
    this.changed();
  }

  float(id: string, box?: Partial<Box>) {
    const { api } = this.need();
    if (this.isCollapsed(id)) this.restoreFromBubble(id);
    const c = this.containerSize();
    if (id === SIDEBAR_ID) {
      const w = this.sidebarWin();
      if (w) {
        if (box) w.overlay.setBounds(rescueBox({ ...this.rel(w.overlay.element), ...box } as Box, c));
        return this.changed();
      }
      const base = this.sidebar.bounds ?? { left: 12, top: 12, width: this.host.sidebarWidth(), height: Math.max(MIN_FLOAT.height, c.height - 24) };
      const b = rescueBox({ ...base, ...box } as Box, c);
      this.sidebar = { ...this.sidebar, mode: 'floating', bounds: b, maximized: undefined };
      this.addSidebarPanel(b);
      return this.changed();
    }
    const p = this.panel(id);
    if (!p) return;
    const w = this.win(p.group);
    if (w && p.group.panels.length === 1 && this.groupsInWindow(w) === 1) {
      if (box) w.overlay.setBounds(rescueBox({ ...this.rel(w.overlay.element), ...box } as Box, c));
      return this.changed();
    }
    const cur = w ? this.rel(w.overlay.element) : this.rel(p.group.element);
    const n = this.need().br.floats().length;
    const base = cascadeBox(n, c, { width: Math.max(MIN_FLOAT.width, Math.min(cur.width, Math.round(c.width * 0.55))), height: Math.max(MIN_FLOAT.height, Math.min(cur.height, Math.round(c.height * 0.6))) });
    const b = rescueBox({ ...base, ...box } as Box, c);
    api.addFloatingGroup(p, { x: b.left, y: b.top, width: b.width, height: b.height });
    this.changed();
  }

  dock(id: string, target: { ref?: string; direction?: DockDirection } = {}) {
    const { api } = this.need();
    if (this.isCollapsed(id)) {
      const info = id === SIDEBAR_ID ? this.sidebar.collapsed : this.collapsed.get(id);
      if (id !== SIDEBAR_ID && info) this.collapsed.set(id, { ...info, from: 'grid', dockRef: target.ref ?? info.dockRef, dockDir: target.direction ?? info.dockDir });
      if (id === SIDEBAR_ID && info) this.sidebar = { ...this.sidebar, collapsed: { ...info, from: 'sidebar-docked' } };
      return this.restoreFromBubble(id);
    }
    if (id === SIDEBAR_ID) {
      const w = this.sidebarWin();
      if (w) this.sidebar = { ...this.sidebar, bounds: this.rel(w.overlay.element) };
      this.sidebar = { ...this.sidebar, mode: 'docked', maximized: undefined };
      this.removeSidebarPanel();
      return this.changed();
    }
    const p = this.panel(id);
    if (!p || p.group.api.location.type === 'grid') return;
    const w = this.win(p.group);
    if (w) this.floatMeta.delete(p.group.id);
    const ref = target.ref ? this.panel(target.ref) : undefined;
    const refGroup = ref && ref.group.api.location.type === 'grid' ? ref.group : this.gridGroupForDock();
    // 停靠只移动已有面板：唯一文档拖到边缘不另开一份，合并进单栏也不关掉另一侧
    if (refGroup) p.api.moveTo({ group: refGroup, position: DIR_TO_POS[target.direction ?? (ref ? 'right' : 'right')] });
    else if (p.group.panels.length === 1) p.group.api.moveTo({ position: 'right' });
    else {
      // 分屏为空且浮动窗口里还有其他标签：先单独浮出，再整组移入分屏
      api.addFloatingGroup(p, {});
      this.panel(id)?.group.api.moveTo({ position: 'right' });
    }
    this.changed();
  }

  toggleFloat(id: string) {
    const i = this.get(id);
    if (!i) return;
    if (i.mode === 'floating') this.dock(id);
    else this.float(id);
  }

  collapseToBubble(id: string) {
    if (this.isCollapsed(id)) return;
    const seq = this.seq++;
    if (id === SIDEBAR_ID) {
      const w = this.sidebarWin();
      if (w) {
        const b = this.sidebar.maximized ? this.sidebar.maximized.restore : this.rel(w.overlay.element);
        const fromDocked = this.sidebar.maximized?.from === 'docked';
        const collapsed = this.enrichCollapsed(SIDEBAR_ID, fromDocked ? { from: 'sidebar-docked', seq } : { from: 'floating', bounds: b, seq });
        this.sidebar = { ...this.sidebar, bounds: b, maximized: undefined, collapsed };
        this.removeSidebarPanel();
      } else this.sidebar = { ...this.sidebar, collapsed: this.enrichCollapsed(SIDEBAR_ID, { from: 'sidebar-docked', seq }) };
      return this.changed();
    }
    const { api } = this.need();
    const p = this.panel(id);
    if (!p) return;
    const snap = this.snapScroll(id);
    if (snap) this.scrolls.set(id, snap);
    let w = this.win(p.group);
    let info: CollapsedInfo;
    if (!w) {
      if (p.group.api.isMaximized()) api.exitMaximizedGroup();
      const hint = this.dockHint(p);
      const r = this.rel(p.group.element);
      info = this.enrichCollapsed(id, { from: 'grid', ...hint, seq });
      this.collapsed.set(id, info);
      api.addFloatingGroup(p, { x: r.left, y: r.top, width: Math.max(MIN_FLOAT.width, r.width), height: Math.max(MIN_FLOAT.height, r.height) });
    } else {
      const fm = this.floatMeta.get(p.group.id);
      const b = fm?.maximized ? fm.maximized.restore : this.rel(w.overlay.element);
      info = this.enrichCollapsed(id, { from: 'floating', bounds: b, seq });
      this.collapsed.set(id, info);
      if (p.group.panels.length > 1 || this.groupsInWindow(w) > 1) api.addFloatingGroup(p, { x: b.left, y: b.top, width: b.width, height: b.height });
      else this.floatMeta.delete(p.group.id);
    }
    w = this.win(this.panel(id)?.group);
    if (w) this.hideWindow(id, w);
    this.changed();
  }

  restoreFromBubble(id: string) {
    if (id === SIDEBAR_ID) {
      const c = this.sidebar.collapsed;
      if (!c) return;
      this.sidebar = { ...this.sidebar, collapsed: undefined };
      if (c.from === 'floating') {
        const b = rescueBox(c.bounds ?? this.sidebar.bounds ?? cascadeBox(0, this.containerSize()), this.containerSize());
        this.sidebar = { ...this.sidebar, mode: 'floating', bounds: b };
        this.addSidebarPanel(b);
      } else this.sidebar = { ...this.sidebar, mode: 'docked' };
      return this.changed();
    }
    const info = this.collapsed.get(id);
    if (!info) return;
    if (!this.panel(id)) this.host.ensurePanel?.(id, info);
    const p = this.panel(id);
    // 面板还补不出来时保留收起记录，避免一次点击把布局清掉。
    if (!p) return;
    // 隐藏期间（例如重启后在收起状态下）视图自己恢复的滚动位置：Chromium 在 visibility 由 hidden 变回 visible 时会静默清零，先记下
    const pre = this.snapScroll(id);
    this.collapsed.delete(id);
    const w = this.win(p.group);
    if (w) this.showWindow(id, w);
    if (info.from === 'grid' || info.from === 'sidebar-docked') {
      this.dock(id, { ref: info.dockRef, direction: info.dockDir });
    } else {
      const live = this.win(this.panel(id)?.group);
      if (live) {
        live.overlay.setBounds(rescueBox(info.bounds ?? this.rel(live.overlay.element), this.containerSize()));
        live.overlay.bringToFront();
      } else this.float(id, info.bounds);
    }
    this.panel(id)?.api.setActive();
    const snap = pre?.length ? pre : this.scrolls.get(id);
    this.scrolls.delete(id);
    this.restoreScroll(id, snap ?? null);
    this.changed();
  }

  /** 记住气泡拖放位置（dock 容器坐标）。夹在可找回范围内。 */
  setBubbleTray(id: string, pos: { left: number; top: number }) {
    if (id === SIDEBAR_ID) return;
    const info = this.collapsed.get(id);
    if (!info) return;
    const c = this.containerSize();
    const left = Math.min(Math.max(-40, pos.left), Math.max(0, c.width - 48));
    const top = Math.min(Math.max(0, pos.top), Math.max(0, c.height - 28));
    this.collapsed.set(id, { ...info, tray: { left, top } });
    this.changed();
  }

  /** 从气泡直接关闭文档面板，不先恢复。未保存草稿沿用编辑器卸下流程。 */
  closeBubble(id: string) {
    if (id === SIDEBAR_ID) return;
    const p = this.panel(id);
    if (!p) {
      if (this.collapsed.delete(id)) this.changed();
      return;
    }
    // 保持收起标记直到 onRemoved 清掉，避免关闭前闪回阅读区
    p.api.close();
  }

  maximize(id: string) {
    if (this.isCollapsed(id)) this.restoreFromBubble(id);
    const c = this.containerSize();
    if (id === SIDEBAR_ID) {
      let from: 'docked' | 'floating' = 'floating';
      if (!this.sidebarWin()) {
        from = 'docked';
        this.float(SIDEBAR_ID);
      }
      const w = this.sidebarWin();
      if (!w) return;
      const restore = this.sidebar.maximized?.restore ?? this.rel(w.overlay.element);
      this.sidebar = { ...this.sidebar, maximized: { restore, from: this.sidebar.maximized?.from ?? from } };
      w.overlay.setBounds(maximizedBox(c));
      w.overlay.bringToFront();
      return this.changed();
    }
    const p = this.panel(id);
    if (!p) return;
    const w = this.win(p.group);
    if (!w) {
      this.need().api.maximizeGroup(p);
      return this.changed();
    }
    const cur = this.rel(w.overlay.element);
    const fm = this.floatMeta.get(p.group.id);
    this.floatMeta.set(p.group.id, { ...fm, maximized: { restore: fm?.maximized?.restore ?? cur } });
    w.overlay.setBounds(maximizedBox(c));
    w.overlay.bringToFront();
    p.api.setActive();
    this.changed();
  }

  restore(id: string) {
    if (this.isCollapsed(id)) return this.restoreFromBubble(id);
    const c = this.containerSize();
    if (id === SIDEBAR_ID) {
      const m = this.sidebar.maximized;
      const w = this.sidebarWin();
      if (!m || !w) return;
      this.sidebar = { ...this.sidebar, maximized: undefined, bounds: m.restore };
      if (m.from === 'docked') return this.dock(SIDEBAR_ID);
      w.overlay.setBounds(rescueBox(m.restore, c));
      return this.changed();
    }
    const p = this.panel(id);
    if (!p) return;
    const w = this.win(p.group);
    if (!w) {
      if (p.group.api.isMaximized()) this.need().api.exitMaximizedGroup();
      return this.changed();
    }
    const fm = this.floatMeta.get(p.group.id);
    if (!fm?.maximized) return;
    this.floatMeta.delete(p.group.id);
    w.overlay.setBounds(rescueBox(fm.maximized.restore, c));
    this.changed();
  }

  isCollapsed(id: string) {
    return id === SIDEBAR_ID ? !!this.sidebar.collapsed : this.collapsed.has(id);
  }

  dockedTabsHidden() {
    return this.dockedTabsHiddenFlag;
  }

  /** 只藏停靠组的标签条。不关面板、不改活动项；浮动组（含侧栏）标题保持可见。 */
  hideDockedTabs() {
    this.dockedTabsHiddenFlag = true;
    this.bump();
  }

  showDocumentTabs() {
    this.dockedTabsHiddenFlag = false;
    this.bump();
  }

  private applyingTabs = false;
  private applyDockedTabVisibility() {
    if (this.applyingTabs || !this.api) return;
    this.applyingTabs = true;
    try {
      for (const g of this.api.groups) {
        const header = g.header;
        if (!header) continue;
        const next = this.dockedTabsHiddenFlag && g.api.location.type === 'grid';
        if (header.hidden === next) continue;
        header.hidden = next;
        if (typeof g.relayout === 'function') g.relayout();
      }
    } finally {
      this.applyingTabs = false;
    }
  }

  /** fromJSON 之前调用：记下将被收起的面板，分级加载据此不在启动时挂载它们（restoreLayout 结束后清空） */
  private primed = new Set<string>();
  primeCollapsed(raw: unknown) {
    this.primed = new Set(Object.keys(migratePanelLayout(raw).layout.collapsed));
  }
  /** 收起（或即将被收起）：对用户不可见，分级加载按后台标签处理 */
  isHiddenForLoad(id: string) {
    return this.isCollapsed(id) || this.primed.has(id);
  }

  // ------------------------------------------------------------------ 找回

  private lastContainer: Size | null = null;
  private scheduleRescue() {
    cancelAnimationFrame(this.rescueRaf);
    this.rescueRaf = requestAnimationFrame(() => {
      const c = this.containerSize();
      const prev = this.lastContainer;
      this.lastContainer = c;
      // 容器变小（窗口缩小、分辨率变化）：完整夹回可见区域；否则只保证标签栏可拖
      const strict = !!prev && (c.width < prev.width - 1 || c.height < prev.height - 1);
      if (this.rescue(strict) > 0) this.host.persist();
      this.bump();
    });
  }

  /** 把所有可见浮动窗口夹回 dock 区域；最大化的窗口跟随容器尺寸。返回移动的窗口数 */
  rescue(strict = true): number {
    if (!this.api || !this.br) return 0;
    const c = this.containerSize();
    const fit = (b: Box) => (strict ? rescueBox(b, c) : keepGrabbable(b, c));
    if (c.width < 50 || c.height < 50) return 0;
    let n = 0;
    for (const w of this.br.floats()) {
      if (!!this.isHidden(w)) continue;
      const cur = this.rel(w.overlay.element);
      const isSidebar = w === this.sidebarWin();
      const max = isSidebar ? !!this.sidebar.maximized : !!this.floatMeta.get(w.group.id)?.maximized;
      const next = max ? maximizedBox(c) : fit(cur);
      if (!sameBox(cur, next)) {
        w.overlay.setBounds(next);
        n++;
      }
      if (isSidebar) this.sidebar = { ...this.sidebar, bounds: max ? this.sidebar.bounds : next };
    }
    // 收起前的位置也夹回（恢复时直接落在可见区域）
    for (const [id, info] of this.collapsed) if (info.bounds) this.collapsed.set(id, { ...info, bounds: fit(info.bounds) });
    this.stats.rescued += n;
    return n;
  }

  // ------------------------------------------------------------------ 序列化

  serialize(): PanelLayout {
    const c = this.containerSize();
    const l = defaultPanelLayout(c);
    if (!this.api || !this.br) return { ...l, sidebar: { ...this.sidebar } };
    const sw = this.sidebarWin();
    const visible = this.br.floats().filter((w) => !this.isHidden(w));
    visible.sort((a, b) => this.level(a) - this.level(b));
    for (const w of visible) {
      const key = w === sw ? SIDEBAR_ID : this.firstPanelId(w);
      if (!key) continue;
      l.order.push(key);
      const fm = this.floatMeta.get(w.group.id);
      if (w !== sw && fm?.maximized) {
        // 用户拖动/缩放过最大化的窗口 → 不再算最大化
        if (sameBox(this.rel(w.overlay.element), maximizedBox(c), 2)) l.floats[key] = { maximized: { restore: fm.maximized.restore } };
        else this.floatMeta.delete(w.group.id);
      }
    }
    for (const [id, info] of this.collapsed) l.collapsed[id] = { ...info };
    const mg = this.api.groups.find((g) => g.api.location.type === 'grid' && g.api.isMaximized());
    if (mg?.activePanel) l.gridMaximized = mg.activePanel.id;
    const s: SidebarWindowState = { ...this.sidebar };
    if (sw) {
      const b = this.rel(sw.overlay.element);
      if (s.maximized && !sameBox(b, maximizedBox(c), 2)) delete s.maximized;
      if (!s.maximized) s.bounds = b;
    }
    l.sidebar = s;
    const ids = new Set(this.api.panels.map((p) => p.id).filter((id) => id !== SIDEBAR_ID));
    return finalizePanelLayout(l, ids);
  }

  dockForSave<T>(dock: T): T {
    if (!dock) return dock;
    return pruneDock(dock as unknown as SerializedDock, (id) => id !== SIDEBAR_ID) as unknown as T;
  }

  /** 工作区切换前 / 布局无法识别时：回到默认（侧栏停靠） */
  reset() {
    this.collapsed.clear();
    this.floatMeta.clear();
    this.scrolls.clear();
    this.sidebar = { mode: 'docked' };
    if (this.panel(SIDEBAR_ID)) this.removeSidebarPanel();
    this.bump();
  }

  restoreLayout(raw: unknown) {
    const { api, br } = this.need();
    const { layout } = migratePanelLayout(raw);
    this.collapsed.clear();
    this.floatMeta.clear();
    this.scrolls.clear();
    this.seq = 1 + Math.max(0, ...Object.values(layout.collapsed).map((c) => c.seq), layout.sidebar.collapsed?.seq ?? 0);
    // 侧栏
    this.sidebar = { ...layout.sidebar };
    if (this.sidebar.collapsed) this.sidebar = { ...this.sidebar, collapsed: this.enrichCollapsed(SIDEBAR_ID, this.sidebar.collapsed) };
    if (this.panel(SIDEBAR_ID)) this.removeSidebarPanel();
    if (this.sidebar.mode === 'floating' && !this.sidebar.collapsed) {
      const b = this.sidebar.maximized ? maximizedBox(this.containerSize()) : (this.sidebar.bounds ?? cascadeBox(0, this.containerSize()));
      this.addSidebarPanel(b);
    }
    // 浮动窗口附加状态
    for (const [pid, fm] of Object.entries(layout.floats)) {
      const g = this.panel(pid)?.group;
      if (g && g.api.location.type === 'floating') this.floatMeta.set(g.id, fm);
    }
    // 气泡
    for (const [pid, info] of Object.entries(layout.collapsed)) {
      const next = this.enrichCollapsed(pid, info);
      // 先记下收起，再补面板：落进隐藏窗口时 relocateIfMisplaced 不会把它拽走。
      this.collapsed.set(pid, next);
      if (!this.panel(pid)) this.host.ensurePanel?.(pid, next);
      const p = this.panel(pid);
      if (!p) continue;
      let w = this.win(p.group);
      if (!w || p.group.panels.length > 1 || this.groupsInWindow(w) > 1) {
        const r = next.bounds ?? cascadeBox(0, this.containerSize());
        api.addFloatingGroup(p, { x: r.left, y: r.top, width: r.width, height: r.height });
        w = this.win(this.panel(pid)?.group);
      }
      if (w) this.hideWindow(pid, w);
    }
    // 层级（dockview toJSON 按创建顺序保存浮动组，不保存层级）
    for (const key of layout.order) {
      const w = key === SIDEBAR_ID ? this.sidebarWin() : this.win(this.panel(key)?.group);
      if (w && !this.isHidden(w)) w.overlay.bringToFront();
    }
    if (layout.gridMaximized) {
      const p = this.panel(layout.gridMaximized);
      if (p && p.group.api.location.type === 'grid') api.maximizeGroup(p);
    }
    void br;
    // 打开到比保存时更小的屏幕：完整夹回可见区域；否则保持原位置（只保证标签栏可拖）
    const smaller = () => {
      const c = this.containerSize();
      return c.width < layout.viewport.width - 1 || c.height < layout.viewport.height - 1;
    };
    this.rescue(smaller());
    this.bump();
    // 容器尺寸在首帧后才稳定（侧栏宽度、窗口尺寸），再找回一次
    requestAnimationFrame(() => requestAnimationFrame(() => (this.lastContainer = this.containerSize(), this.rescue(smaller()) && this.bump())));
    this.primed.clear();
  }

  // ------------------------------------------------------------------ 内部

  private windowFor(id: string): FloatingWindowLike | undefined {
    return id === SIDEBAR_ID ? this.sidebarWin() : this.win(this.panel(id)?.group);
  }
  private groupsInWindow(w: FloatingWindowLike): number {
    return this.need().api.groups.filter((g) => this.br!.windowOf(g) === w).length;
  }
  private clearMax(id: string, w: FloatingWindowLike) {
    if (id === SIDEBAR_ID) this.sidebar = { ...this.sidebar, maximized: undefined };
    else this.floatMeta.delete(w.group.id);
  }
  private gridGroupForDock(): DockviewGroupPanel | undefined {
    const grid = this.need().api.groups.filter((g) => g.api.location.type === 'grid');
    if (this.lastGridGroup && grid.includes(this.lastGridGroup)) return this.lastGridGroup;
    return grid[grid.length - 1];
  }
  /** 收起前记下“停靠在哪个面板的哪一侧” */
  private dockHint(p: IDockviewPanel): { dockRef?: string; dockDir?: DockDirection } {
    const g = p.group;
    const sib = g.panels.find((x) => x.id !== p.id);
    if (sib) return { dockRef: sib.id, dockDir: 'within' };
    const api = this.need().api;
    const pairs: [Parameters<DockviewApi['adjacentGroupInDirection']>[1], DockDirection][] = [
      ['left', 'right'],
      ['right', 'left'],
      ['up', 'below'],
      ['down', 'above'],
    ];
    for (const [dir, rel] of pairs) {
      const n = api.adjacentGroupInDirection(g, dir) as DockviewGroupPanel | undefined;
      const ref = n?.activePanel ?? n?.panels[0];
      if (ref) return { dockRef: ref.id, dockDir: rel };
    }
    return {};
  }
  private addSidebarPanel(b: Box) {
    const { api } = this.need();
    this.internal++;
    try {
      const prev = api.activePanel;
      const p = api.addPanel({ id: SIDEBAR_ID, component: SIDEBAR_COMPONENT, title: '侧栏', floating: { x: b.left, y: b.top, width: b.width, height: b.height } } as never);
      (p.group.api as { locked: unknown }).locked = 'no-drop-target';
      const w = this.win(p.group);
      if (w) w.overlay.setBounds(rescueBox(b, this.containerSize()));
      if (prev && prev.id !== SIDEBAR_ID && api.getPanel(prev.id)) prev.api.setActive();
      // 激活上一个面板会把它的浮动窗口带到最上层；新浮动的侧栏应在最上层
      this.win(this.panel(SIDEBAR_ID)?.group)?.overlay.bringToFront();
    } finally {
      this.internal--;
    }
  }
  private removeSidebarPanel() {
    const p = this.panel(SIDEBAR_ID);
    if (!p) return;
    this.internal++;
    try {
      p.api.close();
    } finally {
      this.internal--;
    }
  }
  /** 面板内容根元素（dockview 内容容器；常驻渲染的面板在 .dv-render-overlay 里） */
  private contentEl(id: string): HTMLElement | null {
    const p = this.panel(id) as unknown as { view?: { content?: { element?: HTMLElement } } } | undefined;
    return p?.view?.content?.element ?? (document.querySelector(`[data-item-id="${CSS.escape(id)}"]`) as HTMLElement | null);
  }
  /**
   * 收起 = visibility:hidden（不是 display:none）：内容保持布局，阅读器在隐藏状态下也能按保存的阅读位置恢复滚动；
   * 不可见元素不接收鼠标、不能获得焦点。网页面板的 slot 因此 checkVisibility() 为 false → 原生视图隐藏。
   */
  private hideWindow(id: string, w: FloatingWindowLike) {
    w.overlay.element.setAttribute('data-pm-collapsed', id);
    this.syncHidden();
  }
  private showWindow(id: string, w: FloatingWindowLike) {
    w.overlay.element.removeAttribute('data-pm-collapsed');
    this.contentEl(id)?.closest('.dv-render-overlay')?.removeAttribute('data-pm-hidden');
    this.syncHidden();
  }
  isHidden(w: FloatingWindowLike) {
    return w.overlay.element.hasAttribute('data-pm-collapsed');
  }
  private hiddenRaf = 0;
  /** 常驻渲染层（网页面板）不在浮动窗口 DOM 里，单独标记；渲染方式可能在挂载后才切换，所以有气泡时逐帧校正 */
  private syncHidden = () => {
    cancelAnimationFrame(this.hiddenRaf);
    for (const id of this.collapsed.keys()) this.contentEl(id)?.closest('.dv-render-overlay')?.setAttribute('data-pm-hidden', '1');
    if (this.collapsed.size) this.hiddenRaf = requestAnimationFrame(this.syncHidden);
  };
  private onRemoved(p: IDockviewPanel) {
    if (p.id === SIDEBAR_ID) {
      if (this.internal) return;
      // 用户关闭了浮动侧栏的标签：回到停靠
      this.sidebar = { ...this.sidebar, mode: 'docked', maximized: undefined };
      return this.changed();
    }
    if (this.collapsed.delete(p.id)) this.bump();
    this.scrolls.delete(p.id);
  }
  private onMoved(p: IDockviewPanel) {
    if (!this.api?.getPanel(p.id)) return;
    if (p.id === SIDEBAR_ID) {
      // 侧栏被拖进分屏 = 停靠回左侧
      if (p.group.api.location.type !== 'floating') this.dock(SIDEBAR_ID);
      return;
    }
    this.relocateIfMisplaced(p);
  }
  /** 新面板/被移动的面板落进了侧栏窗口或收起（隐藏）的窗口 → 移到分屏 */
  private relocateIfMisplaced(p: IDockviewPanel) {
    if (!this.api || p.id === SIDEBAR_ID || !this.api.getPanel(p.id)) return;
    const w = this.win(p.group);
    if (!w) return;
    const sw = this.sidebarWin();
    const intoSidebar = w === sw;
    const intoHidden = !!this.isHidden(w) && !this.collapsed.has(p.id);
    if (!intoSidebar && !intoHidden) return;
    const g = this.gridGroupForDock();
    if (g) p.api.moveTo({ group: g, position: 'center' });
    else {
      this.api.addFloatingGroup(p, cascadeBox(1, this.containerSize()) as never);
    }
    this.stats.relocated++;
    this.changed();
  }
  /** 面板内容里所有可滚动元素（同时看 dockview 内容容器与 data-item-id 节点；按元素引用记录，重挂载后引用仍有效） */
  private scrollables(id: string): Element[] {
    const roots = new Set<Element>();
    const c = this.contentEl(id);
    if (c) roots.add(c);
    document.querySelectorAll(`[data-item-id="${CSS.escape(id)}"]`).forEach((e) => roots.add(e));
    const out = new Set<Element>();
    for (const r of roots) [r, ...r.querySelectorAll('*')].forEach((e) => out.add(e));
    return [...out];
  }
  private snapScroll(id: string): ScrollSnap | null {
    const out: ScrollSnap = [];
    for (const el of this.scrollables(id)) {
      const live = el.scrollTop || el.scrollLeft ? { top: el.scrollTop, left: el.scrollLeft, ratio: el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight), sh: el.scrollHeight, cw: el.clientWidth } : null;
      const last = this.lastScroll.get(el);
      // 现值为 0 而最近记录不为 0：被静默清零过（重挂载），用最近记录
      // 正在写回的元素（上一次结构变化的恢复还没完成）：以要写回的值为准，不记下中间状态
      const pend = this.pendingRestore.get(el);
      const v = pend ?? live ?? (last && (last.top || last.left) ? last : null);
      if (v) out.push({ el, top: v.top, left: v.left, ratio: v.ratio, sh: v.sh, cw: v.cw });
    }
    return out;
  }
  private snapAll(): Map<string, ScrollSnap> {
    const m = new Map<string, ScrollSnap>();
    for (const p of this.api?.panels ?? []) {
      if (p.id === SIDEBAR_ID) continue;
      const s = this.snapScroll(p.id);
      if (s?.length) m.set(p.id, s);
    }
    return m;
  }
  private restoreAll(m: Map<string, ScrollSnap>) {
    for (const [id, s] of m) this.restoreScroll(id, s);
  }
  /** 写回滚动位置：内容高度没变按像素，变了（窗口变窄导致重排）按比例；两帧后执行，再补一次 */
  private restoreScroll(id: string, snap: ScrollSnap | null) {
    if (!snap || !snap.length) return;
    const token = {};
    for (const s of snap) this.pendingRestore.set(s.el, { ...s, token });
    // 宽度没变（只是重挂载/移动）：按原像素写回——内容高度可能因懒渲染、字体加载略有变化，按比例换算会漂移；
    // 宽度变了（重排）：让视口顶部仍是同一段内容，按“顶部在全文中的位置比例”换算
    const apply = () => {
      for (const s of snap) {
        const el = s.el;
        if (!el.isConnected || el.getBoundingClientRect().width === 0 || el.clientHeight === 0) continue;
        const reflowed = Math.abs(el.clientWidth - s.cw) > 2;
        const raw = reflowed ? Math.round((s.top / Math.max(1, s.sh)) * el.scrollHeight) : s.top;
        const want = Math.min(raw, Math.max(0, el.scrollHeight - el.clientHeight));
        if (Math.abs(el.scrollTop - want) > 1) el.scrollTop = want;
        if (Math.abs(el.scrollLeft - s.left) > 1) el.scrollLeft = s.left;
      }
    };
    const done = () => {
      apply();
      for (const s of snap) if (this.pendingRestore.get(s.el)?.token === token) this.pendingRestore.delete(s.el);
    };
    // 两帧后写回，布局稳定过程中再校正两次，最后一次后结束“写回中”状态
    requestAnimationFrame(() => requestAnimationFrame(() => (apply(), setTimeout(apply, 120), setTimeout(done, 400))));
  }
}
