import { describe, expect, it } from 'vitest';
import { applyFileDragOut, dragOutPlainText, planFileDragOut } from '../src/renderer/nativeDrag/mode';
import { KB_DRAG_MIME, beginDrag } from '../src/renderer/dir-view/dnd';
import { rootMoreMenuItems } from '../src/renderer/dir-view/rootMoreMenu';
import { getSidebarPrefs, parseSidebarPrefs, SIDEBAR_PREFS_KEY, updateSidebarPrefs } from '../src/renderer/drawer/sidebarPrefs';

describe('拖出为文件或路径', () => {
  it('默认是文件；旧偏好没有该字段时仍是文件；切换写回同一键', () => {
    const storage = new Map<string, string>();
    storage.set('kb.sidebar.ui', JSON.stringify({ hideUnopenableFiles: false, categoriesLayout: 'list' }));
    const previous = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => { storage.set(key, value); },
        removeItem: (key: string) => { storage.delete(key); },
      },
    });
    try {
      expect(parseSidebarPrefs(null).dragOutMode).toBe('file');
      expect(parseSidebarPrefs({ dragOutMode: 'path' }).dragOutMode).toBe('path');
      expect(parseSidebarPrefs({ dragOutMode: 'move' }).dragOutMode).toBe('file');
      expect(parseSidebarPrefs({ hideUnopenableFiles: false }).dragOutMode).toBe('file');
      expect(getSidebarPrefs().dragOutMode).toBe('file');
      expect(getSidebarPrefs().hideUnopenableFiles).toBe(false);
      expect(getSidebarPrefs().categoriesLayout).toBe('list');
      updateSidebarPrefs({ dragOutMode: 'path' });
      expect(getSidebarPrefs().dragOutMode).toBe('path');
      expect(getSidebarPrefs().hideUnopenableFiles).toBe(false);
      const stored = JSON.parse(storage.get(SIDEBAR_PREFS_KEY) ?? 'null') as { dragOutMode?: string; hideUnopenableFiles?: boolean };
      expect(stored.dragOutMode).toBe('path');
      expect(stored.hideUnopenableFiles).toBe(false);
      const menu = rootMoreMenuItems(getSidebarPrefs(), false, () => undefined);
      const hide = menu.find((item) => item.id === 'hide-unopenable');
      const asFile = menu.find((item) => item.id === 'drag-out-file');
      const asPath = menu.find((item) => item.id === 'drag-out-path');
      expect(hide?.label).toBe('隐藏无法打开的文件');
      expect(typeof hide?.checked).toBe('boolean');
      expect(asFile).toMatchObject({ label: '拖出为：文件', checked: false, testId: 'toggle-drag-out-file' });
      expect(asPath).toMatchObject({ label: '拖出为：路径', checked: true, testId: 'toggle-drag-out-path' });
      asFile?.onClick();
      expect(getSidebarPrefs().dragOutMode).toBe('file');
      expect(rootMoreMenuItems(getSidebarPrefs(), false, () => undefined).find((item) => item.id === 'drag-out-file')?.checked).toBe(true);
    } finally {
      updateSidebarPrefs({ dragOutMode: 'file', hideUnopenableFiles: true, categoriesLayout: 'grid', ribbonCollapsed: false, categoriesCollapsed: false });
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previous });
    }
  });

  it('文件模式登记原生拖出且不改 text/plain；路径模式写入每行一个绝对路径且不登记', () => {
    const data = new Map<string, string>();
    const transfer = {
      setData(type: string, value: string) { data.set(type, value); },
      get effectAllowed() { return ''; },
      set effectAllowed(_value: string) { /* 应用内拖放自己设 */ },
    };
    beginDrag({ dataTransfer: transfer } as never, {
      v: 1,
      items: [{
        resourceId: 'res-1',
        sourceKind: 'file',
        from: { kind: 'root', rootId: 'root-1', relPath: 'a.md' },
        entry: 'file',
      }],
    });
    const armed: string[][] = [];
    const noted: string[][] = [];
    const filePlan = applyFileDragOut(transfer, ['D:\\notes\\a.md'], 'file', {
      armNative: (paths) => { armed.push([...paths]); },
      notePath: (paths) => { noted.push([...paths]); },
    });
    expect(filePlan).toMatchObject({ mode: 'file', arm: true });
    expect(armed).toEqual([['D:\\notes\\a.md']]);
    expect(noted).toEqual([]);
    expect(data.get(KB_DRAG_MIME)).toContain('res-1');
    expect(data.get('text/plain')).toContain('res-1');

    const pathTransfer = {
      setData(type: string, value: string) { data.set(type, value); },
    };
    const pathArmed: string[][] = [];
    const pathNoted: string[][] = [];
    applyFileDragOut(pathTransfer, ['  D:\\notes\\a.md  ', 'D:\\notes\\a.md', 'D:\\notes\\b.md'], 'path', {
      armNative: (paths) => { pathArmed.push([...paths]); },
      notePath: (paths) => { pathNoted.push([...paths]); },
    });
    expect(pathArmed).toEqual([]);
    expect(pathNoted).toEqual([['D:\\notes\\a.md', 'D:\\notes\\b.md']]);
    expect(data.get('text/plain')).toBe('D:\\notes\\a.md\nD:\\notes\\b.md');
    expect(dragOutPlainText(['D:\\notes\\a.md', 'D:\\notes\\b.md'])).toBe('D:\\notes\\a.md\nD:\\notes\\b.md');
    expect(planFileDragOut('path', []).arm).toBe(false);
    expect(planFileDragOut(undefined, ['D:\\notes\\a.md']).mode).toBe('file');
  });
});
