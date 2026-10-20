import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { makeService, tmpDir, write } from './helpers';
import { readerTypeOf } from '../src/shared/types';
import { LiveContentIndex } from '../src/main/backend/liveContent';
import { ensureWorkbenchContentIndex } from '../src/main/backend/kbStack';
import {
  CONTENT_INDEX_SCOPE_KEY,
  DEFAULT_CONTENT_INDEX_MAX_BYTES,
  decideContentIndex,
  defaultContentIndexScope,
  normalizeFolderPrefix,
  parseContentIndexScope,
  truncatedIndexBytes,
} from '../src/shared/contentIndexScope';

vi.mock('../src/renderer/kb', () => ({ kb: { getLayout: async () => null, setLayout: async () => undefined } }));
import { ContentIndexScopeSection } from '../src/renderer/settings/ContentIndexScopeSection';

const TEXT_EXT = ['txt', 'log', 'json', 'csv', 'tsv', 'xml', 'yaml', 'yml', 'ini', 'toml', 'js', 'ts', 'tsx', 'jsx', 'py', 'java', 'c', 'h', 'cpp', 'cs', 'go', 'rs', 'sh', 'ps1', 'bat', 'css', 'html', 'htm', 'sql', 'tex'];
const MD_EXT = ['md', 'markdown'];

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

it('默认只索引文字类扩展名，pdf / xlsx / docx 需勾选', () => {
  const scope = defaultContentIndexScope();
  for (const ext of MD_EXT) {
    expect(readerTypeOf(ext, 'file')).toBe('markdown');
    expect(decideContentIndex(`笔记/a.${ext}`, scope).index).toBe(true);
  }
  for (const ext of TEXT_EXT) {
    expect(readerTypeOf(ext, 'file')).toBe('text');
    expect(decideContentIndex(`笔记/a.${ext}`, scope).index).toBe(true);
  }
  expect(decideContentIndex('资料/论文.PDF', scope)).toMatchObject({ index: false, reason: 'extension' });
  expect(decideContentIndex('资料/表.xlsx', scope).index).toBe(false);
  expect(decideContentIndex('资料/报告.docx', scope).index).toBe(false);
  expect(decideContentIndex('资料/图.png', scope).index).toBe(false);
  const withPdf = parseContentIndexScope({ v: 1, extraExtensions: ['pdf', 'xlsx', 'docx', 'png'] });
  expect(withPdf.extraExtensions).toEqual(['pdf', 'xlsx', 'docx']);
  expect(decideContentIndex('资料/论文.pdf', withPdf).index).toBe(true);
  expect(decideContentIndex('资料/表.XLSX', withPdf).index).toBe(true);
  expect(decideContentIndex('资料/报告.docx', withPdf).index).toBe(true);
  expect(decideContentIndex('资料/图.png', withPdf).index).toBe(false);
});

it('单文件只取前 N 字节，默认 1 MiB，超限仍索引', () => {
  const scope = defaultContentIndexScope();
  expect(scope.maxBytes).toBe(DEFAULT_CONTENT_INDEX_MAX_BYTES);
  expect(DEFAULT_CONTENT_INDEX_MAX_BYTES).toBe(1024 * 1024);
  const big = decideContentIndex('a.md', scope, 2 * 1024 * 1024);
  expect(big).toMatchObject({ index: true, bytes: 1024 * 1024 });
  expect(truncatedIndexBytes(100, scope.maxBytes)).toBe(100);
  const custom = parseContentIndexScope({ v: 1, maxBytes: 4096 });
  expect(decideContentIndex('a.txt', custom, 100_000)).toMatchObject({ index: true, bytes: 4096 });
  expect(parseContentIndexScope({ v: 1, maxBytes: 0 }).maxBytes).toBe(DEFAULT_CONTENT_INDEX_MAX_BYTES);
  expect(parseContentIndexScope({ v: 1, maxBytes: 'nope' }).maxBytes).toBe(DEFAULT_CONTENT_INDEX_MAX_BYTES);
  expect(parseContentIndexScope({ v: 2, maxBytes: 10, extraExtensions: ['pdf'] })).toEqual(defaultContentIndexScope());
});

it('文件夹按根内相对路径前缀包含和排除，排除优先', () => {
  expect(normalizeFolderPrefix('C:\\notes')).toBeNull();
  expect(normalizeFolderPrefix('/home/amy/notes')).toBeNull();
  expect(normalizeFolderPrefix('../secret')).toBeNull();
  expect(normalizeFolderPrefix('docs/2024/')).toBe('docs/2024');
  const scope = parseContentIndexScope({
    v: 1,
    includePrefixes: ['docs', 'docs'],
    excludePrefixes: ['docs/secret', 'C:/Windows', 'docs/secret'],
  });
  expect(scope.includePrefixes).toEqual(['docs']);
  expect(scope.excludePrefixes).toEqual(['docs/secret']);
  expect(decideContentIndex('docs/a.md', scope).index).toBe(true);
  expect(decideContentIndex('Docs/子/B.TXT', scope).index).toBe(true);
  expect(decideContentIndex('docs/secret/a.md', scope)).toMatchObject({ index: false, reason: 'excluded' });
  expect(decideContentIndex('docs/secret-plan/a.md', scope).index).toBe(true);
  expect(decideContentIndex('other/a.md', scope)).toMatchObject({ index: false, reason: 'not-included' });
  expect(decideContentIndex('docs-old/a.md', scope).index).toBe(false);
  const excludeOnly = parseContentIndexScope({ v: 1, excludePrefixes: ['skip'] });
  expect(decideContentIndex('skip/no.md', excludeOnly).index).toBe(false);
  expect(decideContentIndex('skip-extra/a.md', excludeOnly).index).toBe(true);
  expect(decideContentIndex('keep.md', excludeOnly).index).toBe(true);
});

it('startIndex 透传可序列化 contentScope，缺省用文字范围和 1 MiB', () => {
  const seen: Array<Record<string, unknown>> = [];
  const start = (opts: Record<string, unknown>) => {
    seen.push(opts);
    return { done: Promise.resolve(undefined) } as never;
  };
  ensureWorkbenchContentIndex(
    { migrateIndexer: () => undefined, startIndex: start as never },
    {} as never,
    'db',
    'R',
    '/tmp/root',
    () => 'id',
  );
  const defaults = seen[0] as { mode: string; contentScope: { maxBytes: number; includeExts: string[] } };
  expect(defaults.mode).toBe('incremental');
  expect(defaults.contentScope.maxBytes).toBe(DEFAULT_CONTENT_INDEX_MAX_BYTES);
  expect(defaults.contentScope.includeExts).toContain('md');
  expect(defaults.contentScope.includeExts).not.toContain('pdf');
  expect(JSON.parse(JSON.stringify(defaults.contentScope))).toEqual(defaults.contentScope);
  expect(seen[0]).not.toHaveProperty('shouldIndex');

  const scope = parseContentIndexScope({
    v: 1,
    extraExtensions: ['pdf'],
    maxBytes: 2048,
    includePrefixes: ['docs'],
    excludePrefixes: ['docs/secret'],
  });
  ensureWorkbenchContentIndex(
    { migrateIndexer: () => undefined, startIndex: start as never },
    {} as never,
    'db',
    'R',
    '/tmp/root',
    () => 'id',
    undefined,
    scope,
  );
  expect(seen[1].contentScope).toMatchObject({
    maxBytes: 2048, includePrefixes: ['docs'], excludePrefixes: ['docs/secret'],
  });
  expect((seen[1].contentScope as { includeExts: string[] }).includeExts).toContain('pdf');
});

it('实时索引传范围，范围外保留文件名记录而不调用 removeOne', async () => {
  const { svc } = await makeService();
  const dir = tmpDir('index-scope-live-');
  write(path.join(dir, 'keep.md'), 'keep');
  write(path.join(dir, 'note.markdown'), 'md');
  write(path.join(dir, 'readme.txt'), 'txt');
  write(path.join(dir, 'code.ts'), 'export {}');
  write(path.join(dir, 'skip', 'no.md'), 'no');
  write(path.join(dir, 'doc.pdf'), '%PDF');
  write(path.join(dir, 'sheet.xlsx'), 'PK');
  const root = svc.addRoot(dir);
  await svc.scanRoot(root.id);
  svc.db.exec(`CREATE TABLE indexer_files (
    resource_id TEXT PRIMARY KEY,
    root_id TEXT,
    rel_path TEXT,
    size INTEGER,
    mtime_ms REAL
  )`);
  const files = svc.db.prepare(`SELECT id, rel_path FROM resources WHERE root_id=? AND kind='file'`).all(root.id) as Array<{ id: string; rel_path: string }>;
  const byRel = new Map(files.map((row) => [row.rel_path, row.id]));
  for (const rel of ['skip/no.md', 'doc.pdf', 'sheet.xlsx']) {
    const id = byRel.get(rel);
    expect(id).toBeTruthy();
    svc.db.prepare('INSERT INTO indexer_files (resource_id, root_id, rel_path, size, mtime_ms) VALUES (?,?,?,?,?)').run(id, root.id, rel, 4, 1);
  }
  svc.setLayout(CONTENT_INDEX_SCOPE_KEY, { v: 1, extraExtensions: [], maxBytes: 4096, includePrefixes: [], excludePrefixes: ['skip'] });
  const indexed: string[] = [];
  const removed: string[] = [];
  const live = new LiveContentIndex(
    svc,
    svc.db,
    (async (_db: unknown, _id: unknown, opts: { lookupPath: () => { relPath: string }; maxBytes?: number }) => {
      expect(opts.maxBytes).toBe(4096);
      indexed.push(opts.lookupPath().relPath);
    }) as never,
    ((_db: unknown, id: string) => { removed.push(id); }) as never,
    10,
  );
  cleanups.push(async () => { await live.close(); await svc.close(); });
  live.enqueue(files.map((row) => ({ rootId: root.id, relPath: row.rel_path, type: 'change' })));
  await live.flush();
  expect(indexed.slice().sort()).toEqual(files.map((row) => row.rel_path).sort());
  expect(removed).toEqual([]);
});

it('设置页有全文索引范围一节，类型开关与现有开关一致', () => {
  const html = renderToStaticMarkup(React.createElement(ContentIndexScopeSection));
  expect(html).toContain('全文索引范围');
  expect(html).toContain('data-testid="settings-index-ext-pdf"');
  expect(html).not.toContain('data-testid="settings-index-ext-xlsx"');
  expect(html).not.toContain('data-testid="settings-index-ext-docx"');
  expect(html).toContain('aria-checked="false"');
  expect(html).toContain('value="1048576"');
  expect(html).toContain('data-testid="settings-index-include"');
  expect(html).toContain('data-testid="settings-index-exclude"');
  expect(html).toContain('kb-preview-switch');
});

it('加入和移出 Agent 区域时即使文件大小时间未变也改写 scope，保留文件名', async () => {
  const { setContentArea } = await import('../src/main/backend/contentScope');
  const { svc } = await makeService();
  const dir = tmpDir('index-membership-');
  write(path.join(dir, 'large.txt'), 'x'.repeat(2 * 1024 * 1024));
  const root = svc.addRoot(dir);
  await svc.scanRoot(root.id);
  svc.db.exec('CREATE TABLE indexer_files (resource_id TEXT PRIMARY KEY, root_id TEXT, rel_path TEXT, size INTEGER, mtime_ms REAL)');
  const row = svc.db.prepare("SELECT id FROM resources WHERE root_id=? AND kind='file'").get(root.id) as { id: string };
  const seen: Array<{ includeRelPaths?: string[]; maxBytes: number }> = [];
  const live = new LiveContentIndex(svc, svc.db, (async (_db, _id, opts) => {
    seen.push(opts!.contentScope!);
    return { resourceId: row.id, relPath: 'large.txt', pageCount: 1 };
  }), (() => { throw new Error('scope removal must retain the filename'); }), 10);
  cleanups.push(async () => { await live.close(); await svc.close(); });
  await live.flush();
  expect(seen.at(-1)?.includeRelPaths).toEqual([]);
  seen.length = 0;
  setContentArea(svc, 'agent-materials', { resourceIds: [row.id] });
  live.dropOutOfScope();
  await live.flush();
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ includeRelPaths: ['large.txt'], maxBytes: 1024 * 1024 });
  seen.length = 0;
  setContentArea(svc, 'agent-materials', {});
  live.dropOutOfScope();
  await live.flush();
  expect(seen).toHaveLength(1);
  expect(seen[0].includeRelPaths).toEqual([]);
});
