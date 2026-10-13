import { createRequire } from 'node:module';
import type BetterSqlite3 from 'better-sqlite3';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof BetterSqlite3;

export function openDatabase(file: string): BetterSqlite3.Database {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return db;
}

/** 只用来在内存里建好全文再 backup 到文件。不要拿它代替已经打开的知识库。 */
export function openMemoryDatabase(): BetterSqlite3.Database {
  const db = new Database(':memory:');
  db.pragma('busy_timeout = 5000');
  return db;
}
