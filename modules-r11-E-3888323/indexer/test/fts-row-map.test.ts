import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, readTextIndexVersion, TEXT_INDEX_VERSION, tokenizerKind } from '../src/migrate.ts';
import { search } from '../src/search.ts';
import { openDatabase } from '../src/sqlite.ts';
import {
  FTS_CONTENT_DELETE_BY_ROWID_SQL,
  FTS_ROW_MAP_DELETE_SQL,
  FTS_ROW_MAP_SELECT_SQL,
  FTS_SHORT_DELETE_BY_ROWID_SQL,
  IndexStore,
} from '../src/store.ts';
import type { SqliteDb } from '../src/types.ts';

const OLD_CONTENT_SCAN_SQL = 'SELECT rowid FROM fts_content WHERE resource_id = ?';
const OLD_SHORT_SCAN_SQL = 'SELECT rowid FROM fts_short WHERE resource_id = ?';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDb(): SqliteDb {
  const dir = mkdtempSync(path.join(tmpdir(), 'kb-fts-row-map-'));
  dirs.push(dir);
  return openDatabase(path.join(dir, 'index.sqlite'));
}

function planDetails(db: SqliteDb, sql: string): string[] {
  const params = Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => 1);
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>;
  return rows.map((row) => row.detail);
}

/**
 * FTS5 的 EXPLAIN 一律写 SCAN。全表扫描是 `INDEX n:` 收尾；
 * 按 rowid 等值删除是 `INDEX n:=`。禁止的是前者。
 */
function unconstrainedFtsScan(details: string[]): boolean {
  return details.some((detail) => /SCAN fts_(content|short) VIRTUAL TABLE INDEX \d+:\s*$/.test(detail));
}

function meta(db: SqliteDb, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM indexer_meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function ftsSchema(db: SqliteDb): Array<{ name: string; sql: string | null }> {
  return db
    .prepare(
      `SELECT name, sql FROM sqlite_master
       WHERE name IN ('fts_content', 'fts_short')
       ORDER BY name`,
    )
    .all() as Array<{ name: string; sql: string | null }>;
}

function ftsBodies(db: SqliteDb, table: 'fts_content' | 'fts_short'): Array<{ rowid: number; body: string }> {
  return db.prepare(`SELECT rowid, body FROM ${table} ORDER BY rowid`).all() as Array<{
    rowid: number;
    body: string;
  }>;
}

function insertRawFts(db: SqliteDb, resourceId: string, body: string): { contentId: number; shortId: number } {
  if (tokenizerKind(db) === 'bigram') {
    db.prepare(
      `INSERT INTO fts_content (
         resource_id, page, title, body, root_id, title_text, body_text, line_start
       ) VALUES (?, 0, 'old.md', ?, 'root-old', 'old.md', ?, 1)`,
    ).run(resourceId, body, body);
  } else {
    db.prepare(
      `INSERT INTO fts_content (resource_id, page, title, body, root_id, line_start)
       VALUES (?, 0, 'old.md', ?, 'root-old', 1)`,
    ).run(resourceId, body);
  }
  const contentId = Number((db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
  db.prepare(
    `INSERT INTO fts_short (
       resource_id, page, title, body, root_id, title_text, body_text, path_text, line_start
     ) VALUES (?, 0, 'old.md', ?, 'root-old', 'old.md', ?, 'old.md', 1)`,
  ).run(resourceId, body, body);
  const shortId = Number((db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
  return { contentId, shortId };
}

describe('fts 行号映射', () => {
  it('删除路径的查询计划不扫描 fts_content 和 fts_short', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kb-fts-row-map-'));
    dirs.push(dir);
    const db = openDatabase(path.join(dir, 'index.sqlite'));
    try {
      migrate(db);
      const store = new IndexStore(db);
      store.upsertRoot('root-map', dir);
      const lines = Array.from({ length: 45 }, (_, i) => `第${i}行 青岚删除词`).join('\n');
      store.write(
        {
          resourceId: 'res-map',
          rootId: 'root-map',
          relPath: 'note.md',
          size: lines.length,
          mtimeMs: 1,
          pages: [{ page: 0, title: 'note.md', body: lines, lineStart: 1 }],
        },
        undefined,
        'batch-map',
      );

      const contentIds = (db.prepare('SELECT rowid FROM fts_content ORDER BY rowid').all() as Array<{
        rowid: number;
      }>).map((row) => row.rowid);
      const shortIds = (db.prepare('SELECT rowid FROM fts_short ORDER BY rowid').all() as Array<{
        rowid: number;
      }>).map((row) => row.rowid);
      const mappedContent = (
        db.prepare(`${FTS_ROW_MAP_SELECT_SQL} ORDER BY rowid`).all('res-map', 'fts_content') as Array<{
          rowid: number;
        }>
      ).map((row) => row.rowid);
      const mappedShort = (
        db.prepare(`${FTS_ROW_MAP_SELECT_SQL} ORDER BY rowid`).all('res-map', 'fts_short') as Array<{
          rowid: number;
        }>
      ).map((row) => row.rowid);
      expect(contentIds.length).toBeGreaterThan(1);
      expect(mappedContent).toEqual(contentIds);
      expect(mappedShort).toEqual(shortIds);

      const oldContent = planDetails(db, OLD_CONTENT_SCAN_SQL);
      const oldShort = planDetails(db, OLD_SHORT_SCAN_SQL);
      const nextContent = planDetails(db, FTS_CONTENT_DELETE_BY_ROWID_SQL);
      const nextShort = planDetails(db, FTS_SHORT_DELETE_BY_ROWID_SQL);
      const nextMap = planDetails(db, FTS_ROW_MAP_SELECT_SQL);
      const nextMapDelete = planDetails(db, FTS_ROW_MAP_DELETE_SQL);
      console.log(
        `FTS_ROW_MAP_PLANS ${JSON.stringify({
          before: { content: oldContent, short: oldShort },
          after: {
            selectMap: nextMap,
            deleteContent: nextContent,
            deleteShort: nextShort,
            deleteMap: nextMapDelete,
          },
        })}`,
      );
      expect(unconstrainedFtsScan(oldContent), oldContent.join(' | ')).toBe(true);
      expect(unconstrainedFtsScan(oldShort), oldShort.join(' | ')).toBe(true);
      expect(nextContent.join(' | ')).toMatch(/SCAN fts_content VIRTUAL TABLE INDEX 0:=$/);
      expect(nextShort.join(' | ')).toMatch(/SCAN fts_short VIRTUAL TABLE INDEX 0:=$/);
      expect(unconstrainedFtsScan(nextContent), nextContent.join(' | ')).toBe(false);
      expect(unconstrainedFtsScan(nextShort), nextShort.join(' | ')).toBe(false);
      expect(nextMap.join(' | ')).toContain('idx_indexer_fts_rows_resource');
      expect(nextMap.join(' | ')).not.toMatch(/fts_content|fts_short/);
      expect(nextMapDelete.join(' | ')).not.toMatch(/fts_content|fts_short/);
      expect(unconstrainedFtsScan([...nextMap, ...nextMapDelete])).toBe(false);

      expect(search(db, '青岚删除词').length).toBeGreaterThan(0);
      store.removeResource('res-map');
      expect(search(db, '青岚删除词')).toEqual([]);
      expect((db.prepare('SELECT COUNT(*) AS n FROM fts_content').get() as { n: number }).n).toBe(0);
      expect((db.prepare('SELECT COUNT(*) AS n FROM fts_short').get() as { n: number }).n).toBe(0);
      expect((db.prepare('SELECT COUNT(*) AS n FROM indexer_fts_rows').get() as { n: number }).n).toBe(0);

      const orphan = insertRawFts(db, 'res-orphan', '没有映射的旧行');
      db.prepare(
        `INSERT INTO indexer_files (
           resource_id, root_id, rel_path, rel_key, size, mtime_ms, updated_at, batch_id
         ) VALUES ('res-orphan', 'root-map', 'orphan.md', 'orphan.md', 4, 1, 1, 'batch-orphan')`,
      ).run();
      store.removeResource('res-orphan');
      const left = db.prepare('SELECT body FROM fts_content WHERE rowid = ?').get(orphan.contentId) as
        | { body: string }
        | undefined;
      expect(left?.body).toBe('没有映射的旧行');
      expect(
        (db.prepare('SELECT COUNT(*) AS n FROM indexer_fts_rows WHERE resource_id = ?').get('res-orphan') as {
          n: number;
        }).n,
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it('迁移不重建全文，text_index_version 仍是 2，fts_row_map_version 从无到 1', () => {
    const db = tempDb();
    try {
      expect(TEXT_INDEX_VERSION).toBe('2');
      migrate(db);
      db.prepare(`DELETE FROM indexer_meta WHERE key = 'fts_row_map_version'`).run();
      db.exec('DELETE FROM indexer_fts_rows');
      db.prepare(`INSERT INTO indexer_meta(key, value) VALUES ('text_index_version', '2')`).run();
      db.pragma('user_version = 6');
      const kept = insertRawFts(db, 'res-kept', '迁移前就在的正文');
      expect(meta(db, 'fts_row_map_version')).toBeUndefined();
      const userVersion = db.pragma('user_version', { simple: true });
      const schemaBefore = ftsSchema(db);
      const contentBefore = ftsBodies(db, 'fts_content');
      const shortBefore = ftsBodies(db, 'fts_short');
      expect(contentBefore).toEqual([{ rowid: kept.contentId, body: '迁移前就在的正文' }]);

      migrate(db);

      expect(meta(db, 'fts_row_map_version')).toBe('1');
      expect(meta(db, 'text_index_version')).toBe('2');
      expect(readTextIndexVersion(db)).toBe('2');
      expect(db.pragma('user_version', { simple: true })).toBe(userVersion);
      expect(ftsSchema(db)).toEqual(schemaBefore);
      expect(ftsBodies(db, 'fts_content')).toEqual(contentBefore);
      expect(ftsBodies(db, 'fts_short')).toEqual(shortBefore);
      const mapped = db
        .prepare('SELECT tbl, rowid FROM indexer_fts_rows WHERE resource_id = ? ORDER BY tbl')
        .all('res-kept') as Array<{ tbl: string; rowid: number }>;
      expect(mapped).toEqual([
        { tbl: 'fts_content', rowid: kept.contentId },
        { tbl: 'fts_short', rowid: kept.shortId },
      ]);
      expect(
        db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`).get(
          'idx_indexer_fts_rows_resource',
        ),
      ).toBeTruthy();

      const extra = insertRawFts(db, 'res-extra', '版本已是 1 之后写入');
      const mapCount = (db.prepare('SELECT COUNT(*) AS n FROM indexer_fts_rows').get() as { n: number }).n;
      migrate(db);
      expect(meta(db, 'fts_row_map_version')).toBe('1');
      expect(meta(db, 'text_index_version')).toBe('2');
      expect(db.pragma('user_version', { simple: true })).toBe(userVersion);
      expect(ftsBodies(db, 'fts_content')).toEqual([
        ...contentBefore,
        { rowid: extra.contentId, body: '版本已是 1 之后写入' },
      ]);
      expect((db.prepare('SELECT COUNT(*) AS n FROM indexer_fts_rows').get() as { n: number }).n).toBe(mapCount);
      expect(
        db.prepare('SELECT 1 AS ok FROM indexer_fts_rows WHERE tbl = ? AND rowid = ?').get(
          'fts_content',
          extra.contentId,
        ),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
