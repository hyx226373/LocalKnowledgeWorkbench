import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { QuickSwitch } from '../../src/renderer/workspace-picker/QuickSwitch';
import { WorkspacePickerSettings } from '../../src/renderer/workspace-picker/WorkspacePickerSettings';
import {
  filterQuickSwitch,
  initialQuickSwitchUi,
  quickSwitchEntries,
  quickSwitchQuery,
  reduceQuickSwitchKey,
  type QuickSwitchEntry,
} from '../../src/renderer/workspace-picker/quickSwitchModel';
import {
  QUICK_SWITCH_COMMAND_ID,
  QUICK_SWITCH_PROTECTED_KEYS,
  QUICK_SWITCH_TITLE,
  bindWorkspacePickerCommands,
  decideQuickSwitchKey,
  formatQuickSwitchConflict,
  partitionKeyHolders,
  workspacePickerCommandDrafts,
  type KeyCommandLike,
} from '../../src/renderer/workspace-picker/quickSwitchKey';
import { emptyStore } from '../../src/renderer/keybindings/store';
import { OVERLAY_SELECTOR } from '../../src/shared/webPanel';
import { DEFAULT_WORKSPACE_PICKER_SETTINGS, QUICK_SWITCH_DEFAULT_KEY } from '../../src/shared/workspacePicker/types';

const PALETTE: KeyCommandLike = {
  id: 'workbench.commandPalette',
  title: '显示命令面板',
  keybinding: 'Ctrl+Shift+P',
  when: 'global',
};
const CONTENT_ONLY: KeyCommandLike = {
  id: 'view.contentOnly',
  title: '只看内容',
  keybinding: 'Ctrl+Shift+F11',
  when: 'global',
};

const ENTRIES: QuickSwitchEntry[] = [
  { id: 'a', name: '论文', purpose: '写文献综述', tags: ['示例分类'] },
  { id: 'b', name: '英语', purpose: '单词', tags: ['每日'] },
  { id: 'c', name: '空', purpose: '', tags: [] },
];

function decisionOf(input: Parameters<typeof decideQuickSwitchKey>[0]) {
  const before = structuredClone(input);
  const store = emptyStore();
  const storeBefore = structuredClone(store);
  const decision = decideQuickSwitchKey(input);
  expect(input).toEqual(before);
  expect(store).toEqual(storeBefore);
  expect(decision.wroteOverride).toBe(false);
  expect(decision.usedReplace).toBe(false);
  expect(decision.when).toBe('global');
  expect(decision.requestedKey).toBe('Ctrl+Shift+F');
  return decision;
}

describe('快速切换默认键', () => {
  it('内置动作、插件贡献、用户绑定分别占用时不覆盖，并列出双方', () => {
    const builtin = decisionOf({
      builtinActions: [{ id: 'builtin.find', title: '内置查找', keybinding: 'Ctrl+Shift+F', when: 'global' }, PALETTE],
      pluginCommands: [CONTENT_ONLY],
      userBindings: [],
    });
    expect(builtin.assignDefaultKey).toBe(false);
    expect(builtin.report?.ours).toEqual({ id: QUICK_SWITCH_COMMAND_ID, title: QUICK_SWITCH_TITLE });
    expect(builtin.report?.parties).toEqual([{ id: 'builtin.find', title: '内置查找', source: 'builtin', key: 'Ctrl+Shift+F' }]);
    expect(builtin.report?.skippedDefaultKey).toBe(true);
    expect(formatQuickSwitchConflict(builtin.report!)).toContain('内置查找');
    expect(formatQuickSwitchConflict(builtin.report!)).toContain(QUICK_SWITCH_TITLE);
    expect(workspacePickerCommandDrafts(builtin).find((command) => command.id === QUICK_SWITCH_COMMAND_ID)?.keybinding).toBeUndefined();

    const plugin = decisionOf({
      builtinActions: [PALETTE],
      pluginCommands: [{ id: 'plugin.search', title: '插件搜索', keybinding: 'Ctrl+Shift+F', when: 'global' }, CONTENT_ONLY],
      userBindings: [],
    });
    expect(plugin.assignDefaultKey).toBe(false);
    expect(plugin.report?.parties).toEqual([{ id: 'plugin.search', title: '插件搜索', source: 'plugin', key: 'Ctrl+Shift+F' }]);

    const userStore = emptyStore();
    userStore.overrides['plugin.search'] = 'Ctrl+Shift+F';
    const userBefore = structuredClone(userStore);
    const user = decisionOf({
      builtinActions: [PALETTE],
      pluginCommands: [{ id: 'plugin.search', title: '插件搜索', keybinding: 'Ctrl+K', when: 'global' }],
      userBindings: [{ id: 'plugin.search', title: '插件搜索', key: 'Ctrl+Shift+F', when: 'global' }],
    });
    expect(userStore).toEqual(userBefore);
    expect(user.assignDefaultKey).toBe(false);
    expect(user.report?.parties).toEqual([{ id: 'plugin.search', title: '插件搜索', source: 'user', key: 'Ctrl+Shift+F' }]);
    expect(PALETTE.keybinding).toBe('Ctrl+Shift+P');
    expect(CONTENT_ONLY.keybinding).toBe('Ctrl+Shift+F11');
  });

  it('没有占用时登记默认键，命令面板和只看内容保持原样', () => {
    const palette = { ...PALETTE };
    const content = { ...CONTENT_ONLY };
    const decision = decisionOf({
      builtinActions: [palette],
      pluginCommands: [content],
      userBindings: [{ id: 'view.contentOnly', title: '只看内容', key: 'Ctrl+Shift+F11', when: 'global' }],
    });
    expect(decision.assignDefaultKey).toBe(true);
    expect(decision.report).toBeNull();
    expect(palette).toEqual(PALETTE);
    expect(content).toEqual(CONTENT_ONLY);
    const drafts = workspacePickerCommandDrafts(decision);
    expect(drafts[0]).toMatchObject({ id: 'workspace.openOverview', bridgeInvokable: true, approvalRequired: false });
    expect(drafts[0]?.keybinding).toBeUndefined();
    expect(drafts[1]).toMatchObject({
      id: 'workspace.quickSwitch',
      keybinding: QUICK_SWITCH_DEFAULT_KEY,
      when: 'global',
    });
    expect(QUICK_SWITCH_DEFAULT_KEY).toBe('Ctrl+Shift+F');
    for (const key of QUICK_SWITCH_PROTECTED_KEYS) {
      expect(drafts.some((command) => command.keybinding === key)).toBe(false);
    }
    const registered: { id: string; keybinding?: string }[] = [];
    bindWorkspacePickerCommands((command) => registered.push(command), decision, {
      openOverview: () => undefined,
      quickSwitch: () => undefined,
    });
    expect(registered.map((command) => command.keybinding ?? null)).toEqual([null, 'Ctrl+Shift+F']);
  });

  it('登记函数不写 override，源码也不使用替换已有绑定', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/renderer/workspace-picker/quickSwitchKey.ts'), 'utf8');
    expect(src).not.toContain('replace:true');
    expect(src).not.toContain('replace: true');
    expect(src).not.toContain('setKeybinding');
    const holders = partitionKeyHolders({
      commands: [
        { ...PALETTE, owner: 'builtin.workbench' },
        { id: 'plugin.search', title: '插件搜索', keybinding: 'Ctrl+K', when: 'global', owner: 'user.notes' },
      ],
      actions: [{ id: 'builtin.find', title: '内置查找', keybinding: 'Ctrl+F', source: 'builtin', packageId: 'sources' }],
    });
    expect(holders.builtinActions.map((command) => command.id)).toEqual(['workbench.commandPalette', 'builtin.find']);
    expect(holders.pluginCommands.map((command) => command.id)).toEqual(['plugin.search']);
  });
});

describe('快速切换覆盖层', () => {
  it('Enter 调用 onEnter，Esc 不切换，方向键移动，搜索名称用途和标签', () => {
    const onEnter = vi.fn();
    const onClose = vi.fn();
    const ui = initialQuickSwitchUi(ENTRIES, 'b');
    expect(ui).toEqual({ query: '', selectedIndex: 1 });
    const moved = reduceQuickSwitchKey({ ui, entries: ENTRIES, key: 'ArrowDown', onEnter, onClose });
    expect(moved.selectedIndex).toBe(2);
    expect(onEnter).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    reduceQuickSwitchKey({ ui: moved, entries: ENTRIES, key: 'Enter', onEnter, onClose });
    expect(onEnter).toHaveBeenCalledTimes(1);
    expect(onEnter).toHaveBeenCalledWith('c');
    expect(onClose).not.toHaveBeenCalled();
    onEnter.mockClear();
    reduceQuickSwitchKey({ ui: moved, entries: ENTRIES, key: 'Escape', onEnter, onClose });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onEnter).not.toHaveBeenCalled();

    expect(filterQuickSwitch(ENTRIES, '文献').map((entry) => entry.id)).toEqual(['a']);
    expect(filterQuickSwitch(ENTRIES, '每日').map((entry) => entry.id)).toEqual(['b']);
    expect(filterQuickSwitch(ENTRIES, '英语').map((entry) => entry.id)).toEqual(['b']);
    expect(quickSwitchQuery(ui, '文献')).toEqual({ query: '文献', selectedIndex: 0 });
    expect(
      quickSwitchEntries([
        { temporary: true, summary: { id: 'kb-overview-temporary', name: '临时现场', purpose: '', tags: [] } },
        { summary: { id: 'a', name: '论文', purpose: '', tags: [] } },
      ]).map((entry) => entry.id),
    ).toEqual(['a']);
  });

  it('根节点匹配 OVERLAY_SELECTOR，冲突提示双方并给出重新配置，不写库', () => {
    const decision = decideQuickSwitchKey({
      builtinActions: [{ id: 'builtin.find', title: '内置查找', keybinding: 'Ctrl+Shift+F', when: 'global' }],
      pluginCommands: [],
      userBindings: [],
    });
    const html = renderToStaticMarkup(
      createElement(QuickSwitch, {
        entries: ENTRIES,
        currentId: 'a',
        conflict: decision.report,
        onEnter: () => undefined,
        onClose: () => undefined,
        onReconfigure: () => undefined,
        onOpenSettings: () => undefined,
      }),
    );
    const root = html.slice(0, html.indexOf('>') + 1);
    expect(OVERLAY_SELECTOR.split(',').map((part) => part.trim())).toContain('[data-kb-overlay]');
    expect(root).toContain('data-kb-overlay=""');
    expect(root).toContain('class="kb-ws-quick"');
    expect(root).toContain('data-persists="false"');
    expect(root).toContain('data-writes-library="false"');
    expect(root).toContain('data-host-status="not-in-integ"');
    expect(html).toContain('内置查找');
    expect(html).toContain(QUICK_SWITCH_TITLE);
    expect(html).toContain('data-action="reconfigure"');
    expect(html).toContain('重新配置快捷键');
    expect(html).toContain('搜索名称、用途或标签');
    expect(html).toContain('data-selected="true"');
    const src = readFileSync(path.join(process.cwd(), 'src/renderer/workspace-picker/QuickSwitch.tsx'), 'utf8');
    expect(src).not.toContain('setLayout');
    expect(src).not.toContain('alert(');
    expect(src).not.toContain('switchTo');
  });

  it('设置页展示冲突双方和重新配置入口', () => {
    const decision = decideQuickSwitchKey({
      builtinActions: [],
      pluginCommands: [{ id: 'plugin.search', title: '插件搜索', keybinding: 'Ctrl+Shift+F', when: 'global' }],
      userBindings: [],
    });
    const html = renderToStaticMarkup(
      createElement(WorkspacePickerSettings, {
        settings: { ...DEFAULT_WORKSPACE_PICKER_SETTINGS, startup: 'workspace', startupWorkspaceId: 'missing' },
        workspaces: [{ id: 'a', name: '论文' }],
        conflict: decision.report,
        onChange: () => undefined,
        onClose: () => undefined,
        onReconfigure: () => undefined,
      }),
    );
    expect(html).toContain('data-kb-overlay=""');
    expect(html).toContain('data-startup="workspace"');
    expect(html).toContain('插件搜索');
    expect(html).toContain('data-action="reconfigure"');
    expect(html).toContain('value="last"');
    expect(html).toContain('value="overview"');
    expect(html).toContain('value="workspace"');
    expect(html).toContain('不会创建默认工作区');
    expect(html).toContain('指定的工作区不在列表中');
  });
});
