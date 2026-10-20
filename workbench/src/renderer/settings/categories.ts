/**
 * 设置页分类和 Ctrl+, 的冲突判断。只读已有绑定，不改别人的快捷键。
 */
import { findConflict } from '../keybindings/store';
import { isReservedKey } from '../keybindings/reserved';
import type { KeybindingsStoreV1 } from '../keybindings/types';

export const SETTINGS_COMMAND_ID = 'app.settings.open';
export const SETTINGS_SHORTCUT = 'Ctrl+,';
export const SETTINGS_CATEGORY_KEY = 'kb.settings.category';

export const SETTINGS_CATEGORIES = [
  { id: 'update', label: '更新', needsData: false },
  { id: 'appearance', label: '外观', needsData: false },
  { id: 'keybindings', label: '快捷键', needsData: false },
  { id: 'plugins', label: '插件与开发者模式', needsData: true },
  { id: 'workspace', label: '工作区启动', needsData: true },
  { id: 'rebirth', label: '重生仓库', needsData: false },
  { id: 'agentData', label: 'Agent 数据', needsData: false },
  { id: 'aiWrite', label: 'AI 写入通道', needsData: false },
  { id: 'web', label: '网页外部资源授权', needsData: false },
  { id: 'index', label: '索引', needsData: true },
  { id: 'ignored', label: '显示被忽略的文件', needsData: true },
  { id: 'delay', label: '后台加载延迟', needsData: true },
  { id: 'reading', label: '阅读', needsData: false },
  { id: 'obsidian', label: 'Obsidian', needsData: false },
  { id: 'about', label: '关于', needsData: false },
] as const;

export type SettingsCategoryId = (typeof SETTINGS_CATEGORIES)[number]['id'];

const CATEGORY_IDS = new Set<string>(SETTINGS_CATEGORIES.map((c) => c.id));

export function isSettingsCategory(id: string | null | undefined): id is SettingsCategoryId {
  return !!id && CATEGORY_IDS.has(id);
}

export function categoryNeedsData(id: SettingsCategoryId): boolean {
  return SETTINGS_CATEGORIES.find((c) => c.id === id)?.needsData === true;
}

export function readSettingsCategory(raw: string | null | undefined): SettingsCategoryId {
  return isSettingsCategory(raw) ? raw : 'update';
}

export function readStoredSettingsCategory(storage: { getItem(key: string): string | null } | null | undefined): SettingsCategoryId {
  try {
    return readSettingsCategory(storage?.getItem(SETTINGS_CATEGORY_KEY) ?? null);
  } catch {
    return 'update';
  }
}

export function writeSettingsCategory(id: SettingsCategoryId, storage: { setItem(key: string, value: string): void }): void {
  storage.setItem(SETTINGS_CATEGORY_KEY, id);
}

export interface ShortcutCommand {
  id: string;
  title: string;
  keybinding?: string;
  when?: 'global' | 'editorFocus' | 'treeFocus' | 'webFocus';
  category?: string;
  trigger?: 'key' | 'wheel';
}

export interface SettingsShortcutDecision {
  /** 可以绑定才有值。占用或保留键时不设，调用方不得改已有命令。 */
  keybinding?: string;
  reserved: boolean;
  conflictId: string | null;
  conflictTitle: string | null;
}

export function settingsShortcutDecision(store: KeybindingsStoreV1, commands: ShortcutCommand[]): SettingsShortcutDecision {
  if (isReservedKey(SETTINGS_SHORTCUT)) {
    return { reserved: true, conflictId: null, conflictTitle: null };
  }
  const other = findConflict(store, commands, SETTINGS_COMMAND_ID, SETTINGS_SHORTCUT, 'global');
  if (other) {
    return { reserved: false, conflictId: other.id, conflictTitle: other.title };
  }
  return { keybinding: SETTINGS_SHORTCUT, reserved: false, conflictId: null, conflictTitle: null };
}
