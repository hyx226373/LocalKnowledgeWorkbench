import { createRequire } from 'node:module';
import type BetterSqlite3 from 'better-sqlite3';
import type { SqliteDb } from './types.ts';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof BetterSqlite3;

export function openDatabase(file: string): SqliteDb {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  // 自动 checkpoint 会跟调用方已经打开的连接抢锁，主线程定时器会停。
  db.pragma('wal_autocheckpoint = 0');
  db.pragma('synchronous = NORMAL');
  return db;
}
