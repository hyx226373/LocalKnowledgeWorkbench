import { type Db } from './db.js';
import type { ReconcileOptions, ReconcileResult } from './types.js';
/** 只改本机 root_mounts.local_path，然后 reconcile。不改 resources.id。 */
export declare function remapRoot(db: Db, rootId: string, newLocalPath: string, options?: ReconcileOptions): Promise<ReconcileResult>;
//# sourceMappingURL=remap.d.ts.map