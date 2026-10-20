import { normalizeDrawerSelection, type DrawerModuleId } from '../renderer/drawer/order';
export type DrawerColumn = { modules: DrawerModuleId[]; width: number };
export type Columns = { v: 1; cols: DrawerColumn[] };
export const COLUMN_DEFAULT = 360;
export const clampColumnWidth = (n: number) => Number.isFinite(n) ? Math.max(240, n) : COLUMN_DEFAULT;
export function parseColumns(raw: unknown, legacy: unknown = []): Columns {
  const value = raw as Partial<Columns> | null;
  const source = value?.v === 1 && Array.isArray(value.cols) ? value.cols : [{ modules: Array.isArray(legacy) ? legacy : [], width: COLUMN_DEFAULT }];
  const seen = new Set<DrawerModuleId>();
  const cols: DrawerColumn[] = [];
  for (const col of source) {
    if (!col || !Array.isArray(col.modules)) continue;
    const modules = normalizeDrawerSelection(col.modules).filter(id => !seen.has(id));
    modules.forEach(id => seen.add(id));
    if (cols.length < 3) cols.push({ modules, width: clampColumnWidth(col.width) });
    else cols[2].modules.push(...modules);
  }
  return { v: 1, cols: cols.length ? cols : [{ modules: [], width: COLUMN_DEFAULT }] };
}
export function moveModule(layout: Columns, id: DrawerModuleId, target: number): Columns {
  if (target < 0 || target > layout.cols.length || target >= 3) return layout;
  const cols = layout.cols.map(c => ({ ...c, modules: c.modules.filter(m => m !== id) }));
  if (target === cols.length) cols.push({ modules: [], width: COLUMN_DEFAULT });
  cols[target].modules.push(id);
  return { v: 1, cols: cols.filter(c => c.modules.length) };
}
export function visibleColumnWidths(cols: DrawerColumn[], viewport: number, reserve = 480): number[] {
  const widths = cols.map(c => clampColumnWidth(c.width));
  for (let i = widths.length - 1; i >= 0 && widths.reduce((a,b) => a+b,0) > viewport - reserve; i--) widths[i] = 44;
  return widths;
}
export type Rect = { x: number; y: number; width: number; height: number };
export type Restore = Rect & { maximized: boolean; displayId: number };
export type Display = { id: number; workArea: Rect };
export function fitBounds(rect: Rect, area: Rect): Rect {
  if (rect.width > 0 && rect.height > 0 && rect.x >= area.x && rect.y >= area.y && rect.x+rect.width <= area.x+area.width && rect.y+rect.height <= area.y+area.height) return {x:rect.x,y:rect.y,width:rect.width,height:rect.height};
  const width = Math.min(area.width, Math.max(260, rect.width));
  const height = Math.min(area.height, Math.max(100, rect.height));
  return { width, height, x: Math.max(area.x, Math.min(rect.x, area.x + area.width - width)), y: Math.max(area.y, Math.min(rect.y, area.y + area.height - height)) };
}
export function enterBounds(start: Rect, area: Rect, width = 360, maximized = false, saved?: Rect): Rect {
  return fitBounds(saved ?? { ...start, width, ...(maximized ? { y: area.y, height: area.height } : {}) }, area);
}
export function exitBounds(restore: Restore, displays: Display[], primary: Display): Rect {
  const display = displays.find(d => d.id === restore.displayId);
  if (display) return fitBounds(restore, display.workArea);
  const area = primary.workArea;
  const fitted = fitBounds(restore, area);
  return { ...fitted, x: Math.round(area.x + (area.width-fitted.width)/2), y: Math.round(area.y+(area.height-fitted.height)/2) };
}
export const motionDuration = (reduceMotion: boolean, system: boolean, resize = false) => reduceMotion || system ? 0 : resize ? 160 : 200;
/** Solve x(t) before evaluating y(t): CSS cubic-bezier(.2,0,0,1). */
export function sidebarEase(progress: number): number {
  let lo = 0, hi = 1;
  for (let i=0;i<18;i++) { const t=(lo+hi)/2; const x=.6*t*(1-t)*(1-t)+t*t*t; if(x<progress) lo=t; else hi=t; }
  const t=(lo+hi)/2; return 3*t*t-2*t*t*t;
}

/** Mouse buttons map to zero-based physical column positions. */
export function columnForButton(button: number): number | null {
  return button === 0 ? 0 : button === 2 ? 1 : button === 1 ? 2 : null;
}
export function applyModuleClick(layout: Columns, id: DrawerModuleId, button: number): Columns {
  const requested = columnForButton(button);
  if (requested === null) return layout;
  const target = Math.min(requested, layout.cols.length, 2);
  if (layout.cols[target]?.modules.includes(id)) {
    return { v: 1, cols: layout.cols.map(c => ({ ...c, modules: c.modules.filter(m => m !== id) })).filter(c => c.modules.length) };
  }
  return moveModule(layout, id, target);
}

/**
 * Sidebar auto-size. Grow toward the column sum, never toward a read-back.
 * A difference within `tolerance` is DPI noise: do not resize and do not widen a saved column.
 */
export function planSidebarAutoWidth(
  columnWidths: number[],
  windowWidth: number,
  options?: { availWidth?: number; maximized?: boolean; tolerance?: number },
): { resizeTo?: number; widths: number[] } {
  const tolerance = options?.tolerance ?? 3;
  const widths = columnWidths.slice();
  const sum = widths.reduce((a, b) => a + b, 0);
  const avail = options?.availWidth ?? Number.POSITIVE_INFINITY;
  if (sum - windowWidth > tolerance && windowWidth < avail - 4) return { resizeTo: sum, widths };
  if (!options?.maximized && windowWidth - sum > tolerance && widths.length) {
    const next = widths.slice();
    next[next.length - 1] += windowWidth - sum;
    return { widths: next };
  }
  return { widths };
}

/** Preserve requested widths; grow first, then proportionally shrink above the minimum. */
export function planColumnWidths(input: number[], windowWidth: number, workAreaWidth: number) {
  const widths = input.map(clampColumnWidth);
  const sum = widths.reduce((a,b)=>a+b,0);
  const limit = Math.max(1, workAreaWidth);
  const target = Math.min(limit, Math.max(windowWidth, sum));
  if (sum <= target) {
    if (widths.length) widths[widths.length-1] += target-sum;
    return {windowWidth:target, widths, scroll:false};
  }
  if (target < widths.length*240) return {windowWidth:target, widths:widths.map(()=>240), scroll:true};
  const extra = sum-widths.length*240;
  return {windowWidth:target, widths:widths.map(w=>240+(w-240)*(target-widths.length*240)/extra), scroll:false};
}

export type MainColumnPlan = { widths: number[]; readerWidth: number; scroll: boolean };

/**
 * Width shared by main-mode columns and the reader.
 * `mainClientWidth` is `.main`'s clientWidth (padding included). Horizontal shell inset
 * sits outside that pair, so it is subtracted. Before the shell is measured, use the window width.
 */
export function mainColumnViewport(measured: {
  windowWidth: number;
  mainClientWidth?: number;
  paddingLeft?: number;
  paddingRight?: number;
}): number {
  const windowWidth = Number.isFinite(measured.windowWidth) ? measured.windowWidth : 0;
  if (!Number.isFinite(measured.mainClientWidth)) return windowWidth;
  const pad = (Number.isFinite(measured.paddingLeft) ? measured.paddingLeft! : 0)
    + (Number.isFinite(measured.paddingRight) ? measured.paddingRight! : 0);
  return Math.max(0, measured.mainClientWidth! - pad);
}

/** Integer pixels that sum to `budget`. The leftover pixel goes to the last column. */
function packAboveFloor(widths: number[], budget: number, colMin: number): number[] {
  const cap = Math.floor(budget + 1e-9);
  const room = cap - widths.length * colMin;
  const extras = widths.map(width => Math.max(0, width - colMin));
  const extraSum = extras.reduce((total, extra) => total + extra, 0);
  if (room <= 0 || extraSum <= 1e-9) return widths.map(() => colMin);
  const packed: number[] = [];
  let used = 0;
  for (let i = 0; i < widths.length; i++) {
    if (i === widths.length - 1) {
      packed.push(colMin + (room - used));
      break;
    }
    const share = Math.min(room - used, Math.floor(extras[i] * room / extraSum + 1e-9));
    used += share;
    packed.push(colMin + share);
  }
  return packed;
}

/**
 * Full-window columns. Keep saved widths when the reader still has room.
 * Otherwise hold the reader at readerMin and compress only the part of each column above colMin.
 * If every column is already at colMin, scroll the column strip and leave the reader at readerMin.
 * A user-collapsed ribbon stays 44px and is not part of the compression.
 * Display widths are whole pixels and, unless the strip scrolls, their sum stays inside the viewport.
 */
export function planMainColumns(
  colWidths: number[],
  viewport: number,
  options?: { readerMin?: number; colMin?: number; ribbonCollapsed?: boolean },
): MainColumnPlan {
  const readerMin = options?.readerMin ?? 360;
  const colMin = options?.colMin ?? 240;
  const view = Number.isFinite(viewport) ? viewport : 0;
  const ribbon = !!options?.ribbonCollapsed && colWidths.length > 0;
  const normalized = colWidths.map((width, index) => {
    if (ribbon && index === 0) return 44;
    const value = Number.isFinite(width) ? width : COLUMN_DEFAULT;
    return Math.max(colMin, value);
  });
  const sum = normalized.reduce((total, width) => total + width, 0);
  const flexIndex = normalized.map((_, index) => index).filter(index => !(ribbon && index === 0));
  const paint = (flexWidths: number[], scroll: boolean): MainColumnPlan => {
    const widths = normalized.map((_, index) => (ribbon && index === 0 ? 44 : flexWidths[flexIndex.indexOf(index)]));
    const used = widths.reduce((total, width) => total + width, 0);
    return { widths, readerWidth: scroll ? readerMin : view - used, scroll };
  };
  if (view - sum >= readerMin - 1e-6) {
    return paint(flexIndex.map(index => Math.floor(normalized[index] + 1e-9)), false);
  }
  const fixed = ribbon ? 44 : 0;
  const budget = Math.floor(view - readerMin - fixed + 1e-9);
  if (!flexIndex.length || budget < flexIndex.length * colMin) {
    return paint(flexIndex.map(() => colMin), true);
  }
  return paint(packAboveFloor(flexIndex.map(index => normalized[index]), budget, colMin), false);
}

/**
 * Drag cap for one main-mode column.
 * Never below colMin. Never past the integer width that still leaves readerMin.
 * When the saved width is already past that cap, only a smaller drag is kept.
 */
export function clampMainDragWidth(
  requested: number,
  current: number,
  otherFootprint: number,
  viewport: number,
  readerMin = 360,
  colMin = 240,
): number {
  const cur = Number.isFinite(current) ? current : colMin;
  const raw = Number.isFinite(requested) ? requested : cur;
  const limit = viewport - readerMin - otherFootprint;
  const cap = Number.isFinite(limit) ? Math.floor(limit + 1e-9) : limit;
  const next = Math.max(colMin, raw);
  if (cap >= colMin) {
    if (next <= cap) return next;
    if (cur > cap) return raw < cur ? next : cur;
    return cap;
  }
  if (raw >= cur) return Math.max(colMin, cur);
  return Math.max(colMin, Math.min(next, cur));
}
