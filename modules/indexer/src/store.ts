import type BetterSqlite3 from 'better-sqlite3';
import { tokenizerKind } from './migrate.ts';
import { normalizeRel, relKey } from './paths.ts';
import type { SqliteDb } from './types.ts';
import { bigramTokenize } from './tokenize.ts';

export interface PageText {
  page: number;
  title: string;
  body: string;
  /** txt/md 块首行在原文件中的行号，从 1 开始。PDF 为 0。 */
  lineStart?: number;
}

/** md / txt 固定每 20 行一块。锚点用 lineStart，不用块号。 */
export const PLAIN_CHUNK_LINES = 20;

export function chunkPlainPage(page: PageText): PageText[] {
  if (page.page !== 0) return [{ ...page, lineStart: 0 }];
  const text = page.body.normalize('NFC');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '' && text.endsWith('\n')) lines.pop();
  if (lines.length === 0) return [{ ...page, body: '', lineStart: 1 }];
  const chunks: PageText[] = [];
  for (let i = 0; i < lines.length; i += PLAIN_CHUNK_LINES) {
    chunks.push({
      page: 0,
      title: page.title,
      body: lines.slice(i, i + PLAIN_CHUNK_LINES).join('\n'),
      lineStart: i + 1,
    });
  }
  return chunks;
}

export interface StoredFile {
  resourceId: string;
  rootId: string;
  relPath: string;
  size: number;
  mtimeMs: number;
  pages: PageText[];
}

export interface KnownFile {
  resourceId: string;
  relPath: string;
  size: number;
  mtimeMs: number;
}

export class IndexStore {
  readonly kind: 'trigram' | 'bigram';
  private readonly db: SqliteDb;

  private readonly deleteById;
  private readonly selectFileExists;
  private readonly selectRowids;
  private readonly deleteByRowid;
  private readonly insertTrigram: BetterSqlite3.Statement | null;
  private readonly insertBigram: BetterSqlite3.Statement | null;
  private readonly insertShort;
  private readonly selectShortRowids;
  private readonly deleteShortByRowid;
  private readonly upsertFileStmt;
  private readonly upsertRootStmt;
  private readonly selectRootFiles;

  constructor(db: SqliteDb) {
    this.db = db;
    this.kind = tokenizerKind(db);
    this.selectFileExists = db.prepare('SELECT 1 AS ok FROM indexer_files WHERE resource_id = ?');
    this.selectRowids = db.prepare('SELECT rowid FROM fts_content WHERE resource_id = ?');
    this.deleteByRowid = db.prepare('DELETE FROM fts_content WHERE rowid = ?');
    this.deleteById = db.prepare('DELETE FROM indexer_files WHERE resource_id = ?');
    // 另一套列在当前表里不存在，不能提前 prepare。
    if (this.kind === 'trigram') {
      this.insertTrigram = db.prepare(
        `INSERT INTO fts_content (resource_id, page, title, body, root_id, line_start)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      this.insertBigram = null;
    } else {
      this.insertTrigram = null;
      this.insertBigram = db.prepare(
        `INSERT INTO fts_content (resource_id, page, title, body, root_id, title_text, body_text, line_start)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
    }
    // 与 fts_content 同一事务写入。title 是文件名和相对路径的重叠二字加单字，不是原文。
    this.insertShort = db.prepare(
      `INSERT INTO fts_short (
         resource_id, page, title, body, root_id, title_text, body_text, path_text, line_start
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.selectShortRowids = db.prepare('SELECT rowid FROM fts_short WHERE resource_id = ?');
    this.deleteShortByRowid = db.prepare('DELETE FROM fts_short WHERE rowid = ?');
    this.upsertFileStmt = db.prepare(
      `INSERT INTO indexer_files (
         resource_id, root_id, rel_path, rel_key, size, mtime_ms, updated_at, batch_id
       ) VALUES (
         @resourceId, @rootId, @relPath, @relKey, @size, @mtimeMs, @updatedAt, @batchId
       )
       ON CONFLICT(resource_id) DO UPDATE SET
         root_id = excluded.root_id,
         rel_path = excluded.rel_path,
         rel_key = excluded.rel_key,
         size = excluded.size,
         mtime_ms = excluded.mtime_ms,
         updated_at = excluded.updated_at,
         batch_id = excluded.batch_id`,
    );
    this.upsertRootStmt = db.prepare(
      `INSERT INTO indexer_roots (root_id, local_path, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(root_id) DO UPDATE SET
         local_path = excluded.local_path,
         updated_at = excluded.updated_at`,
    );
    this.selectRootFiles = db.prepare(
      `SELECT resource_id AS resourceId, rel_path AS relPath, rel_key AS relKey,
              size, mtime_ms AS mtimeMs
       FROM indexer_files WHERE root_id = ?`,
    );
  }

  upsertRoot(rootId: string, localPath: string): void {
    this.upsertRootStmt.run(rootId, localPath, Date.now());
  }

  loadFiles(rootId: string): Map<string, KnownFile> {
    const rows = this.selectRootFiles.all(rootId) as Array<{
      resourceId: string;
      relPath: string;
      relKey: string;
      size: number;
      mtimeMs: number;
    }>;
    const map = new Map<string, KnownFile>();
    for (const row of rows) {
      map.set(row.relKey, {
        resourceId: row.resourceId,
        relPath: row.relPath,
        size: row.size,
        mtimeMs: row.mtimeMs,
      });
    }
    return map;
  }

  removeResource(resourceId: string): void {
    const tx = this.db.transaction(() => {
      this.deleteFts(resourceId);
      this.deleteById.run(resourceId);
    });
    tx();
  }

  /** 磁盘上已不在扫描范围内的资料，从索引里去掉。 */
  removeUnseen(rootId: string, seenKeys: Set<string>): string[] {
    const removed: string[] = [];
    const known = this.loadFiles(rootId);
    const tx = this.db.transaction(() => {
      for (const [key, file] of known) {
        if (seenKeys.has(key)) continue;
        this.deleteFts(file.resourceId);
        this.deleteById.run(file.resourceId);
        removed.push(file.relPath);
      }
    });
    tx();
    return removed;
  }

  write(file: StoredFile, previousResourceId: string | undefined, batchId: string): void {
    const relPath = normalizeRel(file.relPath);
    const key = relKey(relPath);
    const tx = this.db.transaction(() => {
      // resource_id 在 FTS 里是 UNINDEXED，按它删除会整表扫描。新资料不在 indexer_files 里，跳过扫描。
      if (previousResourceId && previousResourceId !== file.resourceId && this.hasFile(previousResourceId)) {
        this.deleteFts(previousResourceId);
        this.deleteById.run(previousResourceId);
      }
      if (this.hasFile(file.resourceId)) this.deleteFts(file.resourceId);
      const pages = file.pages.flatMap((page) => chunkPlainPage(page));
      for (const page of pages) {
        this.insertPage(file.resourceId, file.rootId, relPath, page);
      }
      this.upsertFileStmt.run({
        resourceId: file.resourceId,
        rootId: file.rootId,
        relPath,
        relKey: key,
        size: file.size,
        mtimeMs: file.mtimeMs,
        updatedAt: Date.now(),
        batchId,
      });
    });
    tx();
  }

  private hasFile(resourceId: string): boolean {
    return this.selectFileExists.get(resourceId) !== undefined;
  }

  private deleteFts(resourceId: string): void {
    const rows = this.selectRowids.all(resourceId) as Array<{ rowid: number }>;
    for (const row of rows) this.deleteByRowid.run(row.rowid);
    const shorts = this.selectShortRowids.all(resourceId) as Array<{ rowid: number }>;
    for (const row of shorts) this.deleteShortByRowid.run(row.rowid);
  }

  private insertPage(resourceId: string, rootId: string, relPath: string, page: PageText): void {
    const title = page.title.normalize('NFC');
    const body = page.body.normalize('NFC');
    const pathText = normalizeRel(relPath);
    const lineStart = page.page === 0 ? (page.lineStart && page.lineStart > 0 ? page.lineStart : 1) : 0;
    // fts_content.title 只放文件名。路径只进 fts_short。
    if (this.insertTrigram) {
      this.insertTrigram.run(resourceId, page.page, title, body, rootId, lineStart);
    } else {
      this.insertBigram!.run(
        resourceId,
        page.page,
        bigramTokenize(title),
        bigramTokenize(body),
        rootId,
        title,
        body,
        lineStart,
      );
    }
    this.insertShort.run(
      resourceId,
      page.page,
      bigramTokenize(`${title}\n${pathText}`),
      bigramTokenize(body),
      rootId,
      title,
      body,
      pathText,
      lineStart,
    );
  }
}
