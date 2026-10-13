import type { SqliteDb, TokenizerKind } from './types.ts';

export interface TokenizerChoice {
  kind: TokenizerKind;
  /** trigram 查询用引号短语还是裸字符串。bigram 不用。 */
  trigramStyle: 'quoted' | 'bare';
}

function tableExists(db: SqliteDb, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { ok: number } | undefined;
  return !!row;
}

function readMeta(db: SqliteDb, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM indexer_meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function writeMeta(db: SqliteDb, key: string, value: string): void {
  db.prepare(
    `INSERT INTO indexer_meta(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

function dropProbe(db: SqliteDb): void {
  try {
    db.exec('DROP TABLE IF EXISTS kb_idx_probe');
  } catch {
    // 探针表可能没建起来
  }
}

function probeTrigram(db: SqliteDb, tokenize: string): 'quoted' | 'bare' | null {
  dropProbe(db);
  try {
    db.exec(`CREATE VIRTUAL TABLE kb_idx_probe USING fts5(body, tokenize = '${tokenize}')`);
    db.prepare('INSERT INTO kb_idx_probe(body) VALUES (?)').run('探针正文青岚索引词结束');
    const quoted = db
      .prepare("SELECT 1 AS ok FROM kb_idx_probe WHERE kb_idx_probe MATCH ?")
      .get('"青岚索引词"') as { ok: number } | undefined;
    if (quoted) return 'quoted';
    const bare = db
      .prepare('SELECT 1 AS ok FROM kb_idx_probe WHERE kb_idx_probe MATCH ?')
      .get('青岚索引词') as { ok: number } | undefined;
    if (bare) return 'bare';
    return null;
  } catch {
    return null;
  } finally {
    dropProbe(db);
  }
}

export function chooseTokenizer(db: SqliteDb): TokenizerChoice {
  const quotedOrBare = probeTrigram(db, 'trigram case_sensitive 0');
  if (quotedOrBare) return { kind: 'trigram', trigramStyle: quotedOrBare };
  const plain = probeTrigram(db, 'trigram');
  if (plain) return { kind: 'trigram', trigramStyle: plain };
  return { kind: 'bigram', trigramStyle: 'quoted' };
}

function createFts(db: SqliteDb, choice: TokenizerChoice): void {
  if (choice.kind === 'trigram') {
    const tokenize = choice.trigramStyle
      ? 'trigram case_sensitive 0'
      : 'trigram case_sensitive 0';
    // 探测已经证明 case_sensitive 0 或退回的 trigram 可用。
    // 若只有不带选项的 trigram 能建表，probe 的第二段会命中，这里再试一次。
    // line_start：txt/md 这一块在原文件里的起始行号。PDF 写 0。
    const sqls = [
      `CREATE VIRTUAL TABLE fts_content USING fts5(
        resource_id UNINDEXED,
        page UNINDEXED,
        title,
        body,
        root_id UNINDEXED,
        line_start UNINDEXED,
        tokenize = 'trigram case_sensitive 0'
      )`,
      `CREATE VIRTUAL TABLE fts_content USING fts5(
        resource_id UNINDEXED,
        page UNINDEXED,
        title,
        body,
        root_id UNINDEXED,
        line_start UNINDEXED,
        tokenize = 'trigram'
      )`,
    ];
    let created = false;
    let last: unknown;
    for (const sql of sqls) {
      try {
        db.exec(sql);
        created = true;
        break;
      } catch (err) {
        last = err;
      }
    }
    if (!created) {
      throw last instanceof Error ? last : new Error(String(last));
    }
    void tokenize;
    return;
  }
  db.exec(`CREATE VIRTUAL TABLE fts_content USING fts5(
    resource_id UNINDEXED,
    page UNINDEXED,
    title,
    body,
    root_id UNINDEXED,
    title_text UNINDEXED,
    body_text UNINDEXED,
    line_start UNINDEXED,
    tokenize = 'unicode61'
  )`);
}

/** 短查询用的重叠二字索引。已有库只建空表，不在这里回填。 */
function ensureFtsShort(db: SqliteDb): void {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS fts_short USING fts5(
    resource_id UNINDEXED,
    page UNINDEXED,
    title,
    body,
    root_id UNINDEXED,
    title_text UNINDEXED,
    body_text UNINDEXED,
    path_text UNINDEXED,
    line_start UNINDEXED,
    tokenize = 'unicode61'
  )`);
}

export const TEXT_INDEX_VERSION = '2';

export function ftsColumnNames(db: SqliteDb, table: string): string[] {
  try {
    const rows = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{
      name: string;
    }>;
    return rows.map((row) => row.name);
  } catch {
    return [];
  }
}

export function ftsHasLineStart(db: SqliteDb, table = 'fts_content'): boolean {
  return ftsColumnNames(db, table).includes('line_start');
}

export function readTextIndexVersion(db: SqliteDb): string | undefined {
  try {
    return readMeta(db, 'text_index_version');
  } catch {
    return undefined;
  }
}

export function markTextIndexVersion(db: SqliteDb): void {
  if (readTextIndexVersion(db) === TEXT_INDEX_VERSION) return;
  writeMeta(db, 'text_index_version', TEXT_INDEX_VERSION);
}

/** 旧表没有行号列时丢掉全文表重建。不把旧行标成已分块。调用前必须已经 migrate。 */
export function rebuildTextTables(db: SqliteDb): void {
  const choice: TokenizerChoice = {
    kind: tokenizerKind(db),
    trigramStyle: trigramStyle(db),
  };
  db.exec('DROP TABLE IF EXISTS fts_content');
  db.exec('DROP TABLE IF EXISTS fts_short');
  createFts(db, choice);
  ensureFtsShort(db);
  // 全文表已换新，旧 rowid 作废。映射还在的话，下次插入会撞主键。
  if (tableExists(db, 'indexer_fts_rows')) db.exec('DELETE FROM indexer_fts_rows');
}

export function migrate(db: SqliteDb): void {
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS indexer_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS indexer_roots (
      root_id TEXT PRIMARY KEY,
      local_path TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS indexer_files (
      resource_id TEXT PRIMARY KEY,
      root_id TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      rel_key TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      batch_id TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_indexer_files_root_rel
      ON indexer_files(root_id, rel_key);
    CREATE INDEX IF NOT EXISTS idx_indexer_files_root
      ON indexer_files(root_id);
  `);
  const fileCols = db.prepare('PRAGMA table_info(indexer_files)').all() as Array<{ name: string }>;
  if (!fileCols.some((col) => col.name === 'batch_id')) {
    db.exec('ALTER TABLE indexer_files ADD COLUMN batch_id TEXT');
  }

  const hasFts = tableExists(db, 'fts_content');
  const existing = readMeta(db, 'tokenizer');
  if (!hasFts) {
    const choice = chooseTokenizer(db);
    createFts(db, choice);
    writeMeta(db, 'tokenizer', choice.kind);
    writeMeta(db, 'trigram_style', choice.trigramStyle);
  } else if (existing !== 'trigram' && existing !== 'bigram') {
    throw new Error('fts_content 已存在，但 indexer_meta 缺少 tokenizer');
  }
  ensureFtsShort(db);
  ensureFtsRowMap(db);
}

/** 没有这个键视为 0。只升到 1，不改 text_index_version，也不改 user_version。 */
function readFtsRowMapVersion(db: SqliteDb): number {
  const raw = readMeta(db, 'fts_row_map_version');
  if (raw == null || raw === '') return 0;
  const version = Number(raw);
  if (!Number.isInteger(version) || version < 0) return 0;
  return version;
}

/**
 * 行号映射。resource_id 在全文表里不建索引，按它删除会整表扫描。
 * 版本小于 1 时允许扫一次两张全文表把已有 rowid 填进来。之后不再扫。
 */
function ensureFtsRowMap(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS indexer_fts_rows (
      resource_id TEXT NOT NULL,
      tbl TEXT NOT NULL CHECK (tbl IN ('fts_content', 'fts_short')),
      rowid INTEGER NOT NULL,
      PRIMARY KEY (tbl, rowid)
    );
    CREATE INDEX IF NOT EXISTS idx_indexer_fts_rows_resource ON indexer_fts_rows(resource_id);
  `);
  if (readFtsRowMapVersion(db) >= 1) return;
  const fill = db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO indexer_fts_rows(resource_id, tbl, rowid)
       SELECT resource_id, 'fts_content', rowid FROM fts_content`,
    ).run();
    db.prepare(
      `INSERT OR IGNORE INTO indexer_fts_rows(resource_id, tbl, rowid)
       SELECT resource_id, 'fts_short', rowid FROM fts_short`,
    ).run();
    writeMeta(db, 'fts_row_map_version', '1');
  });
  fill();
}

export function tokenizerKind(db: SqliteDb): TokenizerKind {
  const kind = readMeta(db, 'tokenizer');
  if (kind === 'trigram' || kind === 'bigram') return kind;
  throw new Error('请先调用 migrate(db)');
}

export function trigramStyle(db: SqliteDb): 'quoted' | 'bare' {
  const style = readMeta(db, 'trigram_style');
  return style === 'bare' ? 'bare' : 'quoted';
}
