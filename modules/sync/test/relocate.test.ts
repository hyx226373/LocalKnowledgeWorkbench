import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import { migrate as migrateIndex, tokenizerKind } from '@kb/indexer';
import { bigramTokenize } from '../src/bigram.ts';
import { ftsShortTitle, relocateResource } from '../src/relocate.ts';
import { relKeyOf } from '../src/paths.ts';
import { makeTemp, removeDir } from './helpers.ts';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof BetterSqlite3;

describe('relocate', () => {
  const tmp = makeTemp('kb-sync-rel-');
  const dbPath = path.join(tmp, 'index.sqlite');
  const root = path.join(tmp, 'files');
  const db = new Database(dbPath);

  afterAll(async () => {
    try {
      db.close();
    } catch {
      // 已经关过
    }
    await removeDir(tmp);
  });

  it('改位置时保留正文，fts_short 的 title_text 和 path_text 换成新位置', () => {
    migrateIndex(db);
    mkdirSync(root, { recursive: true });
    const abs = path.join(root, '归档', '新笔记.md');
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, 'FILE_BYTES_NOT_IN_FTS', 'utf8');
    const resourceId = 'res-relocate';
    const rootId = 'root-relocate';
    const relPath = '归档/新笔记.md';
    db.prepare(
      `INSERT INTO indexer_files (
         resource_id, root_id, rel_path, rel_key, size, mtime_ms, updated_at, batch_id
       ) VALUES (?, ?, 'old.md', 'old.md', 1, 1, 1, 'batch')`,
    ).run(resourceId, rootId);

    const kind = tokenizerKind(db);
    if (kind === 'bigram') {
      db.prepare(
        `INSERT INTO fts_content (
           resource_id, page, title, body, root_id, title_text, body_text
         ) VALUES (?, 0, 'old', ?, ?, 'old.md', 'KEEPBODYTEXT')`,
      ).run(resourceId, bigramTokenize('KEEPBODYTEXT'), rootId);
      db.prepare(
        `INSERT INTO fts_content (
           resource_id, page, title, body, root_id, title_text, body_text
         ) VALUES (?, 1, 'old', ?, ?, 'old.md', 'PAGEBODYTEXT')`,
      ).run(resourceId, bigramTokenize('PAGEBODYTEXT'), rootId);
    } else {
      db.prepare(
        `INSERT INTO fts_content (resource_id, page, title, body, root_id) VALUES (?, 0, 'old.md', 'KEEPBODYTEXT', ?)`,
      ).run(resourceId, rootId);
      db.prepare(
        `INSERT INTO fts_content (resource_id, page, title, body, root_id) VALUES (?, 1, 'old.md', 'PAGEBODYTEXT', ?)`,
      ).run(resourceId, rootId);
    }

    const shortExists = db
      .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'fts_short'`)
      .get() as { ok: number } | undefined;
    if (!shortExists) {
      db.exec(`CREATE VIRTUAL TABLE fts_short USING fts5(
        resource_id UNINDEXED,
        page UNINDEXED,
        title,
        body,
        root_id UNINDEXED,
        title_text UNINDEXED,
        body_text UNINDEXED,
        path_text UNINDEXED,
        tokenize = 'unicode61'
      )`);
    }
    db.prepare(
      `INSERT INTO fts_short (
         resource_id, page, title, body, root_id, title_text, body_text, path_text
       ) VALUES (?, 0, 'old title', 'short body tokens', ?, 'old.md', 'SHORTBODYKEEP', 'old.md')`,
    ).run(resourceId, rootId);

    relocateResource(db, { resourceId, absPath: abs, relPath });

    const file = db
      .prepare(
        `SELECT resource_id AS resourceId, rel_path AS relPath, rel_key AS relKey, size, mtime_ms AS mtimeMs
         FROM indexer_files WHERE resource_id = ?`,
      )
      .get(resourceId) as {
      resourceId: string;
      relPath: string;
      relKey: string;
      size: number;
      mtimeMs: number;
    };
    const st = statSync(abs);
    expect(file.resourceId).toBe(resourceId);
    expect(file.relPath).toBe(relPath);
    expect(file.relKey).toBe(relKeyOf(relPath));
    expect(file.size).toBe(st.size);
    expect(file.mtimeMs).toBe(Math.round(st.mtimeMs));

    const short = db
      .prepare(
        `SELECT title, title_text AS titleText, path_text AS pathText, body, body_text AS bodyText
         FROM fts_short WHERE resource_id = ?`,
      )
      .get(resourceId) as {
      title: string;
      titleText: string;
      pathText: string;
      body: string;
      bodyText: string;
    };
    expect(short.titleText).toBe('新笔记.md');
    expect(short.pathText).toBe(relPath);
    expect(short.bodyText).toBe('SHORTBODYKEEP');
    expect(short.body).toBe('short body tokens');
    expect(short.title).toBe(ftsShortTitle('新笔记.md', relPath));

    if (kind === 'bigram') {
      const pages = db
        .prepare(
          `SELECT page, title, title_text AS titleText, body, body_text AS bodyText
           FROM fts_content WHERE resource_id = ? ORDER BY page`,
        )
        .all(resourceId) as Array<{
        page: number;
        title: string;
        titleText: string;
        body: string;
        bodyText: string;
      }>;
      expect(pages.map((page) => page.bodyText)).toEqual(['KEEPBODYTEXT', 'PAGEBODYTEXT']);
      expect(pages.map((page) => page.body)).toEqual([
        bigramTokenize('KEEPBODYTEXT'),
        bigramTokenize('PAGEBODYTEXT'),
      ]);
      expect(pages.every((page) => page.titleText === '新笔记.md')).toBe(true);
      expect(pages.every((page) => page.title === bigramTokenize('新笔记.md'))).toBe(true);
    } else {
      const pages = db
        .prepare(`SELECT page, title, body FROM fts_content WHERE resource_id = ? ORDER BY page`)
        .all(resourceId) as Array<{ page: number; title: string; body: string }>;
      expect(pages.map((page) => page.body)).toEqual(['KEEPBODYTEXT', 'PAGEBODYTEXT']);
      expect(pages.every((page) => page.title === '新笔记.md')).toBe(true);
    }
    expect(String(file.relPath)).not.toContain('FILE_BYTES_NOT_IN_FTS');
  });
});
