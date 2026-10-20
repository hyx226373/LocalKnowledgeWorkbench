/**
 * L2 chrome / display sync for native-app-host (HOST-REPORT-0031 ①).
 * Consumes layout displays + contentBounds.scaleFactor; never calls host.setBounds/setVisible/activate.
 */

export interface DisplayMetrics {
  id?: number;
  bounds: { x: number; y: number; width: number; height: number };
  /** Must be > 0; never hard-code 96 DPI. */
  scaleFactor: number;
}

export interface ContentBoundsDip {
  x: number;
  y: number;
  w: number;
  h: number;
  scaleFactor?: number;
}

/** Last non-empty list from layout.displaysChanged (module cache). */
let cachedDisplays: DisplayMetrics[] | null = null;

export function cacheDisplaysFromLayout(displays: DisplayMetrics[]): void {
  if (Array.isArray(displays) && displays.length > 0) {
    cachedDisplays = displays.map((d) => ({
      id: d.id,
      bounds: { ...d.bounds },
      scaleFactor: d.scaleFactor,
    }));
  }
}

export function getCachedDisplays(): DisplayMetrics[] | null {
  return cachedDisplays ? cachedDisplays.map((d) => ({ ...d, bounds: { ...d.bounds } })) : null;
}

/** Test helper: clear cache between cases. */
export function resetDisplayCacheForTests(): void {
  cachedDisplays = null;
}

function synthesizePrimary(scaleHint?: number): DisplayMetrics[] {
  let scale = 1;
  if (typeof scaleHint === 'number' && scaleHint > 0) {
    scale = scaleHint;
  } else {
    const dpr = (globalThis as { devicePixelRatio?: number }).devicePixelRatio;
    if (typeof dpr === 'number' && dpr > 0) scale = dpr;
  }
  return [
    {
      id: 0,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      scaleFactor: scale,
    },
  ];
}

function readKbGetDisplays(): DisplayMetrics[] | null {
  const w = (globalThis as { window?: { __kbGetDisplays?: () => DisplayMetrics[] } }).window;
  const fn = w?.__kbGetDisplays;
  if (typeof fn !== 'function') return null;
  try {
    const list = fn();
    if (Array.isArray(list) && list.length > 0) return list;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Resolve a non-empty display list.
 * Order: optional override → __kbGetDisplays → displaysChanged cache → synthesize.
 * **Never returns [].**
 */
export function resolveDisplays(optional?: {
  displays?: DisplayMetrics[];
  scaleHint?: number;
}): DisplayMetrics[] {
  if (optional?.displays && optional.displays.length > 0) {
    return optional.displays;
  }
  const fromApi = readKbGetDisplays();
  if (fromApi) return fromApi;
  const cached = getCachedDisplays();
  if (cached && cached.length > 0) return cached;
  return synthesizePrimary(optional?.scaleHint);
}

export function scaleFactorForPanel(
  displays: DisplayMetrics[],
  bounds?: ContentBoundsDip | null,
): number {
  if (bounds && typeof bounds.scaleFactor === 'number' && bounds.scaleFactor > 0) {
    return bounds.scaleFactor;
  }
  if (!displays.length) return 1;
  if (!bounds) return displays[0]!.scaleFactor;
  const cx = bounds.x + bounds.w / 2;
  const cy = bounds.y + bounds.h / 2;
  for (const d of displays) {
    const b = d.bounds;
    if (cx >= b.x && cx < b.x + b.width && cy >= b.y && cy < b.y + b.height) {
      return d.scaleFactor > 0 ? d.scaleFactor : 1;
    }
  }
  let best = displays[0]!;
  let bestDist = Infinity;
  for (const d of displays) {
    const b = d.bounds;
    const dx = cx - (b.x + b.width / 2);
    const dy = cy - (b.y + b.height / 2);
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  return best.scaleFactor > 0 ? best.scaleFactor : 1;
}

export type HostPanelLayoutSyncResult =
  | { ok: true; scaleFactor: number; displaysUsed: number }
  | { ok: false; code: 'EMPTY_DISPLAYS'; message: string };

function findPanelRoot(panelId: string): Element | null {
  if (typeof document === 'undefined') return null;
  const nodes = document.querySelectorAll('[data-panel-id]');
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i]!;
    if (el.getAttribute('data-panel-id') === panelId) return el;
  }
  return document.querySelector('[data-testid="view-native-app-host"]');
}

/**
 * Sync panel DOM scale attribute from real displays.
 * Rejects explicit empty `displays: []` — never silent scale=1.
 * Does NOT call host.setBounds / setVisible / activate.
 */
export function hostPanelLayoutSync(opts: {
  panelId: string;
  bounds?: ContentBoundsDip | null;
  /** If provided and empty → error. Omit to use resolveDisplays(). */
  displays?: DisplayMetrics[];
  root?: Element | null;
}): HostPanelLayoutSyncResult {
  if (opts.displays !== undefined && opts.displays.length === 0) {
    return {
      ok: false,
      code: 'EMPTY_DISPLAYS',
      message:
        'hostPanelLayoutSync: displays must not be empty (use resolveDisplays / __kbGetDisplays)',
    };
  }
  const displays = resolveDisplays({
    displays: opts.displays,
    scaleHint: opts.bounds?.scaleFactor,
  });
  if (displays.length === 0) {
    return { ok: false, code: 'EMPTY_DISPLAYS', message: 'resolveDisplays returned empty' };
  }
  const scaleFactor = scaleFactorForPanel(displays, opts.bounds ?? null);
  const root = opts.root ?? (typeof document !== 'undefined' ? findPanelRoot(opts.panelId) : null);
  if (root && typeof (root as HTMLElement).setAttribute === 'function') {
    (root as HTMLElement).setAttribute('data-scale-factor', String(scaleFactor));
  }
  return { ok: true, scaleFactor, displaysUsed: displays.length };
}

/** HOST-REPORT-0031 ② — native content visibility attribute. */
export function nativeVisibleAttr(opts: { bound: boolean; occluded: boolean }): 'true' | 'false' {
  return opts.bound && !opts.occluded ? 'true' : 'false';
}

/** When native visible, placeholder must not steal hits. */
export function placeholderBlocksPointer(opts: { nativeVisible: boolean }): boolean {
  return !opts.nativeVisible;
}
