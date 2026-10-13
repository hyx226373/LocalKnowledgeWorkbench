import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import type BetterSqlite3 from 'better-sqlite3';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof BetterSqlite3;

export function openDatabase(file: string): BetterSqlite3.Database {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('temp_store = FILE');
  db.pragma('max_page_count = 4294967294');
  return db;
}

/** SQLITE_FULL 时把库和临时文件的状态附在错误上。主库文件大小不变时，多半是 WAL 或临时文件涨不上去。 */
export function sqliteFullDetail(db: BetterSqlite3.Database, file: string): string {
  const read = (name: string): unknown => {
    try {
      return db.pragma(name, { simple: true });
    } catch {
      return null;
    }
  };
  let walBytes = 0;
  try {
    walBytes = statSync(`${file}-wal`).size;
  } catch {
    walBytes = 0;
  }
  return JSON.stringify({
    db: file,
    page_count: read('page_count'),
    max_page_count: read('max_page_count'),
    freelist_count: read('freelist_count'),
    page_size: read('page_size'),
    temp_store: read('temp_store'),
    walBytes,
    tempDir: process.env.TEMP || process.env.TMP || '',
  });
}

/** 只用来在内存里建好全文再 backup 到文件。不要拿它代替已经打开的知识库。 */
export function openMemoryDatabase(): BetterSqlite3.Database {
  const db = new Database(':memory:');
  db.pragma('busy_timeout = 5000');
  return db;
}
