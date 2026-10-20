/**
 * 数据迁移（docs/12）：迁移包格式、写入并发时的一致快照、换一套路径（含 Windows 风格原路径）导入并重映射、
 * 缺失文件保留为可修复的引用、导入前自动备份与失败回退。
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { makeRoot, tmpDir, write } from './helpers';
import { WorkbenchService } from '../src/main/service/WorkbenchService';
import { purgeMissing } from '../src/main/service/indexer';
import { readZip, writeZip, ZipFormatError } from '../src/main/migration/zip';
import { exportPackage } from '../src/main/migration/exporter';
import { importPackage, loadPackage, listBackups, restoreBackup, suggestMappings, MigrationError, createBackup, KEEP_BACKUPS } from '../src/main/migration/importer';
import { listMissing, relocateResource, rootStatuses } from '../src/main/migration/repair';
import { ENTRY_DB, ENTRY_MANIFEST, MIGRATION_FORMAT, type MigrationManifest } from '../src/main/migration/format';

const ROOT = path.resolve(__dirname, '..');
const req = createRequire(__filename);
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
let notesPlugin = '';
beforeAll(() => {
  notesPlugin = path.join(tmpDir('kbplug-'), 'notes');
  execFileSync('node', [path.join(ROOT, 'scripts/build-adapter-plugin.mjs'), path.join(ROOT, 'e2e/fixtures/plugins/notes'), '--out', notesPlugin], { stdio: 'pipe', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
});

function service(dataDir = tmpDir('kbdata-')) {
  const svc = new WorkbenchService({ dataDir });
  cleanups.push(() => svc.close());
  return svc;
}

const dock = (ids: string[]) => ({
  grid: {
    root: { type: 'branch', size: 900, data: ids.map((id, i) => ({ type: 'leaf', size: i === 0 ? 560 : 340, data: { views: [id], activeView: id, id: String(i + 1) } })) },
    width: 900,
    height: 640,
    orientation: 'HORIZONTAL',
  },
  panels: Object.fromEntries(ids.map((id) => [id, { id, contentComponent: 'view', params: { itemId: id } }])),
});

/** “旧电脑”：两个根、一个双栏工作区（阅读状态）、收藏、外观、插件（安装 + 授权 + 存储）、主题包、操作记录与密钥样的值 */
async function sourceMachine() {
  const svc = service();
  const rootA = makeRoot(); // 笔记/读书笔记.md、笔记/待办.txt、资料/论文/paper.pdf …
  const rootB = tmpDir('kbrootB-');
  write(path.join(rootB, '草稿/第一章.md'), '# 第一章\n\nRAW-CONTENT-MARKER-1234567890');
  write(path.join(rootB, 'n/todo.note'), '- 第一行');
  const ra = svc.addRoot(rootA, '资料库');
  const rb = svc.addRoot(rootB, '写作');
  await svc.scanRoot(ra.id);
  await svc.scanRoot(rb.id);
  const md = svc.resourceIdFor(ra.id, '笔记/读书笔记.md');
  const pdf = svc.resourceIdFor(ra.id, '资料/论文/paper.pdf');
  const ch1 = svc.resourceIdFor(rb.id, '草稿/第一章.md');
  const note = svc.resourceIdFor(rb.id, 'n/todo.note');
  const items = [
    { itemId: 'i-md', sourceKind: 'file', adapterId: 'builtin.markdown', ref: md, displayMode: 'in-app-reader', state: { v: 1, data: { anchor: { block: 7, frac: 0.25 }, scrollRatio: 0.4 } } },
    { itemId: 'i-pdf', sourceKind: 'file', adapterId: 'builtin.pdf', ref: pdf, displayMode: 'in-app-reader', state: { v: 1, data: { page: 3, scale: 1.25 } } },
    { itemId: 'i-ch1', sourceKind: 'file', adapterId: 'auto', ref: ch1, displayMode: 'in-app-reader', state: { v: 1, data: { scrollRatio: 0.7 } } },
    { itemId: 'i-note', sourceKind: 'file', adapterId: 'test.notes.reader', ref: note, displayMode: 'in-app-reader', state: { v: 1, data: { folded: ['a'] } } },
  ];
  const d = dock(['i-md', 'i-pdf']);
  (d.grid.root.data[0] as any).data.views.push('i-ch1');
  (d.grid.root.data[1] as any).data.views.push('i-note');
  d.panels['i-ch1'] = { id: 'i-ch1', contentComponent: 'view', params: { itemId: 'i-ch1' } };
  d.panels['i-note'] = { id: 'i-note', contentComponent: 'view', params: { itemId: 'i-note' } };
  const layout = { schema: 4, dock: d, shell: { sidebarWidth: 312 } };
  const ws = svc.createWorkspace('读文献', '论文', layout, items);
  svc.createWorkspace('空工作区');
  svc.setCurrentWorkspace(ws.id);
  svc.addFavorite(md);
  svc.addFavorite(ch1, '第一章（草稿）');
  svc.addFavorite(svc.getRoot(rb.id).resourceId);
  svc.setLayout('ui', { expanded: [svc.getRoot(ra.id).resourceId], appearance: { chrome: 'study', reading: 'bright', scheme: 'dark' } });
  svc.setLayout('settings.showIgnored', true);
  svc.setLayout('window', { width: 1300, height: 820, x: 10, y: 20 });
  svc.setLayout('web.lastUsed.example.web', Date.now());
  svc.registerPlugin('builtin.readers', '1.0.0', 'builtin');
  svc.registerPlugin('demo.csv-table', '0.3.0', 'builtin');
  svc.setPluginEnabled('demo.csv-table', false);
  svc.pluginStorageSet('demo.csv-table', 'columnWidths', { a: 120 });
  svc.setLayout('settings.devMode', true);
  svc.plugins.installFromFolder(notesPlugin);
  svc.plugins.setGrant({ pluginId: 'test.notes', adapterId: 'test.notes.reader', permissionId: 'read', decision: 'granted', rootIds: [rb.id] });
  svc.plugins.storageSet('test.notes', 'view.sort', 'mtime');
  svc.plugins.storageSet('test.notes', 'apiToken', 'SECRET-TOKEN-abcdef');
  svc.installThemePack(path.join(ROOT, 'themes/study'));
  svc.writeText(svc.resourceIdFor(ra.id, '笔记/待办.txt'), '改过的待办'); // op_log + blobs（不应导出）
  return { svc, rootA, rootB, ra, rb, ids: { md, pdf, ch1, note }, ws, layout, items };
}

/** 把源根复制到“新电脑”的另一套路径（目录名不同、带空格与中文） */
function copyRoots(src: { rootA: string; rootB: string }) {
  const base = tmpDir('kb-newpc-');
  const a = path.join(base, 'D 盘', '我的资料库');
  const b = path.join(base, 'E 盘', '写作 2026');
  fs.cpSync(src.rootA, a, { recursive: true });
  fs.cpSync(src.rootB, b, { recursive: true });
  return { base, a, b };
}

/** 把包里 manifest 的原路径改成 Windows 风格（模拟从 Windows 电脑导出），重新打包 */
function asWindowsPackage(file: string, paths: Record<string, string>) {
  const entries = readZip(fs.readFileSync(file));
  const m = JSON.parse(entries.get(ENTRY_MANIFEST)!.toString()) as MigrationManifest;
  m.source = { platform: 'win32', pathStyle: 'win32' };
  for (const r of m.roots) {
    r.sourcePath = paths[r.id];
    r.sourcePathStyle = 'win32';
  }
  entries.set(ENTRY_MANIFEST, Buffer.from(JSON.stringify(m)));
  const out = file.replace(/\.zip$/, '.win.zip');
  fs.writeFileSync(out, writeZip([...entries].map(([name, data]) => ({ name, data }))));
  return out;
}

function snapshotDb(file: string) {
  const entries = readZip(fs.readFileSync(file));
  const dbf = path.join(tmpDir('kbsnap-'), 'w.db');
  fs.writeFileSync(dbf, entries.get(ENTRY_DB)!);
  return { db: new Database(dbf, { readonly: true }), entries, dbf };
}

/** 用于比较“恢复后是否与导入前完全一致”的状态摘要 */
function stateOf(svc: WorkbenchService) {
  const t = (sql: string) => svc.db.prepare(sql).all();
  return {
    roots: t('SELECT r.id, r.name, m.local_path FROM roots r LEFT JOIN root_mounts m ON m.root_id=r.id ORDER BY r.id'),
    resources: t('SELECT id, root_id, rel_path, missing_since FROM resources ORDER BY id'),
    favorites: t('SELECT * FROM favorites ORDER BY id'),
    workspaces: t('SELECT id, name, project, layout_json FROM workspaces ORDER BY id'),
    items: t('SELECT workspace_id, item_id, ref, state_json FROM workspace_items ORDER BY workspace_id, item_id'),
    layout: t('SELECT key, json FROM layout ORDER BY key'),
    plugins: t('SELECT id, version, source, enabled, granted_json FROM plugins ORDER BY id'),
    kv: t('SELECT plugin_id, key, value_json FROM plugin_kv ORDER BY plugin_id, key'),
    ops: t('SELECT id, op FROM op_log ORDER BY id'),
    fts: (svc.db.prepare('SELECT COUNT(*) n FROM resources_fts').get() as { n: number }).n,
    themes: fs.existsSync(svc.themesDir) ? fs.readdirSync(svc.themesDir).sort() : [],
    pluginDirs: fs.readdirSync(svc.plugins.dir).sort(),
  };
}

describe('zip（迁移包容器）', () => {
  it('往返：中文条目名、压缩/不压缩、二进制；拒绝越界条目名与损坏的数据', () => {
    const bin = crypto.randomBytes(5000);
    const z = writeZip([
      { name: 'manifest.json', data: Buffer.from('{"a":"中文"}'.repeat(50)) },
      { name: 'themes/学习/theme.json', data: Buffer.from('{}') },
      { name: 'db/x.bin', data: bin },
    ]);
    const r = readZip(z);
    expect([...r.keys()]).toEqual(['manifest.json', 'themes/学习/theme.json', 'db/x.bin']);
    expect(r.get('db/x.bin')!.equals(bin)).toBe(true);
    for (const bad of ['../evil', '/abs', 'C:/x', 'a/../b', 'a\\b']) expect(() => writeZip([{ name: bad, data: Buffer.alloc(1) }])).toThrow(ZipFormatError);
    const t = Buffer.from(z);
    t[t.indexOf(Buffer.from('{"a"')) + 2] ^= 0xff; // 已压缩条目被篡改
    expect(() => readZip(t)).toThrow();
    expect(() => readZip(Buffer.from('not a zip at all'.repeat(3)))).toThrow(/不是 zip/);
  });
});

describe('导出', () => {
  it('包含工作区/阅读状态/收藏/外观/插件状态/主题包；不含原始文件、本机路径、操作记录、密钥；快照通过 integrity_check', async () => {
    const src = await sourceMachine();
    const out = path.join(tmpDir('kbexp-'), '迁移.kbmigrate.zip');
    const r = await exportPackage(src.svc, out, { appVersion: '0.1.0' });
    const m = r.manifest;
    expect(m.format).toBe(MIGRATION_FORMAT);
    expect(m.formatVersion).toBe(1);
    expect(m.snapshot).toEqual({ method: 'vacuum-into', integrityCheck: 'ok' });
    expect(m.roots.map((x) => [x.id, x.name, x.sourcePath])).toEqual([
      [src.ra.id, '资料库', path.resolve(src.rootA)],
      [src.rb.id, '写作', path.resolve(src.rootB)],
    ]);
    expect(m.roots[0].referencedCount).toBeGreaterThanOrEqual(2);
    expect(m.contents.workspaces).toBe(2);
    expect(m.contents.workspaceItems).toBe(4);
    expect(m.contents.currentWorkspaceId).toBe(src.ws.id);
    expect(m.contents.favorites).toBe(3);
    expect(m.contents.collections).toBeNull(); // 本版本没有虚拟集合表
    expect(m.contents.appearance).toEqual({ chrome: 'study', reading: 'bright', scheme: 'dark' });
    expect(m.contents.themePacks).toEqual(['kb.theme.study']);
    const notes = m.contents.plugins.find((p) => p.id === 'test.notes')!;
    expect(notes).toMatchObject({ source: 'adapter', enabled: true, grants: 1, storageKeys: 1 });
    expect(m.contents.plugins.find((p) => p.id === 'demo.csv-table')).toMatchObject({ enabled: false, storageKeys: 1 });
    expect(m.excluded.tables.sort()).toEqual(['blobs', 'index_state', 'op_log', 'plugin_audit', 'root_mounts']);
    expect(m.excluded.layoutKeys).toEqual(['web.lastUsed.example.web']);
    expect(m.excluded.secretLikePluginKeys).toEqual([{ pluginId: 'test.notes', key: 'apiToken' }]);

    const { db, entries, dbf } = snapshotDb(out);
    expect([...entries.keys()].some((n) => n.startsWith('plugins/test.notes/') && n.endsWith('manifest.json'))).toBe(true);
    expect(entries.has('themes/kb.theme.study/theme.json')).toBe(true);
    expect((db.pragma('integrity_check') as any[])[0].integrity_check).toBe('ok');
    const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    expect(n('SELECT COUNT(*) n FROM root_mounts')).toBe(0);
    expect(n('SELECT COUNT(*) n FROM op_log')).toBe(0);
    expect(n('SELECT COUNT(*) n FROM resources WHERE file_key IS NOT NULL')).toBe(0);
    expect(n("SELECT COUNT(*) n FROM workspace_items WHERE state_json LIKE '%page%'")).toBe(1);
    db.close();
    // 删除的值被 VACUUM 掉，不残留在空闲页；原始资料内容、本机路径不在包里
    const all = Buffer.concat([...entries.values()]);
    expect(fs.readFileSync(dbf).includes('SECRET-TOKEN')).toBe(false);
    expect(all.includes('RAW-CONTENT-MARKER')).toBe(false);
    expect(all.includes('改过的待办')).toBe(false);
    expect(entries.get(ENTRY_DB)!.includes(Buffer.from(path.resolve(src.rootA)))).toBe(false);
  });

  it('写入并发进行时导出：快照通过 integrity_check，且事务一致（成对写入的行数相等）', async () => {
    const svc = service();
    // 把库撑大一些，让 VACUUM INTO 需要一定时间，确保与写入重叠
    const root = svc.addRoot(makeRoot(), 'big');
    await svc.scanRoot(root.id);
    const ins = svc.db.prepare("INSERT INTO resources(id, root_id, rel_path, rel_path_key, name, ext, kind, size, mtime_ms, created_at, updated_at) VALUES (?,?,?,?,?,?,'file',1,1,1,1)");
    svc.db.transaction(() => {
      for (let i = 0; i < 30000; i++) {
        const rel = `bulk/${i}/文件-${'x'.repeat(40)}.txt`;
        ins.run(crypto.randomUUID(), root.id, rel, rel.toLowerCase(), `文件-${i}.txt`, 'txt');
      }
    })();
    const total = (svc.db.prepare('SELECT COUNT(*) n FROM resources').get() as { n: number }).n;
    const stop = new Int32Array(new SharedArrayBuffer(8));
    const worker = new Worker(
      `const { workerData } = require('node:worker_threads');
       const Database = require(workerData.mod);
       const db = new Database(workerData.file);
       db.pragma('busy_timeout = 5000');
       const ins = db.prepare("INSERT INTO plugin_kv(plugin_id, key, value_json, updated_at) VALUES ('test.pairs', ?, ?, 1)");
       const pair = db.transaction((i) => { ins.run('a-' + i, JSON.stringify('x'.repeat(200))); ins.run('b-' + i, '1'); });
       let i = 0;
       while (Atomics.load(workerData.stop, 0) === 0) { pair(i++); Atomics.store(workerData.stop, 1, i); }
       db.close();`,
      { eval: true, workerData: { file: svc.dbFile, mod: req.resolve('better-sqlite3'), stop } },
    );
    const exited = new Promise((res) => worker.on('exit', res));
    const writes = () => Atomics.load(stop, 1);
    while (writes() < 50) await new Promise((r) => setTimeout(r, 5));
    const dir = tmpDir('kbconc-');
    const overlaps: number[] = [];
    try {
      for (let k = 0; k < 6; k++) {
        const before = writes();
        const r = await exportPackage(svc, path.join(dir, `p${k}.zip`));
        overlaps.push(writes() - before);
        expect(r.manifest.snapshot.integrityCheck).toBe('ok');
        const { db } = snapshotDb(r.file);
        expect((db.pragma('integrity_check') as any[])[0].integrity_check).toBe('ok');
        const c = (p: string) => (db.prepare(`SELECT COUNT(*) n FROM plugin_kv WHERE plugin_id='test.pairs' AND key LIKE '${p}-%'`).get() as { n: number }).n;
        expect(c('a')).toBe(c('b'));
        expect(c('a')).toBeGreaterThan(0);
        expect((db.prepare('SELECT COUNT(*) n FROM resources').get() as { n: number }).n).toBe(total);
        db.close();
      }
    } finally {
      Atomics.store(stop, 0, 1);
      await exited;
    }
    // 至少有一次导出期间写入在继续（证明是真正的并发，而不是写入被导出挡住）
    expect(Math.max(...overlaps)).toBeGreaterThan(0);
    console.log(`[并发导出] 6 次导出期间另一连接完成的写事务数：${overlaps.join(', ')}`);
  }, 60000);
});

describe('在另一台电脑（另一套路径）导入并重映射', () => {
  it('Windows 风格原路径 → 本机另一套路径：工作区、阅读状态、收藏、外观、插件状态、主题包都能对上', async () => {
    const src = await sourceMachine();
    const pkg = asWindowsPackage((await exportPackage(src.svc, path.join(tmpDir('kbexp-'), 'a.kbmigrate.zip'))).file, {
      [src.ra.id]: 'D:\\Users\\用户\\Documents\\我的资料库',
      [src.rb.id]: 'E:\\写作 2026',
    });
    const dst = copyRoots(src);
    const target = service(); // 全新数据目录
    const loaded = loadPackage(pkg);
    expect(loaded.manifest.roots.map((r) => r.sourcePathStyle)).toEqual(['win32', 'win32']);
    const sug = suggestMappings(loaded.manifest, [path.join(dst.base, 'D 盘'), path.join(dst.base, 'E 盘')]);
    expect(sug.map((s) => s.suggested)).toEqual([dst.a, dst.b]); // 按 Windows 路径的最后一段匹配
    const r = await importPackage(target, pkg, { [src.ra.id]: dst.a, [src.rb.id]: dst.b });
    expect(r.scanned).toBe(true);
    expect(r.missing).toEqual({ referenced: 0, total: 0 });
    expect(r.currentWorkspaceId).toBe(src.ws.id);
    expect(target.listRoots().map((x) => [x.id, x.name, x.path, x.status])).toEqual([
      [src.ra.id, '资料库', dst.a, 'ok'],
      [src.rb.id, '写作', dst.b, 'ok'],
    ]);
    // 打开原工作区：布局（分屏、尺寸、标签顺序）、条目与阅读状态一致，文件能从新路径读出
    expect(target.getCurrentWorkspaceId()).toBe(src.ws.id);
    const ws = target.getWorkspace(src.ws.id);
    expect(ws.layout).toEqual(src.layout);
    expect(ws.items).toEqual(src.svc.getWorkspace(src.ws.id).items);
    expect(target.readText(src.ids.md).text).toContain('# 标题');
    expect(target.resolveResourcePath(src.ids.ch1)).toBe(path.join(dst.b, '草稿', '第一章.md'));
    expect(target.getResource(src.ids.pdf)?.exists).toBe(true);
    expect(target.listWorkspaces().map((w) => w.name).sort()).toEqual(['空工作区', '读文献']);
    // 收藏
    expect(target.listFavorites().map((f) => [f.resourceId, f.label, f.missing])).toEqual(src.svc.listFavorites().map((f) => [f.resourceId, f.label, false]));
    // 搜索索引在新位置重建
    expect(target.search('读书笔记').map((h) => h.resourceId)).toContain(src.ids.md);
    // 主题选择与设置
    expect(target.getLayout('ui')).toEqual(src.svc.getLayout('ui'));
    expect(target.getLayout('settings.showIgnored')).toBe(true);
    expect(target.getLayout('web.lastUsed.example.web')).toBeNull();
    expect(target.listThemePacks().map((p) => (p.manifest as any)?.id)).toEqual(['kb.theme.study']);
    // 插件状态：已安装、启用、授权（按根 id，仍然有效）、存储；密钥样的键没有带过来
    const notes = target.plugins.list().find((p) => p.id === 'test.notes')!;
    expect(notes.errors).toEqual([]);
    expect(notes.grants.map((g: any) => [g.permissionId, g.rootIds])).toEqual([['read', [src.rb.id]]]);
    expect(target.plugins.storageGet('test.notes', 'view.sort')).toBe('mtime');
    expect(target.plugins.storageGet('test.notes', 'apiToken')).toBeNull();
    expect(target.plugins.adapterOwners().get('test.notes.reader')?.id).toBe('test.notes');
    expect(target.plugins.file('test.notes', 'test.notes.reader', { op: 'readText', resourceId: src.ids.note } as any)).toMatchObject({ text: '- 第一行' });
    expect(target.listPlugins().find((p) => p.id === 'demo.csv-table')?.enabled).toBe(false);
    expect(target.pluginStorageGet('demo.csv-table', 'columnWidths')).toEqual({ a: 120 });
    // 操作记录是本机的，不随包迁移
    expect(target.listOps()).toEqual([]);
  });

  it('根目录下缺 1 个文件：记录保留并显示“缺失”，可重新定位（UUID 不变），也不会被过期清理删掉', async () => {
    const src = await sourceMachine();
    const pkg = (await exportPackage(src.svc, path.join(tmpDir('kbexp-'), 'b.kbmigrate.zip'))).file;
    const dst = copyRoots(src);
    fs.rmSync(path.join(dst.a, '资料/论文/paper.pdf'));
    const target = service();
    const r = await importPackage(target, pkg, { [src.ra.id]: dst.a, [src.rb.id]: dst.b });
    expect(r.missing.referenced).toBe(1);
    const miss = listMissing(target);
    expect(miss.map((x) => [x.resourceId, x.relPath, x.rootStatus, x.favorite, x.workspaces])).toEqual([[src.ids.pdf, '资料/论文/paper.pdf', 'ok', false, ['读文献']]]);
    expect(target.getResource(src.ids.pdf)).toMatchObject({ exists: false, relPath: '资料/论文/paper.pdf' });
    expect(target.getWorkspace(src.ws.id).items.find((i) => i.itemId === 'i-pdf')?.state).toEqual({ v: 1, data: { page: 3, scale: 1.25 } });
    expect(rootStatuses(target).find((s) => s.rootId === src.ra.id)).toMatchObject({ status: 'ok', missingReferenced: 1 });
    // 过期清理（保留期 0）也不删被工作区引用的缺失资源
    purgeMissing(target.db, src.ra.id, 0, Date.now() + 1000);
    expect(target.getResource(src.ids.pdf)).not.toBeNull();
    // 用户在别处找到了文件：放进根里另一个位置 → 重新定位
    write(path.join(dst.a, '归档/paper (1).pdf'), '%PDF-1.4 fake');
    await target.scanRoot(src.ra.id); // 扫描先为新位置建了另一条记录 → 重新定位时合并
    const dupId = target.resourceIdFor(src.ra.id, '归档/paper (1).pdf');
    expect(dupId).not.toBe(src.ids.pdf);
    const res = relocateResource(target, src.ids.pdf, path.join(dst.a, '归档/paper (1).pdf'));
    expect(res).toMatchObject({ resourceId: src.ids.pdf, relPath: '归档/paper (1).pdf', exists: true });
    expect(target.getResource(dupId)).toBeNull();
    expect(listMissing(target)).toEqual([]);
    expect(target.getWorkspace(src.ws.id).items.find((i) => i.itemId === 'i-pdf')?.ref).toBe(src.ids.pdf);
    expect(() => relocateResource(target, src.ids.md, '/definitely/not/here.md')).toThrow(/不是可访问的文件/);
  });

  it('暂不映射的根：显示未映射、记录全部保留；之后重新映射即恢复（同一批资源 ID）', async () => {
    const src = await sourceMachine();
    const pkg = (await exportPackage(src.svc, path.join(tmpDir('kbexp-'), 'c.kbmigrate.zip'))).file;
    const dst = copyRoots(src);
    const target = service();
    const r = await importPackage(target, pkg, { [src.ra.id]: dst.a });
    expect(r.unmapped).toEqual([{ rootId: src.rb.id, name: '写作' }]);
    expect(target.listRoots().find((x) => x.id === src.rb.id)?.status).toBe('missing');
    expect(rootStatuses(target).find((s) => s.rootId === src.rb.id)?.status).toBe('unmapped');
    const miss = listMissing(target);
    expect(miss.map((x) => x.resourceId).sort()).toEqual([src.ids.ch1, src.ids.note].sort());
    expect(target.listFavorites().find((f) => f.resourceId === src.ids.ch1)?.missing).toBe(true);
    // r12-P4：remapRoot 只自动接受 file_key / content_hash / size_mtime。
    // 紧接着的 scanRoot 仍按 upsertSeen 同路径优先，所以同名文件会复用原来的 ID。
    target.remapRoot(src.rb.id, dst.b);
    await target.scanRoot(src.rb.id);
    expect(listMissing(target)).toEqual([]);
    expect(target.readText(src.ids.ch1).text).toContain('第一章');
    expect(target.listFavorites().find((f) => f.resourceId === src.ids.ch1)?.missing).toBe(false);
  });

  it('映射校验：路径不存在、与数据目录或彼此重叠 → 拒绝，且不动当前数据', async () => {
    const src = await sourceMachine();
    const pkg = (await exportPackage(src.svc, path.join(tmpDir('kbexp-'), 'd.kbmigrate.zip'))).file;
    const dst = copyRoots(src);
    const target = service();
    target.getCurrentWorkspaceId();
    const before = stateOf(target);
    await expect(importPackage(target, pkg, { [src.ra.id]: path.join(dst.base, 'nope') })).rejects.toThrow(/不是可访问的文件夹/);
    await expect(importPackage(target, pkg, { [src.ra.id]: dst.a, [src.rb.id]: path.join(dst.a, '笔记') })).rejects.toThrow(/重叠/);
    await expect(importPackage(target, pkg, { [src.ra.id]: target.dataDir })).rejects.toThrow(/数据目录/);
    await expect(importPackage(target, pkg, { [src.ra.id]: 'relative/path' })).rejects.toThrow(/绝对路径/);
    expect(stateOf(target)).toEqual(before);
    expect(listBackups(target)).toEqual([]);
  });

  it('损坏或版本更新的包 → 拒绝，不动当前数据', async () => {
    const src = await sourceMachine();
    const file = (await exportPackage(src.svc, path.join(tmpDir('kbexp-'), 'e.kbmigrate.zip'))).file;
    const entries = readZip(fs.readFileSync(file));
    const rezip = (mut: (e: Map<string, Buffer>) => void) => {
      const e = new Map(entries);
      mut(e);
      const p = path.join(tmpDir('kbbad-'), 'x.zip');
      fs.writeFileSync(p, writeZip([...e].map(([name, data]) => ({ name, data }))));
      return p;
    };
    const target = service();
    const before = stateOf(target);
    const tampered = rezip((e) => {
      const d = Buffer.from(e.get(ENTRY_DB)!);
      d[d.length - 10] ^= 1;
      e.set(ENTRY_DB, d);
    });
    await expect(importPackage(target, tampered, {})).rejects.toThrow(/校验和不符/);
    const newer = rezip((e) => e.set(ENTRY_MANIFEST, Buffer.from(JSON.stringify({ ...JSON.parse(e.get(ENTRY_MANIFEST)!.toString()), formatVersion: 99 }))));
    await expect(importPackage(target, newer, {})).rejects.toThrow(/请先升级应用/);
    const extra = rezip((e) => e.set('plugins/evil/main.js', Buffer.from('x')));
    await expect(importPackage(target, extra, {})).rejects.toThrow(/清单外/);
    expect(stateOf(target)).toEqual(before);
  });
});

describe('导入前自动备份与回退', () => {
  async function targetWithData() {
    const target = service();
    const own = makeRoot();
    const r = target.addRoot(own, '本机原有');
    await target.scanRoot(r.id);
    target.addFavorite(target.resourceIdFor(r.id, '笔记/待办.txt'));
    target.getCurrentWorkspaceId();
    target.createWorkspace('本机工作区');
    target.setLayout('ui', { expanded: [], appearance: { chrome: 'pro', reading: 'pro', scheme: 'light' } });
    target.writeText(target.resourceIdFor(r.id, '笔记/待办.txt'), '本机改动');
    target.installThemePack(path.join(ROOT, 'themes/pro'));
    return target;
  }

  for (const failAt of ['after-db', 'after-files', 'after-scan'] as const) {
    it(`导入在 ${failAt} 失败 → 自动恢复到导入前（元数据、主题包、插件包完全一致）`, async () => {
      const src = await sourceMachine();
      const pkg = (await exportPackage(src.svc, path.join(tmpDir('kbexp-'), 'f.kbmigrate.zip'))).file;
      const dst = copyRoots(src);
      const target = await targetWithData();
      const before = stateOf(target);
      const err = await importPackage(target, pkg, { [src.ra.id]: dst.a, [src.rb.id]: dst.b }, { failAt }).then(
        () => null,
        (e) => e,
      );
      expect(err).toBeInstanceOf(MigrationError);
      expect(err.message).toMatch(/已恢复到导入前/);
      expect(err.detail.restored).toBe(true);
      expect(stateOf(target)).toEqual(before);
      expect(target.plugins.list()).toEqual([]);
      expect(listBackups(target)).toHaveLength(1);
      expect(fs.readdirSync(target.dataDir).filter((n) => n.startsWith('migration-staging'))).toEqual([]);
    });
  }

  it('导入成功后也能手动“恢复到导入前”', async () => {
    const src = await sourceMachine();
    const pkg = (await exportPackage(src.svc, path.join(tmpDir('kbexp-'), 'g.kbmigrate.zip'))).file;
    const dst = copyRoots(src);
    const target = await targetWithData();
    const before = stateOf(target);
    const r = await importPackage(target, pkg, { [src.ra.id]: dst.a, [src.rb.id]: dst.b });
    expect(target.listRoots().map((x) => x.id)).toEqual([src.ra.id, src.rb.id]);
    expect(target.plugins.list().map((p) => p.id)).toEqual(['test.notes']);
    expect(fs.existsSync(path.join(r.backup.dir, 'workbench.db'))).toBe(true);
    expect(listBackups(target)[0]).toMatchObject({ reason: 'before-import', integrityCheck: 'ok' });
    restoreBackup(target, r.backup.dir);
    expect(stateOf(target)).toEqual(before);
    expect(target.plugins.list()).toEqual([]);
    expect(target.plugins.adapterOwners().size).toBe(0);
  });
});

describe('第 9 轮合并：工作资料引用、不可迁移键、reload、立即备份', () => {
  it('manifest 写入工作资料计数；缺失列表与根统计把只被资料引用的文件算进去；30 天清理保护只被资料引用的资源；重新定位合并重复记录时改写资料引用', async () => {
    const src = await sourceMachine();
    const todo = src.svc.resourceIdFor(src.ra.id, '笔记/待办.txt'); // 只被资料引用（不在标签、不在收藏）
    src.svc.addWorkspaceRefs(src.ws.id, [todo, src.ids.md]);
    const empty = src.svc.listWorkspaces().find((w) => w.name === '空工作区')!;
    src.svc.addWorkspaceRefs(empty.id, [todo]);
    const r = await exportPackage(src.svc, path.join(tmpDir('kbexp-'), 'refs.kbmigrate.zip'));
    expect(r.manifest.contents.workspaceRefs).toEqual({ workspaces: 2, refs: 3, resources: 2 });
    const before = src.svc.db.prepare('SELECT COUNT(*) n FROM resources').get() as { n: number };
    expect(r.manifest.roots.find((x) => x.id === src.ra.id)!.referencedCount).toBeGreaterThanOrEqual(3);
    const dst = copyRoots(src);
    fs.rmSync(path.join(dst.a, '笔记/待办.txt'));
    const target = service();
    const imp = await importPackage(target, r.file, { [src.ra.id]: dst.a, [src.rb.id]: dst.b });
    expect(imp.missing.referenced).toBe(1);
    const miss = listMissing(target);
    expect(miss.map((x) => [x.resourceId, x.favorite, x.workspaces, [...x.collections].sort()])).toEqual([[todo, false, [], ['空工作区', '读文献'].sort()]]);
    expect(rootStatuses(target).find((s) => s.rootId === src.ra.id)).toMatchObject({ missingReferenced: 1 });
    // 资料引用不自动清理；过期清理（保留期 0）也不删
    purgeMissing(target.db, src.ra.id, 0, Date.now() + 1000);
    expect(target.getResource(todo)).not.toBeNull();
    expect(target.listWorkspaceRefs(src.ws.id).find((x) => x.resourceId === todo)).toMatchObject({ missing: true });
    // 用户把文件放回别处 → 扫描建了新记录 → 重新定位合并，资料引用跟着改到原 ID（原 ID 不变）
    write(path.join(dst.a, '归档/待办.txt'), '找回');
    await target.scanRoot(src.ra.id);
    const dup = target.resourceIdFor(src.ra.id, '归档/待办.txt');
    target.addWorkspaceRefs(empty.id, [dup]);
    relocateResource(target, todo, path.join(dst.a, '归档/待办.txt'));
    expect(target.getResource(dup)).toBeNull();
    expect(target.listWorkspaceRefs(empty.id).map((x) => [x.resourceId, x.missing])).toEqual([[todo, false]]);
    expect(listMissing(target)).toEqual([]);
    expect(before.n).toBeGreaterThan(0);
  });

  it('SDK 修订 5：插件声明的不可迁移键不导出（manifest 记键名）；导入后 PluginHostService.reload() 读到新插件', async () => {
    const src = await sourceMachine();
    // 在已安装的 notes 插件 manifest 上声明不可迁移键，重装
    const plug = path.join(tmpDir('kbplug2-'), 'notes');
    fs.cpSync(notesPlugin, plug, { recursive: true });
    const mf = JSON.parse(fs.readFileSync(path.join(plug, 'manifest.json'), 'utf8'));
    mf.storage = { nonMigratableKeys: ['cache:*', 'lastDevice'] };
    fs.writeFileSync(path.join(plug, 'manifest.json'), JSON.stringify(mf));
    src.svc.plugins.installFromFolder(plug);
    src.svc.plugins.storageSet('test.notes', 'cache:pathA', 'C:\\本机\\路径');
    src.svc.plugins.storageSet('test.notes', 'lastDevice', 'PC-1');
    const r = await exportPackage(src.svc, path.join(tmpDir('kbexp-'), 'nm.kbmigrate.zip'));
    expect(r.manifest.excluded.nonMigratablePluginKeys).toEqual([
      { pluginId: 'test.notes', key: 'cache:pathA' },
      { pluginId: 'test.notes', key: 'lastDevice' },
    ]);
    const { db, dbf } = snapshotDb(r.file);
    expect((db.prepare("SELECT key FROM plugin_kv WHERE plugin_id='test.notes' ORDER BY key").all() as { key: string }[]).map((x) => x.key)).toEqual(['view.sort']);
    db.close();
    expect(fs.readFileSync(dbf).includes('PC-1')).toBe(false);
    const dst = copyRoots(src);
    const target = service();
    expect(target.plugins.list()).toEqual([]);
    await importPackage(target, r.file, { [src.ra.id]: dst.a, [src.rb.id]: dst.b });
    // 导入流程用公开的 reload()（不再改私有字段）
    expect(target.plugins.list().map((p) => p.id)).toEqual(['test.notes']);
    expect(target.plugins.storageGet('test.notes', 'view.sort')).toBe('mtime');
    expect(target.plugins.storageGet('test.notes', 'lastDevice')).toBeNull();
    // reload 幂等，且清掉旧的文件令牌
    const tok = target.plugins.mintFileToken('test.notes', 'test.notes.reader');
    target.plugins.reload();
    expect(target.plugins.list().map((p) => p.id)).toEqual(['test.notes']);
    expect(() => target.plugins.resolvePluginFileUrl(`kbfile://plugin/${tok}/${src.ids.note}`)).toThrow(/令牌无效/);
  });

  it(`手动“立即备份”与导入前备份合计保留 ${KEEP_BACKUPS} 份（最旧的先删）`, async () => {
    const svc = service();
    svc.getCurrentWorkspaceId();
    const made: string[] = [];
    for (let i = 0; i < KEEP_BACKUPS + 2; i++) {
      made.push(createBackup(svc, i % 2 ? 'manual' : 'before-import').dir);
      await new Promise((r) => setTimeout(r, 5));
    }
    const list = listBackups(svc);
    expect(KEEP_BACKUPS).toBe(5);
    expect(list).toHaveLength(5);
    expect(list.map((b) => b.dir)).toEqual(made.slice(-5).reverse());
    expect(list.some((b) => b.reason === 'manual')).toBe(true);
    for (const d of made.slice(0, 2)) expect(fs.existsSync(d)).toBe(false);
  });
});
