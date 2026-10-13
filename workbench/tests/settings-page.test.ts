import { describe, expect, it } from 'vitest';
import { emptyStore } from '../src/renderer/keybindings/store';
import { isReservedKey } from '../src/renderer/keybindings/reserved';
import {
  SETTINGS_CATEGORIES,
  SETTINGS_CATEGORY_KEY,
  SETTINGS_SHORTCUT,
  categoryNeedsData,
  readSettingsCategory,
  readStoredSettingsCategory,
  settingsShortcutDecision,
  writeSettingsCategory,
} from '../src/renderer/settings/categories';

describe('统一设置页', () => {
  it('分类含阅读，数据分类和不依赖数据的分类分开', () => {
    expect(SETTINGS_CATEGORIES.map((c) => c.label)).toContain('阅读');
    expect(categoryNeedsData('reading')).toBe(false);
    expect(categoryNeedsData('update')).toBe(false);
    expect(categoryNeedsData('appearance')).toBe(false);
    expect(categoryNeedsData('keybindings')).toBe(false);
    expect(categoryNeedsData('web')).toBe(false);
    expect(categoryNeedsData('about')).toBe(false);
    expect(categoryNeedsData('plugins')).toBe(true);
    expect(categoryNeedsData('workspace')).toBe(true);
    expect(categoryNeedsData('index')).toBe(true);
    expect(categoryNeedsData('ignored')).toBe(true);
    expect(categoryNeedsData('delay')).toBe(true);
  });

  it('上次打开的分类能记下来，不认识的值回到更新', () => {
    const bag = new Map<string, string>();
    const storage = {
      getItem: (k: string) => bag.get(k) ?? null,
      setItem: (k: string, v: string) => {
        bag.set(k, v);
      },
    };
    expect(readStoredSettingsCategory(storage)).toBe('update');
    writeSettingsCategory('reading', storage);
    expect(storage.getItem(SETTINGS_CATEGORY_KEY)).toBe('reading');
    expect(readStoredSettingsCategory(storage)).toBe('reading');
    expect(readSettingsCategory('nope')).toBe('update');
    expect(readStoredSettingsCategory(null)).toBe('update');
  });

  it('Ctrl+, 空闲就绑定，被占用时不改对方的键', () => {
    expect(isReservedKey(SETTINGS_SHORTCUT)).toBeNull();
    const free = settingsShortcutDecision(emptyStore(), [
      { id: 'workbench.commandPalette', title: '显示命令面板', keybinding: 'Ctrl+Shift+P' },
    ]);
    expect(free.keybinding).toBe('Ctrl+,');
    expect(free.conflictId).toBeNull();
    expect(free.reserved).toBe(false);

    const store = emptyStore();
    store.overrides['workbench.commandPalette'] = 'Ctrl+,';
    const cmds = [{ id: 'workbench.commandPalette', title: '显示命令面板', keybinding: 'Ctrl+Shift+P' }];
    const taken = settingsShortcutDecision(store, cmds);
    expect(taken.keybinding).toBeUndefined();
    expect(taken.conflictId).toBe('workbench.commandPalette');
    expect(taken.conflictTitle).toBe('显示命令面板');
    expect(cmds[0]?.keybinding).toBe('Ctrl+Shift+P');
    expect(store.overrides['workbench.commandPalette']).toBe('Ctrl+,');
  });
});
