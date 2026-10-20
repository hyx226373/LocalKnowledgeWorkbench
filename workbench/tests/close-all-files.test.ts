import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discardOpenEditor, registerEditorDiscard, registerEditorSaver, saveOpenEditor } from '../src/renderer/editorSave';
import { dialogs } from '../src/renderer/ui/dialogs';
import {
  CLOSE_ALL_FILES_ID,
  CLOSE_ALL_FILES_KEY,
  CLOSE_ALL_FILES_TITLE,
  closeAllFilesKeybinding,
  collectOpenFileTabs,
  runCloseAll,
  type OpenFileTab,
} from '../src/renderer/tabs/closeAllFiles';
import { askCloseAllDirty } from '../src/renderer/tabs/closeAllPrompt';
import type { KeybindingsStoreV1 } from '../src/renderer/keybindings/types';

function tab(partial: Partial<OpenFileTab> & Pick<OpenFileTab, 'panelId'>): OpenFileTab {
  return { title: partial.panelId, resourceId: null, dirty: false, ...partial };
}

function harness(choice: 'save' | 'discard' | 'cancel' = 'cancel') {
  const closed: string[] = [];
  const saved: string[] = [];
  const discarded: string[] = [];
  const saveResult = new Map<string, boolean>();
  return {
    closed,
    saved,
    discarded,
    saveResult,
    deps: {
      ask: vi.fn(async () => choice),
      save: vi.fn(async (id: string) => {
        saved.push(id);
        return saveResult.get(id) !== false;
      }),
      discard: vi.fn((id: string) => { discarded.push(id); }),
      close: vi.fn((item: OpenFileTab) => { closed.push(item.panelId); }),
    },
  };
}

describe('关闭全部已打开文件', () => {
  const offs: Array<() => void> = [];
  afterEach(() => {
    for (const off of offs) off();
    offs.length = 0;
    vi.restoreAllMocks();
  });

  it('没有未保存修改时直接关掉全部，不弹确认', async () => {
    const tabs = [tab({ panelId: 'a', resourceId: 'ra' }), tab({ panelId: 'web' })];
    const h = harness();
    const result = await runCloseAll(tabs, h.deps);
    expect(h.deps.ask).not.toHaveBeenCalled();
    expect(h.deps.save).not.toHaveBeenCalled();
    expect(h.deps.discard).not.toHaveBeenCalled();
    expect(result).toEqual({ choice: 'clean', closed: ['a', 'web'], saved: [], discarded: [] });
    expect(h.closed).toEqual(['a', 'web']);
  });

  it('有未保存修改时取消：不保存、不丢弃、一个都不关', async () => {
    const tabs = [tab({ panelId: 'a', resourceId: 'ra', dirty: true, title: '笔记' }), tab({ panelId: 'b', resourceId: 'rb' })];
    const h = harness('cancel');
    const result = await runCloseAll(tabs, h.deps);
    expect(h.deps.ask).toHaveBeenCalledOnce();
    expect(h.deps.save).not.toHaveBeenCalled();
    expect(h.deps.discard).not.toHaveBeenCalled();
    expect(h.closed).toEqual([]);
    expect(result.choice).toBe('cancel');
    expect(result.closed).toEqual([]);
  });

  it('选择不保存：先丢弃未保存修改，再关掉全部', async () => {
    const tabs = [
      tab({ panelId: 'a', resourceId: 'ra', dirty: true }),
      tab({ panelId: 'a2', resourceId: 'ra', dirty: true }),
      tab({ panelId: 'b', resourceId: 'rb' }),
    ];
    const h = harness('discard');
    const result = await runCloseAll(tabs, h.deps);
    expect(h.discarded).toEqual(['ra']);
    expect(h.deps.save).not.toHaveBeenCalled();
    expect(h.closed).toEqual(['a', 'a2', 'b']);
    expect(result).toMatchObject({ choice: 'discard', closed: ['a', 'a2', 'b'], discarded: ['ra'], saved: [] });
  });

  it('选择保存且都成功：保存后关掉全部', async () => {
    const tabs = [tab({ panelId: 'a', resourceId: 'ra', dirty: true }), tab({ panelId: 'b', resourceId: 'rb', dirty: true })];
    const h = harness('save');
    const result = await runCloseAll(tabs, h.deps);
    expect(h.saved).toEqual(['ra', 'rb']);
    expect(h.deps.discard).not.toHaveBeenCalled();
    expect(h.closed).toEqual(['a', 'b']);
    expect(result.choice).toBe('save');
    expect(result.saved).toEqual(['ra', 'rb']);
  });

  it('有文件保存失败时一个都不关', async () => {
    const tabs = [tab({ panelId: 'a', resourceId: 'ra', dirty: true }), tab({ panelId: 'b', resourceId: 'rb', dirty: true })];
    const h = harness('save');
    h.saveResult.set('rb', false);
    const result = await runCloseAll(tabs, h.deps);
    expect(h.saved).toEqual(['ra', 'rb']);
    expect(h.closed).toEqual([]);
    expect(h.deps.discard).not.toHaveBeenCalled();
    expect(result).toMatchObject({ choice: 'save', closed: [], saved: ['ra'], discarded: [] });
  });

  it('收集打开的标签时跳过侧栏，非文件不算未保存', () => {
    const tabs = collectOpenFileTabs(
      [
        { id: 'kb.sidebar', title: '侧栏', params: { itemId: 'side' } },
        { id: 'p1', title: '笔记.md', params: { itemId: 'i1' } },
        { id: 'p2', title: '网页', params: { itemId: 'i2' } },
        { id: 'p3', title: '' },
      ],
      {
        i1: { sourceKind: 'file', ref: 'res-1', title: '笔记.md' },
        i2: { sourceKind: 'web', ref: 'https://example.test', title: '网页' },
        side: { sourceKind: 'file', ref: 'hidden', title: '侧栏文件' },
      },
      (id) => id === 'res-1' || id === 'https://example.test',
    );
    expect(tabs.map((item) => item.panelId)).toEqual(['p1', 'p2', 'p3']);
    expect(tabs[0]).toMatchObject({ resourceId: 'res-1', dirty: true, title: '笔记.md' });
    expect(tabs[1]).toMatchObject({ resourceId: null, dirty: false, title: '网页' });
    expect(tabs[2]).toMatchObject({ resourceId: null, dirty: false, title: 'p3' });
  });

  it('默认快捷键是 Ctrl+Shift+W；与现有命令或用户改键冲突时不绑定', () => {
    expect(CLOSE_ALL_FILES_ID).toBe('tabs.closeAll');
    expect(CLOSE_ALL_FILES_TITLE).toBe('关闭全部已打开文件');
    expect(closeAllFilesKeybinding([])).toBe(CLOSE_ALL_FILES_KEY);
    expect(closeAllFilesKeybinding([{ id: 'panel.close', title: '关闭面板', keybinding: 'Ctrl+W' }])).toBe(CLOSE_ALL_FILES_KEY);
    expect(closeAllFilesKeybinding([{ id: 'other', title: '别的', keybinding: CLOSE_ALL_FILES_KEY }])).toBeUndefined();
    const store: KeybindingsStoreV1 = { v: 1, overrides: { 'panel.close': CLOSE_ALL_FILES_KEY } };
    expect(closeAllFilesKeybinding([{ id: 'panel.close', title: '关闭面板', keybinding: 'Ctrl+W' }], store)).toBeUndefined();
  });

  it('确认框有保存、不保存、取消，点取消时什么都不关', async () => {
    let render: ((done: (value: string) => void) => React.ReactNode) | undefined;
    let resolveDialog: ((value: string) => void) | undefined;
    vi.spyOn(dialogs, 'custom').mockImplementation((options) => {
      expect(options.title).toBe('有未保存的修改');
      expect(options.testid).toBe('close-all-dirty-dialog');
      expect(options.cancelValue).toBe('cancel');
      render = options.render as (done: (value: string) => void) => React.ReactNode;
      return new Promise((resolve) => {
        resolveDialog = resolve as (value: string) => void;
      });
    });
    const pending = askCloseAllDirty([{ title: '笔记.md' }, { title: '笔记.md' }]);
    const seen: { testid?: string; label?: string }[] = [];
    const walk = (node: React.ReactNode) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      const el = node as React.ReactElement<{ 'data-testid'?: string; children?: React.ReactNode; onClick?: () => void }>;
      if (el.props?.['data-testid']) seen.push({ testid: el.props['data-testid'], label: typeof el.props.children === 'string' ? el.props.children : undefined });
      walk(el.props?.children);
    };
    walk(render?.((value) => resolveDialog?.(value)));
    expect(seen).toEqual([
      { testid: 'close-all-cancel', label: '取消' },
      { testid: 'close-all-discard', label: '不保存' },
      { testid: 'close-all-save', label: '保存' },
    ]);
    const body = render?.(() => undefined);
    const text: string[] = [];
    const walkText = (node: React.ReactNode) => {
      if (typeof node === 'string') text.push(node);
      else if (Array.isArray(node)) node.forEach(walkText);
      else if (node && typeof node === 'object') walkText((node as React.ReactElement<{ children?: React.ReactNode }>).props?.children);
    };
    walkText(body);
    expect(text.join('')).toContain('笔记.md还没保存');
    resolveDialog?.('cancel');
    await expect(pending).resolves.toBe('cancel');
  });

  it('保存登记：没有保存函数或任一失败则不能关；丢弃会清掉已登记的稿', async () => {
    expect(await saveOpenEditor('missing')).toBe(false);
    const key = Symbol('panel');
    offs.push(registerEditorSaver('res', key, async () => false));
    expect(await saveOpenEditor('res')).toBe(false);
    offs.pop()?.();
    let discarded = 0;
    offs.push(registerEditorSaver('res', key, async () => true));
    offs.push(registerEditorDiscard('res', key, () => { discarded += 1; }));
    offs.push(registerEditorDiscard('res', Symbol('other'), () => { throw new Error('另一面板'); }));
    expect(await saveOpenEditor('res')).toBe(true);
    discardOpenEditor('res');
    expect(discarded).toBe(1);
  });
});
