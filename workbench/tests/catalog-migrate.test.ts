import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import { WorkbenchService } from '../src/main/service/WorkbenchService';
import { openDb, WORKSPACES_CATALOG_ID_VERSION } from '../src/main/service/db';
import { VFOLDER_REFS_KEY, VFOLDERS_KEY } from '../src/main/service/workspaceRefs';
import {
  CATALOGS_KEY,
  DEFAULT_CATALOG_ID,
  catalogDigest,
  dedupeRefs,
  parentChain,
  type CatalogSet,
} from '../src/shared/catalog';
import { makeService } from './helpers';
import type { VirtualFolder } from '../src/shared/types';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function layoutText(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT json FROM layout WHERE key = ?').get(key) as { json: string } | undefined;
  return row?.json ?? null;
}

function track(svc: WorkbenchService) {
  cleanups.push(() => svc.close());
  return svc;
}

/** 把已经迁移过的库改回「还没有 catalog_id」的 workspaces，用来验证独立迁移。 */
function stripCatalogColumn(file: string) {
  const raw = new Database(file);
  raw.pragma('foreign_keys = OFF');
  raw.exec(`
    CREATE TABLE workspaces_p1 (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project TEXT NOT NULL DEFAULT '',
      layout_json TEXT NOT NULL,
      layout_schema INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_opened_at INTEGER
    );
    INSERT INTO workspaces_p1(id, name, project, layout_json, layout_schema, created_at, updated_at, last_opened_at)
      VALUES ('w-old', '旧工作区', '', '{"schema":4}', 4, 1, 1, NULL);
    DROP TABLE workspaces;
    ALTER TABLE workspaces_p1 RENAME TO workspaces;
  `);
  raw.close();
}

describe('父链与引用去重', () => {
  it('父链停在断链和环上；同一目录下的重复引用只留一条，同一资料可以挂在两个目录', () => {
    const folders: VirtualFolder[] = [
      { folderId: 'a', parentId: null, name: 'A', sort: 0, createdAt: 1 },
      { folderId: 'b', parentId: 'a', name: 'B', sort: 0, createdAt: 1 },
      { folderId: 'c', parentId: 'gone', name: 'C', sort: 0, createdAt: 1 },
      { folderId: 'd', parentId: 'e', name: 'D', sort: 0, createdAt: 1 },
      { folderId: 'e', parentId: 'd', name: 'E', sort: 0, createdAt: 1 },
    ];
    expect(parentChain(folders, null)).toEqual([]);
    expect(parentChain(folders, 'missing')).toEqual([]);
    expect(parentChain(folders, 'b')).toEqual(['a', 'b']);
    expect(parentChain(folders, 'c')).toEqual(['c']);
    const cyc = parentChain(folders, 'd');
    expect(cyc.length).toBeLessThanOrEqual(2);
    expect(new Set(cyc).size).toBe(cyc.length);

    expect(
      dedupeRefs([
        { folderId: null, resourceId: 'r' },
        { folderId: '', resourceId: 'r' },
        { folderId: null, resourceId: 'r' },
        { folderId: 'f', resourceId: 'r' },
        { folderId: 'f', resourceId: 'r' },
      ]),
    ).toEqual([
      { folderId: null, resourceId: 'r' },
      { folderId: 'f', resourceId: 'r' },
    ]);
  });
});

describe('默认编排迁移', () => {
  it('空库生成 default，旧键保持不存在；catalog_id 可空，已有行补上 default，user_version 仍是 5', async () => {
    expect(WORKSPACES_CATALOG_ID_VERSION).toBe(1201);
    const { svc: opened, dataDir } = await makeService();
    await opened.close();
    stripCatalogColumn(path.join(dataDir, 'workbench.db'));
    const svc = track(new WorkbenchService({ dataDir }));

    expect(svc.db.pragma('user_version', { simple: true })).toBe(5);
    const cols = svc.db.prepare('PRAGMA table_info(workspaces)').all() as { name: string; notnull: number }[];
    const col = cols.find((c) => c.name === 'catalog_id');
    expect(col?.notnull).toBe(0);
    expect((svc.db.prepare('SELECT catalog_id FROM workspaces WHERE id = ?').get('w-old') as { catalog_id: string | null }).catalog_id).toBe('default');

    expect(svc.listVirtualFolders()).toEqual([]);
    const literal = '{"folders":[],"id":"default","name":"默认编排","refs":[],"revision":1,"virtualRootName":"自建目录"}';
    const digest = crypto.createHash('sha256').update(literal).digest('hex');
    const doc = svc.getLayout(CATALOGS_KEY) as { v: number; sets: CatalogSet[] };
    expect(doc.v).toBe(1);
    expect(doc.sets).toHaveLength(1);
    const set = doc.sets[0];
    expect(set.id).toBe(DEFAULT_CATALOG_ID);
    expect(set.name).toBe('默认编排');
    expect(set.virtualRootName).toBe('自建目录');
    expect(set.revision).toBe(1);
    expect(set.folders).toEqual([]);
    expect(set.refs).toEqual([]);
    expect(set.digest).toBe(digest);
    const { digest: _d, ...rest } = set;
    expect(catalogDigest(rest)).toBe(digest);
    expect(layoutText(svc.db, VFOLDERS_KEY)).toBeNull();
    expect(layoutText(svc.db, VFOLDER_REFS_KEY)).toBeNull();
    const stored = layoutText(svc.db, CATALOGS_KEY);
    svc.listVirtualFolders();
    expect(layoutText(svc.db, CATALOGS_KEY)).toBe(stored);

    const ws = svc.createWorkspace('空工作区', '');
    expect((svc.db.prepare('SELECT catalog_id FROM workspaces WHERE id = ?').get(ws.id) as { catalog_id: string | null }).catalog_id).toBe('default');
    svc.db.prepare('UPDATE workspaces SET catalog_id = NULL WHERE id = ?').run(ws.id);
    await svc.close();
    const again = track(new WorkbenchService({ dataDir }));
    expect((again.db.prepare('SELECT catalog_id FROM workspaces WHERE id = ?').get(ws.id) as { catalog_id: string | null }).catalog_id).toBeNull();
    expect(again.db.pragma('user_version', { simple: true })).toBe(5);
  });

  it('只有旧键时写入 default，计数字段一致，旧键字节不变；之后的写入同时更新旧键', async () => {
    const { svc: opened } = await makeService();
    const svc = track(opened);
    const folders = {
      v: 1,
      folders: [
        { folderId: 'top', parentId: null, name: '资料柜', sort: 0, createdAt: 10 },
        { folderId: 'child', parentId: 'top', name: '论文', sort: 1, createdAt: 11 },
      ],
    };
    const refs = { v: 1, byFolder: { '': ['root-item'], child: ['a', 'b'], top: ['a'] } };
    const foldersJson = JSON.stringify(folders);
    const refsJson = JSON.stringify(refs);
    svc.db.prepare('INSERT INTO layout(key, json, updated_at) VALUES (?,?,?)').run(VFOLDERS_KEY, foldersJson, 1);
    svc.db.prepare('INSERT INTO layout(key, json, updated_at) VALUES (?,?,?)').run(VFOLDER_REFS_KEY, refsJson, 1);

    expect(svc.listVirtualFolders().map((f) => f.folderId)).toEqual(['top', 'child']);
    expect(layoutText(svc.db, VFOLDERS_KEY)).toBe(foldersJson);
    expect(layoutText(svc.db, VFOLDER_REFS_KEY)).toBe(refsJson);
    const doc = svc.getLayout(CATALOGS_KEY) as { sets: CatalogSet[] };
    const set = doc.sets.find((s) => s.id === 'default')!;
    expect(set.folders).toHaveLength(2);
    expect(set.refs).toEqual([
      { folderId: null, resourceId: 'root-item' },
      { folderId: 'child', resourceId: 'a' },
      { folderId: 'child', resourceId: 'b' },
      { folderId: 'top', resourceId: 'a' },
    ]);
    expect(set.revision).toBe(1);
    const { digest: storedDigest, ...storedRest } = set;
    expect(storedDigest).toBe(catalogDigest(storedRest));
    expect(svc.listVfolderView('child').crumbs.map((c) => c.name)).toEqual(['自建目录', '资料柜', '论文']);
    expect(svc.listVfolderMembership('a')).toEqual(['child', 'top']);
    expect(svc.listVfolderView(null).entries.map((e) => e.resourceId)).toEqual(['root-item']);

    const raw = svc.getLayout(CATALOGS_KEY) as { v: number; sets: Record<string, unknown>[] };
    raw.sets.push({ id: 'other', name: '另一套', revision: 3, digest: 'abc', virtualRootName: '根', folders: [], refs: [], note: 'keep' });
    svc.setLayout(CATALOGS_KEY, raw);
    const created = svc.createVirtualFolder(null, '附录');
    const after = svc.getLayout(CATALOGS_KEY) as { sets: (CatalogSet & { note?: string })[] };
    expect(after.sets.find((s) => s.id === 'other')?.note).toBe('keep');
    const next = after.sets.find((s) => s.id === 'default')!;
    expect(next.revision).toBe(2);
    expect(next.folders.map((f) => f.folderId).sort()).toEqual(['child', 'top', created.folderId].sort());
    expect(next.refs).toContainEqual({ folderId: null, resourceId: 'root-item' });
    const oldFolders = svc.getLayout(VFOLDERS_KEY) as { folders: { folderId: string }[] };
    const oldRefs = svc.getLayout(VFOLDER_REFS_KEY) as { byFolder: Record<string, string[]> };
    expect(oldFolders.folders.map((f) => f.folderId)).toContain(created.folderId);
    expect(oldRefs.byFolder['']).toEqual(['root-item']);
    expect(oldRefs.byFolder.child).toEqual(['a', 'b']);

    svc.classifyByType(['id-1']);
    expect(svc.vfolderUndoAvailable()).toBe(true);
    expect(JSON.stringify(svc.getLayout(CATALOGS_KEY))).not.toContain('createdFolderIds');
    expect(svc.getLayout('library.vfolderClassifyUndo')).toBeTruthy();
  });

  it('旧键损坏时不写 library.catalogs，原文字节保持不变，读取不抛错', async () => {
    const bad = track((await makeService()).svc);
    bad.db.prepare('INSERT INTO layout(key, json, updated_at) VALUES (?,?,?)').run(VFOLDERS_KEY, '{', 1);
    bad.db.prepare('INSERT INTO layout(key, json, updated_at) VALUES (?,?,?)').run(VFOLDER_REFS_KEY, '{"v":1,"byFolder":{"top":["a"]}}', 1);
    expect(bad.listVirtualFolders()).toEqual([]);
    expect(layoutText(bad.db, CATALOGS_KEY)).toBeNull();
    expect(layoutText(bad.db, VFOLDERS_KEY)).toBe('{');
    expect(layoutText(bad.db, VFOLDER_REFS_KEY)).toBe('{"v":1,"byFolder":{"top":["a"]}}');

    const dup = track((await makeService()).svc);
    const foldersJson = JSON.stringify({
      v: 1,
      folders: [
        { folderId: 'a', parentId: null, name: '甲', sort: 0, createdAt: 1 },
        { folderId: 'a', parentId: null, name: '乙', sort: 1, createdAt: 2 },
      ],
    });
    const refsJson = JSON.stringify({ v: 1, byFolder: { a: ['r1'] } });
    dup.db.prepare('INSERT INTO layout(key, json, updated_at) VALUES (?,?,?)').run(VFOLDERS_KEY, foldersJson, 1);
    dup.db.prepare('INSERT INTO layout(key, json, updated_at) VALUES (?,?,?)').run(VFOLDER_REFS_KEY, refsJson, 1);
    expect(dup.listVirtualFolders().map((f) => f.name)).toEqual(['甲']);
    expect(layoutText(dup.db, CATALOGS_KEY)).toBeNull();
    expect(layoutText(dup.db, VFOLDERS_KEY)).toBe(foldersJson);
    expect(layoutText(dup.db, VFOLDER_REFS_KEY)).toBe(refsJson);
  });
});
