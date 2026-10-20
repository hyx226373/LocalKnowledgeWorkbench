import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/renderer/kb', () => ({
  kb: {
    openWithDefaultApp: vi.fn(async () => undefined),
    showInFolder: vi.fn(async () => undefined),
    removeVfolderMembership: vi.fn(),
  },
}));

vi.mock('../src/renderer/keybindings/contextMenu', () => ({
  openSetKeybindingFor: vi.fn(),
  SET_KEYBINDING_LABEL: '设置快捷键…',
}));
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SOURCE_ACTIONS } from '../src/shared/actions/packages/sources';
import type { Ctx } from '../src/renderer/dir-view/context';
import type { KbDragPayload } from '../src/renderer/dir-view/dnd';
import {
  HIDE_MENU_ID,
  HIDE_MENU_LABEL,
  TRASH_MENU_ID,
  TRASH_MENU_LABEL,
  TRASH_SEP_ID,
  dispatchTreeKey,
  hideConfirmSpec,
  isPaletteDirectDelete,
  paletteSourceActions,
  runConfirmedAction,
  trashConfirmSpec,
  treeKeyIntent,
} from '../src/renderer/dir-view/diskActions';
import { RootMoreMenuView } from '../src/renderer/dir-view/RootOverflowMenu';
import { RESTORE_ALL_REMOVED_LABEL, rootMoreMenuItems, rootRowMoreItems } from '../src/renderer/dir-view/rootMoreMenu';
import { DEFAULT_SIDEBAR_PREFS } from '../src/renderer/drawer/sidebarPrefs';
import { fileMenu, RowMenu } from '../src/renderer/dir-view/RowMenu';
import { disk } from '../src/main/service/disk';
import { makeRoot, makeService, waitFor, write } from './helpers';
import type { WorkbenchService } from '../src/main/service/WorkbenchService';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function viewCtx(): Ctx {
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
  };
}

function payload(entry: 'file' | 'dir-entry', sourceKind: 'file' | 'web' = 'file', from: KbDragPayload['items'][number]['from'] = { kind: 'root', rootId: 'root-1', relPath: entry === 'file' ? 'notes/a.txt' : 'notes' }): KbDragPayload {
  return {
    v: 1,
    items: [{
      resourceId: 'res-1',
      sourceKind,
      entry,
      from,
    }],
  };
}

function installDeleteSpies() {
  const spies = [
    vi.spyOn(fs, 'rmSync'),
    vi.spyOn(fs, 'unlinkSync'),
    vi.spyOn(fs.promises, 'rm'),
    vi.spyOn(fs.promises, 'unlink'),
  ];
  if (disk.rmSync !== fs.rmSync) spies.push(vi.spyOn(disk, 'rmSync'));
  if (disk.unlinkSync !== fs.unlinkSync) spies.push(vi.spyOn(disk, 'unlinkSync'));
  if (disk.promises.rm !== fs.promises.rm) spies.push(vi.spyOn(disk.promises, 'rm'));
  if (disk.promises.unlink !== fs.promises.unlink) spies.push(vi.spyOn(disk.promises, 'unlink'));
  return {
    under(root: string) {
      const prefix = root.endsWith(path.sep) ? root : root + path.sep;
      return spies.flatMap((spy) => spy.mock.calls.map((args) => String(args[0] ?? ''))).filter((target) => target === root || target.startsWith(prefix));
    },
    restore() {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

async function setup() {
  const { svc, dataDir } = await makeService();
  cleanups.push(() => svc.close());
  const rootDir = makeRoot();
  write(path.join(rootDir, 'alpha-note.txt'), 'alpha');
  const root = svc.addRoot(rootDir);
  await svc.scanRoot(root.id);
  return { svc, dataDir, rootDir, root };
}

function resourceRow(svc: WorkbenchService, rootId: string, rel: string) {
  return svc.db.prepare('SELECT id, missing_since FROM resources WHERE root_id=? AND rel_path=?').get(rootId, rel) as { id: string; missing_since: number | null } | undefined;
}

function ftsCount(svc: WorkbenchService, resourceId: string) {
  return (svc.db.prepare('SELECT COUNT(*) c FROM resources_fts WHERE resource_id=?').get(resourceId) as { c: number }).c;
}

describe('目录树删除入口', () => {
  it('磁盘删除在菜单最后，前面有分隔线，两项都是 danger', () => {
    const items = fileMenu({ ctx: viewCtx(), resourceId: 'res-1', title: 'a.txt', payload: payload('file') });
    const trashAt = items.findIndex((item) => item.id === TRASH_MENU_ID);
    const hideAt = items.findIndex((item) => item.id === HIDE_MENU_ID);
    const sepAt = items.findIndex((item) => item.id === TRASH_SEP_ID);
    expect(trashAt).toBe(items.length - 1);
    expect(sepAt).toBe(trashAt - 1);
    expect(hideAt).toBe(sepAt - 1);
    expect(items[hideAt]).toMatchObject({ label: HIDE_MENU_LABEL, danger: true });
    expect(items[hideAt]?.separator).toBeUndefined();
    expect(items[sepAt]?.separator).toBe(true);
    expect(items[trashAt]).toMatchObject({ label: TRASH_MENU_LABEL, danger: true });
    expect(HIDE_MENU_LABEL).toContain('不删除磁盘文件');
    expect(HIDE_MENU_LABEL).not.toBe(TRASH_MENU_LABEL);

    const html = renderToStaticMarkup(createElement(RowMenu, { x: 1, y: 2, items, onClose: () => undefined }));
    expect(html).toContain('class="menu-sep"');
    expect(html).toContain('role="separator"');
    expect(html).toContain('kb-menu-item danger');
    expect(html.lastIndexOf(TRASH_MENU_LABEL)).toBeGreaterThan(html.lastIndexOf(HIDE_MENU_LABEL));
    expect(html.lastIndexOf('menu-sep')).toBeGreaterThan(html.indexOf(HIDE_MENU_LABEL));
    expect(html.lastIndexOf(TRASH_MENU_LABEL)).toBeGreaterThan(html.lastIndexOf('menu-sep'));

    const dir = fileMenu({ ctx: viewCtx(), resourceId: 'res-1', title: 'notes', payload: payload('dir-entry') });
    expect(dir.at(-1)?.id).toBe(TRASH_MENU_ID);
    expect(dir.some((item) => item.id === HIDE_MENU_ID)).toBe(true);

    const web = fileMenu({ ctx: viewCtx(), resourceId: 'res-1', title: 'page', payload: payload('file', 'web') });
    expect(web.some((item) => item.id === TRASH_MENU_ID || item.id === HIDE_MENU_ID)).toBe(false);

    const rootRow = fileMenu({
      ctx: viewCtx(),
      resourceId: 'root-res',
      title: '笔记',
      payload: payload('dir-entry', 'file', { kind: 'roots-list' }),
    });
    expect(rootRow.some((item) => item.id === HIDE_MENU_ID)).toBe(false);
    expect(rootRow.at(-1)?.id).toBe(TRASH_MENU_ID);
    expect(rootRow.at(-2)?.separator).toBe(true);
  });

  it('取消不执行；确认只执行一次；失败不重试', async () => {
    const act = vi.fn(async () => undefined);
    const cancelled = await runConfirmedAction(async () => false, trashConfirmSpec('/data/notes/a.txt'), act);
    expect(cancelled).toBe('cancelled');
    expect(act).not.toHaveBeenCalled();

    const spec = hideConfirmSpec('/data/notes');
    expect(spec.body).toContain('不删除磁盘文件');
    expect(spec.body).toContain('/data/notes');
    expect(trashConfirmSpec('/data/notes/a.txt').body).toContain('移到回收站');
    expect(trashConfirmSpec('/data/notes/a.txt').body).toContain('/data/notes/a.txt');

    const once = vi.fn(async () => 'moved');
    await expect(runConfirmedAction(async () => true, trashConfirmSpec('/data/notes/a.txt'), once)).resolves.toBe('done');
    expect(once).toHaveBeenCalledTimes(1);

    const boom = vi.fn(async () => {
      throw new Error('回收站忙');
    });
    await expect(runConfirmedAction(async () => true, trashConfirmSpec('/tmp/a'), boom)).rejects.toThrow('回收站忙');
    expect(boom).toHaveBeenCalledTimes(1);
  });

  it('Delete 键只触发从根目录移除，不触发回收站', () => {
    expect(treeKeyIntent('Delete', 'a.txt')).toBe('hide-from-root');
    expect(treeKeyIntent('Delete', '')).toBe('ignore');
    expect(treeKeyIntent('Enter', 'a.txt')).toBe('open');
    const hide = vi.fn();
    const open = vi.fn();
    const trash = vi.fn();
    expect(dispatchTreeKey('Delete', 'a.txt', { open, hideFromRoot: hide })).toBe('hide-from-root');
    expect(hide).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    expect(trash).not.toHaveBeenCalled();
    dispatchTreeKey('Delete', '', { open, hideFromRoot: hide });
    expect(hide).toHaveBeenCalledTimes(1);
    dispatchTreeKey('Enter', 'a.txt', { open, hideFromRoot: hide });
    expect(open).toHaveBeenCalledTimes(1);
    expect(trash).not.toHaveBeenCalled();
  });

  it('命令面板不再直接登记磁盘删除，注册表仍保留该动作', () => {
    expect(isPaletteDirectDelete('disk.trash')).toBe(true);
    const visible = paletteSourceActions(SOURCE_ACTIONS).map((action) => action.actionId);
    expect(visible).not.toContain('disk.trash');
    expect(visible).toContain('disk.write');
    expect(SOURCE_ACTIONS.some((action) => action.actionId === 'disk.trash')).toBe(true);
  });

  it('根目录更多菜单有已隐藏项', () => {
    const prefs = { ...DEFAULT_SIDEBAR_PREFS, hideUnopenableFiles: false, dragOutMode: 'file' as const };
    let opened = 0;
    const items = rootMoreMenuItems(prefs, false, () => undefined, () => { opened += 1; });
    const hidden = items.find((item) => item.id === 'hidden-items');
    expect(hidden?.label).toBe('已隐藏项…');
    hidden?.onClick();
    expect(opened).toBe(1);
    expect(items.some((item) => item.testId === 'root-restore-all-removed')).toBe(false);
  });

  it('没有已移除项时，根上的恢复全部禁用', () => {
    let ran = 0;
    const idle = rootRowMoreItems(0, () => { ran += 1; });
    expect(idle).toHaveLength(1);
    expect(idle[0]).toMatchObject({
      label: RESTORE_ALL_REMOVED_LABEL,
      testId: 'root-restore-all-removed',
      disabled: true,
    });
    idle[0]?.onClick();
    expect(ran).toBe(0);
    const idleHtml = renderToStaticMarkup(createElement(RootMoreMenuView, { items: idle }));
    expect(idleHtml).toContain('data-testid="root-restore-all-removed"');
    expect(idleHtml).toContain('恢复全部已移除项');
    expect(idleHtml).toContain('disabled=""');
    expect(idleHtml).toContain('aria-disabled="true"');

    const ready = rootRowMoreItems(2, () => { ran += 1; });
    expect(ready[0]?.disabled).toBe(false);
    ready[0]?.onClick();
    expect(ran).toBe(1);
    const readyHtml = renderToStaticMarkup(createElement(RootMoreMenuView, { items: ready }));
    expect(readyHtml).toContain('data-testid="root-restore-all-removed"');
    expect(readyHtml).not.toContain('disabled');
    expect(readyHtml).not.toContain('aria-disabled');

    const sidebar = fs.readFileSync(path.join(process.cwd(), 'src/renderer/dir-view/Sidebar.tsx'), 'utf8');
    expect(sidebar).toContain('RootOverflowMenu');
    expect(sidebar).toContain('restoreAllHidden');
  });
});

describe('从根目录移除与回收站', () => {
  it('隐藏只改排除列表，恢复后重新出现并重建索引', async () => {
    const { svc, root, rootDir } = await setup();
    const rel = 'alpha-note.txt';
    const abs = path.join(rootDir, rel);
    const before = resourceRow(svc, root.id, rel);
    expect(before).toBeTruthy();
    expect(ftsCount(svc, before!.id)).toBeGreaterThan(0);
    expect(svc.search('alpha-note').some((hit) => hit.relPath === rel)).toBe(true);
    const trash = vi.fn(async () => undefined);
    svc.setTrashItem(trash);
    const spies = installDeleteSpies();
    try {
      svc.hideFromRoot(root.id, rel);
      expect(trash).not.toHaveBeenCalled();
      expect(fs.readFileSync(abs, 'utf8')).toBe('alpha');
      expect(spies.under(rootDir)).toEqual([]);
      const hiddenRow = resourceRow(svc, root.id, rel);
      expect(hiddenRow?.missing_since).toBeNull();
      expect(ftsCount(svc, before!.id)).toBe(0);
      expect(svc.listDir(root.id, '').some((entry) => entry.relPath === rel)).toBe(false);
      expect(svc.search('alpha-note').some((hit) => hit.relPath === rel)).toBe(false);
      expect(svc.listHiddenItems()).toEqual([
        expect.objectContaining({ rootId: root.id, relPath: rel, name: 'alpha-note.txt' }),
      ]);
      await svc.scanRoot(root.id);
      expect(resourceRow(svc, root.id, rel)?.missing_since).toBeNull();
      expect(fs.existsSync(abs)).toBe(true);
      expect(svc.listDir(root.id, '').some((entry) => entry.relPath === rel)).toBe(false);

      svc.hideFromRoot(root.id, '笔记');
      expect(fs.existsSync(path.join(rootDir, '笔记/待办.txt'))).toBe(true);
      expect(svc.listDir(root.id, '').some((entry) => entry.name === '笔记')).toBe(false);
      expect(svc.listDir(root.id, '笔记')).toEqual([]);
      const child = resourceRow(svc, root.id, '笔记/待办.txt');
      expect(child?.missing_since).toBeNull();
      expect(ftsCount(svc, child!.id)).toBe(0);
      expect(spies.under(rootDir)).toEqual([]);

      await svc.restoreHidden(root.id, '笔记');
      expect(fs.existsSync(path.join(rootDir, '笔记/待办.txt'))).toBe(true);
      expect(svc.listDir(root.id, '').some((entry) => entry.name === '笔记')).toBe(true);
      expect(svc.listDir(root.id, '笔记').some((entry) => entry.name === '待办.txt')).toBe(true);
      expect(resourceRow(svc, root.id, '笔记/待办.txt')?.missing_since).toBeNull();
      expect(ftsCount(svc, child!.id)).toBeGreaterThan(0);
      expect(svc.search('待办').some((hit) => hit.relPath === '笔记/待办.txt')).toBe(true);
      expect(svc.listHiddenItems().some((item) => item.relPath === '笔记')).toBe(false);
      expect(svc.listHiddenItems().some((item) => item.relPath === rel)).toBe(true);

      await svc.restoreHidden(root.id, rel);
      expect(svc.listDir(root.id, '').some((entry) => entry.relPath === rel)).toBe(true);
      expect(svc.search('alpha-note').some((hit) => hit.relPath === rel)).toBe(true);
      expect(ftsCount(svc, before!.id)).toBeGreaterThan(0);
      expect(trash).not.toHaveBeenCalled();
      expect(spies.under(rootDir)).toEqual([]);
    } finally {
      spies.restore();
    }
  });

  it('恢复全部只清空当前根，条目回来并重新扫描', async () => {
    const { svc, root, rootDir } = await setup();
    const otherDir = makeRoot();
    write(path.join(otherDir, 'beta-note.txt'), 'beta');
    const other = svc.addRoot(otherDir);
    await svc.scanRoot(other.id);
    const quietDir = makeRoot();
    const quiet = svc.addRoot(quietDir);
    await svc.scanRoot(quiet.id);

    const rel = 'alpha-note.txt';
    const fileRow = resourceRow(svc, root.id, rel);
    const child = resourceRow(svc, root.id, '笔记/待办.txt');
    const otherChild = resourceRow(svc, other.id, '笔记/待办.txt');
    expect(fileRow && child && otherChild).toBeTruthy();
    const spies = installDeleteSpies();
    const scan = vi.spyOn(svc, 'scanRoot');
    try {
      svc.hideFromRoot(root.id, rel);
      svc.hideFromRoot(root.id, '笔记');
      svc.hideFromRoot(other.id, '笔记');
      svc.hideFromRoot(other.id, 'beta-note.txt');
      expect(svc.listDir(root.id, '').some((entry) => entry.relPath === rel || entry.name === '笔记')).toBe(false);
      expect(ftsCount(svc, fileRow!.id)).toBe(0);
      expect(ftsCount(svc, child!.id)).toBe(0);

      scan.mockClear();
      await svc.restoreAllHidden(quiet.id);
      expect(scan).not.toHaveBeenCalled();
      expect(svc.listHiddenItems().filter((item) => item.rootId === root.id).map((item) => item.relPath).sort()).toEqual(['alpha-note.txt', '笔记']);
      expect(svc.listHiddenItems().filter((item) => item.rootId === other.id).map((item) => item.relPath).sort()).toEqual(['beta-note.txt', '笔记']);

      scan.mockClear();
      const restored = await svc.restoreAllHidden(root.id);
      expect(restored.restored.slice().sort()).toEqual(['alpha-note.txt', '笔记']);
      expect(scan.mock.calls.map((call) => call[0])).toEqual([root.id]);
      expect(svc.listHiddenItems().filter((item) => item.rootId === root.id)).toEqual([]);
      expect(svc.listHiddenItems().filter((item) => item.rootId === other.id).map((item) => item.relPath).sort()).toEqual(['beta-note.txt', '笔记']);
      expect(svc.listDir(root.id, '').some((entry) => entry.relPath === rel)).toBe(true);
      expect(svc.listDir(root.id, '').some((entry) => entry.name === '笔记')).toBe(true);
      expect(svc.listDir(root.id, '笔记').some((entry) => entry.name === '待办.txt')).toBe(true);
      expect(svc.listDir(other.id, '').some((entry) => entry.name === '笔记' || entry.relPath === 'beta-note.txt')).toBe(false);
      expect(resourceRow(svc, root.id, rel)?.missing_since).toBeNull();
      expect(resourceRow(svc, root.id, '笔记/待办.txt')?.missing_since).toBeNull();
      expect(ftsCount(svc, fileRow!.id)).toBeGreaterThan(0);
      expect(ftsCount(svc, child!.id)).toBeGreaterThan(0);
      expect(ftsCount(svc, otherChild!.id)).toBe(0);
      expect(svc.search('alpha-note').some((hit) => hit.rootId === root.id && hit.relPath === rel)).toBe(true);
      expect(svc.search('待办').some((hit) => hit.rootId === root.id && hit.relPath === '笔记/待办.txt')).toBe(true);
      expect(svc.search('待办').some((hit) => hit.rootId === other.id)).toBe(false);
      expect(svc.search('beta-note').some((hit) => hit.rootId === other.id)).toBe(false);
      expect(fs.readFileSync(path.join(rootDir, rel), 'utf8')).toBe('alpha');
      expect(fs.readFileSync(path.join(rootDir, '笔记/待办.txt'), 'utf8')).toBe('待办事项');
      expect(fs.readFileSync(path.join(otherDir, 'beta-note.txt'), 'utf8')).toBe('beta');
      expect(fs.existsSync(path.join(otherDir, '笔记/待办.txt'))).toBe(true);
      expect(spies.under(rootDir)).toEqual([]);
      expect(spies.under(otherDir)).toEqual([]);
      expect(spies.under(quietDir)).toEqual([]);

      await svc.restoreHidden(other.id, '笔记');
      expect(svc.listDir(other.id, '').some((entry) => entry.name === '笔记')).toBe(true);
      expect(svc.listHiddenItems().some((item) => item.rootId === other.id && item.relPath === 'beta-note.txt')).toBe(true);
      expect(svc.listHiddenItems().some((item) => item.rootId === root.id)).toBe(false);
    } finally {
      scan.mockRestore();
      spies.restore();
    }
  });

  it('根内删除只走 trashItem，失败不删文件', async () => {
    const { svc, root, rootDir } = await setup();
    const rel = '笔记/待办.txt';
    const abs = path.join(rootDir, rel);
    const trashed = `${abs}.trashed`;
    const spies = installDeleteSpies();
    try {
      await expect(svc.trashInsideRoot(root.id, rel)).rejects.toThrow('无法移到回收站');
      expect(fs.existsSync(abs)).toBe(true);

      svc.setTrashItem(async () => {
        throw new Error('回收站拒绝');
      });
      await expect(svc.trashInsideRoot(root.id, rel)).rejects.toThrow('回收站拒绝');
      expect(fs.existsSync(abs)).toBe(true);
      expect(spies.under(rootDir)).toEqual([]);

      svc.setTrashItem(async (target) => {
        fs.renameSync(target, `${target}.trashed`);
      });
      const moved = await svc.trashInsideRoot(root.id, rel);
      expect(moved.absPath).toBe(abs);
      expect(fs.existsSync(abs)).toBe(false);
      expect(fs.existsSync(trashed)).toBe(true);
      expect(svc.listDir(root.id, '笔记').some((entry) => entry.name === '待办.txt')).toBe(false);
      expect(spies.under(rootDir)).toEqual([]);
    } finally {
      spies.restore();
    }
  });

  it('整根删除失败时文件夹还在，成功时只交给 trashItem', async () => {
    const { svc, root, rootDir } = await setup();
    const spies = installDeleteSpies();
    try {
      svc.deleteRootFolder(root.id);
      const failed = await waitFor(() => {
        const task = svc.listRootTasks().find((item) => item.rootId === root.id && item.kind === 'delete-disk');
        if (!task || (task.state !== 'failed' && task.state !== 'done')) return null;
        return task;
      });
      if (!failed) throw new Error('任务没有结束');
      expect(failed.state).toBe('failed');
      expect(failed.error).toContain('无法移到回收站');
      expect(fs.existsSync(path.join(rootDir, 'alpha-note.txt'))).toBe(true);
      expect(spies.under(rootDir)).toEqual([]);
    } finally {
      spies.restore();
    }

    const again = await setup();
    const moved = `${again.rootDir}.trashed`;
    again.svc.setTrashItem(async (target) => {
      fs.renameSync(target, `${target}.trashed`);
    });
    const spies2 = installDeleteSpies();
    try {
      again.svc.deleteRootFolder(again.root.id);
      const done = await waitFor(() => {
        const task = again.svc.listRootTasks().find((item) => item.rootId === again.root.id && item.state === 'done');
        return task ?? null;
      });
      if (!done) throw new Error('任务没有结束');
      expect(done.kind).toBe('delete-disk');
      expect(done.phaseText).toBe('删除完成');
      expect(fs.existsSync(again.rootDir)).toBe(false);
      expect(fs.existsSync(moved)).toBe(true);
      expect(spies2.under(again.rootDir)).toEqual([]);
      const logged = again.svc.db.prepare("SELECT COUNT(*) c FROM op_log WHERE op='trash' AND root_id=?").get(again.root.id) as { c: number };
      expect(logged.c).toBe(0);
    } finally {
      spies2.restore();
    }
  });
});
