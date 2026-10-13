import type { Db } from './db.ts';
import { databasePath } from './db.ts';

const locks = new Map<string, Int32Array>();

function lockKey(dbPath: string): string {
  const normalized = dbPath.normalize('NFC');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** 同一库文件的对账共用这把锁。worker 里要使用父线程传进来的那一份。 */
export function jobLock(db: Db): Int32Array {
  const key = lockKey(databasePath(db));
  let lock = locks.get(key);
  if (!lock) {
    lock = new Int32Array(new SharedArrayBuffer(4));
    locks.set(key, lock);
  }
  return lock;
}

export function withJobLock(lock: Int32Array, run: () => void): void {
  for (;;) {
    if (Atomics.compareExchange(lock, 0, 0, 1) === 0) break;
    try {
      Atomics.wait(lock, 0, 1, 30);
    } catch {
      const end = Date.now() + 5;
      while (Date.now() < end && Atomics.load(lock, 0) === 1) {
        /* 主线程不允许 Atomics.wait 时短忙等 */
      }
    }
  }
  try {
    run();
  } finally {
    Atomics.store(lock, 0, 0);
    Atomics.notify(lock, 0, 1);
  }
}
