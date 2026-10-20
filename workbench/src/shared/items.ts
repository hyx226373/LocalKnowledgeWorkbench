/**
 * 工作区条目模型（主进程与渲染进程共用的纯函数）。与适配器 SDK 的 WorkspaceItem 对齐（T22：SDK 为准）。
 * - 条目保存在项目表 workspace_items（按工作区），布局 JSON（schema 4）的面板参数只有 { itemId }。
 * - ref：file = resourceId；web = 去掉 query/账号的 URL；app = appProfileId。绝不出现绝对路径。
 */
import { sanitizeUrlForState } from './adapter-sdk/policy';
import type { DisplayMode, SourceKind } from './adapter-sdk/types';
export type { DisplayMode, SourceKind };

export const SOURCE_KINDS: SourceKind[] = ['file', 'web', 'app'];
export const DISPLAY_MODES: DisplayMode[] = ['in-app-reader', 'in-app-web', 'external-managed'];
/** adapterId 为 auto 时由宿主按优先级挑选，挑中后固化 */
export const AUTO_ADAPTER = 'auto';
/** 单个条目视图状态序列化后的上限（与 SDK DEFAULT_MAX_STATE_BYTES 一致） */
export const MAX_VIEW_STATE_BYTES = 16 * 1024;
const SECRET_KEY = /(pass(word)?|secret|token|api[-_]?key|credential|cookie|auth|session)/i;

/** 版本化的视图状态：v = 适配器的 stateSchemaVersion */
export interface ItemState {
  v: number;
  data: unknown;
  /**
   * 宿主兜底（第 9 轮 R4）：插件恢复视图状态失败（restoreState 抛错/返回 undefined、版本更高）时，
   * 宿主把原来的状态信封原样留在这里，之后的保存只改 v/data，不会覆盖它；用户可在面板上“丢弃旧状态”；
   * 插件版本变化后宿主会先用它再试一次恢复。
   */
  preserved?: PreservedState;
}
export interface PreservedState {
  v: number;
  data: unknown;
  reason: string;
  at: number;
  /** 保留时的插件版本（版本变了才重试恢复） */
  pluginVersion?: string;
  /**
   * 更早保留的旧状态（新的在前，最多 MAX_EARLIER_PRESERVED 份）：已有保留的旧状态时，插件新版本又读不了
   * 当前状态，就把当前状态作为新的 preserved，原来那份挪到这里，两份都不丢。用户“丢弃旧状态”时一起删除。
   */
  earlier?: Omit<PreservedState, 'earlier'>[];
}
export const MAX_EARLIER_PRESERVED = 2;

/** 已有 preserved 时再保留一份：当前状态成为新的 preserved，旧的挪进 earlier（同样的内容不重复保留） */
export function pushPreserved(prev: PreservedState | undefined, next: Omit<PreservedState, 'earlier'>): PreservedState {
  if (!prev) return { ...next };
  const { earlier = [], ...prevTop } = prev;
  if (prevTop.v === next.v && JSON.stringify(prevTop.data) === JSON.stringify(next.data)) return { ...prev, ...(next.pluginVersion ? { pluginVersion: next.pluginVersion } : {}) };
  const rest = [prevTop, ...earlier].filter((e) => !(e.v === next.v && JSON.stringify(e.data) === JSON.stringify(next.data)));
  return { ...next, earlier: rest.slice(0, MAX_EARLIER_PRESERVED) };
}

export interface WorkspaceItem {
  itemId: string;
  sourceKind: SourceKind;
  /** 提供显示的适配器 id，或 'auto' */
  adapterId: string;
  ref: string;
  displayMode: DisplayMode;
  state?: ItemState;
  title?: string;
}

/** 去掉看起来像密钥的字段 */
export function stripSecrets(v: unknown, depth = 0): unknown {
  if (depth > 16 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => stripSecrets(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) if (!SECRET_KEY.test(k)) out[k] = stripSecrets(x, depth + 1);
  return out;
}

/** 视图状态净化：剔除密钥字段；过大（例如误把文件内容放进状态）则丢弃 */
export function sanitizeViewState(state: unknown): { state: unknown; dropped?: 'too-large' | 'not-json' } {
  if (state === undefined) return { state: undefined };
  let json: string;
  try {
    json = JSON.stringify(stripSecrets(state));
  } catch {
    return { state: undefined, dropped: 'not-json' };
  }
  if (json === undefined) return { state: undefined };
  if (new TextEncoder().encode(json).length > MAX_VIEW_STATE_BYTES) return { state: undefined, dropped: 'too-large' };
  return { state: JSON.parse(json) };
}

/** web 引用只允许 http(s)；按 SDK sanitizeUrlForState 去掉 query（常含令牌）与账号密码，只留 origin + path + hash */
export function sanitizeWebRef(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  return sanitizeUrlForState(u.toString());
}

/** 校验/净化单个条目；不合法返回 null */
export function sanitizeItem(raw: unknown): WorkspaceItem | null {
  const it = raw as Partial<WorkspaceItem>;
  if (!it || typeof it !== 'object') return null;
  if (typeof it.itemId !== 'string' || !/^[\w.|:-]{1,200}$/.test(it.itemId)) return null;
  if (!SOURCE_KINDS.includes(it.sourceKind as SourceKind)) return null;
  if (!DISPLAY_MODES.includes(it.displayMode as DisplayMode)) return null;
  if (typeof it.adapterId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(it.adapterId)) return null;
  if (typeof it.ref !== 'string' || !it.ref || it.ref.length > 2048) return null;
  let ref = it.ref;
  if (it.sourceKind === 'web') {
    const clean = sanitizeWebRef(ref);
    if (!clean) return null;
    ref = clean;
  } else if (!/^[\w.:-]{1,200}$/.test(ref)) return null; // resourceId / appProfileId：不允许路径
  const out: WorkspaceItem = { itemId: it.itemId, sourceKind: it.sourceKind as SourceKind, adapterId: it.adapterId, ref, displayMode: it.displayMode as DisplayMode };
  if (it.state && typeof it.state === 'object' && Number.isInteger((it.state as ItemState).v) && (it.state as ItemState).v >= 1) {
    const { state } = sanitizeViewState((it.state as ItemState).data);
    if (state !== undefined) out.state = { v: (it.state as ItemState).v, data: state };
    const pr = (it.state as ItemState).preserved;
    const one = (x: unknown): Omit<PreservedState, 'earlier'> | null => {
      const q = x as PreservedState | null;
      if (!q || typeof q !== 'object' || !Number.isInteger(q.v) || q.v < 1) return null;
      const kept = sanitizeViewState(q.data);
      if (kept.state === undefined) return null;
      return {
        v: q.v,
        data: kept.state,
        reason: String(q.reason ?? '').slice(0, 300),
        at: Number.isFinite(q.at) ? Number(q.at) : 0,
        ...(typeof q.pluginVersion === 'string' ? { pluginVersion: q.pluginVersion.slice(0, 64) } : {}),
      };
    };
    const top = out.state ? one(pr) : null;
    if (out.state && top) {
      const earlier = Array.isArray(pr?.earlier) ? pr.earlier.map(one).filter((e): e is Omit<PreservedState, 'earlier'> => !!e).slice(0, MAX_EARLIER_PRESERVED) : [];
      out.state.preserved = earlier.length ? { ...top, earlier } : top;
    }
  }
  if (typeof it.title === 'string' && it.title.trim()) out.title = it.title.trim().slice(0, 200);
  return out;
}

// ---------------------------------------------------------------- dockview 序列化结构

export interface SerializedPanel {
  id: string;
  contentComponent?: string;
  params?: Record<string, unknown>;
  title?: string;
  [k: string]: unknown;
}
export interface GridLeaf {
  type: 'leaf';
  data: { views: string[]; activeView?: string; id: string; [k: string]: unknown };
  size: number;
  [k: string]: unknown;
}
export interface GridBranch {
  type: 'branch';
  data: GridNode[];
  size: number;
  [k: string]: unknown;
}
export type GridNode = GridLeaf | GridBranch;
export interface SerializedDock {
  grid: { root: GridNode; width: number; height: number; orientation: 'HORIZONTAL' | 'VERTICAL'; [k: string]: unknown };
  panels: Record<string, SerializedPanel>;
  activeGroup?: string;
  [k: string]: unknown;
}

export function panelItemId(id: string, p: SerializedPanel | undefined): string {
  return String((p?.params as Record<string, unknown> | undefined)?.itemId ?? id);
}

/**
 * 去掉不在 keep 中的面板（按 itemId），并清理随之变空的分组/分支。全部去掉时返回 null（空工作区）。
 * 用于：卸载插件时“同时移除工作区中的相关条目”、面板引用的条目不存在时。
 */
export function pruneDock(dock: SerializedDock | null, keep: (itemId: string) => boolean): SerializedDock | null {
  if (!dock || !dock.panels || !dock.grid) return null;
  const panels: Record<string, SerializedPanel> = {};
  for (const [id, p] of Object.entries(dock.panels)) if (keep(panelItemId(id, p))) panels[id] = p;
  if (!Object.keys(panels).length) return null;
  if (Object.keys(panels).length === Object.keys(dock.panels).length) return dock;
  const groups = new Set<string>();
  const leafData = (d: GridLeaf['data']): GridLeaf['data'] | null => {
    const views = d.views.filter((v) => panels[v]);
    if (!views.length) return null;
    groups.add(d.id);
    return { ...d, views, activeView: views.includes(d.activeView ?? '') ? d.activeView : views[0] };
  };
  const walk = (n: GridNode): GridNode | null => {
    if (n.type === 'leaf') {
      const data = leafData(n.data);
      return data ? { ...n, data } : null;
    }
    const kids = n.data.map(walk).filter((c): c is GridNode => !!c);
    if (!kids.length) return null;
    // 只剩一个子节点时保持分支结构（dockview 允许），尺寸交给 dockview 重新分配
    return { ...n, data: kids };
  };
  const root = walk(dock.grid.root);
  // 浮动窗口 / 弹出窗口（dockview floatingGroups / popoutGroups）：单组形式 data，或嵌套 grid；去掉面板后变空的窗口整个删除
  const pruneWindows = (list: unknown): Record<string, unknown>[] | undefined => {
    if (!Array.isArray(list)) return undefined;
    const out: Record<string, unknown>[] = [];
    for (const w of list as Record<string, unknown>[]) {
      if (!w || typeof w !== 'object') continue;
      if (w.data && typeof w.data === 'object') {
        const data = leafData(w.data as GridLeaf['data']);
        if (data) out.push({ ...w, data });
      } else if (w.grid && typeof w.grid === 'object' && (w.grid as { root?: GridNode }).root) {
        const g = w.grid as { root: GridNode };
        const r = walk(g.root);
        if (r) out.push({ ...w, grid: { ...g, root: r.type === 'leaf' ? { type: 'branch', data: [r], size: g.root.size } : r } });
      }
    }
    return out;
  };
  const floatingGroups = pruneWindows(dock.floatingGroups);
  const popoutGroups = pruneWindows(dock.popoutGroups);
  if (!root && !floatingGroups?.length && !popoutGroups?.length) return null;
  const gridRoot: GridNode = !root ? { type: 'branch', data: [], size: dock.grid.root.size } : root.type === 'leaf' ? { type: 'branch', data: [root], size: dock.grid.root.size } : root;
  const out: SerializedDock = {
    ...dock,
    grid: { ...dock.grid, root: gridRoot },
    panels,
    activeGroup: dock.activeGroup && groups.has(dock.activeGroup) ? dock.activeGroup : [...groups][0],
  };
  if (floatingGroups) out.floatingGroups = floatingGroups;
  if (popoutGroups) out.popoutGroups = popoutGroups;
  return out;
}

// ---------------------------------------------------------------- 存储格式

/** 1 = 裸 dockview JSON；2 = { schema, dock }（params 内联 viewType/resourceId/state）；
 *  3 = { schema, items, dock, shell }（条目内联在布局里）；4 = { schema, dock, shell } + 项目表 workspace_items */
export const LAYOUT_SCHEMA_VERSION = 4;

/**
 * 没有保存过布局时的侧栏宽。
 * 已保存的 shell.sidebarWidth 原样读取，不迁到这个数。
 */
export const NEW_LAYOUT_SIDEBAR_WIDTH = 240;

/** 已保存宽度原样返回；没有保存过才用 240。不夹取值，避免改写旧数据。 */
export function newLayoutSidebarWidth(saved: unknown): number {
  return typeof saved === 'number' && Number.isFinite(saved) ? saved : NEW_LAYOUT_SIDEBAR_WIDTH;
}

export interface StoredLayout {
  schema: number;
  dock: SerializedDock | null;
  shell: { sidebarWidth: number };
}

/**
 * schema 3 → 4：把内联条目拆到项目表；面板参数已是 { itemId }，只丢弃引用不存在条目的面板。
 * 其他版本原样返回（schema 1/2 由渲染进程打开时迁移，迁移后立刻按 schema 4 保存）。
 */
export function splitLegacyItems(layout: unknown): { layout: unknown; items: WorkspaceItem[] } {
  const l = layout as Record<string, unknown> | null;
  if (!l || typeof l !== 'object' || l.schema !== 3) return { layout, items: [] };
  const items: WorkspaceItem[] = [];
  for (const v of Object.values((l.items as Record<string, unknown>) ?? {})) {
    const it = sanitizeItem(v);
    if (it) items.push(it);
  }
  const ids = new Set(items.map((i) => i.itemId));
  const dock = pruneDock((l.dock as SerializedDock | null) ?? null, (id) => ids.has(id));
  const used = new Set(dock ? Object.entries(dock.panels).map(([id, p]) => panelItemId(id, p)) : []);
  const shell = (l.shell as StoredLayout['shell']) ?? { sidebarWidth: 280 };
  return { layout: { schema: LAYOUT_SCHEMA_VERSION, dock, shell }, items: items.filter((i) => used.has(i.itemId)) };
}
