import type { Db } from './db.js';
/** 同一库文件的对账共用这把锁。worker 里要使用父线程传进来的那一份。 */
export declare function jobLock(db: Db): Int32Array;
export declare function withJobLock(lock: Int32Array, run: () => void): void;
//# sourceMappingURL=job-lock.d.ts.map