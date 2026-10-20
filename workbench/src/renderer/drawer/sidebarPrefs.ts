import { useSyncExternalStore } from 'react';

/** 只保存侧栏外观，不写入工作区、索引或模块启用数据。 */
export const SIDEBAR_PREFS_KEY = 'kb.sidebar.ui';
/** 文件：dragstart 里 preventDefault 后 startDrag。路径：text/plain 写绝对路径，不调用 startDrag。 */
export type DragOutMode = 'file' | 'path';

/** 大图标卡片四档尺寸。 */
export type CardSize = 'sm' | 'md' | 'lg' | 'xl';
const VALID_CARD_SIZES: ReadonlySet<string> = new Set<CardSize>(['sm', 'md', 'lg', 'xl']);

export type SidebarPrefs = {
  categoriesCollapsed: boolean;
  ribbonCollapsed: boolean;
  categoriesLayout: 'grid' | 'list';
  hideUnopenableFiles: boolean;
  dragOutMode: DragOutMode;
  cardSize: CardSize;
};
export const DEFAULT_SIDEBAR_PREFS: SidebarPrefs = {
  categoriesCollapsed: false,
  ribbonCollapsed: false,
  categoriesLayout: 'grid',
  hideUnopenableFiles: true,
  dragOutMode: 'file',
  cardSize: 'lg',
};

export function parseSidebarPrefs(raw: unknown): SidebarPrefs {
  const value = raw as Partial<SidebarPrefs> | null;
  return {
    categoriesCollapsed: typeof value?.categoriesCollapsed === 'boolean' ? value.categoriesCollapsed : false,
    ribbonCollapsed: typeof value?.ribbonCollapsed === 'boolean' ? value.ribbonCollapsed : false,
    categoriesLayout: value?.categoriesLayout === 'list' ? 'list' : 'grid',
    hideUnopenableFiles: typeof value?.hideUnopenableFiles === 'boolean' ? value.hideUnopenableFiles : true,
    dragOutMode: value?.dragOutMode === 'path' ? 'path' : 'file',
    cardSize: typeof value?.cardSize === 'string' && VALID_CARD_SIZES.has(value.cardSize) ? value.cardSize as CardSize : 'lg',
  };
}

let cache: SidebarPrefs | undefined;
const listeners = new Set<() => void>();
function read(): SidebarPrefs {
  if (!cache) {
    try { cache = parseSidebarPrefs(JSON.parse(localStorage.getItem(SIDEBAR_PREFS_KEY) ?? 'null')); }
    catch { cache = { ...DEFAULT_SIDEBAR_PREFS }; }
  }
  return cache;
}

export function getSidebarPrefs(): SidebarPrefs {
  return read();
}

export function updateSidebarPrefs(patch: Partial<SidebarPrefs>) {
  cache = parseSidebarPrefs({ ...read(), ...patch });
  try { localStorage.setItem(SIDEBAR_PREFS_KEY, JSON.stringify(cache)); }
  catch { /* 无存储时保留本次会话偏好。 */ }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== SIDEBAR_PREFS_KEY && event.key !== null) return;
    cache = undefined;
    listeners.forEach((fn) => fn());
  };
  globalThis.addEventListener?.('storage', onStorage);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener?.('storage', onStorage);
  };
}

export function useSidebarPrefs() {
  return useSyncExternalStore(subscribe, read, read);
}
