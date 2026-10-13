import fs from 'node:fs';
import { rowByPathKey, getMount } from "./db.js";
import { runJob } from "./engine.js";
import { detectFileSystem } from "./fsinfo.js";
import { normalizeRelPath, pathKey } from "./pathutil.js";
import { resolveInsideRoot } from "./resolve.js";
/** 路径必须已存在。会按与 reconcile 相同的规则对齐整棵树，再返回该相对路径的 id。 */
export function ensureResource(db, rootId, relPath) {
    const rel = normalizeRelPath(relPath);
    if (rel === '')
        throw new Error('root directory is not a resource');
    const resolved = resolveInsideRoot(db, rootId, rel);
    if (!fs.existsSync(resolved.absPath))
        throw new Error(`not found: ${rel}`);
    const caps = detectFileSystem(getMount(db, rootId));
    runJob(db, rootId, { caps });
    const keys = [pathKey(resolved.relPath), pathKey(rel)];
    for (const key of keys) {
        const row = rowByPathKey(db, rootId, key);
        if (row)
            return row.id;
    }
    throw new Error(`failed to ensure ${rel}`);
}
//# sourceMappingURL=ensure.js.map