/** 资料抽屉六卡。顺序是卡片网格，不是下方模块的选择顺序。 */
export const DRAWER_MODULE_IDS = ['root', 'fav', 'web', 'bench', 'agent', 'plugin'] as const;

export type DrawerModuleId = (typeof DRAWER_MODULE_IDS)[number];

export const DRAWER_MODULE_LABEL: Record<DrawerModuleId, string> = {
  root: '根目录',
  fav: '收藏',
  web: '网络资料',
  bench: '工作台资料',
  agent: 'Agent资料',
  plugin: '插件',
};

export const DRAWER_WIDTH_DEFAULT = 360;
export const DRAWER_WIDTH_MIN = 300;
export const DRAWER_WIDTH_MAX = 440;

const ID_SET = new Set<string>(DRAWER_MODULE_IDS);

export function isDrawerModuleId(id: string): id is DrawerModuleId {
  return ID_SET.has(id);
}

/**
 * 去重并丢掉未知 ID，保留第一次出现的位置。
 * 本仓库 src/ 与 tests/ 没有已持久化的「合并工作台」分类 ID，因此不登记旧 ID，也不把未知字符串拆成 bench、agent。
 */
export function normalizeDrawerSelection(ids: readonly unknown[]): DrawerModuleId[] {
  const out: DrawerModuleId[] = [];
  const seen = new Set<DrawerModuleId>();
  for (const id of ids) {
    if (typeof id !== 'string' || !isDrawerModuleId(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** 缺键、null、非数组为空选择。不补六卡。数组再 normalize，顺序保留。 */
export function initialDrawerSelection(raw: unknown): DrawerModuleId[] {
  if (!Array.isArray(raw)) return [];
  return normalizeDrawerSelection(raw);
}

/** 已选则从数组删除；未选则追加到末尾。不按卡片网格重排。 */
export function toggleDrawerSelection(selection: readonly unknown[], id: string): DrawerModuleId[] {
  const current = normalizeDrawerSelection(selection);
  if (!isDrawerModuleId(id)) return current;
  const at = current.indexOf(id);
  if (at >= 0) {
    const next = current.slice();
    next.splice(at, 1);
    return next;
  }
  return [...current, id];
}

export function clampDrawerWidth(width: number): number {
  if (!Number.isFinite(width)) return DRAWER_WIDTH_DEFAULT;
  return Math.min(DRAWER_WIDTH_MAX, Math.max(DRAWER_WIDTH_MIN, width));
}
