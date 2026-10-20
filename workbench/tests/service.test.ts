import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FILE_SYMLINK_SKIP_REASON, linkDir, makeRoot, makeService, tmpDir, tryFileSymlink, write, waitFor } from './helpers';
import { PathEscapeError } from '../src/main/service/paths';
import { ConflictError, SourceCoveredError, WorkbenchService, decodeText } from '../src/main/service/WorkbenchService';
import { EMPTY_ROOT_FILTER_JSON } from '../src/main/service/db';
import Database from 'better-sqlite3';
import { RootWatchers } from '../src/main/service/watcher';
import { kbfileResUrl, kbfileRootUrl } from '../src/shared/types';
import { openDb } from '../src/main/service/db';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup() {
  const { svc, dataDir } = await makeService();
  cleanups.push(() => svc.close());
  const rootDir = makeRoot();
  const root = svc.addRoot(rootDir);
  await svc.scanRoot(root.id);
  return { svc, dataDir, rootDir, root };
}

const ridOf = (svc: WorkbenchService, rootId: string, rel: string) => svc.resourceIdFor(rootId, rel);

function rootCount(svc: WorkbenchService) {
  return (svc.db.prepare('SELECT COUNT(*) c FROM roots').get() as { c: number }).c;
}

describe('根目录', () => {
  it('注册、列目录、子路径是别名、父路径盖住则拒绝、数据目录不能当根', async () => {
    const { svc, rootDir, root, dataDir } = await setup();
    expect(svc.listRoots()).toHaveLength(1);
    expect(root.status).toBe('ok');
    expect(root.kind).toBe('folder');
    const names = svc.listDir(root.id, '').map((e) => e.name);
    expect(names).toEqual(['笔记', '资料']); // 目录在前
    const before = rootCount(svc);
    const sub = path.join(rootDir, '笔记');
    const hit = svc.resolveIngest(sub, 'folder');
    expect(hit).toEqual({ alias: true, resourceId: ridOf(svc, root.id, '笔记') });
    const alias = svc.addRoot(sub);
    expect(alias.alias).toBe(true);
    expect(alias.resourceId).toBe(ridOf(svc, root.id, '笔记'));
    expect(alias.id).toBe(root.id);
    expect(rootCount(svc)).toBe(before);
    const kept = root.resourceId;
    // 系统临时目录同时包住资料根和应用数据目录，拒绝即可（具体原因见下面的盖住用例）。
    expect(() => svc.addRoot(path.dirname(rootDir))).toThrow();
    expect(svc.getRoot(root.id).resourceId).toBe(kept);
    expect(rootCount(svc)).toBe(before);
    expect(() => svc.addRoot(path.join(rootDir, '不存在'))).toThrow(/不是可访问的文件夹/);
    expect(() => svc.addRoot(dataDir)).toThrow(/应用数据目录/);
  });

  it('元数据库位于数据目录，根目录内不产生任何文件', async () => {
    const { svc, rootDir, root } = await setup();
    const before = fs.readdirSync(rootDir).sort();
    svc.addFavorite(ridOf(svc, root.id, '笔记/待办.txt'));
    svc.setLayout('dock', { panels: { a: { params: { resourceId: 'x' } } } });
    expect(fs.readdirSync(rootDir).sort()).toEqual(before);
    expect(fs.existsSync(svc.dbFile)).toBe(true);
  });
});

describe('kbfile:// 路径校验', () => {
  it('合法 URL 解析到根内文件', async () => {
    const { svc, root, rootDir } = await setup();
    const rid = ridOf(svc, root.id, '笔记/待办.txt');
    expect(svc.resolveKbfileUrl(kbfileResUrl(rid, '待办.txt'))).toBe(path.join(rootDir, '笔记/待办.txt'));
    expect(svc.resolveKbfileUrl(kbfileRootUrl(root.id, '资料/图片/a.png'))).toBe(path.join(rootDir, '资料/图片/a.png'));
  });
  it('拒绝编码分隔符越界、未注册根、目录链接越界（Windows 上为 junction）', async () => {
    const { svc, root, rootDir } = await setup();
    const outside = tmpDir('kbout-');
    write(path.join(outside, 'secret.txt'), 'secret');
    expect(() => svc.resolveKbfileUrl(`kbfile://root/${root.id}/..%2F..%2F..%2Fetc%2Fpasswd`)).toThrow(PathEscapeError);
    expect(() => svc.resolveKbfileUrl(`kbfile://root/00000000-0000-4000-8000-000000000000/a.txt`)).toThrow(PathEscapeError);
    linkDir(outside, path.join(rootDir, 'link-out'));
    expect(() => svc.resolveKbfileUrl(kbfileRootUrl(root.id, 'link-out/secret.txt'))).toThrow(PathEscapeError);
  });
  it('拒绝文件符号链接越界', async (ctx) => {
    const { svc, root, rootDir } = await setup();
    const outside = tmpDir('kbout-');
    write(path.join(outside, 'secret.txt'), 'secret');
    if (!tryFileSymlink(path.join(outside, 'secret.txt'), path.join(rootDir, 'file-link.txt'))) return ctx.skip(FILE_SYMLINK_SKIP_REASON);
    expect(() => svc.resolveKbfileUrl(kbfileRootUrl(root.id, 'file-link.txt'))).toThrow(PathEscapeError);
  });
});

describe('索引与搜索', () => {
  it('扫描后可按文件名/路径搜索（中文 ≥3 字走 FTS5，短词走 LIKE）', async () => {
    const { svc } = await setup();
    expect(svc.search('读书笔记').map((h) => h.relPath)).toEqual(['笔记/读书笔记.md']);
    expect(svc.search('paper.pdf')[0].relPath).toBe('资料/论文/paper.pdf');
    expect(svc.search('待办').map((h) => h.name)).toContain('待办.txt');
    expect(svc.search('"引号')).toEqual([]);
    const st = svc.getIndexStatus()[0];
    expect(st.fileCount).toBe(5);
    expect(st.lastScanAt).not.toBeNull();
  });
});

describe('资源身份：路径不是身份', () => {
  it('应用外重命名已收藏文件（监听事件：先 add 后 unlink）后，收藏仍指向它', async () => {
    const { svc, root, rootDir } = await setup();
    const rid = ridOf(svc, root.id, '笔记/待办.txt');
    svc.addFavorite(rid);
    fs.renameSync(path.join(rootDir, '笔记/待办.txt'), path.join(rootDir, '笔记/待办-改名.txt'));
    await svc.applyFsEvents(root.id, [
      { type: 'add', relPath: '笔记/待办-改名.txt' },
      { type: 'unlink', relPath: '笔记/待办.txt' },
    ]);
    const fav = svc.listFavorites()[0];
    expect(fav.resourceId).toBe(rid);
    expect(fav.relPath).toBe('笔记/待办-改名.txt');
    expect(fav.missing).toBe(false);
    expect(svc.readText(rid).text).toBe('待办事项');
  });

  it('应用关闭期间移动到其他目录，启动对账扫描后收藏仍指向它', async () => {
    const { svc, root, rootDir } = await setup();
    const rid = ridOf(svc, root.id, '笔记/读书笔记.md');
    svc.addFavorite(rid);
    fs.renameSync(path.join(rootDir, '笔记/读书笔记.md'), path.join(rootDir, '资料/读书笔记-归档.md'));
    const r = await svc.scanRoot(root.id);
    expect(r?.renamed).toBe(1);
    const fav = svc.listFavorites()[0];
    expect(fav.resourceId).toBe(rid);
    expect(fav.relPath).toBe('资料/读书笔记-归档.md');
  });

  it('文件夹整体改名：收藏的子文件跟随（先 unlink 后 add 的顺序）', async () => {
    const { svc, root, rootDir } = await setup();
    const rid = ridOf(svc, root.id, '资料/论文/paper.pdf');
    const dirRid = ridOf(svc, root.id, '资料/论文');
    svc.addFavorite(rid);
    svc.addFavorite(dirRid);
    fs.renameSync(path.join(rootDir, '资料/论文'), path.join(rootDir, '资料/Papers'));
    await svc.applyFsEvents(root.id, [
      { type: 'unlinkDir', relPath: '资料/论文' },
      { type: 'addDir', relPath: '资料/Papers' },
      { type: 'add', relPath: '资料/Papers/paper.pdf' },
    ]);
    const favs = svc.listFavorites();
    expect(favs.find((f) => f.resourceId === rid)?.relPath).toBe('资料/Papers/paper.pdf');
    expect(favs.find((f) => f.resourceId === dirRid)?.relPath).toBe('资料/Papers');
  });

  it('编辑器“写临时文件再替换”（inode 改变、路径不变）不改变资源 ID', async () => {
    const { svc, root, rootDir } = await setup();
    const rid = ridOf(svc, root.id, '笔记/待办.txt');
    const p = path.join(rootDir, '笔记/待办.txt');
    fs.writeFileSync(p + '.tmp', '新内容');
    fs.rmSync(p);
    fs.renameSync(p + '.tmp', p);
    await svc.applyFsEvents(root.id, [{ type: 'unlink', relPath: '笔记/待办.txt' }, { type: 'add', relPath: '笔记/待办.txt' }]);
    expect(ridOf(svc, root.id, '笔记/待办.txt')).toBe(rid);
  });

  it('真正删除后收藏显示为“失联”而不是消失', async () => {
    const { svc, root, rootDir } = await setup();
    const rid = ridOf(svc, root.id, '笔记/待办.txt');
    svc.addFavorite(rid);
    fs.rmSync(path.join(rootDir, '笔记/待办.txt'));
    await svc.applyFsEvents(root.id, [{ type: 'unlink', relPath: '笔记/待办.txt' }]);
    expect(svc.listFavorites()[0].missing).toBe(true);
    expect(svc.getResource(rid)?.exists).toBe(false);
  });

  it('真实文件监听（chokidar）：应用外改名后收藏自动更新', async () => {
    const { svc, root, rootDir } = await setup();
    const w = new RootWatchers(svc, 100);
    cleanups.push(() => w.closeAll());
    w.sync();
    await waitFor(() => svc.getIndexStatus()[0].watching);
    const rid = ridOf(svc, root.id, '资料/报告.docx');
    svc.addFavorite(rid);
    fs.renameSync(path.join(rootDir, '资料/报告.docx'), path.join(rootDir, '报告-final.docx'));
    await waitFor(() => svc.listFavorites()[0].relPath === '报告-final.docx', 10000);
    expect(svc.listFavorites()[0].missing).toBe(false);
  });

  it('大目录挂上监听不用按文件建句柄，改名仍然能跟上', async () => {
    const { svc, root, rootDir } = await setup();
    const big = path.join(rootDir, '很多');
    fs.mkdirSync(big);
    for (let i = 0; i < 2000; i++) fs.writeFileSync(path.join(big, `f${i}.txt`), 'x');
    await svc.scanRoot(root.id);
    const rid = ridOf(svc, root.id, '很多/f0.txt');
    svc.addFavorite(rid);
    const w = new RootWatchers(svc, 50);
    cleanups.push(() => w.closeAll());
    const started = Date.now();
    w.sync();
    await waitFor(() => svc.getIndexStatus().some((s) => s.watching));
    expect(Date.now() - started).toBeLessThan(1000);
    fs.renameSync(path.join(big, 'f0.txt'), path.join(rootDir, 'f0-moved.txt'));
    await waitFor(() => svc.listFavorites()[0].relPath === 'f0-moved.txt', 10000);
    expect(svc.listFavorites()[0].missing).toBe(false);
  });
});

describe('布局持久化与备份/迁移', () => {
  it('布局按 key 保存并在重新打开服务后恢复；拒绝保存绝对路径', async () => {
    const { svc, dataDir } = await setup();
    const layout = { grid: { root: { type: 'branch', data: [] } }, panels: { 'res:1': { params: { resourceId: '1' } } } };
    svc.setLayout('dock', layout);
    expect(() => svc.setLayout('bad', { path: 'C:\\Users\\amy\\a.md' })).toThrow(/绝对路径/);
    expect(() => svc.setLayout('bad', { path: '/home/amy/a.md' })).toThrow(/绝对路径/);
    await svc.close();
    cleanups.pop();
    const svc2 = new WorkbenchService({ dataDir });
    cleanups.push(() => svc2.close());
    expect(svc2.getLayout('dock')).toEqual(layout);
  });

  it('备份元数据库并在“新电脑”上重新映射根：资源 ID、收藏、布局不变', async () => {
    const { svc, root, rootDir } = await setup();
    const rid = ridOf(svc, root.id, '笔记/读书笔记.md');
    svc.addFavorite(rid);
    svc.setLayout('dock', { panels: { [`res:${rid}`]: { params: { resourceId: rid } } } });
    const backup = path.join(tmpDir('kbbak-'), 'backup.db');
    await svc.backupTo(backup);

    // 新电脑：新数据目录 + 文件被复制到别的路径（inode 全变）
    const newData = tmpDir('kbdata2-');
    fs.copyFileSync(backup, path.join(newData, 'workbench.db'));
    const newRootDir = tmpDir('kbroot-moved-');
    fs.cpSync(rootDir, newRootDir, { recursive: true });
    const svc2 = new WorkbenchService({ dataDir: newData, machineId: 'new-pc' });
    cleanups.push(() => svc2.close());
    // r12-P4：remapRoot 不按同名路径自动配对，也不再内部扫描。
    // 下面的 scanRoot 仍走 upsertSeen（同路径优先），相同相对路径会复用资源 ID。
    svc2.remapRoot(root.id, newRootDir);
    await svc2.scanRoot(root.id);
    expect(svc2.getRoot(root.id).path).toBe(newRootDir);
    expect(svc2.listFavorites()[0].resourceId).toBe(rid);
    expect(svc2.listFavorites()[0].missing).toBe(false);
    expect(svc2.readText(rid).text).toContain('# 标题');
    expect(svc2.getLayout('dock')).toEqual({ panels: { [`res:${rid}`]: { params: { resourceId: rid } } } });
  });
});

describe('文件操作：预览 + 可恢复', () => {
  it('删除 = 移入应用暂存区（非系统回收站），可撤销并保持资源 ID', async () => {
    const { svc, root, rootDir, dataDir } = await setup();
    const rid = ridOf(svc, root.id, '笔记/待办.txt');
    svc.addFavorite(rid);
    const pv = svc.previewTrash(rid);
    expect(pv.summary).toMatch(/暂存区/);
    expect(pv.fileCount).toBe(1);
    const op = svc.trash(rid, 'agent:test');
    expect(fs.existsSync(path.join(rootDir, '笔记/待办.txt'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, String(op.detail.staging)))).toBe(true);
    expect(svc.listOps()[0]).toMatchObject({ op: 'trash', actor: 'agent:test', resourceId: rid });
    expect(svc.listFavorites()[0].missing).toBe(true);
    svc.undo(op.id);
    expect(fs.readFileSync(path.join(rootDir, '笔记/待办.txt'), 'utf8')).toBe('待办事项');
    expect(svc.listFavorites()[0]).toMatchObject({ resourceId: rid, missing: false });
    expect(svc.listOps()[0].op).toBe('undo');
    expect(() => svc.undo(op.id)).toThrow(/已撤销/);
  });

  it('恢复时原位置被占用：默认报冲突，keep-both 恢复为新名称', async () => {
    const { svc, root, rootDir } = await setup();
    const rid = ridOf(svc, root.id, '笔记/待办.txt');
    const op = svc.trash(rid);
    write(path.join(rootDir, '笔记/待办.txt'), '新建的同名文件');
    expect(svc.previewUndo(op.id).conflicts.length).toBe(1);
    expect(() => svc.undo(op.id)).toThrow(ConflictError);
    const u = svc.undo(op.id, 'keep-both');
    expect(u.detail.restoredTo).toBe('笔记/待办 (恢复 1).txt');
    expect(fs.readFileSync(path.join(rootDir, '笔记/待办 (恢复 1).txt'), 'utf8')).toBe('待办事项');
    expect(svc.getResource(rid)?.relPath).toBe('笔记/待办 (恢复 1).txt');
  });

  it('删除文件夹并恢复', async () => {
    const { svc, root, rootDir } = await setup();
    const rid = ridOf(svc, root.id, '资料');
    expect(svc.previewTrash(rid).fileCount).toBe(3);
    const op = svc.trash(rid);
    expect(fs.existsSync(path.join(rootDir, '资料'))).toBe(false);
    svc.undo(op.id);
    expect(fs.existsSync(path.join(rootDir, '资料/论文/paper.pdf'))).toBe(true);
  });

  it('覆盖写前把原内容存入内容寻址备份库，撤销可还原；之后又被修改则提示冲突', async () => {
    const { svc, root, rootDir, dataDir } = await setup();
    const rid = ridOf(svc, root.id, '笔记/读书笔记.md');
    const p = path.join(rootDir, '笔记/读书笔记.md');
    const op = svc.writeText(rid, 'Agent 改写的内容', 'agent:test');
    expect(fs.readFileSync(p, 'utf8')).toBe('Agent 改写的内容');
    const blob = path.join(dataDir, 'blobs', String(op.detail.beforeHash).slice(0, 2), String(op.detail.beforeHash));
    expect(fs.readFileSync(blob, 'utf8')).toBe('# 标题\n内容');
    expect(ridOf(svc, root.id, '笔记/读书笔记.md')).toBe(rid); // 原子替换不改变身份

    fs.writeFileSync(p, '用户随后手动改的'); // 用户在 Agent 之后又改了
    const pv = svc.previewUndo(op.id);
    expect(pv.conflicts[0]).toMatch(/又被修改/);
    expect(() => svc.undo(op.id)).toThrow(ConflictError);
    const u = svc.undo(op.id, 'keep-both'); // 先备份用户修改，再还原
    expect(fs.readFileSync(p, 'utf8')).toBe('# 标题\n内容');
    const userBlob = path.join(dataDir, 'blobs', String(u.detail.beforeHash).slice(0, 2), String(u.detail.beforeHash));
    expect(fs.readFileSync(userBlob, 'utf8')).toBe('用户随后手动改的');
  });

  it('移动/重命名记录前后位置并可撤销', async () => {
    const { svc, root, rootDir } = await setup();
    const rid = ridOf(svc, root.id, '资料/报告.docx');
    expect(svc.previewMove(rid, '笔记/待办.txt').conflicts.length).toBe(1);
    expect(() => svc.move(rid, '笔记/待办.txt')).toThrow(ConflictError);
    expect(() => svc.move(rid, '../逃逸.docx')).toThrow(PathEscapeError);
    const op = svc.move(rid, '归档/报告-v1.docx');
    expect(op.detail).toEqual({ from: '资料/报告.docx', to: '归档/报告-v1.docx' });
    expect(svc.getResource(rid)?.relPath).toBe('归档/报告-v1.docx');
    svc.undo(op.id);
    expect(fs.existsSync(path.join(rootDir, '资料/报告.docx'))).toBe(true);
    expect(svc.getResource(rid)?.relPath).toBe('资料/报告.docx');
  });

  it('超过保留期的暂存条目会被清理', async () => {
    const { svc, root } = await setup();
    const op = svc.trash(ridOf(svc, root.id, '笔记/待办.txt'));
    expect(svc.purgeStaging(Date.now() + 31 * 86400000)).toBe(1);
    expect(svc.previewUndo(op.id).conflicts.join()).toMatch(/无法恢复/);
  });
});

describe('文本解码', () => {
  it('UTF-8 / BOM / UTF-16LE / GBK', () => {
    expect(decodeText(Buffer.from('中文', 'utf8'))).toBe('中文');
    expect(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('中文')]))).toBe('中文');
    expect(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文', 'utf16le')]))).toBe('中文');
    expect(decodeText(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))).toBe('中文'); // GBK
  });
});

describe('数据库迁移', () => {
  it('重复打开不重复迁移', () => {
    const f = path.join(tmpDir('kbdb-'), 'x.db');
    openDb(f).close();
    const db = openDb(f);
    expect(db.pragma('user_version', { simple: true })).toBe(5);
    db.close();
  });

  it('旧 roots 补上 kind 与 filter_json，不抬高 user_version', () => {
    const f = path.join(tmpDir('kbdb-'), 'x.db');
    openDb(f).close();
    const raw = new Database(f);
    raw.exec('ALTER TABLE roots DROP COLUMN kind');
    raw.exec('ALTER TABLE roots DROP COLUMN filter_json');
    raw.close();
    const db = openDb(f);
    expect(db.pragma('user_version', { simple: true })).toBe(5);
    db.prepare('INSERT INTO roots(id, name, created_at) VALUES (?,?,?)').run('r', '旧', 1);
    expect(db.prepare('SELECT kind, filter_json FROM roots WHERE id=?').get('r')).toEqual({
      kind: 'folder',
      filter_json: EMPTY_ROOT_FILTER_JSON,
    });
    expect(() => db.prepare('INSERT INTO roots(id, name, created_at, kind) VALUES (?,?,?,?)').run('x', 'n', 1, 'nope')).toThrow(/CHECK/);
    db.close();
  });
});

describe('单文件来源与重叠别名', () => {
  it('同一文件再登记返回同一 ID，下列目录为空，不扫兄弟文件', async () => {
    const { svc } = await makeService();
    cleanups.push(() => svc.close());
    const dir = tmpDir('kbfile-');
    write(path.join(dir, 'a.txt'), 'alpha');
    write(path.join(dir, 'b.txt'), 'beta');
    const file = path.join(dir, 'a.txt');
    const first = svc.addFileSource(file, '甲');
    expect(first.kind).toBe('file');
    expect(first.alias).toBeUndefined();
    expect(first.status).toBe('ok');
    const row = svc.db.prepare('SELECT rel_path, kind FROM resources WHERE root_id=?').all(first.id) as { rel_path: string; kind: string }[];
    expect(row).toEqual([{ rel_path: '', kind: 'file' }]);
    const meta = svc.db.prepare('SELECT name, ext FROM resources WHERE root_id=? AND rel_path=?').get(first.id, '') as { name: string; ext: string };
    expect(meta.name).toBe('a.txt');
    expect(meta.ext).toBe('txt');
    expect(svc.getResource(first.resourceId)?.ext).toBe('txt');
    expect(svc.getResource(first.resourceId)?.readerType).toBe('text');
    expect(svc.db.prepare('SELECT filter_json FROM roots WHERE id=?').get(first.id)).toEqual({ filter_json: EMPTY_ROOT_FILTER_JSON });
    expect(svc.listDir(first.id, '')).toEqual([]);
    await svc.scanRoot(first.id);
    expect(svc.db.prepare('SELECT COUNT(*) c FROM resources WHERE root_id=?').get(first.id)).toEqual({ c: 1 });
    expect(svc.getIndexStatus().find((s) => s.rootId === first.id)?.fileCount).toBe(1);
    const again = svc.addFileSource(file);
    expect(again.alias).toBeUndefined();
    expect(again.id).toBe(first.id);
    expect(again.resourceId).toBe(first.resourceId);
    expect(rootCount(svc)).toBe(1);
    const inside = svc.addFileSource(path.join(dir, 'a.txt'));
    expect(inside.id).toBe(first.id);
  });

  it('含空格与中文路径的单文件可打开，重启元数据仍在，不扫兄弟；旧空 ext 可修复', async () => {
    const { svc } = await makeService();
    cleanups.push(() => svc.close());
    const dir = tmpDir('kb-cn file-');
    const sibling = path.join(dir, '兄弟.md');
    const file = path.join(dir, '说明 文档.txt');
    write(sibling, '# sib');
    write(file, '你好 world');
    const root = svc.addFileSource(file, '说明 文档.txt');
    expect(root.kind).toBe('file');
    expect(svc.listDir(root.id, '')).toEqual([]);
    expect(svc.db.prepare('SELECT COUNT(*) c FROM resources WHERE root_id=?').get(root.id)).toEqual({ c: 1 });
    expect(svc.readText(root.resourceId).text).toBe('你好 world');
    expect(svc.getResource(root.resourceId)?.ext).toBe('txt');
    expect(svc.getResource(root.resourceId)?.readerType).toBe('text');
    // 模拟旧版登记：name/ext 为空，file_count 未写
    svc.db.prepare('UPDATE resources SET name=?, ext=? WHERE id=?').run('', '', root.resourceId);
    svc.db.prepare('DELETE FROM index_state WHERE root_id=?').run(root.id);
    expect(svc.getResource(root.resourceId)?.ext).toBe('txt'); // getResource 回退
    await svc.scanRoot(root.id);
    const fixed = svc.db.prepare('SELECT name, ext FROM resources WHERE id=?').get(root.resourceId) as { name: string; ext: string };
    expect(fixed.name).toBe('说明 文档.txt');
    expect(fixed.ext).toBe('txt');
    expect(svc.getIndexStatus().find((s) => s.rootId === root.id)?.fileCount).toBe(1);
    expect(svc.db.prepare('SELECT COUNT(*) c FROM resources WHERE root_id=?').get(root.id)).toEqual({ c: 1 });
    // 文件夹来源仍展开（用另一棵不重叠的树，避免 SourceCoveredError）
    const folderDir = tmpDir('kb-folder-expand-');
    fs.mkdirSync(path.join(folderDir, 'nested'), { recursive: true });
    write(path.join(folderDir, '子.txt'), 'child');
    write(path.join(folderDir, 'nested', '深.md'), '# deep');
    const folder = svc.addRoot(folderDir, '整夹');
    expect(folder.kind).toBe('folder');
    await svc.scanRoot(folder.id);
    const kids = svc.listDir(folder.id, '');
    expect(kids.some((k) => k.name === '子.txt')).toBe(true);
    expect(kids.some((k) => k.name === 'nested' && k.kind === 'dir')).toBe(true);
  });

  it('文件夹里的文件再登记是别名，不新增根', async () => {
    const { svc, root, rootDir } = await setup();
    const before = rootCount(svc);
    const file = path.join(rootDir, '笔记/待办.txt');
    const alias = svc.addFileSource(file);
    expect(alias.alias).toBe(true);
    expect(alias.resourceId).toBe(ridOf(svc, root.id, '笔记/待办.txt'));
    expect(rootCount(svc)).toBe(before);
    const again = svc.resolveIngest(file, 'file');
    expect(again).toEqual({ alias: true, resourceId: alias.resourceId });
  });

  it('同一文件夹再登记返回该来源，不插入', async () => {
    const { svc, root } = await setup();
    const again = svc.addRoot(root.path);
    expect(again.alias).toBeUndefined();
    expect(again.id).toBe(root.id);
    expect(again.resourceId).toBe(root.resourceId);
    expect(rootCount(svc)).toBe(1);
  });

  it('父文件夹盖住多个来源时列出 ID 与名字，且不改资料 ID', async () => {
    const { svc } = await makeService();
    cleanups.push(() => svc.close());
    const parent = tmpDir('kbcover-');
    const aDir = path.join(parent, 'a');
    const bDir = path.join(parent, 'b');
    fs.mkdirSync(aDir);
    write(path.join(bDir, 'f.txt'), 'f');
    const ra = svc.addRoot(aDir, 'A');
    const fb = svc.addFileSource(path.join(bDir, 'f.txt'), 'F');
    const idA = ra.resourceId;
    const idF = fb.resourceId;
    let err: SourceCoveredError | undefined;
    try {
      svc.addRoot(parent);
    } catch (e) {
      err = e as SourceCoveredError;
    }
    expect(err).toBeInstanceOf(SourceCoveredError);
    expect(err?.covered).toEqual(expect.arrayContaining([
      { id: ra.id, name: 'A' },
      { id: fb.id, name: 'F' },
    ]));
    expect(err?.covered).toHaveLength(2);
    expect(svc.getRoot(ra.id).resourceId).toBe(idA);
    expect(svc.getRoot(fb.id).resourceId).toBe(idF);
    expect(rootCount(svc)).toBe(2);
  });

  it('硬链接并成同一资料 ID；内容相同的另一份文件仍是两个 ID', async () => {
    const { svc } = await makeService();
    cleanups.push(() => svc.close());
    const dir = tmpDir('kblink-');
    const a = path.join(dir, 'a.txt');
    const b = path.join(dir, 'b.txt');
    const copy = path.join(dir, 'c.txt');
    write(a, 'same-bytes');
    fs.linkSync(a, b);
    write(copy, 'same-bytes');
    const sa = svc.addFileSource(a);
    const sb = svc.addFileSource(b);
    expect(sb.alias).toBe(true);
    expect(sb.resourceId).toBe(sa.resourceId);
    expect(rootCount(svc)).toBe(1);
    const sc = svc.addFileSource(copy);
    expect(sc.alias).toBeUndefined();
    expect(sc.id).not.toBe(sa.id);
    expect(sc.resourceId).not.toBe(sa.resourceId);
    expect(rootCount(svc)).toBe(2);
  });

  it('file_key 命中多于一条时不合并', async () => {
    const { svc } = await makeService();
    cleanups.push(() => svc.close());
    const d1 = tmpDir('kbh1-');
    const d2 = tmpDir('kbh2-');
    write(path.join(d1, 'a.txt'), 'x');
    fs.linkSync(path.join(d1, 'a.txt'), path.join(d2, 'a.txt'));
    const r1 = svc.addRoot(d1);
    const r2 = svc.addRoot(d2);
    await svc.scanRoot(r1.id);
    await svc.scanRoot(r2.id);
    const third = path.join(tmpDir('kbh3-'), 'a.txt');
    fs.linkSync(path.join(d1, 'a.txt'), third);
    const before = rootCount(svc);
    const added = svc.addFileSource(third);
    expect(added.alias).toBeUndefined();
    expect(added.kind).toBe('file');
    expect(rootCount(svc)).toBe(before + 1);
    expect(added.resourceId).not.toBe(ridOf(svc, r1.id, 'a.txt'));
    expect(added.resourceId).not.toBe(ridOf(svc, r2.id, 'a.txt'));
  });
});

describe('插件状态与存储命名空间', () => {
  it('登记、禁用保留数据、升级不改变启用状态，数据随备份走；内置登记不能覆盖第三方适配器插件', async () => {
    const { svc } = await setup();
    svc.registerPlugin('builtin.readers', '1.0.0', 'builtin');
    svc.registerPlugin('demo.csv-table', '0.1.0', 'builtin');
    expect(svc.listPlugins().map((p) => [p.id, p.enabled])).toEqual([
      ['builtin.readers', true],
      ['demo.csv-table', true],
    ]);
    svc.pluginStorageSet('demo.csv-table', 'prefs', { delimiter: ',' });
    svc.pluginStorageSet('other.plugin', 'prefs', { x: 1 });
    expect(svc.pluginStorageGet('demo.csv-table', 'prefs')).toEqual({ delimiter: ',' });
    expect(svc.pluginStorageGet('other.plugin', 'prefs')).toEqual({ x: 1 }); // 命名空间互不干扰
    svc.setPluginEnabled('demo.csv-table', false);
    expect(svc.listPlugins().find((p) => p.id === 'demo.csv-table')?.enabled).toBe(false);
    expect(svc.pluginStorageGet('demo.csv-table', 'prefs')).toEqual({ delimiter: ',' }); // 禁用保留数据
    svc.registerPlugin('demo.csv-table', '0.2.0', 'builtin'); // 升级不改变启用状态
    expect(svc.listPlugins().find((p) => p.id === 'demo.csv-table')).toMatchObject({ version: '0.2.0', enabled: false, granted: [] });

    const backup = path.join(tmpDir('kbbak-'), 'b.db');
    await svc.backupTo(backup);
    const db = openDb(backup);
    expect((db.prepare('SELECT COUNT(*) c FROM plugin_kv').get() as { c: number }).c).toBe(2);
    db.close();

    expect(() => svc.registerPlugin('../evil', '1.0.0', 'user')).toThrow(/非法插件/);
    svc.db.prepare("INSERT INTO plugins(id,version,source,enabled,installed_at,updated_at) VALUES ('acme.viewer','1.0.0','adapter',1,0,0)").run();
    expect(() => svc.registerPlugin('acme.viewer', '9.9.9', 'user')).toThrow(/第三方适配器插件占用/);
  });
});

describe('目录树与索引使用同一套忽略规则', () => {
  it('node_modules、.git 等默认不出现在目录树；showIgnored 时出现并标记 ignored，且不进入搜索', async () => {
    const { svc, root, rootDir } = await setup();
    write(path.join(rootDir, 'node_modules/pkg/index.js'), 'x');
    write(path.join(rootDir, '.git/HEAD'), 'ref');
    write(path.join(rootDir, 'Thumbs.db'), 'x');
    write(path.join(rootDir, '.notes.md'), '# 普通的点文件不在忽略列表里');
    const names = svc.listDir(root.id, '').map((e) => e.name);
    expect(names).not.toContain('node_modules');
    expect(names).not.toContain('.git');
    expect(names).not.toContain('Thumbs.db');
    expect(names).toContain('.notes.md');
    const all = svc.listDir(root.id, '', { showIgnored: true });
    expect(all.filter((e) => e.ignored).map((e) => e.name).sort()).toEqual(['.git', 'Thumbs.db', 'node_modules']);
    expect(all.find((e) => e.name === '笔记')?.ignored).toBeUndefined();
    await svc.scanRoot(root.id);
    expect(svc.search('index.js')).toEqual([]);
  });
});

describe('listDirAbs 松散目录', () => {
  it('命中已登记 folder 根时走 listDir', async () => {
    const { svc, root, rootDir } = await setup();
    const nested = path.join(rootDir, '笔记');
    const kids = svc.listDirAbs(nested);
    expect(kids.map((e) => e.name).sort()).toEqual(['待办.txt', '读书笔记.md'].sort());
    expect(kids.every((e) => e.rootId === root.id && !!e.resourceId)).toBe(true);
    const located = svc.locateRootRel(nested);
    expect(located).toEqual({ sourceId: root.id, relPath: '笔记' });
  });

  it('未命中任何根时浅层 readdir，resourceId/rootId 空串；忽略默认 ignored', async () => {
    const { svc } = await makeService();
    cleanups.push(() => svc.close());
    const loose = tmpDir('kb-loose-');
    write(path.join(loose, 'a.txt'), 'hi');
    fs.mkdirSync(path.join(loose, 'sub'));
    write(path.join(loose, 'node_modules/x.js'), 'x');
    const kids = svc.listDirAbs(loose);
    expect(kids.map((e) => e.name).sort()).toEqual(['a.txt', 'sub']);
    expect(kids.find((e) => e.name === 'a.txt')).toMatchObject({ kind: 'file', resourceId: '', rootId: '', relPath: 'a.txt', ext: 'txt' });
    expect(kids.find((e) => e.name === 'sub')).toMatchObject({ kind: 'dir', resourceId: '', rootId: '', relPath: 'sub', ext: '' });
    expect(svc.locateRootRel(loose)).toBeNull();
  });

  it('showIgnored 时根外也能看到 ignored 名', async () => {
    const { svc } = await makeService();
    cleanups.push(() => svc.close());
    const loose = tmpDir('kb-loose-ign-');
    write(path.join(loose, 'ok.md'), 'x');
    fs.mkdirSync(path.join(loose, '.git'));
    const hidden = svc.listDirAbs(loose);
    expect(hidden.map((e) => e.name)).toEqual(['ok.md']);
    const shown = svc.listDirAbs(loose, { showIgnored: true });
    expect(shown.filter((e) => e.ignored).map((e) => e.name)).toEqual(['.git']);
  });
});
