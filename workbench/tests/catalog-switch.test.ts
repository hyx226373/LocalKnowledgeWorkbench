import { afterEach, describe, expect, it } from 'vitest';
import { WorkbenchService } from '../src/main/service/WorkbenchService';
import { DB_VERSION } from '../src/main/service/db';
import { INVOKE_WHITELIST } from '../src/main/agent-bridge/types';
import { VFOLDER_REFS_KEY, VFOLDERS_KEY } from '../src/main/service/workspaceRefs';
import { CATALOGS_KEY, DEFAULT_CATALOG_ID, makeCatalogSet, type CatalogSet } from '../src/shared/catalog';
import { makeRoot, makeService } from './helpers';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function track(svc: WorkbenchService) {
  cleanups.push(() => svc.close());
  return svc;
}

function layoutText(db: WorkbenchService['db'], key: string): string | null {
  const row = db.prepare('SELECT json FROM layout WHERE key = ?').get(key) as { json: string } | undefined;
  return row?.json ?? null;
}

function catalogIdOf(svc: WorkbenchService, id: string): string | null {
  return (svc.db.prepare('SELECT catalog_id FROM workspaces WHERE id=?').get(id) as { catalog_id: string | null }).catalog_id;
}

function wsCore(svc: WorkbenchService, id: string) {
  return svc.db
    .prepare('SELECT name, project, layout_json, layout_schema, created_at, updated_at, last_opened_at FROM workspaces WHERE id=?')
    .get(id);
}

type FileSnap = {
  resources: { id: string; root_id: string; rel_path: string }[];
  mounts: { root_id: string; local_path: string; updated_at: number }[];
};

function readFiles(svc: WorkbenchService): FileSnap {
  return {
    resources: svc.db.prepare('SELECT id, root_id, rel_path FROM resources ORDER BY id').all() as FileSnap['resources'],
    mounts: svc.db.prepare('SELECT root_id, local_path, updated_at FROM root_mounts ORDER BY root_id').all() as FileSnap['mounts'],
  };
}

/** 等后台扫描落定，避免把扫描中的行数当成切换造成的变化。 */
async function stableFiles(svc: WorkbenchService): Promise<FileSnap> {
  let last = JSON.stringify(readFiles(svc));
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 40));
    const cur = JSON.stringify(readFiles(svc));
    if (cur === last) return JSON.parse(cur) as FileSnap;
    last = cur;
  }
  return JSON.parse(last) as FileSnap;
}

async function prepared() {
  const { svc: opened } = await makeService();
  const svc = track(opened);
  const dir = makeRoot();
  const root = svc.addRoot(dir);
  await svc.scanRoot(root.id);
  const pdf = svc.resourceIdFor(root.id, '资料/论文/paper.pdf');
  const files = await stableFiles(svc);
  const folders = {
    v: 1,
    folders: [{ folderId: 'top', parentId: null, name: '资料柜', sort: 0, createdAt: 10 }],
  };
  const refs = { v: 1, byFolder: { top: [pdf] } };
  const foldersJson = JSON.stringify(folders);
  const refsJson = JSON.stringify(refs);
  svc.db.prepare('INSERT INTO layout(key, json, updated_at) VALUES (?,?,?)').run(VFOLDERS_KEY, foldersJson, 1);
  svc.db.prepare('INSERT INTO layout(key, json, updated_at) VALUES (?,?,?)').run(VFOLDER_REFS_KEY, refsJson, 1);
  const wsA = svc.createWorkspace('甲', '项目');
  const wsB = svc.createWorkspace('乙', '项目');
  return { svc, dir, root, pdf, files, foldersJson, refsJson, wsA, wsB };
}

describe('工作区选用编排', () => {
  it('两个工作区各用一套；切换后资料 ID 与磁盘路径不变，另一工作区的 catalog_id 不变', async () => {
    expect(DB_VERSION).toBe(5);
    expect((INVOKE_WHITELIST as readonly string[]).includes('catalog.switch')).toBe(false);
    const { svc, dir, root, pdf, files, foldersJson, refsJson, wsA, wsB } = await prepared();
    expect(svc.db.pragma('user_version', { simple: true })).toBe(5);
    expect(files.resources.length).toBeGreaterThan(0);
    expect(files.resources).toContainEqual(expect.objectContaining({ id: pdf, rel_path: '资料/论文/paper.pdf' }));
    expect(files.mounts).toContainEqual(expect.objectContaining({ root_id: root.id, local_path: dir }));
    expect(catalogIdOf(svc, wsA.id)).toBe(DEFAULT_CATALOG_ID);
    expect(catalogIdOf(svc, wsB.id)).toBe(DEFAULT_CATALOG_ID);

    const migrated = svc.catalogForWorkspace(wsA.id);
    expect(migrated.catalogId).toBe('default');
    expect(migrated.virtualRootName).toBe('自建目录');
    expect(migrated.folders.map((f) => f.folderId)).toEqual(['top']);
    expect(migrated.refs).toEqual([{ folderId: 'top', resourceId: pdf }]);
    expect(layoutText(svc.db, VFOLDERS_KEY)).toBe(foldersJson);
    expect(layoutText(svc.db, VFOLDER_REFS_KEY)).toBe(refsJson);

    const doc = svc.getLayout(CATALOGS_KEY) as { v: number; sets: (CatalogSet & { note?: string })[] };
    const kept = doc.sets.find((s) => s.id === 'default');
    expect(kept).toBeTruthy();
    kept!.note = 'keep';
    const other = makeCatalogSet({
      id: 'cat-b',
      name: '乙套',
      revision: 1,
      virtualRootName: '乙根',
      folders: [{ folderId: 'b1', parentId: null, name: '另册', sort: 0, createdAt: 2 }],
      refs: [{ folderId: 'b1', resourceId: pdf }],
    });
    svc.setLayout(CATALOGS_KEY, { v: 1, sets: [...doc.sets, other] });
    const catalogsText = layoutText(svc.db, CATALOGS_KEY);
    const coreA = wsCore(svc, wsA.id);
    const coreB = wsCore(svc, wsB.id);

    expect(() => svc.switchCatalog(wsB.id, 'missing-set')).toThrow(/编排不存在/);
    expect(() => svc.switchCatalog(wsB.id, 'a/b')).toThrow(/编排 ID 无效/);
    expect(() => svc.switchCatalog('no-such', 'default')).toThrow(/工作区不存在/);
    expect(catalogIdOf(svc, wsA.id)).toBe('default');
    expect(catalogIdOf(svc, wsB.id)).toBe('default');
    expect(layoutText(svc.db, CATALOGS_KEY)).toBe(catalogsText);
    expect(readFiles(svc)).toEqual(files);

    expect(svc.switchCatalog(wsB.id, 'cat-b')).toEqual({ workspaceId: wsB.id, catalogId: 'cat-b' });
    expect(catalogIdOf(svc, wsA.id)).toBe('default');
    expect(catalogIdOf(svc, wsB.id)).toBe('cat-b');
    expect(wsCore(svc, wsA.id)).toEqual(coreA);
    expect(wsCore(svc, wsB.id)).toEqual(coreB);
    expect(layoutText(svc.db, CATALOGS_KEY)).toBe(catalogsText);
    expect(layoutText(svc.db, VFOLDERS_KEY)).toBe(foldersJson);
    expect(readFiles(svc)).toEqual(files);

    expect(svc.currentCatalogId()).toBe('default');
    expect(svc.listVirtualFolders().map((f) => f.folderId)).toEqual(['top']);
    const idsBeforeEnter = [catalogIdOf(svc, wsA.id), catalogIdOf(svc, wsB.id)];
    svc.setCurrentWorkspace(wsB.id);
    expect([catalogIdOf(svc, wsA.id), catalogIdOf(svc, wsB.id)]).toEqual(idsBeforeEnter);
    expect(layoutText(svc.db, CATALOGS_KEY)).toBe(catalogsText);
    expect(svc.currentCatalogId()).toBe('cat-b');
    expect(svc.listVirtualFolders().map((f) => f.name)).toEqual(['另册']);
    expect(svc.listVfolderView(null).crumbs[0]).toEqual({ folderId: null, name: '乙根' });
    expect(svc.listVfolderView('b1').entries.map((e) => ({ resourceId: e.resourceId, relPath: e.relPath }))).toEqual([
      { resourceId: pdf, relPath: '资料/论文/paper.pdf' },
    ]);
    expect(() => svc.listVfolderView('top')).toThrow(/不存在/);
    expect(svc.catalogForWorkspace(wsA.id).folders.map((f) => f.folderId)).toEqual(['top']);
    expect(svc.catalogForWorkspace(wsA.id).refs).toEqual([{ folderId: 'top', resourceId: pdf }]);

    svc.setCurrentWorkspace(wsA.id);
    expect(catalogIdOf(svc, wsB.id)).toBe('cat-b');
    expect(svc.currentCatalogId()).toBe('default');
    expect(svc.listVfolderView('top').crumbs.map((c) => c.name)).toEqual(['自建目录', '资料柜']);
    expect(svc.listVfolderView('top').entries[0]).toMatchObject({ resourceId: pdf, relPath: '资料/论文/paper.pdf' });

    svc.setCurrentWorkspace(wsB.id);
    const legacyBefore = layoutText(svc.db, VFOLDERS_KEY);
    const createdB = svc.createVirtualFolder(null, '只在乙套');
    expect(layoutText(svc.db, VFOLDERS_KEY)).toBe(legacyBefore);
    expect(layoutText(svc.db, VFOLDER_REFS_KEY)).toBe(refsJson);
    const afterB = svc.getLayout(CATALOGS_KEY) as { sets: (CatalogSet & { note?: string })[] };
    expect(afterB.sets.find((s) => s.id === 'default')?.note).toBe('keep');
    expect(afterB.sets.find((s) => s.id === 'default')?.folders.map((f) => f.folderId)).toEqual(['top']);
    expect(svc.listVirtualFolders().map((f) => f.folderId)).toContain(createdB.folderId);
    expect(svc.listVfolderView(null).crumbs[0].name).toBe('乙根');
    expect(catalogIdOf(svc, wsA.id)).toBe('default');

    svc.setCurrentWorkspace(wsA.id);
    const createdA = svc.createVirtualFolder(null, '附录');
    const legacy = svc.getLayout(VFOLDERS_KEY) as { folders: { folderId: string }[] };
    expect(legacy.folders.map((f) => f.folderId)).toEqual(expect.arrayContaining(['top', createdA.folderId]));
    const oldRefs = svc.getLayout(VFOLDER_REFS_KEY) as { byFolder: Record<string, string[]> };
    expect(oldRefs.byFolder.top).toEqual([pdf]);
    const afterA = svc.getLayout(CATALOGS_KEY) as { sets: (CatalogSet & { note?: string })[] };
    expect(afterA.sets.find((s) => s.id === 'default')?.folders.map((f) => f.folderId)).toEqual(expect.arrayContaining(['top', createdA.folderId]));
    const viewB = svc.catalogForWorkspace(wsB.id);
    expect(viewB.catalogId).toBe('cat-b');
    expect(viewB.folders.map((f) => f.folderId)).toContain(createdB.folderId);
    expect(viewB.folders.map((f) => f.folderId)).not.toContain(createdA.folderId);
    expect(catalogIdOf(svc, wsB.id)).toBe('cat-b');

    svc.db.prepare('UPDATE workspaces SET catalog_id = NULL WHERE id=?').run(wsA.id);
    expect(svc.catalogForWorkspace(wsA.id).catalogId).toBe('default');
    expect(svc.catalogForWorkspace(wsA.id).folders.map((f) => f.folderId)).toEqual(expect.arrayContaining(['top', createdA.folderId]));
    expect(catalogIdOf(svc, wsA.id)).toBeNull();
    expect(catalogIdOf(svc, wsB.id)).toBe('cat-b');

    expect(readFiles(svc)).toEqual(files);
    expect(svc.db.pragma('user_version', { simple: true })).toBe(5);
  });
});
