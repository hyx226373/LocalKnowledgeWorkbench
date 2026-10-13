import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  closeIndexer,
  compactTextIndexUntilWritable,
  ftsSegmentCount,
  startIndex,
  suspendFtsMerge,
} from '../src/index.ts';
import { migrate } from '../src/migrate.ts';
import { openDatabase } from '../src/sqlite.ts';
import { IndexStore } from '../src/store.ts';
import type { SqliteDb } from '../src/types.ts';

const tmp = mkdtempSync(path.join(tmpdir(), 'kb-fts-seg-'));

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 测试进程退出时再清
  }
}

function ftsOption(db: SqliteDb, table: 'fts_content' | 'fts_short', key: string): number | null {
  const row = db.prepare(`SELECT v AS v FROM ${table}_config WHERE k = ?`).get(key) as
    | { v: number | bigint }
    | undefined;
  if (!row) return null;
  return Number(row.v);
}

function expectMergeRestored(db: SqliteDb): void {
  expect(ftsOption(db, 'fts_content', 'automerge')).toBe(8);
  expect(ftsOption(db, 'fts_short', 'automerge')).toBe(8);
  expect(ftsOption(db, 'fts_content', 'crisismerge')).toBe(16);
  expect(ftsOption(db, 'fts_short', 'crisismerge')).toBe(16);
}

afterAll(async () => {
  try {
    await closeIndexer();
  } catch {
    // 没起过 worker
  }
  removeDir(tmp);
});

describe('fts segments', () => {
  it('空库段数是 0，automerge=0 时单行写入一段', () => {
    const db = openDatabase(path.join(tmp, 'count.sqlite'));
    try {
      migrate(db);
      expect(ftsSegmentCount(db, 'fts_content')).toBe(0);
      expect(ftsSegmentCount(db, 'fts_short')).toBe(0);
      suspendFtsMerge(db);
      const store = new IndexStore(db);
      store.upsertRoot('root-seg', tmp);
      for (let i = 0; i < 5; i += 1) {
        store.write(
          {
            resourceId: `seg-${i}`,
            rootId: 'root-seg',
            relPath: `n-${i}.txt`,
            size: 4,
            mtimeMs: 1,
            pages: [{ page: 0, title: `n-${i}.txt`, body: `正文${i}`, lineStart: 1 }],
          },
          undefined,
          'batch-seg',
        );
      }
      expect(ftsSegmentCount(db, 'fts_content')).toBe(5);
      expect(ftsSegmentCount(db, 'fts_short')).toBe(5);
    } finally {
      db.close();
    }
  });

  it('compactTextIndexUntilWritable 返回段数和步数', () => {
    const db = openDatabase(path.join(tmp, 'shape.sqlite'));
    try {
      migrate(db);
      const result = compactTextIndexUntilWritable(db, 4);
      expect(result.ok).toBe(true);
      expect(result.steps).toBe(0);
      expect(result.before).toEqual({
        fts_content: expect.any(Number),
        fts_short: expect.any(Number),
      });
      expect(result.after).toEqual({
        fts_content: expect.any(Number),
        fts_short: expect.any(Number),
      });
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(Object.keys(result).sort()).toEqual(['after', 'before', 'elapsedMs', 'ok', 'steps']);
    } finally {
      db.close();
    }
  });

  it('扫描取消后 automerge 恢复为 8', async () => {
    const dir = path.join(tmp, 'cancel-root');
    const dbPath = path.join(tmp, 'cancel.sqlite');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 80; i += 1) {
      writeFileSync(path.join(dir, `note-${i}.txt`), `取消正文 ${i} 标记甲\n`, 'utf8');
    }
    const setup = openDatabase(dbPath);
    migrate(setup);
    setup.exec('CREATE TABLE user_notes (id INTEGER)');
    setup.close();
    const rootId = `cancel-${randomUUID()}`;
    const ids = new Map<string, string>();
    const job = startIndex({
      rootId,
      localPath: dir,
      dbPath,
      mode: 'full',
      resolveResourceId(_root, relPath) {
        const key = relPath.replace(/\\/g, '/').toLowerCase();
        let id = ids.get(key);
        if (!id) {
          id = randomUUID();
          ids.set(key, id);
        }
        return id;
      },
    });
    job.onProgress((progress) => {
      if (progress.processed >= 2) job.cancel();
    });
    const result = await job.done;
    expect(result.status).toBe('cancelled');
    const db = openDatabase(dbPath);
    try {
      expectMergeRestored(db);
    } finally {
      db.close();
    }
  });

  it('扫描抛错后 automerge 恢复为 8', async () => {
    const dir = path.join(tmp, 'boom-root');
    const dbPath = path.join(tmp, 'boom.sqlite');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'one.txt'), '抛错正文\n', 'utf8');
    const setup = openDatabase(dbPath);
    migrate(setup);
    setup.exec(`
      CREATE TRIGGER idx_roots_boom BEFORE INSERT ON indexer_roots
      BEGIN
        SELECT RAISE(ABORT, 'scan-boom');
      END;
    `);
    setup.close();
    const job = startIndex({
      rootId: 'root-boom',
      localPath: dir,
      dbPath,
      mode: 'full',
      resolveResourceId() {
        return 'res-boom';
      },
    });
    await expect(job.done).rejects.toThrow(/scan-boom/);
    const db = openDatabase(dbPath);
    try {
      expectMergeRestored(db);
    } finally {
      db.close();
    }
  });

  const fullDb = process.env.KB_FTS_FULL_DB;
  it.skipIf(!fullDb)('满段库两表段数至少 1900', () => {
    const db = openDatabase(fullDb!);
    try {
      expect(ftsSegmentCount(db, 'fts_content')).toBeGreaterThanOrEqual(1900);
      expect(ftsSegmentCount(db, 'fts_short')).toBeGreaterThanOrEqual(1900);
    } finally {
      db.close();
    }
  });
});
