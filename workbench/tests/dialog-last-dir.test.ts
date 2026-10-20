import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  askDialogKey,
  createDialogLastDir,
  createJsonDialogLastDirStore,
  directoryToRemember,
  existingAncestor,
  fsIsDir,
  migrationDialogKey,
  normalizeDialogKey,
  openDialogWithMemory,
  resolveDialogDefaultPath,
  saveDialogWithMemory,
} from '../src/main/dialogLastDir';
import { DIALOG_LAST_DIR } from '../src/shared/dialogLastDir';
import type { OpenDialogOptions, OpenDialogReturnValue, SaveDialogOptions, SaveDialogReturnValue } from 'electron';

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-dialog-dir-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setOf(...paths: string[]): (abs: string) => boolean {
  const live = new Set(paths);
  return (abs) => live.has(abs);
}

describe('上次目录回退', () => {
  it('目录还在就用它，缺了就逐级用上级，全没有则不给路径', () => {
    expect(existingAncestor('/keep/mid/leaf', setOf('/keep'))).toBe('/keep');
    expect(existingAncestor('/keep/mid/leaf', setOf('/keep/mid/leaf'))).toBe('/keep/mid/leaf');
    expect(existingAncestor('/nope/leaf', setOf())).toBeNull();
    expect(existingAncestor('D:\\notes\\gone\\deep', setOf('D:\\notes'))).toBe('D:\\notes');
    expect(existingAncestor('E:\\nope\\x', setOf('D:\\'))).toBeNull();
    expect(existingAncestor('D:\\notes\\a.md', setOf('D:\\notes'))).toBe('D:\\notes');
  });

  it('真实目录被删掉后落到还在的上级', () => {
    const root = tempDir();
    const keep = path.join(root, 'keep');
    const leaf = path.join(keep, 'mid', 'leaf');
    fs.mkdirSync(leaf, { recursive: true });
    fs.rmSync(path.join(keep, 'mid'), { recursive: true });
    expect(existingAncestor(leaf, fsIsDir)).toBe(keep);
    expect(existingAncestor(path.join(keep, 'mid', 'file.md'), fsIsDir)).toBe(keep);
  });

  it('打开框只传还在的目录；保存框在该目录下保留建议文件名', () => {
    const isDir = setOf('/keep', '/docs');
    expect(resolveDialogDefaultPath('/keep/old', '/docs/pack.zip', isDir, 'open')).toBe('/keep');
    expect(resolveDialogDefaultPath('/keep/old', '/docs/pack.zip', isDir, 'save')).toBe('/keep/pack.zip');
    expect(resolveDialogDefaultPath('/gone/child', '/docs/pack.zip', isDir, 'open')).toBeUndefined();
    expect(resolveDialogDefaultPath('/gone/child', '/docs/pack.zip', isDir, 'save')).toBeUndefined();
    expect(resolveDialogDefaultPath(null, '/docs/pack.zip', isDir, 'save')).toBe('/docs/pack.zip');
    expect(resolveDialogDefaultPath(null, '/docs/pack.zip', isDir, 'open')).toBe('/docs');
    expect(resolveDialogDefaultPath(null, 'layout.kblayout.json', setOf(), 'save')).toBe('layout.kblayout.json');
    expect(resolveDialogDefaultPath('D:\\old\\gone', 'D:\\docs\\迁移.kbmigrate.zip', setOf('D:\\old'), 'save')).toBe('D:\\old\\迁移.kbmigrate.zip');
  });

  it('选文件记所在目录，选文件夹记文件夹本身', () => {
    const isDir = setOf('/proj/docs', '/proj/docs/sub');
    expect(directoryToRemember('/proj/docs/a.md', ['openFile'], isDir)).toBe('/proj/docs');
    expect(directoryToRemember('/proj/docs/sub', ['openDirectory'], isDir)).toBe('/proj/docs/sub');
    expect(directoryToRemember('D:\\notes\\a.md', ['openFile'], setOf())).toBe('D:\\notes');
    expect(directoryToRemember('D:\\notes', ['openDirectory'], setOf())).toBe('D:\\notes');
    expect(directoryToRemember('  ', ['openFile'], isDir)).toBeNull();
  });
});

describe('入口键隔离', () => {
  it('注册根目录和注册单个文件是两把键，其它入口也不撞车', () => {
    expect(typeof openDialogWithMemory).toBe('function');
    expect(openDialogWithMemory.length).toBe(3);
    expect(typeof saveDialogWithMemory).toBe('function');
    expect(DIALOG_LAST_DIR.registerRoot).toBe('dialogLastDir.registerRoot');
    expect(DIALOG_LAST_DIR.registerFile).toBe('dialogLastDir.registerFile');
    expect(DIALOG_LAST_DIR.registerRoot).not.toBe(DIALOG_LAST_DIR.registerFile);
    expect(normalizeDialogKey('registerRoot')).toBe(DIALOG_LAST_DIR.registerRoot);
    expect(normalizeDialogKey(DIALOG_LAST_DIR.registerFile)).toBe(DIALOG_LAST_DIR.registerFile);

    const wired = [
      DIALOG_LAST_DIR.registerRoot,
      DIALOG_LAST_DIR.registerFile,
      DIALOG_LAST_DIR.addMaterial,
      DIALOG_LAST_DIR.relocateMaterial,
      DIALOG_LAST_DIR.sourceFile,
      DIALOG_LAST_DIR.archiveLocation,
      DIALOG_LAST_DIR.agentDataLocation,
      DIALOG_LAST_DIR.writeProjectRoot,
      askDialogKey('pickDirectory', '选择插件文件夹（包含 manifest.json 与打包后的 main）'),
      askDialogKey('pickDirectory', '选择主题包文件夹（包含 theme.json）'),
      askDialogKey('pickFile', '导入工作区布局'),
      askDialogKey('saveFile', '导出工作区布局'),
      migrationDialogKey('save'),
      migrationDialogKey('package'),
      migrationDialogKey('folder', '资料所在的上级文件夹'),
      migrationDialogKey('folder', '「论文」在本机的位置'),
      migrationDialogKey('folder', '选择文件夹'),
      migrationDialogKey('file', '重新定位：a/b.md'),
      migrationDialogKey('file', '选择文件'),
    ];
    expect(new Set(wired).size).toBe(wired.length);
    expect(askDialogKey('pickFile', '导入工作区布局', DIALOG_LAST_DIR.addMaterial)).toBe(DIALOG_LAST_DIR.addMaterial);
    expect(askDialogKey('pickFile', '甲')).not.toBe(askDialogKey('pickFile', '乙'));
    expect(askDialogKey('pickFile', '甲')).not.toBe(askDialogKey('pickDirectory', '甲'));
    expect(migrationDialogKey('folder', '「甲」在本机的位置')).toBe(migrationDialogKey('folder', '「乙」在本机的位置'));
    expect(migrationDialogKey('folder')).toBe(DIALOG_LAST_DIR.migrationRemapFolder);
    expect(migrationDialogKey('file', '重新定位：a.md')).toBe(migrationDialogKey('file', '重新定位：b/c.md'));
  });

  it('两把键写在同一个文件里，改一个不会动另一个', () => {
    const file = path.join(tempDir(), 'dialog-last-dir.json');
    const store = createJsonDialogLastDirStore(file);
    store.set(DIALOG_LAST_DIR.registerRoot, '/roots/proj');
    store.set(DIALOG_LAST_DIR.registerFile, '/files');
    store.set('registerRoot', '/roots/other');
    expect(store.get(DIALOG_LAST_DIR.registerFile)).toBe('/files');
    expect(store.get('registerFile')).toBe('/files');

    const again = createJsonDialogLastDirStore(file);
    expect(again.get(DIALOG_LAST_DIR.registerRoot)).toBe('/roots/other');
    expect(again.get(DIALOG_LAST_DIR.registerFile)).toBe('/files');
    again.set(DIALOG_LAST_DIR.addMaterial, '/loose');
    expect(createJsonDialogLastDirStore(file).get(DIALOG_LAST_DIR.registerFile)).toBe('/files');
    expect(createJsonDialogLastDirStore(file).get(DIALOG_LAST_DIR.addMaterial)).toBe('/loose');
    expect(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp'))).toEqual([]);

    const body = JSON.parse(fs.readFileSync(file, 'utf8')) as { v: number; dirs: Record<string, string> };
    expect(body.v).toBe(1);
    expect(body.dirs[DIALOG_LAST_DIR.registerRoot]).toBe('/roots/other');
    expect(body.dirs[DIALOG_LAST_DIR.registerFile]).toBe('/files');
  });

  it('损坏的记录文件当作没有，之后写入只补当前键', () => {
    const file = path.join(tempDir(), 'dialog-last-dir.json');
    fs.writeFileSync(file, '{');
    const store = createJsonDialogLastDirStore(file);
    expect(store.get(DIALOG_LAST_DIR.registerRoot)).toBeNull();
    store.set(DIALOG_LAST_DIR.registerFile, '/only');
    expect(store.get(DIALOG_LAST_DIR.registerRoot)).toBeNull();
    expect(store.get(DIALOG_LAST_DIR.registerFile)).toBe('/only');
  });
});

describe('openDialogWithMemory', () => {
  function harness(isDir: (abs: string) => boolean) {
    const file = path.join(tempDir(), 'dialog-last-dir.json');
    const store = createJsonDialogLastDirStore(file);
    const opens: OpenDialogOptions[] = [];
    const saves: SaveDialogOptions[] = [];
    const windows: unknown[] = [];
    let opened: OpenDialogReturnValue = { canceled: true, filePaths: [] };
    let saved: SaveDialogReturnValue = { canceled: true, filePath: '' };
    const api = createDialogLastDir({
      store,
      isDir,
      showOpenDialog: async (win, options) => {
        windows.push(win);
        opens.push(options);
        return opened;
      },
      showSaveDialog: async (win, options) => {
        windows.push(win);
        saves.push(options);
        return saved;
      },
    });
    return {
      api,
      store,
      opens,
      saves,
      windows,
      setOpened(next: OpenDialogReturnValue) {
        opened = next;
      },
      setSaved(next: SaveDialogReturnValue) {
        saved = next;
      },
    };
  }

  it('按键记住目录，不存在就回退，取消不覆盖', async () => {
    const live = new Set(['/roots/proj', '/files']);
    const box = harness((abs) => live.has(abs));
    const caller = { title: '选择要注册为来源的单个文件', defaultPath: '/missing/a.zip', properties: ['openFile'] as Array<'openFile'> };

    box.setOpened({ canceled: false, filePaths: ['/roots/proj'] });
    await box.api.openDialogWithMemory(DIALOG_LAST_DIR.registerRoot, null, { properties: ['openDirectory'], title: '选择要注册为根的文件夹' });
    box.setOpened({ canceled: false, filePaths: ['/files/a.md'] });
    await box.api.openDialogWithMemory(DIALOG_LAST_DIR.registerFile, null, caller);

    expect(caller.defaultPath).toBe('/missing/a.zip');
    expect(box.store.get(DIALOG_LAST_DIR.registerRoot)).toBe('/roots/proj');
    expect(box.store.get(DIALOG_LAST_DIR.registerFile)).toBe('/files');
    expect(box.opens[0]?.defaultPath).toBeUndefined();
    expect(box.opens[1]?.defaultPath).toBeUndefined();
    expect(box.opens[1]?.title).toBe(caller.title);
    expect(box.opens[1]?.properties).toEqual(['openFile']);

    box.opens.length = 0;
    box.setOpened({ canceled: true, filePaths: [] });
    await box.api.openDialogWithMemory(DIALOG_LAST_DIR.registerFile, { isDestroyed: () => false }, { properties: ['openFile'] });
    expect(box.opens[0]?.defaultPath).toBe('/files');
    expect(box.store.get(DIALOG_LAST_DIR.registerFile)).toBe('/files');
    expect(box.store.get(DIALOG_LAST_DIR.registerRoot)).toBe('/roots/proj');

    live.delete('/files');
    live.add('/');
    box.opens.length = 0;
    await box.api.openDialogWithMemory(DIALOG_LAST_DIR.registerFile, { isDestroyed: () => true }, { properties: ['openFile'] });
    expect(box.opens[0]?.defaultPath).toBe('/');
    expect(box.windows.at(-1)).toBeNull();

    live.delete('/');
    box.opens.length = 0;
    await box.api.openDialogWithMemory(DIALOG_LAST_DIR.registerFile, null, { properties: ['openFile'], defaultPath: '/docs/a.md' });
    expect(Object.prototype.hasOwnProperty.call(box.opens[0], 'defaultPath')).toBe(false);
    expect(box.store.get(DIALOG_LAST_DIR.registerRoot)).toBe('/roots/proj');
  });

  it('保存框记住文件所在目录，另一把键不动', async () => {
    const live = new Set(['/docs', '/out']);
    const box = harness((abs) => live.has(abs));
    box.setSaved({ canceled: false, filePath: '/out/pack.zip' });
    await box.api.saveDialogWithMemory(DIALOG_LAST_DIR.migrationExport, null, {
      title: '导出数据迁移包',
      defaultPath: '/docs/pack.zip',
      filters: [{ name: '迁移包', extensions: ['zip'] }],
    });
    expect(box.saves[0]?.defaultPath).toBe('/docs/pack.zip');
    expect(box.saves[0]?.filters).toEqual([{ name: '迁移包', extensions: ['zip'] }]);
    expect(box.store.get(DIALOG_LAST_DIR.migrationExport)).toBe('/out');
    expect(box.store.get(DIALOG_LAST_DIR.migrationPackage)).toBeNull();

    box.setSaved({ canceled: true, filePath: '' });
    await box.api.saveDialogWithMemory(DIALOG_LAST_DIR.migrationExport, null, {
      title: '导出数据迁移包',
      defaultPath: '/docs/pack.zip',
    });
    expect(box.saves[1]?.defaultPath).toBe('/out/pack.zip');
    expect(box.store.get(DIALOG_LAST_DIR.migrationExport)).toBe('/out');
  });
});
