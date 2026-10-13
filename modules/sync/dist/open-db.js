import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
export function openDatabase(file) {
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    // 自动 checkpoint 会跟调用方已经打开的连接抢锁，主线程定时器会停。
    db.pragma('wal_autocheckpoint = 0');
    db.pragma('synchronous = NORMAL');
    return db;
}
//# sourceMappingURL=open-db.js.map