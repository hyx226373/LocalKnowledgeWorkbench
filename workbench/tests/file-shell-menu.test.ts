import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../src/renderer/dir-view/context';
import type { KbDragPayload } from '../src/renderer/dir-view/dnd';
import { isRendererDataMethod } from '../src/shared/dataMethods';
import { openInsideRoots } from '../src/shared/shellReveal';

const { openDefault, showFolder } = vi.hoisted(() => ({
  openDefault: vi.fn(async () => undefined),
  showFolder: vi.fn(async () => undefined),
}));

vi.mock('../src/renderer/kb', () => ({
  kb: {
    openWithDefaultApp: openDefault,
    showInFolder: showFolder,
    removeVfolderMembership: vi.fn(),
  },
}));

vi.mock('../src/renderer/keybindings/contextMenu', () => ({
  openSetKeybindingFor: vi.fn(),
  SET_KEYBINDING_LABEL: '设置快捷键…',
}));

import { fileMenu } from '../src/renderer/dir-view/RowMenu';

function ctx(): { view: Ctx; notify: ReturnType<typeof vi.fn> } {
  const notify = vi.fn();
  const view: Ctx = {
    open: () => undefined,
    favIds: new Set(),
    toggleFav: () => undefined,
    expanded: new Set(),
    setExpanded: () => undefined,
    fsVersion: 0,
    fsEvents: [],
    activeResourceId: null,
    showIgnored: false,
    setShowIgnored: () => undefined,
    refIds: new Set(),
    toggleRef: () => undefined,
    notify,
  };
  return { view, notify };
}

function payload(entry: 'file' | 'dir-entry', sourceKind: 'file' | 'web' = 'file'): KbDragPayload {
  return {
    v: 1,
    items: [{
      resourceId: 'res-1',
      sourceKind,
      entry,
      from: { kind: 'root', rootId: 'root-1', relPath: entry === 'file' ? 'notes/a.txt' : 'notes' },
    }],
  };
}

const roots = ['/data/kb'];
const shell = { pathLib: path, caseInsensitive: false };

describe('目录树文件用默认程序打开', () => {
  beforeEach(() => {
    openDefault.mockReset();
    showFolder.mockReset();
    openDefault.mockResolvedValue(undefined);
    showFolder.mockResolvedValue(undefined);
  });

  it('磁盘文件菜单含两项，调用时带上资源 id', () => {
    const items = fileMenu({ ctx: ctx().view, resourceId: 'res-1', title: 'a.txt', payload: payload('file') });
    expect(items.filter((item) => !item.separator).map((item) => item.label)).toEqual([
      '在新面板中再打开一份',
      '用默认程序打开',
      '在资源管理器中显示',
      '复制文件路径',
      '移动到…',
      '加入自建目录…',
      '设置快捷键…',
      '从根目录移除（不删除磁盘文件）',
      '移到回收站',
    ]);
    items.find((item) => item.id === 'file.openDefault')?.run();
    items.find((item) => item.id === 'file.showInFolder')?.run();
    expect(openDefault).toHaveBeenCalledWith('res-1');
    expect(showFolder).toHaveBeenCalledWith('res-1');
  });

  it('目录和网页条目不提供这两项', () => {
    const dir = fileMenu({ ctx: ctx().view, resourceId: 'res-1', title: 'notes', payload: payload('dir-entry') });
    const web = fileMenu({ ctx: ctx().view, resourceId: 'res-1', title: 'page', payload: payload('file', 'web') });
    expect(dir.some((item) => item.id === 'file.openDefault' || item.id === 'file.showInFolder')).toBe(false);
    expect(web.some((item) => item.id === 'file.openDefault' || item.id === 'file.showInFolder')).toBe(false);
    expect(web.some((item) => item.id === 'tree.trashDisk' || item.id === 'tree.hideFromRoot')).toBe(false);
    expect(dir.map((item) => item.label)).toContain('移动到…');
    expect(dir.at(-1)?.id).toBe('tree.trashDisk');
  });

  it('打开失败时把原因交给通知，不静默吞掉', async () => {
    const { view, notify } = ctx();
    openDefault.mockRejectedValueOnce(new Error('路径超出已登记的根目录'));
    const items = fileMenu({ ctx: view, resourceId: 'res-1', title: 'a.txt', payload: payload('file') });
    items.find((item) => item.id === 'file.openDefault')?.run();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('路径超出已登记的根目录'));
    expect(showFolder).not.toHaveBeenCalled();
  });

  it('根内路径传给 openPath；根外和逃出根的路径拒绝且不调用', async () => {
    expect(isRendererDataMethod('openWithDefaultApp')).toBe(true);
    const openPath = vi.fn(async () => '');
    await openInsideRoots('/data/kb/notes/a.txt', roots, { ...shell, openPath });
    expect(openPath).toHaveBeenCalledTimes(1);
    expect(openPath).toHaveBeenCalledWith('/data/kb/notes/a.txt');

    openPath.mockClear();
    await expect(openInsideRoots('/etc/passwd', roots, { ...shell, openPath })).rejects.toThrow('路径超出已登记的根目录');
    await expect(openInsideRoots('/data/kb/../outside.txt', roots, { ...shell, openPath })).rejects.toThrow('路径超出已登记的根目录');
    await expect(openInsideRoots('/data/kb2/a.txt', roots, { ...shell, openPath })).rejects.toThrow('路径超出已登记的根目录');
    expect(openPath).not.toHaveBeenCalled();

    await openInsideRoots('/data/one.txt', ['/data/one.txt'], { ...shell, openPath });
    expect(openPath).toHaveBeenCalledWith('/data/one.txt');
  });

  it('默认程序返回错误字符串时抛出', async () => {
    const openPath = vi.fn(async () => 'Failed to open path');
    await expect(openInsideRoots('/data/kb/a.txt', roots, { ...shell, openPath })).rejects.toThrow('Failed to open path');
    expect(openPath).toHaveBeenCalledWith('/data/kb/a.txt');
  });
});
