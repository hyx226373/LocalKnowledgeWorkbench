import { expect, it } from 'vitest';
import path from 'node:path';
import { makeService, tmpDir, write } from './helpers';
import { CONTENT_SEARCH_UNAVAILABLE_NOTICE, setContentBodyIndexEnabledForTests } from '../src/shared/contentIndexScope';
import {
  DegradedSearch,
  HybridSearch,
  KbSearch,
  LocalSearch,
  contentFetchLimit,
  fromIndexerGrouped,
  type GroupedHit,
  type SearchBackend,
} from '../src/main/backend/search';

function rawName(i: number) {
  return {
    resourceId: `n${i}`,
    rootId: 'R',
    relPath: `n${i}.md`,
    title: `n${i}`,
    score: 1,
    matchKind: 'name' as const,
    page: 0,
    snippet: `n${i}`,
    matches: [] as Array<{ matchKind?: string; page: number; line: number | null; snippet: string; anchor: { line: number } }>,
    matchesTruncated: false,
  };
}

function rawBoth() {
  return {
    resourceId: 'both',
    rootId: 'R',
    relPath: 'both.md',
    title: 'both.md',
    score: 2,
    matchKind: 'name' as const,
    page: 1,
    snippet: 'both.md',
    matches: [{ matchKind: 'body', page: 1, line: 3, snippet: '正文<b>戊己</b>', anchor: { line: 3 } }],
    matchesTruncated: false,
  };
}

function nameHit(i: number): GroupedHit {
  return {
    resourceId: `n${i}`,
    rootId: 'R',
    relPath: `n${i}.md`,
    title: `n${i}`,
    score: 1,
    matchKind: 'name',
    snippet: `n${i}`,
    matches: [],
    matchesTruncated: false,
  };
}

function contentHit(): GroupedHit {
  return {
    resourceId: 'body',
    rootId: 'R',
    relPath: 'body.md',
    title: 'body.md',
    score: 2,
    matchKind: 'content',
    snippet: '正文戊己',
    matches: [{ start: 0, end: 2, anchor: 'line:3' }],
    matchesTruncated: false,
  };
}

it('文件名命中占满 limit 时，正文范围仍返回同时名中文中的那条', async () => {
  const all = [...Array.from({ length: 50 }, (_, i) => rawName(i)), rawBoth()];
  const calls: Array<{ limit: number; scope?: string }> = [];
  const search = new KbSearch((_db, _q, o) => {
    calls.push(o);
    return fromIndexerGrouped({ hits: all.slice(0, o.limit), truncated: all.length > o.limit });
  }, 'DB');
  const result = await search.search('戊己', { limit: 50, scope: 'content' });
  expect(calls[0]?.scope).toBe('content');
  expect(calls[0]?.limit).toBe(contentFetchLimit(50));
  expect(calls[0]?.limit).toBeGreaterThan(50);
  expect(result.hits.map((h) => h.resourceId)).toEqual(['both']);
  expect(result.hits[0]?.matchKind).toBe('content');
  expect(result.hits[0]?.snippet).toContain('戊己');
});

it('indexer 命中级 matchKind 为 name、matches 里有 body 时按正文', () => {
  const grouped = fromIndexerGrouped({ hits: [rawBoth()], truncated: false });
  expect(grouped.hits[0]).toMatchObject({ resourceId: 'both', matchKind: 'content' });
  expect(grouped.hits[0]?.snippet).toContain('戊己');
  const onlyName = fromIndexerGrouped({ hits: [rawName(0)], truncated: false });
  expect(onlyName.hits[0]?.matchKind).toBe('name');
});

it('主结果只有文件名时继续问模块库，正文范围不调用仅文件名兜底', async () => {
  setContentBodyIndexEnabledForTests(true);
  let localCalls = 0;
  const primary: SearchBackend = {
    async search() {
      return { hits: Array.from({ length: 50 }, (_, i) => nameHit(i)), truncated: true };
    },
  };
  const modules: SearchBackend = {
    async search() {
      return { hits: [contentHit()], truncated: false };
    },
  };
  const local: SearchBackend = {
    async search() {
      localCalls += 1;
      return { hits: [nameHit(99)], truncated: false };
    },
  };
  const search = new HybridSearch(primary, new HybridSearch(modules, local, false));
  try {
    const result = await search.search('戊己', { scope: 'content', limit: 50 });
    expect(result.hits.map((h) => h.resourceId)).toEqual(['body']);
    expect(result.hits[0]?.matchKind).toBe('content');
    expect(localCalls).toBe(0);
  } finally {
    setContentBodyIndexEnabledForTests(undefined);
  }
});

it('默认范围仍在主结果有文件名时直接返回，不传 scope', async () => {
  setContentBodyIndexEnabledForTests(true);
  const calls: unknown[] = [];
  let fallbackCalls = 0;
  const search = new KbSearch((_db, q, o) => {
    calls.push([q, o]);
    return { hits: [nameHit(0), nameHit(1), nameHit(2)], truncated: false };
  }, 'DB');
  const hybrid = new HybridSearch(search, {
    async search() {
      fallbackCalls += 1;
      return { hits: [], truncated: false };
    },
  });
  try {
    const result = await hybrid.search('关键词', { limit: 2, rootIds: ['R'] });
    expect(calls[0]).toEqual(['关键词', { limit: 2, rootIds: ['R'] }]);
    expect(result.hits.map((h) => h.resourceId)).toEqual(['n0', 'n1']);
    expect(fallbackCalls).toBe(0);
  } finally {
    setContentBodyIndexEnabledForTests(undefined);
  }
});

it('正文索引不可用时返回降级提示，不给出文件名', async () => {
  const { svc } = await makeService();
  try {
    const dir = tmpDir('content-search-');
    write(path.join(dir, 'a.md'), 'hello');
    const root = svc.addRoot(dir);
    await svc.scanRoot(root.id);
    const local = new LocalSearch(svc);
    const names = await local.search('a', { limit: 10 });
    expect(names.hits[0]).toMatchObject({ relPath: 'a.md', matchKind: 'name' });
    const content = await local.search('a', { scope: 'content' });
    expect(content.hits).toEqual([]);
    expect(content.degraded).toBe(true);
    expect(content.notice).toBe(CONTENT_SEARCH_UNAVAILABLE_NOTICE);
    const wrapped = await new DegradedSearch(local).search('a', { scope: 'content' });
    expect(wrapped.hits).toEqual([]);
    expect(wrapped.degraded).toBe(true);
    expect(wrapped.notice).toBe(CONTENT_SEARCH_UNAVAILABLE_NOTICE);
  } finally {
    await svc.close();
  }
});
