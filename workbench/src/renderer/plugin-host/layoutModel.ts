import { CURRENT_PHASE as HOST_PHASE } from '../../shared/hostApi';
/**
 * 工作区布局数据模型（纯函数，可单测）。
 * - 工作区 = items（工作区条目）+ dock（分栏排列）+ shell（侧栏宽度）。
 * - 条目 WorkspaceItem 描述“放进工作区的东西”：来源类型（file/web/app）、由哪个适配器显示、引用、显示方式、视图状态。
 * - dockview 面板只引用 itemId（面板 id = itemId，params = { itemId }），从不出现具体阅读器类名、路径或文件内容。
 * - 存储格式带 schema 版本号（当前 4：条目在项目表，布局只引用 itemId）；读取时迁移旧版本；遇到更新版本的格式拒绝打开而不是覆盖。
 */
import {
  AUTO_ADAPTER,
  DISPLAY_MODES,
  LAYOUT_SCHEMA_VERSION,
  SOURCE_KINDS,
  pruneDock,
  panelItemId,
  sanitizeItem,
  sanitizeViewState,
  sanitizeWebRef,
  stripSecrets,
  type DisplayMode,
  type GridBranch,
  type GridLeaf,
  type GridNode,
  type ItemState,
  type SerializedDock,
  type SerializedPanel,
  type SourceKind,
  type StoredLayout,
  type WorkspaceItem,
} from '../../shared/items';
import { DISPLAY_MODE_BY_KIND, PHASE_BY_KIND, sanitizeUrlForState } from '../../shared/adapter-sdk/policy';
import type { PlaceholderKind, RolloutPhase } from '../../shared/adapter-sdk/types';
export {
  AUTO_ADAPTER,
  DISPLAY_MODES,
  LAYOUT_SCHEMA_VERSION,
  SOURCE_KINDS,
  pruneDock,
  sanitizeItem,
  sanitizeViewState,
  sanitizeWebRef,
  stripSecrets,
};
export type { DisplayMode, GridBranch, GridLeaf, GridNode, ItemState, SerializedDock, SerializedPanel, SourceKind, StoredLayout, WorkspaceItem };
export { MAX_VIEW_STATE_BYTES } from '../../shared/items';

export const VIEW_HOST_COMPONENT = 'view';
/** @deprecated 旧名 */
export const AUTO_VIEW = AUTO_ADAPTER;
/** 整个工作区布局的上限 */
export const MAX_LAYOUT_BYTES = 512 * 1024;

/** 诚实的显示方式（来自 SDK policy）：每种来源类型只有一种允许的显示方式 */
export const DISPLAY_MODE_FOR: Record<SourceKind, DisplayMode> = DISPLAY_MODE_BY_KIND;
/** 返回 null 表示声明诚实；否则返回原因 */
export function checkDisplayMode(id: string, sourceKinds: readonly string[], displayMode: string): string | null {
  if (sourceKinds.length !== 1) return `适配器 ${id} 必须恰好声明一种来源类型（sourceKinds）`;
  const k = sourceKinds[0] as SourceKind;
  if (DISPLAY_MODE_FOR[k] !== displayMode) return `适配器 ${id} 的显示方式与来源类型不符：${k} 只能声明 ${DISPLAY_MODE_FOR[k]}，实际为 ${displayMode}`;
  return null;
}

export interface ItemPanelParams {
  itemId: string;
}

let seq = 0;
export function newItemId(): string {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(16).slice(2, 10);
  return `it-${Date.now().toString(36)}-${(seq++).toString(36)}-${rnd}`;
}

export function makeFileItem(resourceId: string, adapterId = AUTO_ADAPTER, itemId = newItemId()): WorkspaceItem {
  return { itemId, sourceKind: 'file', adapterId, ref: resourceId, displayMode: 'in-app-reader' };
}

/** 网页条目：ref 保存前按 SDK sanitizeUrlForState 去掉 query 与账号（核心与适配器同一规则） */
export function makeWebItem(url: string, adapterId: string, itemId = newItemId()): WorkspaceItem {
  return { itemId, sourceKind: 'web', adapterId, ref: sanitizeUrlForState(url) ?? url, displayMode: 'in-app-web' };
}

export interface ShellLayout {
  sidebarWidth: number;
}
/** 内存中的工作区：条目（来自项目表）+ 分栏 + 侧栏 */
export interface WorkspaceLayout {
  schema: number;
  items: Record<string, WorkspaceItem>;
  dock: SerializedDock | null; // null = 空工作区
  shell: ShellLayout;
}

export const DEFAULT_SHELL: ShellLayout = { sidebarWidth: 280 };

export type MigrateResult = { ok: true; layout: WorkspaceLayout; migratedFrom: number } | { ok: false; reason: 'newer' | 'invalid'; schema?: number };

/**
 * 读取任意历史版本 → 当前内存模型。
 * - schema 4：条目来自项目表（参数 items）；
 * - schema 3：条目内联在布局中（导入旧文件时）；
 * - schema 1/2：面板 params 内联 viewType/resourceId/state → 生成 file 条目。
 * legacyShell：v1/v2 没有 shell 字段时使用（来自旧的 ui 设置）
 */
export function migrateLayout(raw: unknown, legacyShell: Partial<ShellLayout> = {}, tableItems: WorkspaceItem[] | Record<string, WorkspaceItem> = []): MigrateResult {
  if (raw === null || raw === undefined) return { ok: true, layout: emptyLayout(legacyShell), migratedFrom: LAYOUT_SCHEMA_VERSION };
  if (typeof raw !== 'object') return { ok: false, reason: 'invalid' };
  const obj = raw as Record<string, unknown>;
  const schema = typeof obj.schema === 'number' ? obj.schema : 1;
  if (schema > LAYOUT_SCHEMA_VERSION) return { ok: false, reason: 'newer', schema };
  const shell = normalizeShell(schema >= 3 && obj.shell && typeof obj.shell === 'object' ? (obj.shell as Partial<ShellLayout>) : { ...legacyShell, ...((obj.shell as object) ?? {}) });
  const rawDock = (schema === 1 ? obj : obj.dock) as SerializedDock | null | undefined;
  if (schema >= 3) {
    const items: Record<string, WorkspaceItem> = {};
    const src = schema === 3 ? Object.values((obj.items as Record<string, unknown>) ?? {}) : Array.isArray(tableItems) ? tableItems : Object.values(tableItems);
    for (const v of src) {
      const it = sanitizeItem(v);
      if (it) items[it.itemId] = it;
    }
    if (rawDock === null || rawDock === undefined) return { ok: true, layout: { schema: LAYOUT_SCHEMA_VERSION, items: {}, dock: null, shell }, migratedFrom: schema };
    if (typeof rawDock !== 'object' || !rawDock.panels || !rawDock.grid) return { ok: false, reason: 'invalid', schema };
    // 面板引用的条目不存在 → 去掉该面板（及随之变空的分组）
    const pruned = pruneDock(rawDock, (id) => !!items[id]);
    if (!pruned) return { ok: true, layout: { schema: LAYOUT_SCHEMA_VERSION, items: {}, dock: null, shell }, migratedFrom: schema };
    const panels: Record<string, SerializedPanel> = {};
    for (const [id, p] of Object.entries(pruned.panels)) panels[id] = { ...p, contentComponent: VIEW_HOST_COMPONENT, params: { itemId: panelItemId(id, p) } };
    return { ok: true, layout: { schema: LAYOUT_SCHEMA_VERSION, items, dock: { ...pruned, panels }, shell }, migratedFrom: schema };
  }
  // v1 / v2：面板 params 内联了 viewType/resourceId/state → 转为 file 条目
  if (!rawDock || typeof rawDock !== 'object' || !rawDock.panels || !rawDock.grid) return { ok: false, reason: 'invalid', schema };
  const items: Record<string, WorkspaceItem> = {};
  const panels: Record<string, SerializedPanel> = {};
  for (const [id, p] of Object.entries(rawDock.panels)) {
    const params = (p.params ?? {}) as Record<string, unknown>;
    if (typeof params.resourceId !== 'string') continue;
    const item = makeFileItem(params.resourceId, typeof params.viewType === 'string' ? params.viewType : AUTO_ADAPTER, id);
    if (params.state !== undefined) {
      const { state } = sanitizeViewState(params.state);
      if (state !== undefined) item.state = { v: 1, data: state };
    }
    items[id] = item;
    panels[id] = { ...p, contentComponent: VIEW_HOST_COMPONENT, params: { itemId: id } };
  }
  return { ok: true, layout: { schema: LAYOUT_SCHEMA_VERSION, items, dock: { ...rawDock, panels }, shell }, migratedFrom: schema };
}

export function emptyLayout(shell: Partial<ShellLayout> = {}): WorkspaceLayout {
  return { schema: LAYOUT_SCHEMA_VERSION, items: {}, dock: null, shell: normalizeShell(shell) };
}

function normalizeShell(s: Partial<ShellLayout> | undefined): ShellLayout {
  const w = Number(s?.sidebarWidth);
  return { sidebarWidth: Number.isFinite(w) ? Math.max(180, Math.min(600, Math.round(w))) : DEFAULT_SHELL.sidebarWidth };
}

/** 保存格式：布局（schema 4，面板 params 只有 itemId）+ 项目表行 */
export interface StoredWorkspace {
  layout: StoredLayout;
  items: WorkspaceItem[];
}

/**
 * 保存前规范化：只保留 dock 中实际存在的面板对应的条目；面板 params 只保留 itemId；条目经过净化。
 */
export function toStoredLayout(dock: SerializedDock | null, items: Record<string, WorkspaceItem>, shell: ShellLayout): StoredWorkspace {
  if (!dock || !dock.panels || Object.keys(dock.panels).length === 0) return { layout: { schema: LAYOUT_SCHEMA_VERSION, dock: null, shell: normalizeShell(shell) }, items: [] };
  const panels: Record<string, SerializedPanel> = {};
  const kept: WorkspaceItem[] = [];
  for (const [id, p] of Object.entries(dock.panels)) {
    const itemId = panelItemId(id, p);
    const it = sanitizeItem(items[itemId]);
    if (!it) continue;
    kept.push(it);
    panels[id] = { ...p, params: { itemId } };
  }
  return { layout: { schema: LAYOUT_SCHEMA_VERSION, dock: { ...dock, panels }, shell: normalizeShell(shell) }, items: kept };
}

/** 工作区引用到的文件资源 ID（用于跨根统计、导出时重新匹配） */
export function referencedResources(items: Record<string, WorkspaceItem> | WorkspaceItem[]): string[] {
  const list = Array.isArray(items) ? items : Object.values(items);
  return [...new Set(list.filter((i) => i.sourceKind === 'file').map((i) => i.ref))];
}

/** 当前发布阶段：P3（文件阅读器 + 网页面板 H9 + 外部程序项目 H10–H12，第 9 轮接线；SDK PHASE_BY_KIND） */
export const CURRENT_PHASE: RolloutPhase = HOST_PHASE;
export function isKindAvailable(kind: SourceKind, phase: RolloutPhase = CURRENT_PHASE): boolean {
  return PHASE_BY_KIND[kind] <= phase;
}

/** 占位种类与 SDK PlaceholderKind 一致（T22） */
export type PlaceholderReason = PlaceholderKind;

export type ResolvedAdapter<V> = { kind: 'adapter'; adapter: V } | { kind: 'placeholder'; reason: PlaceholderReason; adapterId: string; detail?: string };

export type OwnerStatus = 'active' | 'disabled' | 'incompatible' | 'error' | 'denied' | undefined;

/**
 * 决定一个条目由哪个适配器显示（核心只做查找与占位，兼容逻辑都在适配器里）。判定顺序同 SDK §5.1 前三步：
 *  - adapterId 已注册 → 用它；auto → 优先级最高的匹配适配器
 *  - 未注册 → 按提供它的插件状态：adapter-missing / adapter-incompatible / adapter-error / adapter-disabled
 *  - 来源类型在当前阶段未开放 → phase-unavailable（不询问权限）
 * 权限与资源预检在之后由 ViewHost 完成（permission-denied / resource-missing）。
 */
export function resolveItemAdapter<V>(
  item: Pick<WorkspaceItem, 'sourceKind' | 'adapterId'>,
  lookup: (id: string) => V | undefined,
  best: () => V | undefined,
  ownerStatus: (adapterId: string) => OwnerStatus = () => undefined,
  phase: RolloutPhase = CURRENT_PHASE,
): ResolvedAdapter<V> {
  let found: V | undefined;
  if (item.adapterId === AUTO_ADAPTER) {
    if (!isKindAvailable(item.sourceKind, phase)) return { kind: 'placeholder', reason: 'phase-unavailable', adapterId: item.adapterId, detail: phaseText(item.sourceKind, phase) };
    found = best();
    if (!found) return { kind: 'placeholder', reason: 'adapter-missing', adapterId: item.adapterId };
  } else {
    found = lookup(item.adapterId);
    if (!found) {
      const st = ownerStatus(item.adapterId);
      const reason: PlaceholderReason = st === 'disabled' ? 'adapter-disabled' : st === 'incompatible' ? 'adapter-incompatible' : st === 'error' ? 'adapter-error' : 'adapter-missing';
      // 插件缺失/禁用时也先报阶段：P1 中的 web/app 条目统一显示“尚未开放”
      if (!isKindAvailable(item.sourceKind, phase) && reason === 'adapter-missing') return { kind: 'placeholder', reason: 'phase-unavailable', adapterId: item.adapterId, detail: phaseText(item.sourceKind, phase) };
      return { kind: 'placeholder', reason, adapterId: item.adapterId };
    }
  }
  if (!isKindAvailable(item.sourceKind, phase)) return { kind: 'placeholder', reason: 'phase-unavailable', adapterId: item.adapterId, detail: phaseText(item.sourceKind, phase) };
  return { kind: 'adapter', adapter: found };
}

const KIND_NAME: Record<SourceKind, string> = { file: '文件', web: '网页', app: '外部程序' };
export function phaseText(kind: SourceKind, phase: RolloutPhase = CURRENT_PHASE): string {
  return `${KIND_NAME[kind]}类条目将在 P${PHASE_BY_KIND[kind]} 开放（当前 P${phase}）。条目与状态已保留，开放后自动恢复。`;
}

/** 版本化状态 → 适配器可用的数据：同版本直接用；旧版本交给适配器自己的 migrateState；其余丢弃 */
export function restoreItemState(
  state: ItemState | undefined,
  adapter: { stateSchemaVersion?: number; migrateState?(data: unknown, fromVersion: number): unknown; restoreState?(raw: unknown): unknown },
): unknown {
  if (!state) return undefined;
  const want = adapter.stateSchemaVersion ?? 1;
  let data: unknown = state.data;
  try {
    if (state.v !== want) {
      if (state.v < want && adapter.migrateState) data = adapter.migrateState(data, state.v);
      else return undefined;
    }
    return adapter.restoreState ? adapter.restoreState(data) : data;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- 布局预设

/** 布局预设模板：只描述“分栏如何排列”，不含任何文件或颜色 */
export type PresetNode = { slot: number; size?: number } | { split: 'row' | 'column'; size?: number; children: PresetNode[] };
export interface LayoutPresetTemplate {
  id: string;
  label: string;
  description?: string;
  sidebarWidth?: number;
  grid: PresetNode;
}

export function validatePreset(p: unknown): string | null {
  const t = p as LayoutPresetTemplate;
  if (!t || typeof t !== 'object') return '预设不是对象';
  if (typeof t.id !== 'string' || !t.id) return '预设缺少 id';
  if (typeof t.label !== 'string' || !t.label) return '预设缺少 label';
  if (t.sidebarWidth !== undefined && (typeof t.sidebarWidth !== 'number' || t.sidebarWidth < 180 || t.sidebarWidth > 600)) return 'sidebarWidth 须在 180–600 之间';
  const slots: number[] = [];
  const walk = (n: PresetNode, parent: 'row' | 'column' | null, depth: number): string | null => {
    if (depth > 4) return '预设嵌套过深（最多 4 层）';
    if ('slot' in n) {
      if (!Number.isInteger(n.slot) || n.slot < 1) return 'slot 须为正整数';
      slots.push(n.slot);
      return null;
    }
    if (n.split !== 'row' && n.split !== 'column') return 'split 须为 row 或 column';
    if (parent === n.split) return '相邻层的 split 方向必须交替';
    if (!Array.isArray(n.children) || n.children.length < 1) return 'children 不能为空';
    for (const c of n.children) {
      if (c.size !== undefined && !(c.size > 0)) return 'size 须为正数';
      const e = walk(c, n.split, depth + 1);
      if (e) return e;
    }
    return null;
  };
  if (!t.grid) return '预设缺少 grid';
  const e = walk(t.grid, null, 0);
  if (e) return e;
  const sorted = [...slots].sort((a, b) => a - b);
  if (sorted.some((s, i) => s !== i + 1)) return 'slot 须从 1 开始连续编号';
  return null;
}

/** 按从左到右/从上到下的顺序列出分组 */
export function leafOrder(node: GridNode): GridLeaf[] {
  return node.type === 'leaf' ? [node] : node.data.flatMap(leafOrder);
}

/**
 * 把预设应用到当前布局：现有分组按顺序放进 slot 1..n（整组标签一起移动），
 * 多出的分组并入最后一个 slot，空 slot 被裁掉。面板参数（视图状态）原样保留。
 */
export function applyPreset(dock: SerializedDock | null, preset: LayoutPresetTemplate, width: number, height: number): SerializedDock | null {
  if (!dock) return null;
  const groups = leafOrder(dock.grid.root);
  if (!groups.length) return dock;
  const nSlots = countSlots(preset.grid);
  const used = Math.min(nSlots, groups.length);
  const bySlot = new Map<number, GridLeaf['data']>();
  for (let i = 0; i < used; i++) bySlot.set(i + 1, { ...groups[i].data });
  for (let i = used; i < groups.length; i++) {
    const last = bySlot.get(used)!;
    bySlot.set(used, { ...last, views: [...last.views, ...groups[i].data.views] });
  }
  let pruned = prune(preset.grid, used);
  // 根只剩一个子分支时提升它（避免多余的一层）
  while (pruned && 'split' in pruned && pruned.children.length === 1 && 'split' in pruned.children[0]) pruned = pruned.children[0];
  if (!pruned) return dock;
  const rootSplit: 'row' | 'column' = 'split' in pruned ? pruned.split : 'row';
  const orientation = rootSplit === 'row' ? 'HORIZONTAL' : 'VERTICAL';
  // 根分支：主方向长度 = row ? width : height；交叉方向 = 另一个
  const build = (n: PresetNode, main: number, cross: number): GridNode => {
    if ('slot' in n) return { type: 'leaf', data: bySlot.get(n.slot)!, size: cross };
    const total = n.children.reduce((s, c) => s + (c.size ?? 1), 0);
    let acc = 0;
    const kids = n.children.map((c, i) => {
      const sz = i === n.children.length - 1 ? main - acc : Math.round((main * (c.size ?? 1)) / total);
      acc += sz;
      // 子节点：其 size 是在父主方向上的长度；子分支的主方向是父的交叉方向
      const child = build(c, cross, sz);
      return { ...child, size: sz } as GridNode;
    });
    return { type: 'branch', data: kids, size: cross };
  };
  const rootNode: PresetNode = 'slot' in pruned ? { split: 'row', children: [pruned] } : pruned;
  const main = rootSplit === 'row' ? width : height;
  const cross = rootSplit === 'row' ? height : width;
  const root = build(rootNode, main, cross);
  return { ...dock, grid: { ...dock.grid, root, width, height, orientation } };
}

function countSlots(n: PresetNode): number {
  return 'slot' in n ? 1 : n.children.reduce((s, c) => s + countSlots(c), 0);
}
function prune(n: PresetNode, keep: number): PresetNode | null {
  if ('slot' in n) return n.slot <= keep ? n : null;
  const kids = n.children.map((c) => prune(c, keep)).filter((c): c is PresetNode => !!c);
  if (!kids.length) return null;
  return { ...n, children: kids };
}
