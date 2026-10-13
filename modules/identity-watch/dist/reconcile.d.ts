import { type Db } from './db.js';
import type { ReconcileOptions, ReconcileResult } from './types.js';
/** 在 worker_threads 里跑。better-sqlite3 连接不传给 worker，由它按 dbPath 自己打开。 */
export declare function reconcile(db: Db, rootId: string, options?: ReconcileOptions): Promise<ReconcileResult>;
//# sourceMappingURL=reconcile.d.ts.map