import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WorkbenchService } from '../src/main/service/WorkbenchService';
import { WEB_SOURCES_VERSION } from '../src/main/service/db';
import { VFOLDER_REFS_KEY, VFOLDERS_KEY, WEB_STUBS_KEY } from '../src/main/service/workspaceRefs';
import {
  CATALOG_FILE_EXT,
  CATALOG_FILE_FORMAT,
  CATALOG_SCHEMA_PATH,
  CATALOGS_KEY,
  CatalogFileError,
  catalogJsonHasAbsolutePath,
  parseCatalogFile,
  stringifyCatalogFile,
} from '../src/main/service/catalogFile';
import { makeRoot, makeService } from './helpers';
import schema from '../src/shared/catalog.schema.json';

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

function snap(svc: WorkbenchService) {
  return {
    userVersion: svc.db.pragma('user_version', { simple: true }),
    layout: svc.db.prepare('SELECT key, json FROM layout ORDER BY key').all(),
    web: svc.db.prepare('SELECT resource_id, url, title FROM web_resources ORDER BY resource_id').all(),
    view: svc.db.prepare('SELECT id, url, title FROM web_sources ORDER BY id').all(),
    roots: svc.db.prepare('SELECT id, name FROM roots ORDER BY id').all(),
    fts: svc.db.prepare('SELECT resource_id FROM resources_fts ORDER BY resource_id').all(),
    catalogs: layoutText(svc.db, CATALOGS_KEY),
    vfolders: layoutText(svc.db, VFOLDERS_KEY),
    vrefs: layoutText(svc.db, VFOLDER_REFS_KEY),
    stubs: layoutText(svc.db, WEB_STUBS_KEY),
  };
}

async function filled() {
  const { svc, dataDir } = await makeService();
  track(svc);
  const dir = makeRoot();
  const root = svc.addRoot(dir);
  await svc.scanRoot(root.id);
  const pdf = svc.resourceIdFor(root.id, '资料/论文/paper.pdf');
  const md = svc.resourceIdFor(root.id, '笔记/读书笔记.md');
  const top = svc.createVirtualFolder(null, '资料柜');
  const child = svc.createVirtualFolder(top.folderId, '论文');
  svc.setVfolderMembership(pdf, [top.folderId, child.folderId]);
  svc.setVfolderMembership(md, [child.folderId]);
  const webId = crypto.randomUUID();
  svc.rememberWebStub({ resourceId: webId, url: 'https://papers.example.org/n', title: '网络论文' });
  svc.setVfolderMembership(webId, [child.folderId]);
  const missingId = 'missing-resource-id';
  svc.setVfolderMembership(missingId, [child.folderId]);
  return { svc, dataDir, dir, root, pdf, md, top, child, webId, missingId };
}

describe('schema 与路径', () => {
  it('schema 描述 kb-workbench.catalog，扩展名 .kbcatalog.json', () => {
    expect(schema.title).toBe('kb-workbench.catalog');
    expect((schema as { properties: { format: { const: string } } }).properties.format.const).toBe(CATALOG_FILE_FORMAT);
    expect((schema as { properties: { formatVersion: { const: number } } }).properties.formatVersion.const).toBe(1);
    expect(CATALOG_FILE_EXT).toBe('.kbcatalog.json');
    expect(CATALOG_SCHEMA_PATH).toBe('src/shared/catalog.schema.json');
    expect(fs.existsSync(path.join(__dirname, '..', CATALOG_SCHEMA_PATH))).toBe(true);
    expect(WEB_SOURCES_VERSION).toBe(1206);
  });
});

describe('往返无损', () => {
  it('同一库导出再导入，编排与网络资料 ID 不变，不含绝对路径，不进 FTS', async () => {
    const { svc, pdf, md, webId, child } = await filled();
    expect(svc.db.pragma('user_version', { simple: true })).toBe(5);
    const viewKind = svc.db.prepare("SELECT type FROM sqlite_master WHERE name='web_sources'").get() as { type: string };
    expect(viewKind.type).toBe('view');

    const file = svc.exportCatalog();
    expect(file.format).toBe('kb-workbench.catalog');
    expect(file.formatVersion).toBe(1);
    expect(file.id).toBe('default');
    expect(file.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(file.baseDigest).toBe(file.digest);
    const text = stringifyCatalogFile(file);
    expect(text).toContain('\n  "format":');
    expect(catalogJsonHasAbsolutePath(text)).toBe(false);
    expect(catalogJsonHasAbsolutePath(JSON.stringify(file.sources))).toBe(false);

    const parsed = parseCatalogFile(text);
    expect(parsed.folders.map((f) => f.name).sort()).toEqual(['资料柜', '论文'].sort());
    expect(parsed.refs).toEqual(expect.arrayContaining([
      { folderId: child.folderId, resourceId: pdf },
      { folderId: child.folderId, resourceId: md },
      { folderId: child.folderId, resourceId: webId },
      { folderId: child.folderId, resourceId: 'missing-resource-id', pending: true },
    ]));
    expect(parsed.refs.find((r) => r.resourceId === webId)?.pending).toBeUndefined();
    expect(parsed.refs.find((r) => r.resourceId === 'missing-resource-id')?.pending).toBe(true);
    const webSrc = parsed.sources.find((s) => s.kind === 'web' && s.sourceId === webId);
    expect(webSrc?.url).toBe('https://papers.example.org/n');
    const folderSrc = parsed.sources.filter((s) => s.kind === 'folder');
    expect(folderSrc.length).toBeGreaterThanOrEqual(1);
    expect(folderSrc.every((s) => !('url' in s) || s.url == null)).toBe(true);

    const before = snap(svc);
    const result = svc.importCatalog(text);
    expect(result.digest).toBe(file.digest);
    expect(result.id).toBe('default');
    const again = svc.exportCatalog();
    expect(again.folders).toEqual(file.folders);
    expect(again.refs).toEqual(file.refs);
    expect(again.digest).toBe(file.digest);
    expect(again.sources.filter((s) => s.kind === 'web')).toEqual(file.sources.filter((s) => s.kind === 'web'));
    expect(layoutText(svc.db, VFOLDERS_KEY)).toBeTruthy();
    expect(layoutText(svc.db, VFOLDER_REFS_KEY)).toBeTruthy();
    expect(layoutText(svc.db, WEB_STUBS_KEY)).toBe(before.stubs);

    const row = svc.db.prepare('SELECT id, url, title FROM web_sources WHERE id=?').get(webId) as { id: string; url: string; title: string };
    expect(row.id).toBe(webId);
    expect(row.url).toBe('https://papers.example.org/n');
    expect(svc.db.prepare('SELECT resource_id FROM resources_fts WHERE resource_id=?').all(webId)).toEqual([]);
    expect(svc.search('SECRET_BODY_TOKEN_NOT_IN_TITLE')).toEqual([]);
    expect(svc.listVfolderView(child.folderId).entries.map((e) => e.resourceId)).toEqual(expect.arrayContaining([pdf, md, webId]));
    expect(svc.listVfolderView(child.folderId).entries.find((e) => e.resourceId === webId)?.sourceKind).toBe('web');
  });

  it('文件本身 parse/stringify 往返字段一致', async () => {
    const { svc } = await filled();
    const file = svc.exportCatalog();
    const text = stringifyCatalogFile(file);
    const once = parseCatalogFile(text);
    const twice = parseCatalogFile(stringifyCatalogFile(once));
    expect(twice).toEqual(once);
    expect(once.digest).toBe(file.digest);
  });

  it('导入到空库时保留网络资料 ID，不新建磁盘根，未知文件引用标 pending', async () => {
    const a = await filled();
    const file = a.svc.exportCatalog();
    const { svc: b } = await makeService();
    track(b);
    const empty = b.exportCatalog();
    const incoming = { ...file, baseDigest: empty.digest };
    const result = b.importCatalog(stringifyCatalogFile(incoming));
    expect(result.id).toBe('default');
    expect(b.listRoots()).toEqual([]);
    expect(b.listVirtualFolders().map((f) => f.name).sort()).toEqual(['资料柜', '论文'].sort());
    const web = b.db.prepare('SELECT id, url FROM web_sources WHERE id=?').get(a.webId) as { id: string; url: string };
    expect(web).toEqual({ id: a.webId, url: 'https://papers.example.org/n' });
    expect(result.pendingResourceIds).toEqual(expect.arrayContaining([a.pdf, a.md]));
    expect(result.pendingResourceIds).not.toContain(a.webId);
    const exported = b.exportCatalog();
    expect(exported.refs.find((r) => r.resourceId === a.pdf)?.pending).toBe(true);
    expect(exported.refs.find((r) => r.resourceId === a.webId)?.pending).toBeUndefined();
    expect(b.db.prepare('SELECT resource_id FROM resources_fts WHERE resource_id=?').all(a.webId)).toEqual([]);
  });
});

describe('坏文件报错不写库', () => {
  async function primed() {
    const { svc } = await filled();
    svc.exportCatalog();
    return svc;
  }

  it.each([
    ['不是 JSON', '{'],
    ['format 不对', { format: 'kb-workbench.layout', formatVersion: 1, id: 'default', name: '默认编排', revision: 1, digest: 'a'.repeat(64), virtualRootName: '自建目录', folders: [], refs: [], sources: [] }],
    ['版本不对', { format: CATALOG_FILE_FORMAT, formatVersion: 2, id: 'default', name: '默认编排', revision: 1, digest: 'a'.repeat(64), virtualRootName: '自建目录', folders: [], refs: [], sources: [] }],
    ['空名', { format: CATALOG_FILE_FORMAT, formatVersion: 1, id: 'default', name: '默认编排', revision: 1, digest: 'a'.repeat(64), virtualRootName: '自建目录', folders: [{ folderId: 'f1', parentId: null, name: '  ', sort: 0, createdAt: 1 }], refs: [], sources: [] }],
    ['斜杠名', { format: CATALOG_FILE_FORMAT, formatVersion: 1, id: 'default', name: '默认编排', revision: 1, digest: 'a'.repeat(64), virtualRootName: '自建目录', folders: [{ folderId: 'f1', parentId: null, name: 'a/b', sort: 0, createdAt: 1 }], refs: [], sources: [] }],
    ['未知 folderId', { format: CATALOG_FILE_FORMAT, formatVersion: 1, id: 'default', name: '默认编排', revision: 1, digest: 'a'.repeat(64), virtualRootName: '自建目录', folders: [{ folderId: 'f1', parentId: null, name: '甲', sort: 0, createdAt: 1 }], refs: [{ folderId: 'gone', resourceId: 'r1' }], sources: [] }],
    ['成环', { format: CATALOG_FILE_FORMAT, formatVersion: 1, id: 'default', name: '默认编排', revision: 1, digest: 'a'.repeat(64), virtualRootName: '自建目录', folders: [{ folderId: 'a', parentId: 'b', name: 'A', sort: 0, createdAt: 1 }, { folderId: 'b', parentId: 'a', name: 'B', sort: 0, createdAt: 1 }], refs: [], sources: [] }],
    ['绝对路径', { format: CATALOG_FILE_FORMAT, formatVersion: 1, id: 'default', name: '默认编排', revision: 1, digest: 'a'.repeat(64), virtualRootName: '自建目录', folders: [{ folderId: 'f1', parentId: null, name: '柜', sort: 0, createdAt: 1 }], refs: [], sources: [{ sourceId: 's1', kind: 'folder', name: 'C:\\notes', extensions: [] }] }],
  ])('%s', async (_label, raw) => {
    const svc = await primed();
    const before = snap(svc);
    expect(() => svc.importCatalog(raw)).toThrow(CatalogFileError);
    expect(snap(svc)).toEqual(before);
  });

  it('baseDigest 与库内不一致则拒绝，两边 digest 都在错误里', async () => {
    const { svc } = await filled();
    const file = svc.exportCatalog();
    svc.createVirtualFolder(null, '附录');
    const afterEdit = snap(svc);
    const libraryDigest = (svc.getLayout(CATALOGS_KEY) as { sets: { id: string; digest: string }[] }).sets.find((s) => s.id === 'default')!.digest;
    expect(file.baseDigest).not.toBe(libraryDigest);
    try {
      svc.importCatalog(stringifyCatalogFile(file));
      throw new Error('应当拒绝');
    } catch (e) {
      expect(e).toBeInstanceOf(CatalogFileError);
      const err = e as CatalogFileError;
      expect(err.code).toBe('conflict');
      expect(err.libraryDigest).toBe(libraryDigest);
      expect(err.fileBaseDigest).toBe(file.baseDigest);
      expect(err.message).toContain(libraryDigest);
      expect(err.message).toContain(file.baseDigest);
    }
    expect(snap(svc)).toEqual(afterEdit);
  });
});

describe('webStubs 迁入 web_sources', () => {
  it('UUID stub 迁入后 ID 不变，旧键字节不动，不索引正文', async () => {
    const { svc } = await makeService();
    track(svc);
    const id = crypto.randomUUID();
    svc.rememberWebStub({ resourceId: id, url: 'https://docs.example.org/a', title: '文档' });
    const stubsBefore = layoutText(svc.db, WEB_STUBS_KEY);
    expect(stubsBefore).toBeTruthy();
    expect(svc.db.prepare('SELECT id FROM web_sources WHERE id=?').get(id)).toBeUndefined();
    const folder = svc.createVirtualFolder(null, '网页');
    svc.setVfolderMembership(id, [folder.folderId]);
    const file = svc.exportCatalog();
    expect(layoutText(svc.db, WEB_STUBS_KEY)).toBe(stubsBefore);
    expect(file.sources.some((s) => s.sourceId === id && s.kind === 'web' && s.url === 'https://docs.example.org/a')).toBe(true);
    const row = svc.db.prepare('SELECT id, url, title FROM web_sources WHERE id=?').get(id) as { id: string; url: string; title: string };
    expect(row).toEqual({ id, url: 'https://docs.example.org/a', title: '文档' });
    expect(svc.db.prepare('SELECT resource_id FROM resources_fts WHERE resource_id=?').all(id)).toEqual([]);
    expect(svc.search('文档正文不会出现在索引里的句子')).toEqual([]);
  });
});
