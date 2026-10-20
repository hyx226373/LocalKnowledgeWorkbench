import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { HybridSearch, LocalSearch, type SearchBackend } from '../src/main/backend/search';
import { createDataApi, type DataApiDeps } from '../src/main/data/api';
import { CONTENT_BODY_INDEX_ENABLED, CONTENT_SEARCH_UNAVAILABLE_NOTICE, isContentBodyIndexEnabled } from '../src/shared/contentIndexScope';
import { makeRoot, makeService, tmpDir, write } from './helpers';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function track<T extends { close(): Promise<void> | void }>(svc: T): T {
  cleanups.push(() => svc.close());
  return svc;
}

it('总闸常量默认关闭', () => {
  expect(CONTENT_BODY_INDEX_ENABLED).toBe(false);
  expect(isContentBodyIndexEnabled()).toBe(false);
});

it('闸门关时 searchGrouped(scope=content) 为空，且不加正文索引', async () => {
  const { svc } = await makeService();
  track(svc);
  const indexCalls: string[] = [];
  const searchCalls: unknown[] = [];
  const backend = {
    onRootRemoved() {},
    onRootAdded() {},
    indexContent() {
      indexCalls.push('indexContent');
    },
    search: {
      async search(_q: string, o?: unknown) {
        searchCalls.push(o);
        return {
          hits: [{ resourceId: 'old', rootId: 'r', relPath: 'a.md', title: '旧正文', score: 1, matchKind: 'content', matches: [], matchesTruncated: false }],
          truncated: false,
        };
      },
    },
    getHealth: () => ({ engine: 'kb-indexer', contentSearch: true, since: 1, scannedFiles: 1, contentIndexedFiles: 3 }),
    ops: { forUi: () => ({}) },
    fileOps: {},
    agent: null,
    stack: null,
  };
  const api = createDataApi({
    svc,
    backend,
    watchers: { sync() {}, restart() {} },
    appHost: {},
    ask: async () => null,
    packaged: false,
    e2e: false,
    version: '0.0.0',
    onRootsReplaced: async () => {},
    webApi: {},
    store: {},
    harness: null,
    publishPlugins() {},
    publishHarness() {},
  } as unknown as DataApiDeps);

  const content = await api.searchGrouped('戊己', { scope: 'content', limit: 20 });
  expect(content).toMatchObject({ hits: [], degraded: true, notice: CONTENT_SEARCH_UNAVAILABLE_NOTICE });
  expect(searchCalls).toEqual([]);

  const dir = makeRoot();
  const root = (await api.addRoot(dir, '笔记')) as { id: string };
  expect(indexCalls).toEqual([]);
  await api.rescan(root.id);
  expect(indexCalls).toEqual([]);
  const rebuilt = (await api.indexRebuild(root.id)) as { ok: boolean; detail?: unknown };
  expect(rebuilt.ok).toBe(true);
  expect(String(rebuilt.detail)).toContain('只按文件名搜索');
  expect(indexCalls).toEqual([]);

  const moved = tmpDir('kb-remap-gate-');
  fs.cpSync(dir, moved, { recursive: true });
  await api.remapRoot(root.id, moved);
  expect(indexCalls).toEqual([]);
});

it('文件名搜索仍命中 md 和 png，且不被 indexer 正文列短路', async () => {
  const { svc } = await makeService();
  track(svc);
  const dir = makeRoot();
  const root = svc.addRoot(dir, '库');
  await svc.scanRoot(root.id);
  const names = svc.search('读书笔记').map((hit) => hit.name);
  expect(names).toContain('读书笔记.md');
  const png = svc.search('a.png');
  expect(png.some((hit) => hit.name === 'a.png' && hit.relPath.endsWith('a.png'))).toBe(true);

  let primaryCalls = 0;
  const primary: SearchBackend = {
    async search() {
      primaryCalls += 1;
      return {
        hits: [{
          resourceId: 'only-md',
          rootId: root.id,
          relPath: '笔记/读书笔记.md',
          title: '读书笔记.md',
          score: 1,
          matchKind: 'name',
          matches: [],
          matchesTruncated: false,
        }],
        truncated: false,
      };
    },
  };
  const hybrid = new HybridSearch(primary, new LocalSearch(svc));
  const found = await hybrid.search('a.png', { scope: 'name', limit: 20 });
  expect(primaryCalls).toBe(0);
  expect(found.hits.some((hit) => hit.title === 'a.png')).toBe(true);
});

it('空 rel_path 的单文件按文件名能命中', async () => {
  const { svc } = await makeService();
  track(svc);
  const dir = tmpDir('kbsolo-fts-');
  const file = path.join(dir, 'solo-pic.png');
  write(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const root = svc.addFileSource(file, 'solo-pic.png');
  const row = svc.db.prepare('SELECT rel_path, name FROM resources_fts WHERE resource_id=?').get(root.resourceId) as { rel_path: string; name: string };
  expect(row).toEqual({ rel_path: '', name: 'solo-pic.png' });
  expect(svc.search('solo-pic.png').map((hit) => hit.resourceId)).toContain(root.resourceId);
  expect(svc.search('so').map((hit) => hit.resourceId)).toContain(root.resourceId);
  const via = await new LocalSearch(svc).search('solo-pic.png', { scope: 'name' });
  expect(via.hits.some((hit) => hit.resourceId === root.resourceId && hit.matchKind === 'name')).toBe(true);
});
