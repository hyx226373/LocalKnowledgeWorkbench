/**
 * 数据迁移的 Electron 接线：迁移窗口（导出 / 导入并映射根目录 / 根目录与缺失文件 / 备份与回退）与 kb-migration IPC。
 * index.ts 只需调用 registerMigration(...)，菜单项调用 openMigrationWindow(tab)。
 */
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { PACKAGE_EXT } from './format';
import { MIGRATION_HTML } from './ui';

export type MigrationTab = 'export' | 'import' | 'repair' | 'backups';

interface Deps {
  /** 数据库操作在数据进程。方法名以 migration. 开头。 */
  call: (method: string, ...args: unknown[]) => Promise<unknown>;
  getMainWindow: () => BrowserWindow | null;
}

let deps: Deps | null = null;
let mwin: BrowserWindow | null = null;

/** 让主窗口把防抖中的布局写完（复用关闭窗口时的 kb:before-quit → kb:flush-done 协议） */
function flushMainWindow(): Promise<void> {
  const w = deps?.getMainWindow();
  if (!w || w.isDestroyed()) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      ipcMain.removeListener('kb:flush-done', onDone);
      resolve();
    };
    const onDone = (ev: Electron.IpcMainEvent) => ev.sender === w.webContents && finish();
    ipcMain.on('kb:flush-done', onDone);
    w.webContents.send('kb:before-quit');
    setTimeout(finish, 3000);
  });
}

/** 数据整体替换：主窗口先离开工作台页面（不会再写入旧布局），替换完成后重新载入（从数据库恢复导入的工作区） */
async function withMainWindowParked<T>(fn: () => Promise<T>): Promise<T> {
  const w = deps?.getMainWindow();
  await flushMainWindow();
  const url = w && !w.isDestroyed() ? w.webContents.getURL() : '';
  if (w && !w.isDestroyed() && url) await w.webContents.loadURL('about:blank').catch(() => undefined);
  try {
    return await fn();
  } finally {
    await deps?.call('migration.rootsReplaced');
    if (w && !w.isDestroyed() && url) await w.webContents.loadURL(url).catch(() => undefined);
  }
}

function clean(e: unknown) {
  return String((e as Error)?.message ?? e);
}

function registerIpc() {
  const call = (method: string, ...args: unknown[]) => deps!.call(method, ...args);
  const parent = () => mwin ?? undefined;
  const api: Record<string, (...a: any[]) => unknown> = {
    info: () => call('migration.info'),
    pickSave: async () => {
      const d = new Date();
      const name = `本地知识工作台-迁移-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.${PACKAGE_EXT}`;
      const r = await dialog.showSaveDialog(parent()!, { title: '导出数据迁移包', defaultPath: path.join(app.getPath('documents'), name), filters: [{ name: '迁移包', extensions: ['zip'] }] });
      return r.canceled ? null : r.filePath;
    },
    pickPackage: async () => {
      const r = await dialog.showOpenDialog(parent()!, { title: '选择数据迁移包', properties: ['openFile'], filters: [{ name: '迁移包', extensions: ['zip'] }] });
      return r.canceled ? null : r.filePaths[0];
    },
    pickFolder: async (title?: string) => {
      const r = await dialog.showOpenDialog(parent()!, { title: String(title ?? '选择文件夹'), properties: ['openDirectory'] });
      return r.canceled ? null : r.filePaths[0];
    },
    pickFile: async (title?: string) => {
      const r = await dialog.showOpenDialog(parent()!, { title: String(title ?? '选择文件'), properties: ['openFile'] });
      return r.canceled ? null : r.filePaths[0];
    },
    exportTo: async (file: string) => {
      await flushMainWindow();
      return call('migration.exportTo', file);
    },
    inspect: (file: string, baseDirs?: string[]) => call('migration.inspect', file, baseDirs),
    suggest: (file: string, baseDir: string) => call('migration.suggest', file, baseDir),
    importPackage: (file: string, mappings: unknown) => withMainWindowParked(() => call('migration.importPackage', file, mappings)),
    roots: () => call('migration.roots'),
    // 数据进程只重新挂上监听，不再紧跟 scanRoot：扫描会按同路径把未接受的 pathHint 绑回去。
    remapRoot: (rootId: string, p: string) => call('migration.remapRoot', rootId, p),
    listMissing: () => call('migration.listMissing'),
    relocate: (rid: string, p: string) => call('migration.relocate', rid, p),
    listBackups: () => call('migration.listBackups'),
    backupNow: async () => {
      await flushMainWindow();
      return call('migration.backupNow');
    },
    restoreBackup: (dir: string) => withMainWindowParked(() => call('migration.restoreBackup', dir)),
  };
  ipcMain.handle('kb-migration', async (e, method: string, ...args: unknown[]) => {
    if (!mwin || e.sender !== mwin.webContents) throw new Error('只接受数据迁移窗口的调用');
    const fn = api[method];
    if (!fn) throw new Error(`未知方法: ${method}`);
    try {
      return await fn(...args);
    } catch (err) {
      throw new Error(clean(err));
    }
  });
}

export function registerMigration(d: Deps) {
  deps = d;
  registerIpc();
}

export function openMigrationWindow(tab: MigrationTab = 'export') {
  if (!deps) return;
  if (mwin && !mwin.isDestroyed()) {
    void mwin.webContents.executeJavaScript(`window.__showTab && window.__showTab(${JSON.stringify(tab)})`);
    mwin.focus();
    return;
  }
  const parent = deps.getMainWindow() ?? undefined;
  mwin = new BrowserWindow({
    width: 900,
    height: 700,
    parent,
    title: '数据迁移 — 本地知识工作台',
    autoHideMenuBar: true,
    backgroundColor: '#1e1e1e',
    webPreferences: { preload: path.join(__dirname, 'migrationPreload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  mwin.setMenu(null);
  mwin.webContents.on('will-navigate', (e) => e.preventDefault());
  mwin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mwin.on('closed', () => (mwin = null));
  void mwin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(MIGRATION_HTML.replace('__TAB__', tab)));
}
