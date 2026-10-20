/**
 * 总览里用户自建的项目/标签，以及全部、收藏的卡片顺序。
 * 只增一份 layout 对象。不改工作区字段，不写快照，不写 ENTRY。
 * 纯数据：不写库、不碰剪贴板、不读本机路径。
 */

export const OVERVIEW_BOARDS_KEY = 'settings.overviewBoards';

const MAX_GROUPS = 40;
const MAX_IDS = 200;
const MAX_ORDER = 500;
const MAX_NAME = 40;

export interface OverviewBoardGroup {
  id: string;
  name: string;
  workspaceIds: string[];
}

export interface OverviewBoards {
  v: 1;
  projects: OverviewBoardGroup[];
  tags: OverviewBoardGroup[];
  /** 「全部」页的卡片顺序。空则用默认顺序。 */
  allOrder: string[];
  /** 「收藏」页的卡片顺序。空则按名称。 */
  favoriteOrder: string[];
  /**
   * 用户新建的分类。只增这一项。
   * 旧的项目、标签分组仍写在 projects、tags，不改名、不挪走。
   * 缺省当作空数组。
   */
  categories?: OverviewBoardGroup[];
}

/** 侧栏里的一条分类。projects、tags 是从旧分组读出来的，custom 来自 categories。 */
export interface OverviewCategory {
  id: string;
  name: string;
  workspaceIds: string[];
  origin: 'projects' | 'tags' | 'custom';
}

const DEFAULT_CATEGORY_IDS = new Set(['all', 'recent', 'favorites']);

export type OverviewBoardKind = 'projects' | 'tags';

export const EMPTY_OVERVIEW_BOARDS: OverviewBoards = {
  v: 1,
  projects: [],
  tags: [],
  allOrder: [],
  favoriteOrder: [],
  categories: [],
};

export interface PickerWorkspace {
  id: string;
  name: string;
  lastUsedAt: number | null;
}

function emptyBoards(): OverviewBoards {
  return { v: 1, projects: [], tags: [], allOrder: [], favoriteOrder: [], categories: [] };
}

export function isDefaultOverviewCategory(id: string): boolean {
  return DEFAULT_CATEGORY_IDS.has(id);
}

function cleanId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  if (!id || id.length > 80) return null;
  if (/[\u0000-\u001f\\/]/.test(id) || id.includes('..') || /^[A-Za-z]:/.test(id)) return null;
  return id;
}

function cleanIdList(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const id = cleanId(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

/** 去掉控制符和斜杠，拒绝盘符。空名称返回 null。 */
export function cleanBoardName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().replace(/[\u0000-\u001f\\/]/g, '');
  if (!name || /^[A-Za-z]:/.test(name) || name.startsWith('~')) return null;
  const chars = Array.from(name);
  return chars.slice(0, MAX_NAME).join('');
}

function parseGroups(raw: unknown): OverviewBoardGroup[] {
  if (!Array.isArray(raw)) return [];
  const index = new Map<string, OverviewBoardGroup>();
  const out: OverviewBoardGroup[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const id = cleanId(rec.id);
    if (!id) continue;
    const ids = cleanIdList(rec.workspaceIds, MAX_IDS);
    const prev = index.get(id);
    if (prev) {
      prev.workspaceIds = cleanIdList([...prev.workspaceIds, ...ids], MAX_IDS);
      continue;
    }
    const name = cleanBoardName(rec.name);
    if (!name || out.length >= MAX_GROUPS) continue;
    const group: OverviewBoardGroup = { id, name, workspaceIds: ids };
    index.set(id, group);
    out.push(group);
  }
  return out;
}

/** 后面的列表若和前面撞了同一个 id，把工作区 id 并进先出现的那条，后面不再单列。 */
function absorbGroups(primary: readonly OverviewBoardGroup[], extra: readonly OverviewBoardGroup[]): OverviewBoardGroup[] {
  const known = new Map(primary.map((group) => [group.id, group]));
  const out: OverviewBoardGroup[] = [];
  for (const group of extra) {
    const prev = known.get(group.id);
    if (prev) {
      prev.workspaceIds = cleanIdList([...prev.workspaceIds, ...group.workspaceIds], MAX_IDS);
      continue;
    }
    known.set(group.id, group);
    out.push(group);
  }
  return out;
}

/** 缺键、空值、认不出的 v：空分组。不修改入参。未知字段丢掉。 */
export function parseOverviewBoards(raw: unknown): OverviewBoards {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyBoards();
  const rec = raw as Record<string, unknown>;
  if (rec.v !== undefined && rec.v !== 1) return emptyBoards();
  const projects = parseGroups(rec.projects);
  const tags = absorbGroups(projects, parseGroups(rec.tags));
  const categories = absorbGroups([...projects, ...tags], parseGroups(rec.categories));
  return {
    v: 1,
    projects,
    tags,
    allOrder: cleanIdList(rec.allOrder, MAX_ORDER),
    favoriteOrder: cleanIdList(rec.favoriteOrder, MAX_ORDER),
    categories,
  };
}

export function serializeOverviewBoards(boards: OverviewBoards): OverviewBoards {
  return parseOverviewBoards(boards);
}

/** 丢掉已经不在工作区列表里的 id。分组本身留着。 */
export function retainOverviewWorkspaces(boards: OverviewBoards, savedIds: ReadonlySet<string>): OverviewBoards {
  const keep = (ids: readonly string[]) => ids.filter((id) => savedIds.has(id));
  return serializeOverviewBoards({
    v: 1,
    projects: boards.projects.map((group) => ({ ...group, workspaceIds: keep(group.workspaceIds) })),
    tags: boards.tags.map((group) => ({ ...group, workspaceIds: keep(group.workspaceIds) })),
    allOrder: keep(boards.allOrder),
    favoriteOrder: keep(boards.favoriteOrder),
    categories: (boards.categories ?? []).map((group) => ({ ...group, workspaceIds: keep(group.workspaceIds) })),
  });
}

function nextGroupId(groups: readonly { id: string }[], prefix: string): string {
  const used = new Set(groups.map((group) => group.id));
  let n = 1;
  while (used.has(`${prefix}-${n}`)) n += 1;
  return `${prefix}-${n}`;
}

function allStoredGroups(boards: OverviewBoards): OverviewBoardGroup[] {
  return [...boards.projects, ...boards.tags, ...(boards.categories ?? [])];
}

/** 旧的项目、标签分组和新建分类，合成侧栏用的分类列表。不改入参。 */
export function listOverviewCategories(boards: OverviewBoards | null | undefined): OverviewCategory[] {
  const parsed = parseOverviewBoards(boards ?? null);
  return [
    ...parsed.projects.map((group) => ({ ...group, origin: 'projects' as const })),
    ...parsed.tags.map((group) => ({ ...group, origin: 'tags' as const })),
    ...(parsed.categories ?? []).map((group) => ({ ...group, origin: 'custom' as const })),
  ];
}

/** 分类1、分类2…。只看已有名称里的编号，空列表从 1 开始。 */
export function nextCategoryName(groups: readonly { name: string }[]): string {
  const re = /^分类(\d+)$/;
  let max = 0;
  for (const group of groups) {
    const matched = re.exec(group.name.trim());
    if (!matched) continue;
    const n = Number(matched[1]);
    if (Number.isFinite(n) && n > max) max = Math.trunc(n);
  }
  return `分类${max + 1}`;
}

/** 新建一条空的自定义分类。分类已满或名称洗不成时返回原对象。 */
export function addOverviewCategory(boards: OverviewBoards, name?: string): OverviewBoards {
  const categories = boards.categories ?? [];
  if (categories.length >= MAX_GROUPS) return boards;
  const clean = name === undefined ? nextCategoryName(allStoredGroups(boards)) : cleanBoardName(name);
  if (!clean) return boards;
  const group: OverviewBoardGroup = {
    id: nextGroupId(allStoredGroups(boards), 'c'),
    name: clean,
    workspaceIds: [],
  };
  return { ...boards, categories: [...categories, group] };
}

function mapStored(
  boards: OverviewBoards,
  visit: (group: OverviewBoardGroup) => OverviewBoardGroup,
): { boards: OverviewBoards; changed: boolean } {
  let changed = false;
  const mapList = (groups: readonly OverviewBoardGroup[]) =>
    groups.map((group) => {
      const next = visit(group);
      if (next !== group) changed = true;
      return next;
    });
  const projects = mapList(boards.projects);
  const tags = mapList(boards.tags);
  const categories = mapList(boards.categories ?? []);
  if (!changed) return { boards, changed: false };
  return { boards: { ...boards, projects, tags, categories }, changed: true };
}

/** 全部、最近、收藏以及不存在的 id：返回原对象。 */
export function renameOverviewCategory(boards: OverviewBoards, categoryId: string, name: string): OverviewBoards {
  if (isDefaultOverviewCategory(categoryId)) return boards;
  const clean = cleanBoardName(name);
  if (!clean) return boards;
  return mapStored(boards, (group) => {
    if (group.id !== categoryId || group.name === clean) return group;
    return { ...group, name: clean };
  }).boards;
}

/**
 * 删掉分类本身。工作区 id 只从这一条拿掉，其它分类不动。
 * 全部、最近、收藏不可删，返回原对象。
 */
export function deleteOverviewCategory(boards: OverviewBoards, categoryId: string): OverviewBoards {
  if (isDefaultOverviewCategory(categoryId)) return boards;
  const categories = boards.categories ?? [];
  const projects = boards.projects.filter((group) => group.id !== categoryId);
  const tags = boards.tags.filter((group) => group.id !== categoryId);
  const nextCategories = categories.filter((group) => group.id !== categoryId);
  if (projects.length === boards.projects.length && tags.length === boards.tags.length && nextCategories.length === categories.length) {
    return boards;
  }
  return { ...boards, projects, tags, categories: nextCategories };
}

/** 把工作区加进一条分类。已在里面的不再加第二次。默认分类和未知分类返回原对象。 */
export function addWorkspacesToCategory(boards: OverviewBoards, categoryId: string, workspaceIds: readonly string[]): OverviewBoards {
  if (isDefaultOverviewCategory(categoryId)) return boards;
  const incoming = cleanIdList(workspaceIds, MAX_IDS);
  if (!incoming.length) return boards;
  return mapStored(boards, (group) => {
    if (group.id !== categoryId) return group;
    const have = new Set(group.workspaceIds);
    const extra = incoming.filter((id) => !have.has(id));
    if (!extra.length) return group;
    return { ...group, workspaceIds: cleanIdList([...group.workspaceIds, ...extra], MAX_IDS) };
  }).boards;
}

/**
 * 从一条分类里拿走一个工作区引用。
 * 不碰其它分类里的同一 id。同一条里的重复 id 一并收掉，避免删一个、另一个还占着同一个键。
 */
export function removeWorkspaceFromCategory(boards: OverviewBoards, categoryId: string, workspaceId: string): OverviewBoards {
  if (isDefaultOverviewCategory(categoryId)) return boards;
  const id = cleanId(workspaceId);
  if (!id) return boards;
  return mapStored(boards, (group) => {
    if (group.id !== categoryId || !group.workspaceIds.includes(id)) return group;
    return { ...group, workspaceIds: group.workspaceIds.filter((item) => item !== id) };
  }).boards;
}

/** 有最近时间的在前，空的在后。同一时刻再按名称。 */
export function sortPickerWorkspaces(rows: readonly PickerWorkspace[]): PickerWorkspace[] {
  return rows.slice().sort((a, b) => {
    const aOk = typeof a.lastUsedAt === 'number' && Number.isFinite(a.lastUsedAt);
    const bOk = typeof b.lastUsedAt === 'number' && Number.isFinite(b.lastUsedAt);
    if (aOk && bOk && a.lastUsedAt !== b.lastUsedAt) return (b.lastUsedAt as number) - (a.lastUsedAt as number);
    if (aOk !== bOk) return aOk ? -1 : 1;
    const byName = a.name.localeCompare(b.name, 'zh');
    if (byName !== 0) return byName;
    return a.id.localeCompare(b.id, 'en');
  });
}

/** 同一天显示时:分，更早的显示月/日。没有时间返回空串。 */
export function formatPickerStamp(at: number | null, now = Date.now()): string {
  if (at == null || !Number.isFinite(at)) return '';
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return '';
  const today = new Date(now);
  const pad = (value: number) => String(value).padStart(2, '0');
  if (when.getFullYear() === today.getFullYear() && when.getMonth() === today.getMonth() && when.getDate() === today.getDate()) {
    return `${pad(when.getHours())}:${pad(when.getMinutes())}`;
  }
  return `${when.getMonth() + 1}/${when.getDate()}`;
}

/** 选择窗和卡片用的相对时间。没有时间返回空串。 */
export function formatRelativeStamp(at: number | null, now = Date.now()): string {
  if (at == null || !Number.isFinite(at)) return '';
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return '';
  const delta = now - at;
  if (delta < 0) return formatPickerStamp(at, now);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return '刚刚';
  if (delta < hour) return `${Math.max(1, Math.floor(delta / minute))} 分钟前`;
  if (delta < day) return `${Math.max(1, Math.floor(delta / hour))} 小时前`;
  const today = new Date(now);
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startWhen = new Date(when.getFullYear(), when.getMonth(), when.getDate()).getTime();
  const dayDiff = Math.round((startToday - startWhen) / day);
  if (dayDiff <= 0) return formatPickerStamp(at, now);
  if (dayDiff === 1) return '昨天';
  if (dayDiff < 7) return `${dayDiff} 天前`;
  if (dayDiff < 14) return '上周';
  return formatPickerStamp(at, now);
}
