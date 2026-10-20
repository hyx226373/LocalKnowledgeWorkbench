/**
 * L2：显示器列表 → scaleFactor 链路（布局侧）
 * - 生产路径 getDisplays() 永不返回 []（无桥时用可注入 provider / 合成主屏）
 * - 发出 layout.displaysChanged，供插件消费（禁止插件再传空数组）
 * - 禁止硬编码 96 DPI
 */
import {
  GET_DISPLAYS_HOOK,
  LAYOUT_DISPLAYS_CHANGED_EVENT,
  L2_BOUNDS_THRESHOLD,
  type DisplayMetrics,
  type LayoutDisplaysChangedPayload,
} from '../../shared/chromeLayout';

export {
  LAYOUT_DISPLAYS_CHANGED_EVENT,
  GET_DISPLAYS_HOOK,
  L2_BOUNDS_THRESHOLD,
};
export type { DisplayMetrics, LayoutDisplaysChangedPayload };

export type DisplayListProvider = () => DisplayMetrics[] | Promise<DisplayMetrics[]>;

/** 合成主屏：scale 来自 devicePixelRatio / 注入值，永不假设 96 DPI */
export function synthesizePrimaryDisplay(scaleFactor: number, size?: { width: number; height: number }): DisplayMetrics {
  const s = assertScale(scaleFactor);
  const width =
    size?.width ??
    (typeof screen !== 'undefined' && screen.width ? screen.width : 1920);
  const height =
    size?.height ??
    (typeof screen !== 'undefined' && screen.height ? screen.height : 1080);
  return {
    id: 0,
    bounds: { x: 0, y: 0, width, height },
    scaleFactor: s,
  };
}

export function assertScale(scaleFactor: number): number {
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) {
    throw new Error(
      `invalid scaleFactor: ${scaleFactor} (must come from Electron screen / display list, not hard-coded 96 DPI)`,
    );
  }
  return scaleFactor;
}

export function sanitizeDisplay(raw: unknown): DisplayMetrics | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const b = o.bounds as Record<string, unknown> | undefined;
  if (!b || typeof b !== 'object') return null;
  const scale = Number(o.scaleFactor);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const x = Number(b.x);
  const y = Number(b.y);
  const width = Number(b.width ?? b.w);
  const height = Number(b.height ?? b.h);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  const out: DisplayMetrics = {
    bounds: { x, y, width, height },
    scaleFactor: scale,
  };
  if (typeof o.id === 'number') out.id = o.id;
  return out;
}

export function sanitizeDisplays(raw: unknown): DisplayMetrics[] {
  if (!Array.isArray(raw)) return [];
  const out: DisplayMetrics[] = [];
  for (const item of raw) {
    const d = sanitizeDisplay(item);
    if (d) out.push(d);
  }
  return out;
}

/**
 * 选中包含矩形中心的显示器（对齐 native pickDisplayForRect）。
 * 列表为空时抛错——调用方应先 ensureNonEmpty。
 */
export function pickDisplayForRect(
  rect: { x: number; y: number; width?: number; height?: number; w?: number; h?: number },
  displays: DisplayMetrics[],
): DisplayMetrics {
  if (!displays.length) {
    throw new Error('pickDisplayForRect: empty displays (use DisplayListStore.getDisplays / ensureNonEmpty)');
  }
  const width = rect.width ?? rect.w ?? 0;
  const height = rect.height ?? rect.h ?? 0;
  const cx = rect.x + width / 2;
  const cy = rect.y + height / 2;
  for (const d of displays) {
    const b = d.bounds;
    if (cx >= b.x && cx < b.x + b.width && cy >= b.y && cy < b.y + b.height) return d;
  }
  let best = displays[0]!;
  let bestDist = Infinity;
  for (const d of displays) {
    const bx = d.bounds.x + d.bounds.width / 2;
    const by = d.bounds.y + d.bounds.height / 2;
    const dist = (bx - cx) ** 2 + (by - cy) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  return best;
}

export function scaleFactorForPoint(x: number, y: number, displays: DisplayMetrics[]): number {
  return pickDisplayForRect({ x, y, width: 0, height: 0 }, displays).scaleFactor;
}

export function scaleFactorForPanel(
  bounds: { x: number; y: number; w?: number; h?: number; width?: number; height?: number },
  displays: DisplayMetrics[],
): number {
  return pickDisplayForRect(bounds, displays).scaleFactor;
}

/**
 * DIP 矩形 → 物理（浮点 ×scale；对齐 native rectDipToPhysical）。
 * 布局→OS / 阈值断言请用 rectDipToPhysicalTrunc（Math.trunc 向 0）。
 */
export function rectDipToPhysical(
  rect: { x: number; y: number; width: number; height: number },
  scaleFactor: number,
): { x: number; y: number; width: number; height: number } {
  const s = assertScale(scaleFactor);
  return {
    x: rect.x * s,
    y: rect.y * s,
    width: rect.width * s,
    height: rect.height * s,
  };
}

/** DIP → 物理 + Math.trunc（向 0），对齐 native / SetWindowPos（6b09257） */
export function rectDipToPhysicalTrunc(
  rect: { x: number; y: number; width: number; height: number },
  scaleFactor: number,
): { x: number; y: number; width: number; height: number } {
  const p = rectDipToPhysical(rect, scaleFactor);
  return {
    x: Math.trunc(p.x),
    y: Math.trunc(p.y),
    width: Math.max(0, Math.trunc(p.width)),
    height: Math.max(0, Math.trunc(p.height)),
  };
}

export function panelDipToPhysical(
  point: { x: number; y: number },
  scaleFactor: number,
): { x: number; y: number } {
  const s = assertScale(scaleFactor);
  return { x: point.x * s, y: point.y * s };
}

export function panelDipToPhysicalTrunc(
  point: { x: number; y: number },
  scaleFactor: number,
): { x: number; y: number } {
  const p = panelDipToPhysical(point, scaleFactor);
  return { x: Math.trunc(p.x), y: Math.trunc(p.y) };
}

/**
 * 薄包装：DIP 原点平移 only（对齐 native panelToScreen）。
 * 布局宿主本身不调 host.panelToScreen；仅附带 scaleFactor 供消费者。
 * 此 helper 供文档/单测证明「不 ×scale」。
 */
export function panelToScreenDip(
  point: { x: number; y: number },
  panel: { x: number; y: number },
): { x: number; y: number } {
  return { x: point.x + panel.x, y: point.y + panel.y };
}

export function screenToPanelDip(
  point: { x: number; y: number },
  panel: { x: number; y: number },
): { x: number; y: number } {
  return { x: point.x - panel.x, y: point.y - panel.y };
}

export function maxAbsDelta(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  return Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.width - b.width),
    Math.abs(a.height - b.height),
  );
}

/** 空列表 → 用 fallback 替换（永不对外返回 []） */
export function ensureNonEmptyDisplays(
  list: DisplayMetrics[],
  fallback: DisplayMetrics,
): DisplayMetrics[] {
  const clean = sanitizeDisplays(list);
  if (clean.length >= 1) return clean;
  return [sanitizeDisplay(fallback) ?? synthesizePrimaryDisplay(assertScale(fallback.scaleFactor), fallback.bounds)];
}

function readKbDisplays(kb: Record<string, unknown> | null | undefined): DisplayMetrics[] | null {
  if (!kb) return null;
  const tryCall = (name: string): unknown => {
    const fn = kb[name];
    if (typeof fn === 'function') {
      try {
        return (fn as () => unknown)();
      } catch {
        return null;
      }
    }
    return undefined;
  };
  // 同步桥优先；Promise 由 refreshAsync 处理
  for (const name of ['host.listDisplays', 'getDisplays', 'host.getDisplays', 'listDisplays']) {
    const v = tryCall(name);
    if (v !== undefined && v !== null && !(v instanceof Promise)) {
      const list = sanitizeDisplays(v);
      if (list.length) return list;
    }
  }
  // 直接挂数组
  for (const name of ['displays', '__displays']) {
    if (name in kb) {
      const list = sanitizeDisplays(kb[name]);
      if (list.length) return list;
    }
  }
  return null;
}

async function readKbDisplaysAsync(kb: Record<string, unknown> | null | undefined): Promise<DisplayMetrics[] | null> {
  if (!kb) return null;
  for (const name of ['host.listDisplays', 'getDisplays', 'host.getDisplays', 'listDisplays']) {
    const fn = kb[name];
    if (typeof fn !== 'function') continue;
    try {
      const v = await (fn as () => unknown)();
      const list = sanitizeDisplays(v);
      if (list.length) return list;
    } catch {
      /* try next */
    }
  }
  return readKbDisplays(kb);
}

export type DisplayListListener = (displays: DisplayMetrics[]) => void;

export interface DisplayListStoreOptions {
  /** 测试 / App 注入；优先于 kb */
  provider?: DisplayListProvider;
  /** kb 桥（window.kb） */
  kb?: Record<string, unknown> | null;
  /** 无桥且 provider 空时的合成 scale（默认 devicePixelRatio 或 1 — 仍非 96 DPI 常数） */
  fallbackScaleFactor?: number;
  /** 事件目标（默认 window） */
  eventTarget?: EventTarget | null;
}

export class DisplayListStore {
  private displays: DisplayMetrics[] = [];
  private provider: DisplayListProvider | null;
  private kb: Record<string, unknown> | null;
  private readonly fallbackScale: number;
  private readonly listeners = new Set<DisplayListListener>();
  private readonly eventTarget: EventTarget | null;
  private warnedEmpty = false;

  constructor(opts: DisplayListStoreOptions = {}) {
    this.provider = opts.provider ?? null;
    this.kb = opts.kb ?? null;
    const dpr =
      typeof window !== 'undefined' && typeof window.devicePixelRatio === 'number' && window.devicePixelRatio > 0
        ? window.devicePixelRatio
        : 1;
    this.fallbackScale = opts.fallbackScaleFactor && opts.fallbackScaleFactor > 0 ? opts.fallbackScaleFactor : dpr;
    this.eventTarget =
      opts.eventTarget !== undefined
        ? opts.eventTarget
        : typeof window !== 'undefined'
          ? window
          : null;
    // 同步初值：保证 getDisplays 立刻非空
    this.displays = [synthesizePrimaryDisplay(this.fallbackScale)];
    this.installGlobalHook();
  }

  private fallbackPrimary(): DisplayMetrics {
    return synthesizePrimaryDisplay(this.fallbackScale);
  }

  private installGlobalHook(): void {
    try {
      const g = (typeof window !== 'undefined' ? window : globalThis) as unknown as Record<string, unknown>;
      g[GET_DISPLAYS_HOOK] = () => this.getDisplays();
    } catch {
      /* */
    }
  }

  setProvider(provider: DisplayListProvider | null): void {
    this.provider = provider;
  }

  attachKb(kb: Record<string, unknown> | null | undefined): void {
    this.kb = kb ?? null;
  }

  /** 当前非空列表（拷贝） */
  getDisplays(): DisplayMetrics[] {
    return this.displays.map((d) => ({
      ...d,
      bounds: { ...d.bounds },
    }));
  }

  scaleFactorForPoint(x: number, y: number): number {
    return scaleFactorForPoint(x, y, this.displays);
  }

  scaleFactorForPanel(bounds: { x: number; y: number; w?: number; h?: number; width?: number; height?: number }): number {
    return scaleFactorForPanel(bounds, this.displays);
  }

  subscribe(fn: DisplayListListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * 用已知列表替换（测试 / 注入）。空数组 → 替换为 fallback，并可选记警告。
   * 返回对外可见的非空列表。
   */
  setDisplays(list: DisplayMetrics[], opts?: { allowEmptyReplace?: boolean }): DisplayMetrics[] {
    const next = ensureNonEmptyDisplays(list, this.fallbackPrimary());
    if (!list.length && !this.warnedEmpty) {
      this.warnedEmpty = true;
      try {
        console.warn(
          '[chrome-layout][L2] display provider returned []; replaced with synthetic primary scaleFactor=',
          next[0]!.scaleFactor,
        );
      } catch {
        /* */
      }
    }
    const changed =
      next.length !== this.displays.length ||
      JSON.stringify(next) !== JSON.stringify(this.displays);
    this.displays = next;
    if (changed) this.emitChanged();
    void opts;
    return this.getDisplays();
  }

  /** 同步刷新：provider → kb → 保持/fallback */
  refresh(): DisplayMetrics[] {
    if (this.provider) {
      const raw = this.provider();
      if (!(raw instanceof Promise)) {
        return this.setDisplays(sanitizeDisplays(raw));
      }
      // provider 异步：先用 kb / 现有，再背景更新
      void raw.then((list) => this.setDisplays(sanitizeDisplays(list)));
    }
    const fromKb = readKbDisplays(this.kb);
    if (fromKb && fromKb.length) return this.setDisplays(fromKb);
    if (!this.displays.length) return this.setDisplays([]);
    return this.getDisplays();
  }

  async refreshAsync(): Promise<DisplayMetrics[]> {
    if (this.provider) {
      const raw = await this.provider();
      return this.setDisplays(sanitizeDisplays(raw));
    }
    const fromKb = await readKbDisplaysAsync(this.kb);
    if (fromKb && fromKb.length) return this.setDisplays(fromKb);
    return this.setDisplays(this.displays.length ? this.displays : []);
  }

  private emitChanged(): void {
    const payload: LayoutDisplaysChangedPayload = { displays: this.getDisplays() };
    for (const fn of this.listeners) fn(payload.displays);
    try {
      const g = (typeof window !== 'undefined' ? window : globalThis) as unknown as {
        dispatchEvent?: (e: Event) => void;
        CustomEvent?: typeof CustomEvent;
      };
      const CE = g.CustomEvent ?? (typeof CustomEvent !== 'undefined' ? CustomEvent : undefined);
      const target = this.eventTarget ?? (typeof g.dispatchEvent === 'function' ? (g as unknown as EventTarget) : null);
      if (CE && target && typeof target.dispatchEvent === 'function') {
        target.dispatchEvent(new CE(LAYOUT_DISPLAYS_CHANGED_EVENT, { detail: payload }));
      }
    } catch {
      /* */
    }
  }
}

let singleton: DisplayListStore | null = null;

export function getDisplayListStore(): DisplayListStore {
  if (!singleton) singleton = new DisplayListStore();
  return singleton;
}

export function resetDisplayListStoreForTests(store?: DisplayListStore | null): void {
  singleton = store === undefined ? null : store;
}

/**
 * 若布局侧找到面板 DOM，写入 data-scale-factor（与 setBounds 同源）。
 * 面板 DOM 多由插件拥有；找不到则 no-op。
 */
export function applyPanelScaleFactorAttr(panelId: string, scaleFactor: number, root?: ParentNode | null): void {
  const s = assertScale(scaleFactor);
  const doc =
    root ?? (typeof document !== 'undefined' ? document : null);
  if (!doc || typeof (doc as Document).querySelector !== 'function') return;
  const sels = [
    `[data-panel-id="${CSS.escape?.(panelId) ?? panelId}"]`,
    `[data-native-panel-id="${CSS.escape?.(panelId) ?? panelId}"]`,
    `[data-testid="native-panel-${panelId}"]`,
  ];
  for (const sel of sels) {
    try {
      const el = (doc as Document).querySelector(sel) as HTMLElement | null;
      if (el) {
        el.setAttribute('data-scale-factor', String(s));
        return;
      }
    } catch {
      /* invalid selector */
    }
  }
}
