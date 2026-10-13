/**
 * r12-P3：访问范围谓词与范围外读路径。
 * 不实现 setSourceFilter，也不做筛选后重扫（那是 P3b）。已有行由测试直接标 out_of_scope=1。
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { LocalFileOps } from '../src/main/backend/fileOps';
import { LocalPlanService, OperationService } from '../src/main/backend/operations';
import { mountFileAgentBridge } from '../src/main/agent-bridge';
import { DB_VERSION, migrateResourcesOutOfScope, RESOURCES_OUT_OF_SCOPE_VERSION } from '../src/main/service/db';
import type { WorkbenchService } from '../src/main/service/WorkbenchService';
import { onDropTarget } from '../src/renderer/dnd/resolve';
import type { DragItem, DragPayload, DropTarget } from '../src/renderer/dnd/types';
import { CATALOGS_KEY } from '../src/shared/catalog';
import { inAccessScope, OUT_OF_SCOPE_MESSAGE, OutOfScopeError } from '../src/shared/sourceFilter';
import { makeService, tmpDir, waitFor, write } from './helpers';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const Q_TXT = '11111111-1111-4111-8111-111111111111';
const Q_MD = '22222222-2222-4222-8222-222222222222';
const Q_DIR = '33333333-3333-4333-8333-333333333333';
const SECRET = 'SECRET_TXT_BODY';

function track(svc: WorkbenchService) {
  cleanups.push(() => svc.close());
  return svc;
}

async function settle(svc: WorkbenchService, rootId: string) {
  await waitFor(() => {
    const s = svc.getIndexStatus().find((x) => x.rootId === rootId);
    return !!s && s.state === 'idle' && s.lastScanAt != null;
  });
}

function rels(svc: WorkbenchService, rootId: string) {
  return (svc.db.prepare('SELECT rel_path, kind, ext, out_of_scope FROM resources WHERE root_id=? ORDER BY rel_path').all(rootId) as {
    rel_path: string;
    kind: string;
    ext: string;
    out_of_scope: number;
  }[]);
}

function ftsPaths(svc: WorkbenchService, rootId: string) {
  return (svc.db.prepare('SELECT rel_path FROM resources_fts WHERE root_id=? ORDER BY rel_path').all(rootId) as { rel_path: string }[]).map((r) => r.rel_path);
}

function diskItem(over: Partial<DragItem>): DragItem {
  return {
    resourceId: 'r1',
    sourceKind: 'file',
    from: { kind: 'root', rootId: 'A', relPath: 'a.md' },
    entry: 'file',
    name: 'a.md',
    rootId: 'A',
    relPath: 'a.md',
    size: 1,
    ...over,
  };
}

const diskTarget: DropTarget = { kind: 'disk-dir', rootId: 'B', relPath: '归档' };

describe('访问范围谓词', () => {
  it('空扩展名通过，列出的扩展名才通过，目录和单文件来源始终通过', () => {
    expect(OUT_OF_SCOPE_MESSAGE).toBe('不在访问范围');
    const folder = { sourceKind: 'folder' as const, extensions: ['.MD', 'PDF'] };
    expect(inAccessScope(folder, { kind: 'file', relPath: 'a.md', ext: 'MD' })).toBe(true);
    expect(inAccessScope(folder, { kind: 'file', relPath: 'a.PDF', ext: '.pdf' })).toBe(true);
    expect(inAccessScope(folder, { kind: 'file', relPath: 'b.txt', ext: 'txt' })).toBe(false);
    expect(inAccessScope(folder, { kind: 'dir', relPath: 'skip.txt', ext: 'txt' })).toBe(true);
    expect(inAccessScope(folder, { kind: 'file', relPath: 'kept.md', ext: 'md', outOfScope: 1 })).toBe(false);
    expect(inAccessScope({ sourceKind: 'folder', extensions: [] }, { kind: 'file', relPath: 'b.txt', ext: 'txt' })).toBe(true);
    expect(inAccessScope({ sourceKind: 'file', extensions: ['md'] }, { kind: 'file', relPath: '', ext: 'txt', outOfScope: 1 })).toBe(true);
    expect(new OutOfScopeError().message).toBe(OUT_OF_SCOPE_MESSAGE);
  });

  it('迁移号 1203，幂等 ALTER，不抬高 user_version', async () => {
    expect(RESOURCES_OUT_OF_SCOPE_VERSION).toBe(1203);
    expect(DB_VERSION).toBe(5);
    const bare = new Database(path.join(tmpDir('kbbare-'), 'a.db'));
    bare.exec('CREATE TABLE resources (id TEXT PRIMARY KEY)');
    bare.pragma('user_version = 5');
    migrateResourcesOutOfScope(bare);
    migrateResourcesOutOfScope(bare);
    const col = (bare.prepare('PRAGMA table_info(resources)').all() as { name: string; notnull: number; dflt_value: unknown }[]).find((c) => c.name === 'out_of_scope');
    expect(col?.notnull).toBe(1);
    expect(String(col?.dflt_value)).toBe('0');
    expect(bare.pragma('user_version', { simple: true })).toBe(5);
    bare.close();
    const empty = new Database(':memory:');
    expect(() => migrateResourcesOutOfScope(empty)).not.toThrow();
    empty.close();

    const svc = track((await makeService()).svc);
    expect(svc.db.pragma('user_version', { simple: true })).toBe(5);
    const live = (svc.db.prepare('PRAGMA table_info(resources)').all() as { name: string }[]).map((c) => c.name);
    expect(live).toContain('out_of_scope');
    expect(live.filter((n) => n === 'out_of_scope')).toHaveLength(1);
  });
});

describe('首次扫描与监听', () => {
  it('只要 md 的首次扫描不插入 txt，FTS 也没有；监听同样丢掉筛选外的新文件', async () => {
    const dir = tmpDir('kbscope-');
    const svc = track((await makeService()).svc);
    const root = svc.addRoot(dir, '笔记');
    await settle(svc, root.id);

    fs.mkdirSync(path.join(dir, 'sub'));
    fs.mkdirSync(path.join(dir, 'skip.txt'));
    fs.mkdirSync(path.join(dir, 'node_modules'));
    write(path.join(dir, 'a.md'), '# a');
    write(path.join(dir, 'Upper.MD'), '# U');
    write(path.join(dir, 'b.txt'), 'bee');
    write(path.join(dir, 'readme'), 'no ext');
    write(path.join(dir, 'sub/d.md'), '# d');
    write(path.join(dir, 'sub/c.txt'), 'cee');
    write(path.join(dir, 'node_modules/x.md'), '# ignored');
    svc.db.prepare('UPDATE roots SET filter_json=? WHERE id=?').run(JSON.stringify({ extensions: ['.MD'] }), root.id);

    const scanned = await svc.scanRoot(root.id);
    expect(scanned && !scanned.cancelled).toBeTruthy();
    const paths = rels(svc, root.id).map((r) => `${r.kind}:${r.rel_path}`);
    expect(paths).toContain('file:a.md');
    expect(paths).toContain('file:Upper.MD');
    expect(paths).toContain('file:sub/d.md');
    expect(paths).toContain('dir:sub');
    expect(paths).toContain('dir:skip.txt');
    expect(paths.some((p) => p.endsWith('.txt') && p.startsWith('file:'))).toBe(false);
    expect(paths.some((p) => p.includes('node_modules') || p.endsWith('readme'))).toBe(false);
    const indexed = ftsPaths(svc, root.id);
    expect(indexed).toEqual(expect.arrayContaining(['a.md', 'Upper.MD', 'sub/d.md', 'skip.txt']));
    expect(indexed.some((p) => p === 'b.txt' || p === 'sub/c.txt' || p.includes('node_modules') || p === 'readme')).toBe(false);
    expect(rels(svc, root.id).filter((r) => r.kind === 'file').every((r) => r.out_of_scope === 0)).toBe(true);

    write(path.join(dir, 'late.txt'), 'late');
    write(path.join(dir, 'late.md'), '# late');
    fs.mkdirSync(path.join(dir, 'extra-dir'));
    await svc.applyFsEvents(root.id, [
      { type: 'add', relPath: 'late.txt' },
      { type: 'add', relPath: 'late.md' },
      { type: 'addDir', relPath: 'extra-dir' },
    ]);
    await svc.applyFsEvents(root.id, [{ type: 'change', relPath: 'late.txt' }]);
    const after = rels(svc, root.id).map((r) => r.rel_path);
    expect(after).toContain('late.md');
    expect(after).toContain('extra-dir');
    expect(after).not.toContain('late.txt');
    expect(ftsPaths(svc, root.id)).not.toContain('late.txt');
    expect(() => svc.resourceIdFor(root.id, 'late.txt')).toThrow(OUT_OF_SCOPE_MESSAGE);
    expect(svc.db.prepare('SELECT id FROM resources WHERE root_id=? AND rel_path=?').get(root.id, 'late.txt')).toBeUndefined();
    expect(svc.db.pragma('user_version', { simple: true })).toBe(5);
  });
});

describe('范围外读路径', () => {
  it('标成 out_of_scope 后列表和搜索看不到，打开、桥和插件都返回不在访问范围，收藏和编排引用还在', async () => {
    const dir = tmpDir('kbscope2-');
    write(path.join(dir, 'notesalpha.txt'), SECRET);
    write(path.join(dir, 'notesalpha.md'), '# md');
    const { svc, dataDir } = await makeService();
    track(svc);
    const root = svc.addRoot(dir, '资料');
    await settle(svc, root.id);
    await svc.scanRoot(root.id);
    const txtId = svc.resourceIdFor(root.id, 'notesalpha.txt');
    const mdId = svc.resourceIdFor(root.id, 'notesalpha.md');
    expect(svc.readText(txtId).text).toBe(SECRET);

    const plug = tmpDir('kbscopeplug-');
    write(path.join(plug, 'dist/index.js'), 'export default {}\n');
    write(
      path.join(plug, 'manifest.json'),
      JSON.stringify({
        id: 'scope.reader',
        name: '范围测试',
        version: '0.1.0',
        engines: { workbench: '^0.2.0', adapterApi: '^0.1.0' },
        main: 'dist/index.js',
        sandbox: 'iframe',
        contributes: {
          adapters: [
            {
              id: 'scope.reader.main',
              title: '读取',
              sourceKinds: ['file'],
              displayMode: 'in-app-reader',
              match: { file: { extensions: ['txt', 'md'] } },
              permissions: [{ id: 'read', kind: 'fs.read', scope: 'all-registered-roots', extensions: ['txt', 'md'], reason: '测试读取' }],
              stateSchemaVersion: 1,
            },
          ],
        },
      }),
    );
    const installed = svc.plugins.installFromFolder(plug);
    expect(installed.errors).toEqual([]);
    svc.plugins.setGrant({ pluginId: 'scope.reader', adapterId: 'scope.reader.main', permissionId: 'read', decision: 'granted' });
    const readPlug = () => svc.plugins.file('scope.reader', 'scope.reader.main', { op: 'readText', resourceId: txtId });
    expect(readPlug()).toMatchObject({ text: SECRET });
    const token = svc.plugins.mintFileToken('scope.reader', 'scope.reader.main');
    const kbUrl = `kbfile://plugin/${token}/${txtId}/notesalpha.txt`;
    expect(fs.existsSync(svc.plugins.resolvePluginFileUrl(kbUrl))).toBe(true);

    svc.addFavorite(txtId, '留着');
    const folder = svc.createVirtualFolder(null, '摘录');
    expect(svc.setVfolderMembership(txtId, [folder.folderId])).toEqual([folder.folderId]);
    const favBefore = svc.db.prepare('SELECT COUNT(*) AS c FROM favorites WHERE resource_id=?').get(txtId) as { c: number };
    const catalogBefore = JSON.stringify(svc.getLayout(CATALOGS_KEY));
    expect(catalogBefore).toContain(txtId);

    svc.db.prepare('UPDATE resources SET out_of_scope=1 WHERE id=?').run(txtId);
    const marked = svc.db.prepare('SELECT out_of_scope, missing_since FROM resources WHERE id=?').get(txtId) as { out_of_scope: number; missing_since: number | null };
    expect(marked).toEqual({ out_of_scope: 1, missing_since: null });

    expect(svc.listDir(root.id, '').map((e) => e.name)).not.toContain('notesalpha.txt');
    expect(svc.listDir(root.id, '').map((e) => e.name)).toContain('notesalpha.md');
    expect(svc.search('notesalpha').map((h) => h.resourceId)).toEqual([mdId]);
    expect(svc.search('notesalpha').some((h) => h.resourceId === txtId)).toBe(false);
    expect(() => svc.getResource(txtId)).toThrow(OutOfScopeError);
    expect(() => svc.readText(txtId)).toThrow(OUT_OF_SCOPE_MESSAGE);
    try {
      svc.readText(txtId);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(OutOfScopeError);
      expect((e as Error).message).toBe(OUT_OF_SCOPE_MESSAGE);
      expect((e as Error).message).not.toContain(SECRET);
    }
    expect(svc.readText(mdId).text).toBe('# md');

    const fileOps = new LocalFileOps(svc);
    const ops = new OperationService(svc, new LocalPlanService(svc, fileOps));
    const bridge = await mountFileAgentBridge({ userDataDir: dataDir, svc, ops, pollMs: 0, useChokidar: false, stableMs: 0 });
    cleanups.push(() => bridge.close());
    const writeReq = (id: string, query: Record<string, unknown>) => {
      fs.writeFileSync(path.join(bridge.root, 'requests', `${id}.json`), JSON.stringify({ requestId: id, type: 'query', query }), 'utf8');
    };
    writeReq(Q_TXT, { resourceId: txtId });
    writeReq(Q_MD, { resourceId: mdId });
    writeReq(Q_DIR, { rootId: root.id, relPath: '' });
    await bridge.pumpOnce();
    const readRes = (id: string) => {
      const text = fs.readFileSync(path.join(bridge.root, 'responses', `${id}.json`), 'utf8');
      expect(text).not.toContain(SECRET);
      return JSON.parse(text) as { status: string; error?: { message: string }; result?: { resource?: { resourceId: string }; entries?: { name: string }[] } };
    };
    const denied = readRes(Q_TXT);
    expect(denied.status).toBe('failed');
    expect(denied.error?.message).toBe(OUT_OF_SCOPE_MESSAGE);
    const allowed = readRes(Q_MD);
    expect(allowed.status).toBe('success');
    expect(allowed.result?.resource?.resourceId).toBe(mdId);
    const listed = readRes(Q_DIR);
    expect(listed.status).toBe('success');
    const names = listed.result?.entries?.map((e) => e.name) ?? [];
    expect(names).not.toContain('notesalpha.txt');
    expect(names).toContain('notesalpha.md');

    expect(() => readPlug()).toThrow(OutOfScopeError);
    try {
      readPlug();
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as Error).message).toBe(OUT_OF_SCOPE_MESSAGE);
      expect((e as Error).message).not.toContain(SECRET);
    }
    expect(() => svc.plugins.resolvePluginFileUrl(kbUrl)).toThrow(OUT_OF_SCOPE_MESSAGE);

    expect((svc.db.prepare('SELECT COUNT(*) AS c FROM favorites WHERE resource_id=?').get(txtId) as { c: number }).c).toBe(favBefore.c);
    expect(svc.listFavorites().some((f) => f.resourceId === txtId && f.label === '留着')).toBe(true);
    expect(svc.listVfolderMembership(txtId)).toEqual([folder.folderId]);
    expect(JSON.stringify(svc.getLayout(CATALOGS_KEY))).toContain(txtId);
    expect(svc.db.prepare('SELECT id FROM resources WHERE id=?').get(txtId)).toBeTruthy();
  });

  it('单文件来源不按扩展名排除', async () => {
    const dir = tmpDir('kbsolo-');
    const file = path.join(dir, 'solo.txt');
    write(file, 'solo-body');
    const svc = track((await makeService()).svc);
    const src = svc.addFileSource(file, 'solo.txt');
    svc.db.prepare('UPDATE roots SET filter_json=? WHERE id=?').run(JSON.stringify({ extensions: ['md'] }), src.id);
    svc.db.prepare('UPDATE resources SET out_of_scope=1 WHERE id=?').run(src.resourceId);
    expect(svc.listDir(src.id, '')).toEqual([]);
    // 单文件来源的资料行 rel_path 为空，扩展名不落在 ext 列上；访问范围仍按来源种类放行。
    expect(svc.getResource(src.resourceId)?.name).toBe('solo.txt');
    expect(svc.getResource(src.resourceId)?.relPath).toBe('');
    expect(svc.readText(src.resourceId).text).toBe('solo-body');
  });
});

describe('拖拽磁盘载荷', () => {
  it('范围外的文件不进入移动载荷，目录和单文件来源仍在', () => {
    const md = diskItem({ resourceId: 'md', name: 'a.md', relPath: 'a.md', from: { kind: 'root', rootId: 'A', relPath: 'a.md' }, scope: { sourceKind: 'folder', extensions: ['md'] } });
    const txt = diskItem({
      resourceId: 'txt',
      name: 'b.txt',
      relPath: 'b.txt',
      from: { kind: 'root', rootId: 'A', relPath: 'b.txt' },
      scope: { sourceKind: 'folder', extensions: ['md'], outOfScope: true },
    });
    const blocked = onDropTarget(diskTarget, { v: 1, items: [txt] });
    expect(blocked.action).toEqual({ type: 'reject', reason: OUT_OF_SCOPE_MESSAGE });
    expect(blocked.hint).toBe(OUT_OF_SCOPE_MESSAGE);
    const mixed = onDropTarget(diskTarget, { v: 1, items: [md, txt] });
    expect(mixed.action.type).toBe('move');
    if (mixed.action.type === 'move') expect(mixed.action.ops.map((op) => op.resourceId)).toEqual(['md']);

    const extBlocked = diskItem({
      resourceId: 'by-ext',
      name: 'c.txt',
      relPath: 'c.txt',
      from: { kind: 'root', rootId: 'A', relPath: 'c.txt' },
      scope: { sourceKind: 'folder', extensions: ['.MD'] },
    });
    expect(onDropTarget(diskTarget, { v: 1, items: [extBlocked] }).hint).toBe(OUT_OF_SCOPE_MESSAGE);

    const dir = diskItem({
      resourceId: 'dir',
      entry: 'dir-entry',
      name: 'skip.txt',
      relPath: 'skip.txt',
      from: { kind: 'root', rootId: 'A', relPath: 'skip.txt' },
      scope: { sourceKind: 'folder', extensions: ['md'], outOfScope: true },
    });
    const dirDrop = onDropTarget(diskTarget, { v: 1, items: [dir] });
    expect(dirDrop.action.type).toBe('move');

    const solo = diskItem({
      resourceId: 'solo',
      name: 'solo.txt',
      relPath: '',
      rootId: 'F',
      from: { kind: 'root', rootId: 'F', relPath: '' },
      scope: { sourceKind: 'file', extensions: ['md'], outOfScope: true },
    });
    const soloDrop = onDropTarget(diskTarget, { v: 1, items: [solo] });
    expect(soloDrop.action.type).toBe('move');
    if (soloDrop.action.type === 'move') expect(soloDrop.action.ops.map((op) => op.resourceId)).toEqual(['solo']);

    const plain: DragPayload = { v: 1, items: [diskItem({})] };
    expect(onDropTarget(diskTarget, plain).action.type).toBe('move');
  });
});
