import { setMount } from "./db.js";
import { reconcile } from "./reconcile.js";
/** 只改本机 root_mounts.local_path，然后 reconcile。不改 resources.id。 */
export async function remapRoot(db, rootId, newLocalPath, options = {}) {
    setMount(db, rootId, newLocalPath);
    return reconcile(db, rootId, options);
}
//# sourceMappingURL=remap.js.map