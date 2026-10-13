/**
 * layout.windows 的序列化 / 反序列化 / 迁移（纯函数，可单测）。
 *  - 缺失（第八轮及更早保存的工作区）→ 版本 0：全部面板按 dock JSON 原样（停靠/浮动），侧栏停靠，无气泡，层级按 dock JSON 中浮动组的顺序。
 *  - v1：当前格式。
 *  - 更新的版本（v > 1）：读取能识别的字段（向前兼容约定：新版本只加字段，不改已有字段含义），未知字段丢弃。
 * 净化：只保留合法 id、有限数字与已知枚举；超过 MAX_WINDOWS_BYTES 则只保留侧栏状态。
 */
import { normBox } from './geometry';
import { MAX_WINDOWS_BYTES, PANEL_LAYOUT_VERSION, SIDEBAR_ID, type Box, type CollapsedInfo, type DockDirection, type FloatMeta, type PanelLayoutV1, type SidebarWindowState } from './types';

const ID = /^[\w.|:-]{1,200}$/;
const DIRS: DockDirection[] = ['left', 'right', 'above', 'below', 'within'];
const KINDS = ['file', 'web', 'app', 'native-host', 'sidebar', 'unknown'] as const;
const ZERO: Box = { left: 0, top: 0, width: 480, height: 360 };

/** 气泡标题：去掉控制字符；拒绝路径、URL 和占位词 unknown。 */
function cleanTitle(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let t = '';
  for (const ch of raw) {
    const c = ch.charCodeAt(0);
    if (c <= 0x1f || c === 0x7f) continue;
    t += ch;
  }
  t = t.trim();
  if (!t || t === 'unknown') return undefined;
  if (t.includes('\\') || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return undefined;
  return t.slice(0, 200);
}

export function defaultPanelLayout(viewport = { width: 0, height: 0 }): PanelLayoutV1 {
  return { v: PANEL_LAYOUT_VERSION, viewport: { ...viewport }, order: [], collapsed: {}, floats: {}, sidebar: { mode: 'docked' } };
}

function box(raw: unknown): Box | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const b = raw as Record<string, unknown>;
  if (![b.left, b.top, b.width, b.height].every((v) => typeof v === 'number' && Number.isFinite(v))) return undefined;
  if ((b.width as number) <= 0 || (b.height as number) <= 0) return undefined;
  return normBox(b as Partial<Box>, ZERO);
}

function collapsed(raw: unknown, sidebar = false): CollapsedInfo | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const c = raw as Record<string, unknown>;
  const title = cleanTitle(c.title);
  const kind = (KINDS as readonly string[]).includes(c.kind as string) ? (c.kind as CollapsedInfo['kind']) : undefined;
  const seq = typeof c.seq === 'number' && Number.isFinite(c.seq) ? Math.round(c.seq) : undefined;
  const dockRef = typeof c.dockRef === 'string' && ID.test(c.dockRef) ? c.dockRef : undefined;
  const dockDir = DIRS.includes(c.dockDir as DockDirection) ? (c.dockDir as DockDirection) : undefined;
  const bounds = box(c.bounds);
  let from: CollapsedInfo['from'] | undefined;
  if (sidebar) {
    if (c.from === 'sidebar-docked' || c.from === 'floating') from = c.from;
  } else if (c.from === 'grid' || c.from === 'floating') from = c.from;
  // 旧布局可能没有合法 from，但标题、类型或位置还在：补一个 from，让气泡至少能打开。
  const recoverable = !!title || !!kind || seq !== undefined || !!bounds || !!dockRef || !!dockDir;
  if (!from) {
    if (!recoverable) return undefined;
    from = sidebar ? 'sidebar-docked' : dockRef || dockDir ? 'grid' : 'floating';
  }
  const trayRaw = c.tray && typeof c.tray === 'object' ? (c.tray as Record<string, unknown>) : null;
  const trayLeft = trayRaw && typeof trayRaw.left === 'number' && Number.isFinite(trayRaw.left) ? trayRaw.left : undefined;
  const trayTop = trayRaw && typeof trayRaw.top === 'number' && Number.isFinite(trayRaw.top) ? trayRaw.top : undefined;
  const out: CollapsedInfo = { from, seq: seq ?? 0 };
  if (dockRef) out.dockRef = dockRef;
  if (dockDir) out.dockDir = dockDir;
  if (bounds) out.bounds = bounds;
  if (title) out.title = title;
  if (kind) out.kind = kind;
  if (trayLeft !== undefined && trayTop !== undefined) out.tray = { left: trayLeft, top: trayTop };
  return out;
}

function sidebarState(raw: unknown): SidebarWindowState {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: SidebarWindowState = { mode: s.mode === 'floating' ? 'floating' : 'docked' };
  const b = box(s.bounds);
  if (b) out.bounds = b;
  const c = collapsed(s.collapsed, true);
  if (c) out.collapsed = c;
  const m = s.maximized as Record<string, unknown> | undefined;
  const mr = m && box(m.restore);
  if (mr && out.mode === 'floating' && !out.collapsed) out.maximized = { restore: mr, from: m!.from === 'docked' ? 'docked' : 'floating' };
  return out;
}

export type MigrateWindowsResult = { layout: PanelLayoutV1; from: number; dropped?: string };

/** 任意输入 → v1。不会抛异常。 */
export function migratePanelLayout(raw: unknown): MigrateWindowsResult {
  if (raw === undefined || raw === null) return { layout: defaultPanelLayout(), from: 0 };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { layout: defaultPanelLayout(), from: 0, dropped: 'invalid' };
  const r = raw as Record<string, unknown>;
  const v = typeof r.v === 'number' && Number.isInteger(r.v) && r.v >= 1 ? r.v : 0;
  if (v === 0) return { layout: defaultPanelLayout(), from: 0, dropped: 'no-version' };
  const vp = r.viewport as Record<string, unknown> | undefined;
  const out: PanelLayoutV1 = defaultPanelLayout({
    width: typeof vp?.width === 'number' && Number.isFinite(vp.width) ? Math.max(0, Math.round(vp.width)) : 0,
    height: typeof vp?.height === 'number' && Number.isFinite(vp.height) ? Math.max(0, Math.round(vp.height)) : 0,
  });
  if (Array.isArray(r.order)) out.order = [...new Set(r.order.filter((x): x is string => typeof x === 'string' && ID.test(x)))].slice(0, 500);
  if (r.collapsed && typeof r.collapsed === 'object')
    for (const [k, c] of Object.entries(r.collapsed as Record<string, unknown>).slice(0, 500)) {
      if (!ID.test(k) || k === SIDEBAR_ID) continue;
      const ci = collapsed(c);
      if (ci) out.collapsed[k] = ci;
    }
  if (r.floats && typeof r.floats === 'object')
    for (const [k, f] of Object.entries(r.floats as Record<string, unknown>).slice(0, 500)) {
      if (!ID.test(k)) continue;
      const m = (f as Record<string, unknown> | null)?.maximized as Record<string, unknown> | undefined;
      const restore = m && box(m.restore);
      const fm: FloatMeta = {};
      if (restore) fm.maximized = { restore };
      if (fm.maximized) out.floats[k] = fm;
    }
  if (typeof r.gridMaximized === 'string' && ID.test(r.gridMaximized)) out.gridMaximized = r.gridMaximized;
  out.sidebar = sidebarState(r.sidebar);
  return { layout: sanitizeSize(out), from: v };
}

/** 超过上限（异常情况）：只保留侧栏状态，避免整个工作区保存失败 */
function sanitizeSize(l: PanelLayoutV1): PanelLayoutV1 {
  if (new TextEncoder().encode(JSON.stringify(l)).length <= MAX_WINDOWS_BYTES) return l;
  return { ...defaultPanelLayout(l.viewport), sidebar: l.sidebar };
}

/** 保存前：只保留仍存在的面板的条目 */
export function finalizePanelLayout(l: PanelLayoutV1, panelIds: Set<string>): PanelLayoutV1 {
  const keep = (id: string) => id === SIDEBAR_ID || panelIds.has(id);
  const out: PanelLayoutV1 = {
    ...l,
    order: l.order.filter(keep),
    collapsed: Object.fromEntries(Object.entries(l.collapsed).filter(([k]) => panelIds.has(k))),
    floats: Object.fromEntries(Object.entries(l.floats).filter(([k]) => panelIds.has(k))),
  };
  if (out.gridMaximized && !panelIds.has(out.gridMaximized)) delete out.gridMaximized;
  return sanitizeSize(out);
}
