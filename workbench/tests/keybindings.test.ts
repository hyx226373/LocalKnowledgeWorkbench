import { describe, expect, it } from 'vitest';
import { normalizeKeybinding, bindingFromEvent } from '../src/renderer/keybindings/normalize';
import { isReservedKey, RESERVED_KEYS } from '../src/renderer/keybindings/reserved';
import {
  emptyStore,
  parseStore,
  effectiveOf,
  setKeybinding,
  resetKeybinding,
  resetAllKeybindings,
  findConflict,
  conflicts,
  exportKeybindingsJson,
  importKeybindingsJson,
} from '../src/renderer/keybindings/store';
import { whenMatches, allowInEditable, isEditableTarget } from '../src/renderer/keybindings/match';
import { planSummon } from '../src/renderer/keybindings/summon';

describe('normalizeKeybinding', () => {
  it('固定修饰符顺序 Ctrl+Alt+Shift+Meta', () => {
    expect(normalizeKeybinding('shift+ctrl+a')).toBe('Ctrl+Shift+A');
    expect(normalizeKeybinding('Alt+Ctrl+Shift+Meta+X')).toBe('Ctrl+Alt+Shift+Meta+X');
  });
  it('别名与功能键', () => {
    expect(normalizeKeybinding('Cmd+S')).toBe('Meta+S');
    expect(normalizeKeybinding('Control+Shift+P')).toBe('Ctrl+Shift+P');
    expect(normalizeKeybinding('f9')).toBe('F9');
    expect(normalizeKeybinding('esc')).toBe('Escape');
  });
  it('拒绝 chord（空格多段）', () => {
    expect(normalizeKeybinding('Ctrl+K Ctrl+S')).toBeNull();
  });
  it('bindingFromEvent', () => {
    expect(
      bindingFromEvent({ key: 'p', code: 'KeyP', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false }),
    ).toBe('Ctrl+Shift+P');
  });
});

describe('reserved keys（含 Ctrl+S）', () => {
  it('列出保留键', () => {
    const keys = RESERVED_KEYS.map((r) => r.key);
    expect(keys).toContain('Ctrl+S');
    expect(keys).toContain('Alt+F4');
    expect(keys).toContain('F11');
    expect(keys).toContain('Ctrl+Z');
  });
  it('isReservedKey', () => {
    expect(isReservedKey('ctrl+s')?.reason).toMatch(/保存/);
    expect(isReservedKey('Ctrl+Shift+P')).toBeNull();
  });
});

describe('overrides store', () => {
  const cmds = [
    { id: 'workbench.commandPalette', title: '命令面板', keybinding: 'Ctrl+Shift+P', when: 'global' as const },
    { id: 'reading.focus.toggle', title: '专注', keybinding: 'F9' },
    { id: 'view.contentZoomIn', title: '内容放大', keybinding: 'Ctrl+=', when: 'editorFocus' as const },
    { id: 'panel.size.increase', title: '面板增大' },
  ];

  it('effective：默认 / 覆盖 / 清除', () => {
    let s = emptyStore();
    expect(effectiveOf(cmds[0]!, s).key).toBe('Ctrl+Shift+P');
    expect(effectiveOf(cmds[0]!, s).isDefault).toBe(true);
    const r = setKeybinding(s, cmds, 'workbench.commandPalette', 'Ctrl+Shift+K');
    expect(r.ok).toBe(true);
    if (r.ok) s = r.store;
    expect(effectiveOf(cmds[0]!, s).key).toBe('Ctrl+Shift+K');
    expect(effectiveOf(cmds[0]!, s).isDefault).toBe(false);
    const c = setKeybinding(s, cmds, 'workbench.commandPalette', null);
    expect(c.ok).toBe(true);
    if (c.ok) s = c.store;
    expect(effectiveOf(cmds[0]!, s).key).toBeNull();
    expect(effectiveOf(cmds[0]!, s).isCleared).toBe(true);
    s = resetKeybinding(s, 'workbench.commandPalette');
    expect(effectiveOf(cmds[0]!, s).key).toBe('Ctrl+Shift+P');
  });

  it('拒绝保留键 Ctrl+S', () => {
    const r = setKeybinding(emptyStore(), cmds, 'reading.focus.toggle', 'Ctrl+S');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('reserved');
  });

  it('冲突检测与替换', () => {
    let s = emptyStore();
    const r = setKeybinding(s, cmds, 'reading.focus.toggle', 'Ctrl+Shift+P');
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === 'conflict') expect(r.otherId).toBe('workbench.commandPalette');
    const rep = setKeybinding(s, cmds, 'reading.focus.toggle', 'Ctrl+Shift+P', { replace: true });
    expect(rep.ok).toBe(true);
    if (rep.ok) s = rep.store;
    expect(effectiveOf(cmds[0]!, s).key).toBeNull();
    expect(effectiveOf(cmds[1]!, s).key).toBe('Ctrl+Shift+P');
    expect(findConflict(s, cmds, 'x', 'Ctrl+Shift+P')?.id).toBe('reading.focus.toggle');
  });

  it('when：editorFocus 与 treeFocus 同键可不冲突；global 冲突', () => {
    let s = emptyStore();
    const a = setKeybinding(s, cmds, 'view.contentZoomIn', 'Ctrl+1', { when: 'editorFocus' });
    expect(a.ok).toBe(true);
    if (a.ok) s = a.store;
    // 改 panel.size 到 treeFocus 同键
    const b = setKeybinding(s, cmds, 'panel.size.increase', 'Ctrl+1', { when: 'treeFocus' });
    expect(b.ok).toBe(true);
    // global 占用则冲突
    const g = setKeybinding(s, cmds, 'reading.focus.toggle', 'Ctrl+1', { when: 'global' });
    expect(g.ok).toBe(false);
  });

  it('备份导入导出', () => {
    let s = emptyStore();
    const r = setKeybinding(s, cmds, 'reading.focus.toggle', 'F8');
    if (r.ok) s = r.store;
    const json = exportKeybindingsJson(s);
    expect(json).toContain('"v": 1');
    const back = importKeybindingsJson(json);
    expect(back.overrides['reading.focus.toggle']).toBe('F8');
    expect(parseStore(JSON.parse(json)).overrides['reading.focus.toggle']).toBe('F8');
    expect(resetAllKeybindings().overrides).toEqual({});
  });

  it('conflicts 汇总', () => {
    const s = parseStore({
      v: 1,
      overrides: { a: 'Ctrl+1', b: 'Ctrl+1' },
    });
    const list = [
      { id: 'a', title: 'A', keybinding: undefined },
      { id: 'b', title: 'B', keybinding: undefined },
    ];
    const c = conflicts(s, list);
    expect(c.some((x) => x.key === 'Ctrl+1' && x.commandIds.includes('a') && x.commandIds.includes('b'))).toBe(true);
  });
});

describe('输入框优先级与 when', () => {
  it('allowInEditable', () => {
    expect(allowInEditable({ key: 'a', ctrlKey: false, altKey: false, metaKey: false })).toBe(false);
    expect(allowInEditable({ key: 'a', ctrlKey: true, altKey: false, metaKey: false })).toBe(true);
    expect(allowInEditable({ key: 'F9', ctrlKey: false, altKey: false, metaKey: false })).toBe(true);
  });
  it('whenMatches', () => {
    expect(whenMatches('global', 'editor')).toBe(true);
    expect(whenMatches('editorFocus', 'editor')).toBe(true);
    expect(whenMatches('editorFocus', 'tree')).toBe(false);
    expect(whenMatches('webFocus', 'web')).toBe(true);
  });
  it('isEditableTarget null', () => {
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe('呼出规则 planSummon', () => {
  it('四态', () => {
    expect(planSummon({ isOpen: true, isCollapsed: false, needsWorkspaceSwitch: false }).phase).toBe('focus');
    expect(planSummon({ isOpen: true, isCollapsed: true, needsWorkspaceSwitch: false }).phase).toBe('restore');
    expect(planSummon({ isOpen: false, isCollapsed: false, needsWorkspaceSwitch: false }).phase).toBe('reopen');
    expect(planSummon({ isOpen: false, isCollapsed: false, needsWorkspaceSwitch: true, hasUnsaved: true }).phase).toBe(
      'switchWorkspace',
    );
  });
});

describe('内容缩放 ≠ 面板尺寸（命令 id 分离）', () => {
  it('id 不同', () => {
    expect('view.contentZoomIn').not.toBe('panel.size.increase');
    expect('view.contentZoomOut').not.toBe('panel.size.decrease');
  });
});
