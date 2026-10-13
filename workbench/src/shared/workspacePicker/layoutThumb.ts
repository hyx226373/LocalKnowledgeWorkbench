/**
 * 布局缩略图几何（纯函数）。不读盘、不截图。
 * 分屏方向与 dockview 一致：根用 grid.orientation，每进一层分支取正交方向。
 * cacheKey = sha256(稳定字符串化 { layout, 节点 id/rect/flags/kind, thumbVersion })，不含选中态。
 */
import { createHash } from 'node:crypto';
import type { GridNode } from '../items';
import { clipCodePoints } from './normalize';
import type { LayoutThumbModel, LayoutThumbNode, ThumbItem, ThumbLayout, ThumbWindows } from './types';

const SIDEBAR_ID = 'kb.sidebar';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Collected {
  id: string;
  rect: Rect;
  hidden: boolean;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function clampRect(r: Rect): Rect {
  return { x: clamp01(r.x), y: clamp01(r.y), w: clamp01(r.w), h: clamp01(r.h) };
}

function orthogonal(orientation: 'HORIZONTAL' | 'VERTICAL'): 'HORIZONTAL' | 'VERTICAL' {
  return orientation === 'HORIZONTAL' ? 'VERTICAL' : 'HORIZONTAL';
}

function childSize(node: GridNode): number {
  const s = node.size;
  return typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : 0;
}

function pushView(id: unknown, rect: Rect, active: unknown, out: Collected[]) {
  if (typeof id !== 'string' || !id) return;
  const hidden = typeof active === 'string' && active !== '' && id !== active;
  out.push({ id, rect, hidden });
}

/** 收起后面板在 floatingGroups 里，不在 grid.root。缩略图也要收进来。 */
function collectFloats(dock: ThumbLayout['dock'], out: Collected[]) {
  const groups = (dock as unknown as { floatingGroups?: unknown } | null | undefined)?.floatingGroups;
  const list = Array.isArray(groups) ? groups : [];
  const grid = dock?.grid;
  const vw = grid && typeof grid.width === 'number' && grid.width > 0 ? grid.width : 0;
  const vh = grid && typeof grid.height === 'number' && grid.height > 0 ? grid.height : 0;
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const g = raw as {
      data?: { views?: unknown; activeView?: unknown };
      grid?: { root?: GridNode; orientation?: string };
      position?: { left?: number; top?: number; width?: number; height?: number };
    };
    const pos = g.position;
    const rect: Rect =
      vw > 0 && vh > 0 && pos && [pos.left, pos.top, pos.width, pos.height].every((n) => typeof n === 'number' && Number.isFinite(n))
        ? { x: (pos.left as number) / vw, y: (pos.top as number) / vh, w: (pos.width as number) / vw, h: (pos.height as number) / vh }
        : { x: 0, y: 0, w: 0.3, h: 0.3 };
    if (g.data && Array.isArray(g.data.views)) {
      for (const id of g.data.views) pushView(id, rect, g.data.activeView, out);
      continue;
    }
    if (g.grid?.root) {
      const orientation = g.grid.orientation === 'VERTICAL' ? 'VERTICAL' : 'HORIZONTAL';
      collect(g.grid.root, rect, orientation, out);
    }
  }
}

function collect(node: GridNode, rect: Rect, orientation: 'HORIZONTAL' | 'VERTICAL', out: Collected[]) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'leaf') {
    const views = Array.isArray(node.data?.views) ? node.data.views : [];
    const active = node.data?.activeView;
    for (const id of views) {
      if (typeof id !== 'string' || !id) continue;
      const hidden = typeof active === 'string' && active !== '' && id !== active;
      out.push({ id, rect, hidden });
    }
    return;
  }
  if (node.type !== 'branch') return;
  const kids = Array.isArray(node.data) ? node.data : [];
  if (!kids.length) return;
  const sizes = kids.map(childSize);
  const sum = sizes.reduce((a, b) => a + b, 0);
  const next = orthogonal(orientation);
  let cursor = 0;
  for (let i = 0; i < kids.length; i++) {
    const frac = sum > 0 ? sizes[i]! / sum : 1 / kids.length;
    const child: Rect =
      orientation === 'HORIZONTAL'
        ? { x: rect.x + rect.w * cursor, y: rect.y, w: rect.w * frac, h: rect.h }
        : { x: rect.x, y: rect.y + rect.h * cursor, w: rect.w, h: rect.h * frac };
    cursor += frac;
    const kid = kids[i];
    if (kid) collect(kid, child, next, out);
  }
}

function bubble(seq: number): Rect {
  const n = Number.isFinite(seq) ? Math.trunc(seq) : 0;
  return { x: 0.02 + (n % 8) * 0.08, y: 0.9, w: 0.06, h: 0.08 };
}

function aspectOf(layout: ThumbLayout | null): number {
  const grid = layout?.dock?.grid;
  if (grid && typeof grid.width === 'number' && typeof grid.height === 'number' && grid.width > 0 && grid.height > 0) {
    return grid.width / grid.height;
  }
  const vp = layout?.windows?.viewport;
  if (vp && typeof vp.width === 'number' && typeof vp.height === 'number' && vp.width > 0 && vp.height > 0) {
    return vp.width / vp.height;
  }
  return 16 / 9;
}

function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (t === 'string' || t === 'boolean') return JSON.stringify(value);
  if (t !== 'object') return 'null';
  if (Array.isArray(value)) return `[${value.map((x) => stableStringify(x)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function shortNameOf(title: unknown, panelTitle: unknown): string {
  const fromItem = typeof title === 'string' ? title.trim() : '';
  const fromPanel = typeof panelTitle === 'string' ? panelTitle.trim() : '';
  const raw = fromItem || fromPanel;
  return raw ? clipCodePoints(raw, 8) : '未命名';
}

function isMaximized(windows: ThumbWindows | null | undefined, id: string): boolean {
  if (windows?.gridMaximized === id) return true;
  const f = windows?.floats?.[id];
  return !!f && typeof f === 'object' && f.maximized != null;
}

function collapsedSeq(windows: ThumbWindows | null | undefined, id: string): number | null {
  const c = windows?.collapsed?.[id];
  if (c == null) return null;
  if (typeof c === 'object' && typeof c.seq === 'number' && Number.isFinite(c.seq)) return c.seq;
  return 0;
}

export function layoutThumbModel(input: {
  layout: ThumbLayout | null;
  items?: readonly ThumbItem[];
  thumbVersion?: number;
}): LayoutThumbModel {
  const layout = input.layout ?? null;
  const ver = typeof input.thumbVersion === 'number' && Number.isFinite(input.thumbVersion) ? input.thumbVersion : 0;
  const items = new Map<string, ThumbItem>();
  for (const it of input.items ?? []) {
    if (it && typeof it.itemId === 'string' && !items.has(it.itemId)) items.set(it.itemId, it);
  }
  const windows = layout?.windows ?? null;
  const panels = layout?.dock?.panels ?? {};
  const grid = layout?.dock?.grid;
  const collected: Collected[] = [];
  if (grid?.root) {
    const orientation = grid.orientation === 'VERTICAL' ? 'VERTICAL' : 'HORIZONTAL';
    collect(grid.root, { x: 0, y: 0, w: 1, h: 1 }, orientation, collected);
  }
  collectFloats(layout?.dock, collected);
  const seen = new Set<string>();
  const nodes: LayoutThumbNode[] = [];
  for (const c of collected) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    const panel = panels[c.id];
    if (c.id === SIDEBAR_ID || panel?.contentComponent === SIDEBAR_ID) continue;
    const params = panel?.params;
    const viewType = params && typeof params.viewType === 'string' ? params.viewType : undefined;
    const itemId = params && typeof params.itemId === 'string' ? params.itemId : c.id;
    const item = items.get(itemId);
    let kind: LayoutThumbNode['kind'] = 'unknown';
    let unknown = true;
    const cc = panel?.contentComponent;
    // dockview 缺 contentComponent 时写成 "unknown"。已知条目仍按 file/web/app 画。
    const treatAsView = cc == null || cc === '' || cc === 'view' || cc === 'unknown';
    if (viewType === 'native-app-host') {
      kind = 'native-host';
      unknown = false;
    } else if (treatAsView && item?.adapterKnown !== false && (item?.sourceKind === 'file' || item?.sourceKind === 'web' || item?.sourceKind === 'app')) {
      kind = item.sourceKind;
      unknown = false;
    }
    const iconKey = unknown ? 'unknown' : kind === 'native-host' ? 'native' : item?.iconKey ? item.iconKey : kind;
    const maximized = isMaximized(windows, c.id);
    const seq = collapsedSeq(windows, c.id);
    const collapsed = seq !== null;
    let rect = c.rect;
    if (maximized) rect = { x: 0, y: 0, w: 1, h: 1 };
    else if (collapsed) rect = bubble(seq);
    const flags: LayoutThumbNode['flags'] = {};
    if (c.hidden) flags.hidden = true;
    if (collapsed) flags.collapsed = true;
    if (maximized) flags.maximized = true;
    nodes.push({
      id: c.id,
      rect: clampRect(rect),
      kind,
      iconKey,
      shortName: shortNameOf(item?.title, panel?.title),
      flags,
      unknown,
    });
  }
  nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const cacheKey = createHash('sha256')
    .update(
      stableStringify({
        layout,
        geometry: nodes.map((n) => ({ id: n.id, rect: n.rect, flags: n.flags, kind: n.kind })),
        thumbVersion: ver,
      }),
    )
    .digest('hex');
  return { cacheKey, aspect: aspectOf(layout), nodes };
}
