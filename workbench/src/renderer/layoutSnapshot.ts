/**
 * 启动时先画界面用的小快照。只放 localStorage，不读 workbench.db。
 * 可交互只认界面壳已经画出来。可见内容超时不能当成可交互。
 */
import type { WorkspaceItem } from '../shared/items';
import { LEGACY_SCHEME_SLIDER_FIELDS, normalizeAppearance, type Appearance } from './theme/appearance';
import { sanitizeColorVars } from './theme/customColors';

export const LAYOUT_SNAPSHOT_KEY = 'kb.layoutSnapshot.v1';
export const UI_SNAPSHOT_KEY = 'kb.uiSnapshot.v1';
const MAX_CHARS = 1_500_000;

export interface LayoutSnapshotV1 {
  v: 1;
  workspaceId: string;
  name: string;
  project: string;
  layoutSchema: number;
  layout: unknown;
  items: WorkspaceItem[];
  rootIds: string[];
  savedAt: number;
}

export interface UiSnapshotV1 {
  v: 1;
  appearance: Appearance;
  focus: boolean;
  expanded: string[];
  dirView?: unknown;
  sidebarWidth: number;
  /** 非空才写入。自定义配色覆盖，键是 --kb-*。 */
  customColors?: Record<string, string>;
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function browserStore(): Store | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function readJson(storage: Store | null, key: string): unknown {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw || raw.length > MAX_CHARS) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function readLayoutSnapshot(storage: Store | null = browserStore()): LayoutSnapshotV1 | null {
  const v = readJson(storage, LAYOUT_SNAPSHOT_KEY);
  if (!v || typeof v !== 'object') return null;
  const s = v as Partial<LayoutSnapshotV1>;
  if (s.v !== 1 || typeof s.workspaceId !== 'string' || !s.workspaceId) return null;
  if (typeof s.name !== 'string' || !s.layout || typeof s.layout !== 'object') return null;
  if (!Array.isArray(s.items)) return null;
  return {
    v: 1,
    workspaceId: s.workspaceId,
    name: s.name,
    project: typeof s.project === 'string' ? s.project : '',
    layoutSchema: typeof s.layoutSchema === 'number' ? s.layoutSchema : 0,
    layout: s.layout,
    items: s.items as WorkspaceItem[],
    rootIds: Array.isArray(s.rootIds) ? s.rootIds.filter((id) => typeof id === 'string') : [],
    savedAt: typeof s.savedAt === 'number' ? s.savedAt : 0,
  };
}

export function writeLayoutSnapshot(
  dto: { id: string; name: string; project: string; layoutSchema: number; layout: unknown; items: WorkspaceItem[]; rootIds?: string[] },
  storage: Store | null = browserStore(),
): void {
  if (!storage || !dto.id || !dto.layout) return;
  const snap: LayoutSnapshotV1 = {
    v: 1,
    workspaceId: dto.id,
    name: dto.name,
    project: dto.project,
    layoutSchema: dto.layoutSchema,
    layout: dto.layout,
    items: dto.items,
    rootIds: dto.rootIds ?? [],
    savedAt: Date.now(),
  };
  try {
    const text = JSON.stringify(snap);
    if (text.length > MAX_CHARS) return;
    storage.setItem(LAYOUT_SNAPSHOT_KEY, text);
  } catch {
    /* 快照写失败时下次仍从库恢复 */
  }
}

export function patchLayoutSnapshot(workspaceId: string, layout: unknown, items: WorkspaceItem[], storage: Store | null = browserStore()): void {
  const cur = readLayoutSnapshot(storage);
  if (!cur || cur.workspaceId !== workspaceId || !layout) return;
  writeLayoutSnapshot(
    { id: cur.workspaceId, name: cur.name, project: cur.project, layoutSchema: cur.layoutSchema, layout, items, rootIds: cur.rootIds },
    storage,
  );
}

/** 给现有的布局恢复用。时间戳是占位，真正的工作区随后从库里再载入。 */
export function snapshotToWorkspace(s: LayoutSnapshotV1) {
  return {
    id: s.workspaceId,
    name: s.name,
    project: s.project,
    layoutSchema: s.layoutSchema,
    rootIds: s.rootIds,
    panelCount: s.items.length,
    createdAt: 0,
    updatedAt: s.savedAt,
    lastOpenedAt: s.savedAt,
    layout: s.layout,
    items: s.items,
  };
}

function attachRootSlider(appearance: Appearance, root: Record<string, unknown>): Appearance {
  const next = { ...appearance } as Appearance & Record<string, unknown>;
  let added = false;
  for (const key of LEGACY_SCHEME_SLIDER_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(next, key) || !Object.prototype.hasOwnProperty.call(root, key)) continue;
    next[key] = root[key];
    added = true;
  }
  return added ? next : appearance;
}

function appearanceFromSnapshot(raw: unknown, root: Record<string, unknown>): Appearance | null {
  const direct = normalizeAppearance(raw);
  if (direct) return attachRootSlider(direct, root);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = { ...(raw as Record<string, unknown>) };
  for (const key of LEGACY_SCHEME_SLIDER_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(rec, key) && Object.prototype.hasOwnProperty.call(root, key)) rec[key] = root[key];
  }
  const mapped = normalizeAppearance(rec);
  return mapped ? attachRootSlider(mapped, root) : null;
}

export function readUiSnapshot(storage: Store | null = browserStore()): UiSnapshotV1 | null {
  const v = readJson(storage, UI_SNAPSHOT_KEY);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const s = v as Partial<UiSnapshotV1> & Record<string, unknown>;
  if (s.v !== 1) return null;
  const appearance = appearanceFromSnapshot(s.appearance, s);
  if (!appearance) return null;
  const width = typeof s.sidebarWidth === 'number' && s.sidebarWidth >= 180 && s.sidebarWidth <= 600 ? s.sidebarWidth : 280;
  const customColors = sanitizeColorVars(s.customColors);
  const snap: UiSnapshotV1 = {
    v: 1,
    appearance,
    focus: s.focus === true,
    expanded: Array.isArray(s.expanded) ? s.expanded.filter((id) => typeof id === 'string').slice(0, 500) : [],
    dirView: s.dirView,
    sidebarWidth: width,
  };
  if (Object.keys(customColors).length) snap.customColors = customColors;
  return snap;
}

export function writeUiSnapshot(snap: Omit<UiSnapshotV1, 'v'>, storage: Store | null = browserStore()): void {
  if (!storage) return;
  try {
    const prev = readJson(storage, UI_SNAPSHOT_KEY);
    const extras: Record<string, unknown> = {};
    if (prev && typeof prev === 'object' && !Array.isArray(prev)) {
      for (const [key, value] of Object.entries(prev as Record<string, unknown>)) {
        if (key === 'v' || key === 'appearance' || key === 'focus' || key === 'expanded' || key === 'dirView' || key === 'sidebarWidth' || key === 'customColors') continue;
        extras[key] = value;
      }
    }
    const customColors = sanitizeColorVars(snap.customColors);
    const body: Record<string, unknown> = { ...extras, v: 1, ...snap };
    if (Object.keys(customColors).length) body.customColors = customColors;
    else delete body.customColors;
    storage.setItem(UI_SNAPSHOT_KEY, JSON.stringify(body));
  } catch {
    /* 忽略配额错误 */
  }
}

/**
 * 可交互的唯一起因是界面壳已经画出来并且点得动。
 * visible-content-timeout 只说明可见内容等超时了，不能用来打 interactive。
 */
export function shellInteractiveMark(reason: string): 'interactive' | null {
  return reason === 'shell' ? 'interactive' : null;
}
