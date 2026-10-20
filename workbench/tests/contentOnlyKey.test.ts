import { describe, expect, it } from 'vitest';
import {
  CONTENT_ONLY_COMMAND_ID,
  CONTENT_ONLY_DEFAULT_KEY,
  CONTENT_ONLY_PROTECTED_KEYS,
  CONTENT_ONLY_TITLE,
  bindContentOnlyCommand,
  contentOnlyCommandDraft,
  decideContentOnlyKey,
  formatContentOnlyConflict,
} from '../src/renderer/chrome-layout/contentOnlyKey';
import { findConflict, emptyStore, setKeybinding } from '../src/renderer/keybindings/store';

describe('contentOnlyKey · 默认键冲突不覆盖', () => {
  it('无冲突时分配 Ctrl+Shift+F11', () => {
    const d = decideContentOnlyKey({ builtinActions: [], pluginCommands: [], userBindings: [] });
    expect(d.assignDefaultKey).toBe(true);
    expect(d.requestedKey).toBe('Ctrl+Shift+F11');
    expect(d.wroteOverride).toBe(false);
    expect(d.usedReplace).toBe(false);
    expect(contentOnlyCommandDraft(d).keybinding).toBe(CONTENT_ONLY_DEFAULT_KEY);
  });

  it('内置占用时跳过默认键并报告', () => {
    const d = decideContentOnlyKey({
      builtinActions: [{ id: 'other.cmd', title: '别的命令', keybinding: 'Ctrl+Shift+F11' }],
      pluginCommands: [],
      userBindings: [],
    });
    expect(d.assignDefaultKey).toBe(false);
    expect(d.report?.skippedDefaultKey).toBe(true);
    expect(d.report?.parties[0].id).toBe('other.cmd');
    expect(formatContentOnlyConflict(d.report!)).toContain('不覆盖');
    expect(contentOnlyCommandDraft(d).keybinding).toBeUndefined();
  });

  it('用户绑定冲突不写 override', () => {
    const d = decideContentOnlyKey({
      builtinActions: [],
      pluginCommands: [],
      userBindings: [{ id: 'user.x', title: '用户命令', key: 'Ctrl+Shift+F11' }],
    });
    expect(d.assignDefaultKey).toBe(false);
    expect(d.wroteOverride).toBe(false);
    expect(d.usedReplace).toBe(false);
  });

  it('findConflict 与设置页文案可发现', () => {
    const cmds = [
      { id: CONTENT_ONLY_COMMAND_ID, title: CONTENT_ONLY_TITLE, keybinding: CONTENT_ONLY_DEFAULT_KEY },
      { id: 'taken', title: '已被占用', keybinding: 'Ctrl+Shift+F11' },
    ];
    const hit = findConflict(emptyStore(), cmds, CONTENT_ONLY_COMMAND_ID, CONTENT_ONLY_DEFAULT_KEY, 'global');
    expect(hit?.id).toBe('taken');
    const r = setKeybinding(emptyStore(), cmds, CONTENT_ONLY_COMMAND_ID, CONTENT_ONLY_DEFAULT_KEY);
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === 'conflict') {
      expect(r.otherTitle).toBe('已被占用');
    }
  });

  it('保护键集合含命令面板/快速切换/F11', () => {
    expect(CONTENT_ONLY_PROTECTED_KEYS).toEqual(['Ctrl+Shift+P', 'Ctrl+Shift+F', 'F11']);
  });

  it('bind 始终登记命令；冲突时无 keybinding', () => {
    const registered: { id: string; keybinding?: string }[] = [];
    const d = decideContentOnlyKey({
      builtinActions: [{ id: 'x', title: 'x', keybinding: 'Ctrl+Shift+F11' }],
      pluginCommands: [],
      userBindings: [],
    });
    const report = bindContentOnlyCommand(
      (c) => registered.push({ id: c.id, keybinding: c.keybinding }),
      d,
      () => {},
    );
    expect(registered[0].id).toBe(CONTENT_ONLY_COMMAND_ID);
    expect(registered[0].keybinding).toBeUndefined();
    expect(report?.reason).toContain('不覆盖');
  });
});
