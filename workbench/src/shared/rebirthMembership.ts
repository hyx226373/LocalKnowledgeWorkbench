/** 全局 Agent 库成员清单。与 index.json 同目录的 membership.json，不进 snapshot / ENTRY。 */

export interface MembershipItem {
  /** 生成时的工作区 id。null 表示升级前未记。 */
  origin: string | null;
  /** 引用这份文件的工作区。同一 id 只出现一次。 */
  members: string[];
}

export interface MembershipFile {
  v: 1;
  items: Record<string, MembershipItem>;
}

export interface LibraryFile {
  id: string;
  title: string;
  fileName: string;
  origin: string | null;
  members: string[];
  bytes: number;
  mtimeMs: number;
  missing: boolean;
  folder: string;
}

export interface LibraryPreview {
  id: string;
  title: string;
  fileName: string;
  text: string;
  bytes: number;
  mtimeMs: number;
  origin: string | null;
}

export const UNRECORDED_LABEL = '升级前未记来源';

const REBIRTH_ID = /^R[1-9]\d*$/;

export function emptyMembership(): MembershipFile {
  return { v: 1, items: {} };
}

export function uniqIds(ids: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const text = typeof id === 'string' ? id.trim() : '';
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

export function normalizeMembership(raw: unknown): MembershipFile {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as { items?: unknown }).items
    : null;
  const items: Record<string, MembershipItem> = {};
  if (!source || typeof source !== 'object' || Array.isArray(source)) return { v: 1, items };
  for (const [id, value] of Object.entries(source as Record<string, unknown>)) {
    if (!REBIRTH_ID.test(id) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as { origin?: unknown; members?: unknown };
    const origin = typeof row.origin === 'string' && row.origin.trim() ? row.origin.trim() : null;
    const members = Array.isArray(row.members) ? uniqIds(row.members) : [];
    items[id] = { origin, members };
  }
  return { v: 1, items };
}

/** C.3：第一次没有 membership.json 时，当时每个已登记文件对当时全部工作区可见，来源未记。 */
export function migrateMembership(registeredIds: readonly string[], workspaceIds: readonly string[]): MembershipFile {
  const members = uniqIds(workspaceIds);
  const items: Record<string, MembershipItem> = {};
  for (const id of uniqIds(registeredIds)) {
    if (!REBIRTH_ID.test(id)) continue;
    items[id] = { origin: null, members: [...members] };
  }
  return { v: 1, items };
}

/** 新文件来源 = 生成那一刻的当前工作区。没有当前区则只进全局库。 */
export function membershipForNewFile(workspaceId: string | null | undefined): MembershipItem {
  const id = typeof workspaceId === 'string' ? workspaceId.trim() : '';
  if (!id) return { origin: null, members: [] };
  return { origin: id, members: [id] };
}

export function memberIdSet(file: MembershipFile, workspaceId: string): Set<string> {
  const ws = workspaceId.trim();
  const out = new Set<string>();
  if (!ws) return out;
  for (const [id, item] of Object.entries(file.items)) {
    if (item.members.includes(ws)) out.add(id);
  }
  return out;
}

export interface MemberTreeFolder<T> {
  name?: string;
  items?: T[];
  children?: MemberTreeFolder<T>[];
}

/** 侧栏只留 members 含当前工作区的项。空文件夹不画。 */
export function filterMemberTree<T extends { id: string }>(
  folders: readonly MemberTreeFolder<T>[],
  rootItems: readonly T[],
  allow: ReadonlySet<string>,
): { folders: MemberTreeFolder<T>[]; items: T[] } {
  const walk = (folder: MemberTreeFolder<T>): MemberTreeFolder<T> | null => {
    const children = (folder.children ?? []).map(walk).filter((item): item is MemberTreeFolder<T> => item !== null);
    const items = (folder.items ?? []).filter((item) => allow.has(item.id));
    if (!children.length && !items.length) return null;
    return { ...folder, children, items };
  };
  return {
    folders: folders.map(walk).filter((item): item is MemberTreeFolder<T> => item !== null),
    items: rootItems.filter((item) => allow.has(item.id)),
  };
}

export interface SourceGroup {
  key: string;
  label: string;
  ids: string[];
}

/** 左栏：第一组「全部」（含升级前文件），下面按工作台，最后是来源未记。 */
export function sourceGroups(
  files: readonly { id: string; origin: string | null }[],
  workspaces: readonly { id: string; name: string }[],
): SourceGroup[] {
  const groups: SourceGroup[] = [{ key: 'all', label: '全部', ids: files.map((file) => file.id) }];
  const byOrigin = new Map<string, string[]>();
  const unrecorded: string[] = [];
  for (const file of files) {
    if (!file.origin) unrecorded.push(file.id);
    else {
      const list = byOrigin.get(file.origin) ?? [];
      list.push(file.id);
      byOrigin.set(file.origin, list);
    }
  }
  const seen = new Set<string>();
  for (const ws of workspaces) {
    const id = ws.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    groups.push({ key: `ws:${id}`, label: ws.name.trim() || id, ids: byOrigin.get(id) ?? [] });
  }
  for (const [id, ids] of byOrigin) {
    if (seen.has(id)) continue;
    groups.push({ key: `ws:${id}`, label: id, ids });
  }
  if (unrecorded.length) groups.push({ key: 'unrecorded', label: UNRECORDED_LABEL, ids: unrecorded });
  return groups;
}

export interface MembershipPlan {
  next: MembershipFile;
  added: string[];
  removed: string[];
}

/**
 * 确认：勾选的加入当前工作区（已在成员里的不重复添加），取消勾选的只移出本工作区。
 * 不碰文件字节。knownIds 以外的 id 忽略。
 */
export function planMembershipChange(
  file: MembershipFile,
  workspaceId: string,
  checkedIds: readonly string[],
  knownIds: readonly string[],
): MembershipPlan {
  const ws = workspaceId.trim();
  if (!ws) throw new Error('没有当前工作区');
  const checked = new Set(uniqIds(checkedIds));
  const known = uniqIds(knownIds).filter((id) => REBIRTH_ID.test(id));
  const added: string[] = [];
  const removed: string[] = [];
  const items: Record<string, MembershipItem> = {};
  for (const [id, item] of Object.entries(file.items)) {
    items[id] = { origin: item.origin, members: uniqIds(item.members) };
  }
  for (const id of known) {
    const prev = items[id] ?? { origin: null, members: [] as string[] };
    const was = prev.members.includes(ws);
    const now = checked.has(id);
    let members = prev.members;
    if (!was && now) {
      members = uniqIds([...prev.members, ws]);
      added.push(id);
    } else if (was && !now) {
      members = prev.members.filter((member) => member !== ws);
      removed.push(id);
    }
    items[id] = { origin: prev.origin, members };
  }
  return { next: { v: 1, items }, added, removed };
}

/** 换工作区不搬重生根。根路径与工作区 id 无关。 */
export function rebirthRootAfterWorkspaceChange(root: string, _workspaceId: string | null | undefined): string {
  return root;
}
