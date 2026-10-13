import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const nodeRequire = createRequire(import.meta.url);
import { makeService, tmpDir, write } from './helpers';
import { CONTENT_INDEX_FULL_NOTICE, getIndexHealth, setIndexHealth } from '../src/main/backend/indexHealth';
import {
  LIVE_INDEX_RETRY,
  LiveContentIndex,
  liveIndexRetryDelay,
  resetLiveIndexCompactForTests,
  type CompactTextIndexFn,
} from '../src/main/backend/liveContent';
import { classifyLiveIndexError } from '../src/main/backend/liveIndexError';
import type { WorkbenchService } from '../src/main/service/WorkbenchService';

const FULL_DB = process.env.KB_FTS_FULL_DB;
if (!FULL_DB) process.stdout.write('SKIP_FTS_FULL_DB\n');

function sqliteError(message: string, code?: string) {
  const error = new Error(message);
  if (code !== undefined) (error as { code?: string }).code = code;
  return error;
}

describe('classifyLiveIndexError', () => {
  it('只认 code，不认消息文字', () => {
    expect(classifyLiveIndexError(sqliteError('database or disk is full'))).toBe('other');
    expect(classifyLiveIndexError(sqliteError('database is locked'))).toBe('other');
    expect(classifyLiveIndexError(sqliteError('SQLITE_BUSY SQLITE_FULL'))).toBe('other');
    expect(classifyLiveIndexError(sqliteError('ignored', 'SQLITE_LOCKED'))).toBe('locked');
    expect(classifyLiveIndexError(sqliteError('ignored', 'SQLITE_LOCKED_SHAREDCACHE'))).toBe('locked');
    expect(classifyLiveIndexError(sqliteError('database or disk is full', 'SQLITE_BUSY'))).toBe('busy');
    expect(classifyLiveIndexError(sqliteError('ignored', 'SQLITE_BUSY_TIMEOUT'))).toBe('busy');
    expect(classifyLiveIndexError(sqliteError('not full', 'SQLITE_FULL'))).toBe('full');
    expect(classifyLiveIndexError(sqliteError('x', 'SQLITE_IOERR'))).toBe('other');
    expect(classifyLiveIndexError(Object.assign(new Error('full'), { code: 13 }))).toBe('other');
    expect(classifyLiveIndexError(null)).toBe('other');
    expect(classifyLiveIndexError(undefined)).toBe('other');
    expect(classifyLiveIndexError('SQLITE_FULL')).toBe('other');
  });

  it('等待按已失败次数指数增长，并且有上限', () => {
    expect(LIVE_INDEX_RETRY).toEqual({ baseMs: 200, capMs: 30_000, maxAttempts: 8 });
    expect(liveIndexRetryDelay(1)).toBe(200);
    expect(liveIndexRetryDelay(2)).toBe(400);
    expect(liveIndexRetryDelay(3)).toBe(800);
    expect(liveIndexRetryDelay(4)).toBe(1600);
    expect(liveIndexRetryDelay(7)).toBe(12800);
    expect(liveIndexRetryDelay(8)).toBe(25600);
    expect(liveIndexRetryDelay(20)).toBe(30_000);
  });
});

type LiveBox = {
  svc: WorkbenchService;
  rootId: string;
  rel: string;
  closeIndexer: () => Promise<void>;
};

type Opened = {
  live: LiveContentIndex;
  svc: WorkbenchService;
  closeIndexer: () => Promise<void>;
};

async function setup(name = 'a.md'): Promise<LiveBox> {
  const indexer = await import('@kb/indexer');
  const { svc } = await makeService();
  const dir = tmpDir('live-retry-');
  write(path.join(dir, name), '正文');
  const root = svc.addRoot(dir);
  await svc.scanRoot(root.id);
  indexer.migrate(svc.db);
  return {
    svc,
    rootId: root.id,
    rel: name,
    closeIndexer: () => indexer.closeIndexer(),
  };
}

const open: Opened[] = [];

beforeEach(() => {
  resetLiveIndexCompactForTests();
  setIndexHealth({
    engine: 'kb-indexer',
    contentSearch: true,
    scannedFiles: 1,
    contentIndexedFiles: 0,
    since: 1,
    reason: undefined,
    contentIndexNotice: undefined,
  });
});

afterEach(async () => {
  vi.useRealTimers();
  resetLiveIndexCompactForTests();
  const boxes = open.splice(0);
  for (const box of boxes) {
    try { await box.live.close(); } catch { /* 收尾失败不影响下一个 */ }
  }
  for (const closeIndexer of new Set(boxes.map((box) => box.closeIndexer))) {
    try { await closeIndexer(); } catch { /* 已经关过 */ }
  }
  for (const svc of new Set(boxes.map((box) => box.svc))) {
    try { await svc.close(); } catch { /* 已经关过 */ }
  }
  setIndexHealth({ contentIndexNotice: undefined, contentSearch: false, engine: 'starting', contentIndexFailed: [] });
});

function useLive(box: LiveBox, index: () => Promise<void> | void, compact?: CompactTextIndexFn, debounceMs = 20) {
  const live = new LiveContentIndex(box.svc, box.svc.db, index as never, (() => undefined) as never, debounceMs, compact);
  open.push({ live, svc: box.svc, closeIndexer: box.closeIndexer });
  return live;
}

async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('LiveContentIndex 重试', () => {
  it('locked 和 busy 同一条路径最多 8 次，第 1 次失败后等 200ms', async () => {
    const box = await setup();
    const times: number[] = [];
    const live = useLive(box, async () => {
      times.push(Date.now());
      throw sqliteError('not a lock message', times.length % 2 === 0 ? 'SQLITE_BUSY' : 'SQLITE_LOCKED_SHAREDCACHE');
    }, undefined, 20);
    live.enqueue([{ rootId: box.rootId, relPath: box.rel, type: 'change' }]);
    await live.flush();
    expect(times).toHaveLength(1);
    const start = Date.now();
    while (times.length < LIVE_INDEX_RETRY.maxAttempts && Date.now() - start < 40_000) await wait(30);
    expect(times).toHaveLength(8);
    for (let i = 1; i < times.length; i += 1) {
      const gap = times[i] - times[i - 1];
      const expected = liveIndexRetryDelay(i);
      expect(gap).toBeGreaterThanOrEqual(expected - 50);
      expect(gap).toBeLessThan(expected + 1000);
    }
    await wait(350);
    expect(times).toHaveLength(8);
    expect(getIndexHealth().contentIndexFailed).toEqual([
      { rootId: box.rootId, relPath: box.rel, kind: 'busy' },
    ]);
  }, 45_000);

  it('没有 code 或其它 code 不重试，也不压实', async () => {
    const box = await setup();
    let calls = 0;
    let compacts = 0;
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args); });
    const live = useLive(box, async () => {
      calls += 1;
      throw sqliteError('database is locked SQLITE_FULL');
    }, async () => {
      compacts += 1;
      return { ok: true, steps: 1 };
    });
    live.enqueue([{ rootId: box.rootId, relPath: box.rel, type: 'change' }]);
    await live.flush();
    await wait(350);
    expect(calls).toBe(1);
    expect(compacts).toBe(0);
    expect(getIndexHealth().contentIndexNotice).toBeUndefined();
    expect(getIndexHealth().contentSearch).toBe(true);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('SQLITE_FULL 整个进程只压实一次；成功后每条路径再索引一次，仍满就停', async () => {
    const box = await setup();
    write(path.join(box.svc.listRoots()[0].path, 'b.md'), '乙');
    await box.svc.scanRoot(box.rootId);
    let calls = 0;
    let compacts = 0;
    const live = useLive(box, async () => {
      calls += 1;
      throw sqliteError('no message match', 'SQLITE_FULL');
    }, async () => {
      compacts += 1;
      return { ok: true, steps: 4 };
    });
    live.enqueue([
      { rootId: box.rootId, relPath: box.rel, type: 'change' },
      { rootId: box.rootId, relPath: 'b.md', type: 'change' },
    ]);
    await live.flush();
    await wait(80);
    expect(compacts).toBe(1);
    expect(calls).toBe(4);
    await wait(400);
    expect(compacts).toBe(1);
    expect(calls).toBe(4);
    expect(getIndexHealth().contentIndexNotice).toBe(CONTENT_INDEX_FULL_NOTICE);
    expect(getIndexHealth().contentSearch).toBe(true);
    expect(getIndexHealth().engine).toBe('kb-indexer');

    const box2 = await setup('c.md');
    let calls2 = 0;
    let compacts2 = 0;
    const live2 = useLive(box2, async () => {
      calls2 += 1;
      throw sqliteError('still full', 'SQLITE_FULL');
    }, async () => {
      compacts2 += 1;
      return { ok: true, steps: 9 };
    });
    live2.enqueue([{ rootId: box2.rootId, relPath: 'c.md', type: 'change' }]);
    await live2.flush();
    await wait(80);
    expect(compacts2).toBe(0);
    expect(calls2).toBe(2);
    expect(compacts).toBe(1);
  });

  it('压实返回 ok false 或抛错就停止，不再按 200ms 重试', async () => {
    const box = await setup();
    let calls = 0;
    let compacts = 0;
    const live = useLive(box, async () => {
      calls += 1;
      throw sqliteError('disk full text', 'SQLITE_FULL');
    }, async () => {
      compacts += 1;
      return { ok: false, steps: 2 };
    });
    live.enqueue([{ rootId: box.rootId, relPath: box.rel, type: 'change' }]);
    await live.flush();
    await wait(400);
    expect(calls).toBe(1);
    expect(compacts).toBe(1);
    expect(getIndexHealth().contentIndexNotice).toBe('全文索引空间已满，已尝试压实');
    expect(getIndexHealth().contentSearch).toBe(true);
    live.replayFailures();
    await live.flush();
    expect(calls).toBe(2);
    await wait(400);
    expect(calls).toBe(2);
    expect(compacts).toBe(1);
  });

  it('压实函数抛错视作失败', async () => {
    const box = await setup();
    let calls = 0;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const live = useLive(box, async () => {
      calls += 1;
      throw sqliteError('x', 'SQLITE_FULL');
    }, async () => {
      throw sqliteError('compact broke', 'SQLITE_FULL');
    });
    live.enqueue([{ rootId: box.rootId, relPath: box.rel, type: 'change' }]);
    await live.flush();
    await wait(80);
    expect(calls).toBe(1);
    expect(getIndexHealth().contentIndexNotice).toBe(CONTENT_INDEX_FULL_NOTICE);
    expect(getIndexHealth().contentSearch).toBe(true);
    spy.mockRestore();
  });

  it('手动重建结束和 replayFailures 把失败路径放回队列，成功后清掉提示', async () => {
    const box = await setup();
    let fail = true;
    let calls = 0;
    const live = useLive(box, async () => {
      calls += 1;
      if (fail) throw sqliteError('busy text', 'SQLITE_BUSY_TIMEOUT');
    });
    live.enqueue([{ rootId: box.rootId, relPath: box.rel, type: 'change' }]);
    await live.flush();
    expect(calls).toBe(1);
    const started = Date.now();
    live.track(Promise.resolve());
    await wait(80);
    expect(calls).toBe(2);
    expect(Date.now() - started).toBeLessThan(180);
    fail = false;
    live.replayFailures();
    await wait(80);
    expect(calls).toBe(3);
    fail = true;
    resetLiveIndexCompactForTests();
    let compacts = 0;
    const full = useLive(box, async () => {
      calls += 1;
      if (fail) throw sqliteError('x', 'SQLITE_FULL');
    }, async () => {
      compacts += 1;
      return { ok: false, steps: 0 };
    });
    full.enqueue([{ rootId: box.rootId, relPath: box.rel, type: 'change' }]);
    await full.flush();
    await wait(50);
    expect(compacts).toBe(1);
    expect(getIndexHealth().contentIndexNotice).toBe(CONTENT_INDEX_FULL_NOTICE);
    fail = false;
    full.track(Promise.resolve());
    await wait(80);
    expect(getIndexHealth().contentIndexNotice).toBeUndefined();
    expect(getIndexHealth().contentSearch).toBe(true);
  });

  it('四个参数的构造函数仍能索引', async () => {
    const box = await setup();
    let calls = 0;
    const live = new LiveContentIndex(box.svc, box.svc.db, (async () => { calls += 1; }) as never, (() => undefined) as never);
    open.push({ live, svc: box.svc, closeIndexer: box.closeIndexer });
    live.enqueue([{ rootId: box.rootId, relPath: box.rel, type: 'change' }]);
    await live.flush();
    expect(calls).toBe(1);
  });
});

it.skipIf(!FULL_DB)('满段库能抛出 SQLITE_FULL，并按 code 归类', () => {
  const src = FULL_DB as string;
  expect(fs.existsSync(src)).toBe(true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-fts-full-'));
  const dest = path.join(dir, 'full.db');
  fs.copyFileSync(src, dest);
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(src + ext)) fs.copyFileSync(src + ext, dest + ext);
  }
  const Database = nodeRequire('better-sqlite3') as typeof import('better-sqlite3');
  const db = new Database(dest);
  try {
    const pages = Number(db.pragma('page_count', { simple: true }));
    expect(pages).toBeGreaterThan(0);
    db.pragma(`max_page_count = ${pages}`);
    db.exec('CREATE TABLE IF NOT EXISTS kb_full_probe(x BLOB)');
    let caught: unknown;
    for (let i = 0; i < 5000 && !caught; i += 1) {
      try {
        db.prepare('INSERT INTO kb_full_probe(x) VALUES (?)').run(Buffer.alloc(64 * 1024, i % 255));
      } catch (error) {
        caught = error;
      }
    }
    if (!caught) throw new Error('KB_FTS_FULL_DB 在页数封顶后仍能写入，不能把这条记成通过');
    expect((caught as { code?: string }).code).toBe('SQLITE_FULL');
    expect(classifyLiveIndexError(caught)).toBe('full');
    expect(classifyLiveIndexError(new Error(String((caught as Error).message)))).toBe('other');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('wire 只在装配处传入压实函数，主进程入口不新增索引 import', () => {
  const wire = fs.readFileSync(path.join(process.cwd(), 'src/main/backend/wire.ts'), 'utf8');
  expect(wire).toContain('compactTextIndexUntilWritable');
  expect(wire).toContain('{ ok: false, steps: 0 }');
  expect(wire).toContain('compactLive');
  const main = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  expect(main).not.toContain('liveContent');
  expect(main).not.toContain('@kb/indexer');
  expect(main).not.toContain('better-sqlite3');
});
