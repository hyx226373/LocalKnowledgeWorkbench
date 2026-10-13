import { setMount, type Db } from './db.ts';
import { reconcile } from './reconcile.ts';
import type { ReconcileOptions, ReconcileResult } from './types.ts';

/** 只改本机 root_mounts.local_path，然后 reconcile。不改 resources.id。 */
export async function remapRoot(
  db: Db,
  rootId: string,
  newLocalPath: string,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  setMount(db, rootId, newLocalPath);
  return reconcile(db, rootId, options);
}
