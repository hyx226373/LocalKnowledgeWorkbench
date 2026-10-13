import { randomUUID } from 'node:crypto';
import { createRoot, loadResources, rootRow, setMount } from "./db.js";
import { isTombstone, logicalRelPath, normalizeRelPath, pathKey } from "./pathutil.js";
const ABSOLUTE = /[A-Za-z]:[\\/]/;
function assertNoMachinePath(value) {
    if (typeof value === 'string') {
        if (ABSOLUTE.test(value) || value.startsWith('\\\\') || value.startsWith('//')) {
            throw new Error('portable data contains an absolute path');
        }
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value)
            assertNoMachinePath(item);
        return;
    }
    if (value && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) {
            if (key === 'local_path' || key === 'localPath' || key === 'absPath' || key === 'fs_file_id' || key === 'fsFileId') {
                throw new Error(`portable data contains ${key}`);
            }
            assertNoMachinePath(item);
        }
    }
}
export function exportPortable(db, rootId) {
    const root = rootRow(db, rootId);
    if (!root)
        throw new Error(`unknown root: ${rootId}`);
    const rows = loadResources(db, rootId);
    const live = new Set(rows.filter((row) => row.missing === 0).map((row) => pathKey(logicalRelPath(row.rel_path))));
    const resources = rows.map((row) => {
        const logical = logicalRelPath(row.rel_path);
        return {
            id: row.id,
            rel_path: logical,
            displaced: isTombstone(row.rel_path) || (row.missing === 1 && live.has(pathKey(logical))),
            kind: row.kind,
            size: row.size,
            mtime_ms: row.mtime_ms,
            content_hash: row.content_hash,
            missing: row.missing,
            created_at: row.created_at,
            updated_at: row.updated_at,
        };
    });
    const bundle = {
        format: 'kb-identity-portable-v1',
        root: { id: root.id, name: root.name, created_at: root.created_at },
        resources,
    };
    assertNoMachinePath(bundle);
    return bundle;
}
export function importPortable(db, bundle, options = {}) {
    if (!bundle || bundle.format !== 'kb-identity-portable-v1')
        throw new Error('unsupported portable format');
    assertNoMachinePath(bundle);
    const rootId = bundle.root?.id;
    if (!rootId)
        throw new Error('portable root id missing');
    const seen = new Set();
    for (const resource of bundle.resources) {
        if (!resource.id || seen.has(resource.id))
            throw new Error('portable resource id missing or duplicated');
        seen.add(resource.id);
        normalizeRelPath(resource.rel_path);
        if (resource.kind !== 'file' && resource.kind !== 'dir')
            throw new Error('portable kind invalid');
        if (resource.missing !== 0 && resource.missing !== 1)
            throw new Error('portable missing invalid');
    }
    const liveKeys = new Set();
    for (const resource of bundle.resources) {
        if (resource.missing !== 0)
            continue;
        const key = pathKey(normalizeRelPath(resource.rel_path));
        if (liveKeys.has(key))
            throw new Error('portable live path duplicated');
        liveKeys.add(key);
    }
    const tx = db.transaction(() => {
        const existing = rootRow(db, rootId);
        if (!existing) {
            createRoot(db, { id: rootId, name: bundle.root.name ?? '' });
            db.prepare(`UPDATE roots SET name = ?, created_at = ? WHERE id = ?`).run(bundle.root.name, bundle.root.created_at ?? Date.now(), rootId);
        }
        else {
            db.prepare(`UPDATE roots SET name = ? WHERE id = ?`).run(bundle.root.name, rootId);
        }
        db.prepare(`DELETE FROM resources WHERE root_id = ?`).run(rootId);
        const insert = db.prepare(`INSERT INTO resources (
         id, root_id, rel_path, rel_path_key, kind, size, mtime_ms, content_hash, fs_file_id, missing, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`);
        for (const resource of bundle.resources) {
            const logical = normalizeRelPath(resource.rel_path);
            insert.run(resource.id, rootId, logical, pathKey(logical), resource.kind, resource.size, resource.mtime_ms, resource.content_hash, resource.missing, resource.created_at, resource.updated_at);
        }
    });
    tx();
    if (options.localPath)
        setMount(db, rootId, options.localPath);
    return rootId;
}
export function newResourceId() {
    return randomUUID();
}
//# sourceMappingURL=portable.js.map