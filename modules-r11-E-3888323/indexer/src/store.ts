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

/**
 * 段已经堆到两万以上时，一个事务里提交 16 页 2KB 正文就会 SQLITE_FULL。
 * 同一份库上 8 页可以提交。4 页再留一截余量。
 * 318 页的资料在第 288 次删除时也能复现同一种报错。
 */
const FTS_TX_ROWS = 4;

/** 一段太长时，20 行仍可能是一整块大正文。按字数再切开。 */
export const PLAIN_CHUNK_CHARS = 2000;

function splitBody(body: string): string[] {
  if (body.length <= PLAIN_CHUNK_CHARS) return [body];
  const parts: string[] = [];
  for (let i = 0; i < body.length; i += PLAIN_CHUNK_CHARS) parts.push(body.slice(i, i + PLAIN_CHUNK_CHARS));
  return parts;
}

export function chunkPlainPage(page: PageText): PageText[] {
  if (page.page !== 0) {
    return splitBody(page.body.normalize('NFC')).map((body) => ({
      page: page.page,
      title: page.title,
      body,
      lineStart: 0,
    }));
  }
  const text = page.body.normalize('NFC');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '' && text.endsWith('\n')) lines.pop();
  if (lines.length === 0) return [{ ...page, body: '', lineStart: 1 }];
  const chunks: PageText[] = [];
  for (let i = 0; i < lines.length; i += PLAIN_CHUNK_LINES) {
    const lineStart = i + 1;
    for (const body of splitBody(lines.slice(i, i + PLAIN_CHUNK_LINES).join('\n'))) {
      chunks.push({ page: 0, title: page.title, body, lineStart });
    }
  }
  return chunks;
}

/** 删除前只查这张表。禁止再按 resource_id 去扫 fts_content / fts_short。 */
export const FTS_ROW_MAP_SELECT_SQL =
  'SELECT rowid FROM indexer_fts_rows WHERE resource_id = ? AND tbl = ?';
export const FTS_CONTENT_DELETE_BY_ROWID_SQL = 'DELETE FROM fts_content WHERE rowid = ?';
export const FTS_SHORT_DELETE_BY_ROWID_SQL = 'DELETE FROM fts_short WHERE rowid = ?';
export const FTS_ROW_MAP_DELETE_SQL = 'DELETE FROM indexer_fts_rows WHERE tbl = ? AND rowid = ?';

const COMPACT_ID = 'kb-fts-compact-probe';
const COMPACT_BODY = '特征值与状态方程，用来检查全文提交。'.repeat(40);

/** 段堆得太多时，提交会被回滚成 SQLITE_FULL。能提交一段正常正文才返回 true。 */
export function textIndexAcceptsWrite(db: SqliteDb): boolean {
  const insertContent = db.prepare(
    `INSERT INTO fts_content(resource_id, page, title, body, root_id, line_start) VALUES (?,?,?,?,?,?)`,
  );
  const insertShort = db.prepare(
    `INSERT INTO fts_short(
       resource_id, page, title, body, root_id, title_text, body_text, path_text, line_start
     ) VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  let contentRow = 0;
  let shortRow = 0;
  try {
    db.transaction(() => {
      insertContent.run(COMPACT_ID, 0, '笔记', COMPACT_BODY, 'compact', 1);
      contentRow = Number((db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
      insertShort.run(COMPACT_ID, 0, '笔记', COMPACT_BODY, 'compact', '笔记', COMPACT_BODY, 'compact.md', 1);
      shortRow = Number((db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
    })();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/full/i.test(msg)) return false;
    throw err;
  }
  try {
    db.prepare('DELETE FROM fts_content WHERE rowid = ?').run(contentRow);
    db.prepare('DELETE FROM fts_short WHERE rowid = ?').run(shortRow);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/full/i.test(msg)) throw err;
  }
  return true;
}

/**
 * 关闭自动合并后，段会一直涨，正常正文就写不进去。
 * 每次只合并固定页数，直到一段 700 字左右的正文能提交。
 * 返回实际合并的步数。
 */
export function compactTextIndex(db: SqliteDb, maxSteps = 40): number {
  let steps = 0;
  while (steps < maxSteps && !textIndexAcceptsWrite(db)) {
    for (const table of ['fts_content', 'fts_short'] as const) {
      db.prepare(`INSERT INTO ${table}(${table}, rank) VALUES('merge', 800)`).run();
    }
    steps += 1;
  }
  return steps;
}

/** 自动增量合并的段数。0 会让段一直堆，只在扫描途中短时间使用。 */
export const FTS_AUTOMERGE = 8;

/**
 * SQLite 默认值。一个层级堆到这个段数就整层合并。
 * 默认 crisismerge=16 会在几百个文件后把整层 b-tree 合成一次，写入停几百毫秒，主线程定时器跟着漂。
 * 所以旧索引把 crisismerge 写成 100000、automerge 写成 0。这两个值会留在库里，段数没有上限。
 */
export const FTS_CRISISMERGE_DEFAULT = 16;

/** 超过这个段数就在索引进程里后台 optimize，不在应用主进程做。 */
export const FTS_SEGMENT_SOFT_LIMIT = 1000;

/** 启动时达到这个段数，先在索引进程里压实，写入排队。 */
export const FTS_SEGMENT_NEAR_LIMIT = 1500;

/** 再往上写会把全文提交顶成 SQLITE_FULL。写入前先压。 */
export const FTS_SEGMENT_HARD_LIMIT = 2000;

const FTS_TABLES = ['fts_content', 'fts_short'] as const;

function readStructureVarint(block: Buffer, offset: number): { value: number; offset: number } {
  let value = 0;
  for (let i = 0; i < 9; i += 1) {
    if (offset >= block.length) return { value: 0, offset };
    const byte = block[offset] ?? 0;
    offset += 1;
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, offset };
  }
  return { value, offset };
}

/** FTS5 结构记录在 %_data 的 id=10。cookie 后第二个 varint 是当前段数。 */
export function ftsSegmentCount(db: SqliteDb, table: 'fts_content' | 'fts_short'): number {
  let row: { block: Buffer | Uint8Array } | undefined;
  try {
    row = db.prepare(`SELECT block FROM ${table}_data WHERE id = 10`).get() as
      | { block: Buffer | Uint8Array }
      | undefined;
  } catch {
    return 0;
  }
  if (!row?.block) return 0;
  const block = Buffer.from(row.block);
  if (block.length < 6) return 0;
  const levels = readStructureVarint(block, 4);
  const segments = readStructureVarint(block, levels.offset);
  if (!Number.isFinite(segments.value) || segments.value < 0) return 0;
  return segments.value;
}

function writeFtsRank(db: SqliteDb, table: 'fts_content' | 'fts_short', key: string, value: number): void {
  // FTS5 的 rank 命令不接受绑定参数，必须是字面量。
  if (key !== 'automerge' && key !== 'crisismerge') throw new Error(`未知全文合并参数 ${key}`);
  if (!Number.isInteger(value) || value < 0) throw new Error(`非法全文合并参数 ${value}`);
  db.prepare(`INSERT INTO ${table}(${table}, rank) VALUES('${key}', ${value})`).run();
}

/** 仅扫描期间 automerge=0。crisismerge 不动。成功、出错、取消都要 restoreFtsMerge。 */
export function suspendFtsMerge(db: SqliteDb): void {
  for (const table of FTS_TABLES) writeFtsRank(db, table, 'automerge', 0);
}

/** automerge=8，crisismerge=16。这是扫描结束后留在库里的值。 */
export function restoreFtsMerge(db: SqliteDb): void {
  for (const table of FTS_TABLES) {
    writeFtsRank(db, table, 'automerge', FTS_AUTOMERGE);
    writeFtsRank(db, table, 'crisismerge', FTS_CRISISMERGE_DEFAULT);
  }
}

export function compactTextIndexUntilWritable(db: SqliteDb, maxSteps = 40): {
  ok: boolean;
  steps: number;
  before: { fts_content: number; fts_short: number };
  after: { fts_content: number; fts_short: number };
  elapsedMs: number;
} {
  const started = performance.now();
  const before = {
    fts_content: ftsSegmentCount(db, 'fts_content'),
    fts_short: ftsSegmentCount(db, 'fts_short'),
  };
  let steps = 0;
  let ok = textIndexAcceptsWrite(db);
  while (!ok && steps < maxSteps) {
    for (const table of FTS_TABLES) {
      db.prepare(`INSERT INTO ${table}(${table}, rank) VALUES('merge', 800)`).run();
    }
    steps += 1;
    ok = textIndexAcceptsWrite(db);
  }
  return {
    ok,
    steps,
    before,
    after: {
      fts_content: ftsSegmentCount(db, 'fts_content'),
      fts_short: ftsSegmentCount(db, 'fts_short'),
    },
    elapsedMs: performance.now() - started,
  };
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
  private readonly selectMappedRowids;
  private readonly deleteByRowid;
  private readonly deleteShortByRowid;
  private readonly deleteMappedRow;
  private readonly insertMappedRow;
  private readonly selectLastRowid;
  private readonly insertTrigram: BetterSqlite3.Statement | null;
  private readonly insertBigram: BetterSqlite3.Statement | null;
  private readonly insertShort;
  private readonly upsertFileStmt;
  private readonly upsertRootStmt;
  private readonly selectRootFiles;
  private readonly markDirtyStmt;

  constructor(db: SqliteDb) {
    this.db = db;
    this.kind = tokenizerKind(db);
    this.selectFileExists = db.prepare('SELECT 1 AS ok FROM indexer_files WHERE resource_id = ?');
    this.selectMappedRowids = db.prepare(FTS_ROW_MAP_SELECT_SQL);
    this.deleteByRowid = db.prepare(FTS_CONTENT_DELETE_BY_ROWID_SQL);
    this.deleteShortByRowid = db.prepare(FTS_SHORT_DELETE_BY_ROWID_SQL);
    this.deleteMappedRow = db.prepare(FTS_ROW_MAP_DELETE_SQL);
    this.insertMappedRow = db.prepare(
      'INSERT INTO indexer_fts_rows(resource_id, tbl, rowid) VALUES (?, ?, ?)',
    );
    this.selectLastRowid = db.prepare('SELECT last_insert_rowid() AS id');
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
    this.markDirtyStmt = db.prepare('UPDATE indexer_files SET mtime_ms = -1 WHERE resource_id = ?');
  }

  /** 外层已经包了事务时不再套一层，否则分批提交会变成保存点，仍然一次性提交。 */
  private runChunk(work: () => void): void {
    if (this.db.inTransaction) {
      work();
      return;
    }
    this.db.transaction(work)();
  }

  upsertRoot(rootId: string, localPath: string): void {
    const row = this.db.prepare('SELECT local_path FROM indexer_roots WHERE root_id = ?').get(rootId) as
      | { local_path: string }
      | undefined;
    if (row && row.local_path === localPath) return;
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
    this.deleteFts(resourceId);
    this.runChunk(() => this.deleteById.run(resourceId));
  }

  /** 磁盘上已不在扫描范围内的资料，从索引里去掉。按页分批提交，避免一次删完整份大文档。 */
  removeUnseen(rootId: string, seenKeys: Set<string>): string[] {
    const removed: string[] = [];
    const known = this.loadFiles(rootId);
    for (const [key, file] of known) {
      if (seenKeys.has(key)) continue;
      this.deleteFts(file.resourceId);
      this.runChunk(() => this.deleteById.run(file.resourceId));
      removed.push(file.relPath);
    }
    return removed;
  }

  write(file: StoredFile, previousResourceId: string | undefined, batchId: string): void {
    const relPath = normalizeRel(file.relPath);
    const key = relKey(relPath);
    // resource_id 在 FTS 里是 UNINDEXED，按它删除会整表扫描。新资料不在 indexer_files 里，跳过扫描。
    if (previousResourceId && previousResourceId !== file.resourceId && this.hasFile(previousResourceId)) {
      this.deleteFts(previousResourceId);
      this.runChunk(() => this.deleteById.run(previousResourceId));
    }
    if (this.hasFile(file.resourceId)) {
      // 先把 mtime 标脏。中途失败的话，下次增量会重写这份资料。
      this.runChunk(() => this.markDirtyStmt.run(file.resourceId));
      this.deleteFts(file.resourceId);
    }
    const pages = file.pages.flatMap((page) => chunkPlainPage(page));
    for (let i = 0; i < pages.length; i += FTS_TX_ROWS) {
      const slice = pages.slice(i, i + FTS_TX_ROWS);
      this.runChunk(() => {
        for (const page of slice) this.insertPage(file.resourceId, file.rootId, relPath, page);
      });
    }
    this.runChunk(() => {
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
  }

  private hasFile(resourceId: string): boolean {
    return this.selectFileExists.get(resourceId) !== undefined;
  }

  private deleteFts(resourceId: string): void {
    const rows = this.selectMappedRowids.all(resourceId, 'fts_content') as Array<{ rowid: number }>;
    const shorts = this.selectMappedRowids.all(resourceId, 'fts_short') as Array<{ rowid: number }>;
    const count = Math.max(rows.length, shorts.length);
    for (let i = 0; i < count; i += FTS_TX_ROWS) {
      const content = rows.slice(i, i + FTS_TX_ROWS);
      const brief = shorts.slice(i, i + FTS_TX_ROWS);
      this.runChunk(() => {
        for (const row of content) {
          this.deleteByRowid.run(row.rowid);
          this.deleteMappedRow.run('fts_content', row.rowid);
        }
        for (const row of brief) {
          this.deleteShortByRowid.run(row.rowid);
          this.deleteMappedRow.run('fts_short', row.rowid);
        }
      });
    }
  }

  /** 必须紧挨着全文 INSERT。映射自己的插入会改掉 last_insert_rowid。 */
  private rememberFtsRow(resourceId: string, tbl: 'fts_content' | 'fts_short'): void {
    const rowid = Number((this.selectLastRowid.get() as { id: number }).id);
    this.insertMappedRow.run(resourceId, tbl, rowid);
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
    this.rememberFtsRow(resourceId, 'fts_content');
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
    this.rememberFtsRow(resourceId, 'fts_short');
  }
}
