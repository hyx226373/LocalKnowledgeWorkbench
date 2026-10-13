import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import { getIndexHealth, setIndexHealth, formatIndexStatusLabel, FALLBACK_BANNER, CONTENT_INDEX_FULL_NOTICE } from '../src/main/backend/indexHealth';

describe('IndexHealth', () => {
  beforeEach(() => {
    setIndexHealth({
      engine: 'starting',
      contentSearch: false,
      scannedFiles: 0,
      contentIndexedFiles: 0,
      since: Date.now(),
      reason: undefined,
      contentIndexNotice: undefined,
    });
  });

  it('fallback 文案含「仅文件名/路径搜索」且不说已索引正文', () => {
    setIndexHealth({ engine: 'local-fallback', contentSearch: false, reason: 'fork failed', scannedFiles: 8 });
    const h = getIndexHealth();
    expect(h.engine).toBe('local-fallback');
    expect(FALLBACK_BANNER).toMatch(/仅文件名\/路径搜索/);
    const label = formatIndexStatusLabel({
      rootName: '第 1 章',
      state: 'idle',
      progress: 0,
      scannedFiles: 8,
      contentIndexedFiles: 0,
      health: h,
      lastError: null,
      watching: true,
    });
    expect(label).toMatch(/仅文件名\/路径搜索/);
    expect(label).toMatch(/已扫描 8/);
    expect(label).not.toMatch(/^第 1 章：已索引/);
  });

  it('kb-indexer 时分开显示扫描量与正文量', () => {
    setIndexHealth({ engine: 'kb-indexer', contentSearch: true, scannedFiles: 10, contentIndexedFiles: 7 });
    const label = formatIndexStatusLabel({
      rootName: '笔记',
      state: 'idle',
      progress: 0,
      scannedFiles: 10,
      contentIndexedFiles: 7,
      health: getIndexHealth(),
      lastError: null,
      watching: false,
    });
    expect(label).toBe('笔记：已扫描 10 个文件 · 正文索引 7 个');
  });
});

it('空间满提示不改 contentSearch，也不换掉降级文案', () => {
  expect(CONTENT_INDEX_FULL_NOTICE).toBe('全文索引空间已满，已尝试压实');
  setIndexHealth({
    engine: 'kb-indexer',
    contentSearch: true,
    scannedFiles: 4,
    contentIndexedFiles: 3,
    contentIndexNotice: CONTENT_INDEX_FULL_NOTICE,
  });
  const h = getIndexHealth();
  expect(h.contentSearch).toBe(true);
  expect(h.engine).toBe('kb-indexer');
  expect(h.contentIndexNotice).toBe('全文索引空间已满，已尝试压实');
  const label = formatIndexStatusLabel({
    rootName: '笔记',
    state: 'idle',
    progress: 0,
    scannedFiles: 4,
    contentIndexedFiles: 3,
    health: h,
    lastError: null,
    watching: true,
  });
  expect(label).toBe('笔记：已扫描 4 个文件 · 正文索引 3 个');
  expect(FALLBACK_BANNER).toBe('全文索引不可用 · 仅文件名/路径搜索');
  const app = fs.readFileSync(path.join(process.cwd(), 'src/renderer/App.tsx'), 'utf8');
  expect(app).toContain('data-testid="index-full-notice"');
  expect(app).toContain('全文索引空间已满，已尝试压实');
  expect(app).toContain('全文索引不可用 · 仅文件名/路径搜索');
  const fallbackAt = app.indexOf('data-testid="index-health-fallback"');
  const fullAt = app.indexOf('data-testid="index-full-notice"');
  expect(fallbackAt).toBeGreaterThan(0);
  expect(fullAt).toBeGreaterThan(fallbackAt);
});

// Zero means no body index; it must never inherit the directory file count.
it('keeps zero body rows separate from nonzero scanned files', () => {
  setIndexHealth({ engine: 'kb-indexer', contentSearch: true, contentIndexedFiles: 0 });
  expect(formatIndexStatusLabel({ rootName: 'root', state: 'idle', progress: 0, scannedFiles: 5, contentIndexedFiles: 0, health: getIndexHealth(), lastError: null, watching: true })).toContain('正文索引 0 个');
});
