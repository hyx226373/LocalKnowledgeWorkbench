import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../src/renderer/dir-view/context';
import type { KbDragPayload } from '../src/renderer/dir-view/dnd';
import { setNativeDragRootIndex, toWindowsPath, nativeNodePath } from '../src/renderer/nativeDrag/paths';
import { copyToClipboard, fileMenu, resolveItemPath, resolveItemPathSync } from '../src/renderer/dir-view/RowMenu';

const { resourceAbsPathMock } = vi.hoisted(() => ({
  resourceAbsPathMock: vi.fn(async (rid: string) => `C:\\fallback\\${rid}.txt`),
}));

vi.mock('../src/renderer/kb', () => ({
  kb: {
    resourceAbsPath: resourceAbsPathMock,
    openWithDefaultApp: vi.fn(async () => undefined),
    showInFolder: vi.fn(async () => undefined),
    removeVfolderMembership: vi.fn(),
  },
}));

vi.mock('../src/renderer/keybindings/contextMenu', () => ({
  openSetKeybindingFor: vi.fn(),
  SET_KEYBINDING_LABEL: '设置快捷键…',
}));

function dummyCtx(): Ctx {
  return {
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
    notify: vi.fn(),
  };
}

describe('spec §12 目录树右键「复制文件路径/复制文件夹路径」', () => {
  let clipboardText = '';

  beforeEach(() => {
    clipboardText = '';
    resourceAbsPathMock.mockClear();
    setNativeDragRootIndex([
      { id: 'root-1', path: 'C:\\Data\\Workspace', kind: 'folder' },
      { id: 'root-slash', path: 'D:/Forward/Slash/Root', kind: 'folder' },
      { id: 'file-root', path: 'E:\\SingleFile\\alone.pdf', kind: 'file' },
    ]);

    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: vi.fn(async (t: string) => {
          clipboardText = t;
        }),
      },
      configurable: true,
      writable: true,
    });
  });

  describe('路径格式转换 (toWindowsPath & nativeNodePath)', () => {
    it('正斜杠统一转换为 Windows 反斜杠', () => {
      expect(toWindowsPath('C:/Data/Workspace/notes/doc.md')).toBe('C:\\Data\\Workspace\\notes\\doc.md');
      expect(toWindowsPath('D:/Forward/Slash/Root')).toBe('D:\\Forward\\Slash\\Root');
    });

    it('去除末尾斜杠，但保留盘符根目录（如 C:\\）', () => {
      expect(toWindowsPath('C:\\Data\\Workspace\\')).toBe('C:\\Data\\Workspace');
      expect(toWindowsPath('C:/Data/Workspace///')).toBe('C:\\Data\\Workspace');
      expect(toWindowsPath('C:\\')).toBe('C:\\');
      expect(toWindowsPath('D:/')).toBe('D:\\');
    });

    it('nativeNodePath 能正确解析根目录、子文件夹及文件绝对路径', () => {
      expect(nativeNodePath('root-1', '')).toBe('C:\\Data\\Workspace');
      expect(nativeNodePath('root-1', 'subfolder')).toBe('C:\\Data\\Workspace\\subfolder');
      expect(nativeNodePath('root-1', 'subfolder/a.txt')).toBe('C:\\Data\\Workspace\\subfolder\\a.txt');
      expect(nativeNodePath('file-root', '')).toBe('E:\\SingleFile\\alone.pdf');
      expect(toWindowsPath(nativeNodePath('root-slash', 'docs/readme.md')!)).toBe('D:\\Forward\\Slash\\Root\\docs\\readme.md');
      expect(nativeNodePath('unknown-root', 'a.txt')).toBeNull();
    });
  });

  describe('菜单文案规范', () => {
    it('文件显示「复制文件路径」', () => {
      const payload: KbDragPayload = {
        v: 1,
        items: [{
          resourceId: 'res-file-1',
          sourceKind: 'file',
          entry: 'file',
          from: { kind: 'root', rootId: 'root-1', relPath: 'notes/a.md' },
          rootId: 'root-1',
          relPath: 'notes/a.md',
          name: 'a.md',
        }],
      };
      const items = fileMenu({ ctx: dummyCtx(), resourceId: 'res-file-1', title: 'a.md', payload });
      const copyItem = items.find((it) => it.id === 'file.copyPath');
      expect(copyItem).toBeDefined();
      expect(copyItem?.label).toBe('复制文件路径');
    });

    it('文件夹（含子文件夹与根目录）显示「复制文件夹路径」', () => {
      const subDirPayload: KbDragPayload = {
        v: 1,
        items: [{
          resourceId: 'res-dir-1',
          sourceKind: 'file',
          entry: 'dir-entry',
          from: { kind: 'root', rootId: 'root-1', relPath: 'notes' },
          rootId: 'root-1',
          relPath: 'notes',
          name: 'notes',
        }],
      };
      const subItems = fileMenu({ ctx: dummyCtx(), resourceId: 'res-dir-1', title: 'notes', payload: subDirPayload });
      const subCopy = subItems.find((it) => it.id === 'dir.copyPath');
      expect(subCopy).toBeDefined();
      expect(subCopy?.label).toBe('复制文件夹路径');

      const rootDirPayload: KbDragPayload = {
        v: 1,
        items: [{
          resourceId: 'res-root-1',
          sourceKind: 'file',
          entry: 'dir-entry',
          from: { kind: 'roots-list' },
          rootId: 'root-1',
          relPath: '',
          name: 'Workspace',
        }],
      };
      const rootItems = fileMenu({ ctx: dummyCtx(), resourceId: 'res-root-1', title: 'Workspace', payload: rootDirPayload });
      const rootCopy = rootItems.find((it) => it.id === 'dir.copyPath');
      expect(rootCopy).toBeDefined();
      expect(rootCopy?.label).toBe('复制文件夹路径');
    });

    it('单文件根显示「复制文件路径」', () => {
      const rootFilePayload: KbDragPayload = {
        v: 1,
        items: [{
          resourceId: 'res-file-root',
          sourceKind: 'file',
          entry: 'file',
          from: { kind: 'roots-list' },
          rootId: 'file-root',
          relPath: '',
          name: 'alone.pdf',
        }],
      };
      const items = fileMenu({ ctx: dummyCtx(), resourceId: 'res-file-root', title: 'alone.pdf', payload: rootFilePayload });
      const copyItem = items.find((it) => it.id === 'file.copyPath');
      expect(copyItem).toBeDefined();
      expect(copyItem?.label).toBe('复制文件路径');
    });

    it('网页条目与虚拟目录节点不出现复制路径菜单', () => {
      const webPayload: KbDragPayload = {
        v: 1,
        items: [{
          resourceId: 'res-web',
          sourceKind: 'web',
          entry: 'file',
          from: { kind: 'root', rootId: 'root-1', relPath: '' },
          name: '网页',
        }],
      };
      const webItems = fileMenu({ ctx: dummyCtx(), resourceId: 'res-web', title: '网页', payload: webPayload });
      expect(webItems.some((it) => it.id === 'file.copyPath' || it.id === 'dir.copyPath')).toBe(false);

      const vfolderPayload: KbDragPayload = {
        v: 1,
        items: [{
          resourceId: 'res-vf',
          sourceKind: 'file',
          entry: 'vfolder-node',
          from: { kind: 'vfolder', folderId: 'f1' },
          name: '自建目录',
        }],
      };
      const vfItems = fileMenu({ ctx: dummyCtx(), resourceId: 'res-vf', title: '自建目录', payload: vfolderPayload });
      expect(vfItems.some((it) => it.id === 'file.copyPath' || it.id === 'dir.copyPath')).toBe(false);
    });
  });

  describe('剪贴板复制行为与 Windows 绝对路径', () => {
    it('复制单个文件路径，写入 Windows 绝对路径', async () => {
      const payload: KbDragPayload = {
        v: 1,
        items: [{
          resourceId: 'res-file-1',
          sourceKind: 'file',
          entry: 'file',
          from: { kind: 'root', rootId: 'root-1', relPath: 'notes/a.md' },
          rootId: 'root-1',
          relPath: 'notes/a.md',
          name: 'a.md',
        }],
      };
      const items = fileMenu({ ctx: dummyCtx(), resourceId: 'res-file-1', title: 'a.md', payload });
      const copyItem = items.find((it) => it.id === 'file.copyPath');
      await copyItem?.run();

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('C:\\Data\\Workspace\\notes\\a.md');
      expect(clipboardText).toBe('C:\\Data\\Workspace\\notes\\a.md');
    });

    it('复制子文件夹路径，写入 Windows 绝对路径', async () => {
      const payload: KbDragPayload = {
        v: 1,
        items: [{
          resourceId: 'res-dir-1',
          sourceKind: 'file',
          entry: 'dir-entry',
          from: { kind: 'root', rootId: 'root-1', relPath: 'notes/sub' },
          rootId: 'root-1',
          relPath: 'notes/sub',
          name: 'sub',
        }],
      };
      const items = fileMenu({ ctx: dummyCtx(), resourceId: 'res-dir-1', title: 'sub', payload });
      const copyItem = items.find((it) => it.id === 'dir.copyPath');
      await copyItem?.run();

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('C:\\Data\\Workspace\\notes\\sub');
      expect(clipboardText).toBe('C:\\Data\\Workspace\\notes\\sub');
    });

    it('复制根目录路径，写入 Windows 绝对路径', async () => {
      const payload: KbDragPayload = {
        v: 1,
        items: [{
          resourceId: 'res-root-1',
          sourceKind: 'file',
          entry: 'dir-entry',
          from: { kind: 'roots-list' },
          rootId: 'root-1',
          relPath: '',
          name: 'Workspace',
        }],
      };
      const items = fileMenu({ ctx: dummyCtx(), resourceId: 'res-root-1', title: 'Workspace', payload, absPath: 'C:\\Data\\Workspace' });
      const copyItem = items.find((it) => it.id === 'dir.copyPath');
      await copyItem?.run();

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('C:\\Data\\Workspace');
      expect(clipboardText).toBe('C:\\Data\\Workspace');
    });

    it('多选时每行一条路径（\\n 分隔）', async () => {
      const payload: KbDragPayload = {
        v: 1,
        items: [
          {
            resourceId: 'res-file-1',
            sourceKind: 'file',
            entry: 'file',
            from: { kind: 'root', rootId: 'root-1', relPath: 'notes/a.md' },
            rootId: 'root-1',
            relPath: 'notes/a.md',
            name: 'a.md',
          },
          {
            resourceId: 'res-file-2',
            sourceKind: 'file',
            entry: 'file',
            from: { kind: 'root', rootId: 'root-1', relPath: 'notes/b.md' },
            rootId: 'root-1',
            relPath: 'notes/b.md',
            name: 'b.md',
          },
          {
            resourceId: 'res-file-3',
            sourceKind: 'file',
            entry: 'file',
            from: { kind: 'root', rootId: 'root-slash', relPath: 'extra.txt' },
            rootId: 'root-slash',
            relPath: 'extra.txt',
            name: 'extra.txt',
          },
        ],
      };

      const items = fileMenu({ ctx: dummyCtx(), resourceId: 'res-file-1', title: 'a.md', payload });
      const copyItem = items.find((it) => it.id === 'file.copyPath');
      await copyItem?.run();

      const expected = [
        'C:\\Data\\Workspace\\notes\\a.md',
        'C:\\Data\\Workspace\\notes\\b.md',
        'D:\\Forward\\Slash\\Root\\extra.txt',
      ].join('\n');
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expected);
      expect(clipboardText).toBe(expected);
    });

    it('多选文件夹时显示「复制文件夹路径」，且每行一条', async () => {
      const payload: KbDragPayload = {
        v: 1,
        items: [
          {
            resourceId: 'res-dir-1',
            sourceKind: 'file',
            entry: 'dir-entry',
            from: { kind: 'root', rootId: 'root-1', relPath: 'dirA' },
            rootId: 'root-1',
            relPath: 'dirA',
            name: 'dirA',
          },
          {
            resourceId: 'res-dir-2',
            sourceKind: 'file',
            entry: 'dir-entry',
            from: { kind: 'root', rootId: 'root-1', relPath: 'dirB' },
            rootId: 'root-1',
            relPath: 'dirB',
            name: 'dirB',
          },
        ],
      };

      const items = fileMenu({ ctx: dummyCtx(), resourceId: 'res-dir-1', title: 'dirA', payload });
      const copyItem = items.find((it) => it.id === 'dir.copyPath');
      expect(copyItem?.label).toBe('复制文件夹路径');
      await copyItem?.run();

      const expected = [
        'C:\\Data\\Workspace\\dirA',
        'C:\\Data\\Workspace\\dirB',
      ].join('\n');
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expected);
    });

    it('当 rootId 未在索引中时，回退调用 kb.resourceAbsPath 异步解析路径', async () => {
      resourceAbsPathMock.mockResolvedValueOnce('D:/async/resolved/path.txt');
      const payload: KbDragPayload = {
        v: 1,
        items: [{
          resourceId: 'res-orphan',
          sourceKind: 'file',
          entry: 'file',
          from: { kind: 'root', rootId: 'unknown-root', relPath: 'path.txt' },
          rootId: 'unknown-root',
          relPath: 'path.txt',
          name: 'path.txt',
        }],
      };

      const items = fileMenu({ ctx: dummyCtx(), resourceId: 'res-orphan', title: 'path.txt', payload });
      const copyItem = items.find((it) => it.id === 'file.copyPath');
      await copyItem?.run();

      expect(resourceAbsPathMock).toHaveBeenCalledWith('res-orphan');
      expect(clipboardText).toBe('D:\\async\\resolved\\path.txt');
    });

    it('剪贴板 API 抛错时回退走 document.execCommand', async () => {
      const execFn = vi.fn();
      const appendFn = vi.fn();
      const removeFn = vi.fn();
      const dummyElem = { select: vi.fn(), value: '', style: {} };
      (globalThis as unknown as { document: unknown }).document = {
        createElement: vi.fn(() => dummyElem),
        body: { appendChild: appendFn, removeChild: removeFn },
        execCommand: execFn,
      };
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: vi.fn(async () => {
            throw new Error('Permission denied');
          }),
        },
        configurable: true,
        writable: true,
      });

      await copyToClipboard('C:\\fallback\\text.txt');
      expect(execFn).toHaveBeenCalledWith('copy');
      delete (globalThis as unknown as { document?: unknown }).document;
    });
  });
});
