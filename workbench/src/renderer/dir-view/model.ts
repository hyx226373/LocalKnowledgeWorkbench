/**
 * 侧栏双目录视图的布局状态，挂在 layout 键 `ui.dirView`。
 * 规格里的形状是 { dual, left, right, split }，left/right 为 DirViewTarget。
 * expanded / scrollTop / selected / axis 是附加字段（见汇报里的接口变更申请），用来恢复每栏自己的展开、滚动和选中，不占用全局 ui.expanded。
 */
/** 栏目标上的编排。缺省时标题用 P7 当前工作区编排（listVfolderView 的虚拟根名）。 */
export type DirViewTarget =
  | { kind: 'root'; rootId: string; relPath: string; catalogId?: string }
  | { kind: 'vfolder'; folderId: string | null; catalogId?: string }
  | { kind: 'workspace-refs'; workspaceId: string; catalogId?: string };

/** P7 `library.catalogs` 里一套编排的标题。渲染进程只读，不写。 */
export interface CatalogHeading {
  catalogId: string;
  virtualRootName: string;
}

export type DirViewPane = DirViewTarget & {
  expanded?: string[];
  scrollTop?: number;
  selected?: string[];
};

export interface DirViewState {
  dual: boolean;
  left: DirViewPane;
  right: DirViewPane;
  split: number;
  /** row = 左右；column = 上下 */
  axis: 'row' | 'column';
}

export const DEFAULT_DIR_VIEW: DirViewState = {
  dual: false,
  left: { kind: 'root', rootId: '', relPath: '', expanded: [], scrollTop: 0, selected: [] },
  right: { kind: 'vfolder', folderId: null, expanded: [], scrollTop: 0, selected: [] },
  split: 0.5,
  axis: 'row',
};

function strList(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string').slice(0, max);
}

function catalogIdOf(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const id = v.trim();
  if (!id || id.length > 80 || /[\\/]/.test(id)) return undefined;
  return id;
}

/** 从 P7 编排文档读出各套虚拟根标题。键损坏或不是 v:1 时返回空，不抛。 */
export function catalogHeadings(raw: unknown): CatalogHeading[] {
  if (!raw || typeof raw !== 'object' || (raw as { v?: unknown }).v !== 1) return [];
  const sets = (raw as { sets?: unknown }).sets;
  if (!Array.isArray(sets)) return [];
  const out: CatalogHeading[] = [];
  const seen = new Set<string>();
  for (const item of sets) {
    if (!item || typeof item !== 'object') continue;
    const id = catalogIdOf((item as { id?: unknown }).id);
    const name = (item as { virtualRootName?: unknown }).virtualRootName;
    if (!id || seen.has(id) || typeof name !== 'string' || !name.trim()) continue;
    seen.add(id);
    out.push({ catalogId: id, virtualRootName: name.trim() });
  }
  return out;
}

/**
 * 虚拟根标题。catalogId 命中哪一套，就用那一套的 virtualRootName。
 * 没写 catalogId 时用 fallback（P7 当前工作区编排的虚拟根名）。
 */
export function virtualRootTitle(catalogId: string | null | undefined, catalogs: readonly CatalogHeading[], fallback = '自建目录'): string {
  const id = catalogIdOf(catalogId);
  if (!id) return fallback;
  const hit = catalogs.find((c) => c.catalogId === id);
  return hit?.virtualRootName || fallback;
}

export function normalizePane(raw: unknown, fallback: DirViewTarget): DirViewPane {
  const t = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  let target: DirViewTarget = fallback;
  if (t?.kind === 'root' && typeof t.rootId === 'string' && typeof t.relPath === 'string') target = { kind: 'root', rootId: t.rootId, relPath: t.relPath };
  else if (t?.kind === 'vfolder' && (t.folderId === null || typeof t.folderId === 'string')) target = { kind: 'vfolder', folderId: t.folderId as string | null };
  else if (t?.kind === 'workspace-refs' && typeof t.workspaceId === 'string') target = { kind: 'workspace-refs', workspaceId: t.workspaceId };
  const extra = t ?? {};
  const catalogId = catalogIdOf(extra.catalogId);
  return {
    ...target,
    ...(catalogId ? { catalogId } : {}),
    expanded: strList(extra.expanded, 500),
    selected: strList(extra.selected, 200),
    scrollTop: typeof extra.scrollTop === 'number' && extra.scrollTop >= 0 && extra.scrollTop < 1e6 ? extra.scrollTop : 0,
  };
}

export function normalizeDirView(raw: unknown): DirViewState {
  const d = raw && typeof raw === 'object' ? (raw as Partial<DirViewState>) : {};
  const split = typeof d.split === 'number' && d.split >= 0.2 && d.split <= 0.8 ? d.split : 0.5;
  return {
    dual: d.dual === true,
    left: normalizePane(d.left, DEFAULT_DIR_VIEW.left),
    right: normalizePane(d.right, DEFAULT_DIR_VIEW.right),
    split,
    axis: d.axis === 'column' ? 'column' : 'row',
  };
}

export function clampSplit(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(0.8, Math.max(0.2, n));
}
