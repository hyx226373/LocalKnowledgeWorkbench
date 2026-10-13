import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logicalRelPath, pathKey } from "./pathutil.js";
let cachedMachineId = null;
export function machineId() {
    if (cachedMachineId)
        return cachedMachineId;
    const raw = `${os.hostname()}\0${os.userInfo().username}\0${os.platform()}`;
    cachedMachineId = createHash('sha256').update(raw).digest('hex');
    return cachedMachineId;
}
export function migrate(db) {
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.exec(`
    CREATE TABLE IF NOT EXISTS roots (
      id TEXT PRIMARY KEY,
      name TEXT,
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS root_mounts (
      root_id TEXT NOT NULL,
      machine_id TEXT NOT NULL,
      local_path TEXT NOT NULL,
      updated_at INTEGER,
      PRIMARY KEY (root_id, machine_id)
    );

    CREATE TABLE IF NOT EXISTS resources (
      id TEXT PRIMARY KEY,
      root_id TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      rel_path_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('file', 'dir')),
      size INTEGER,
      mtime_ms INTEGER,
      content_hash TEXT,
      fs_file_id TEXT,
      missing INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER,
      updated_at INTEGER
    );
  `);
    const tx = db.transaction(() => {
        if (legacyResourceUnique(db))
            rebuildResources(db);
        restoreLegacyMissingPaths(db);
        dropFullPathUniqueIndexes(db);
        db.exec(`
      CREATE INDEX IF NOT EXISTS idx_resources_root ON resources(root_id);
      CREATE INDEX IF NOT EXISTS idx_resources_fs_file ON resources(root_id, fs_file_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_resources_live_path ON resources(root_id, rel_path_key) WHERE missing = 0;
    `);
    });
    tx();
}
function legacyResourceUnique(db) {
    const row = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'resources'`)
        .get();
    return !!row?.sql && /UNIQUE\s*\(/i.test(row.sql);
}
function rebuildResources(db) {
    // SQLite 不能 ALTER 掉表级 UNIQUE，只能建新表再拷走。
    db.exec(`
    DROP TABLE IF EXISTS resources_new;
    CREATE TABLE resources_new (
      id TEXT PRIMARY KEY,
      root_id TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      rel_path_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('file', 'dir')),
      size INTEGER,
      mtime_ms INTEGER,
      content_hash TEXT,
      fs_file_id TEXT,
      missing INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER,
      updated_at INTEGER
    );
    INSERT INTO resources_new (
      id, root_id, rel_path, rel_path_key, kind, size, mtime_ms, content_hash,
      fs_file_id, missing, created_at, updated_at
    )
    SELECT
      id, root_id, rel_path, rel_path_key, kind, size, mtime_ms, content_hash,
      fs_file_id, missing, created_at, updated_at
    FROM resources;
    DROP TABLE resources;
    ALTER TABLE resources_new RENAME TO resources;
  `);
}
function restoreLegacyMissingPaths(db) {
    const rows = db
        .prepare(`SELECT id, rel_path FROM resources WHERE rel_path LIKE '//missing/%'`)
        .all();
    if (rows.length === 0)
        return;
    const upd = db.prepare(`UPDATE resources SET rel_path = ?, rel_path_key = ? WHERE id = ?`);
    for (const row of rows) {
        const logical = logicalRelPath(row.rel_path);
        upd.run(logical, pathKey(logical), row.id);
    }
}
function dropFullPathUniqueIndexes(db) {
    const indexes = db
        .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'resources'`)
        .all();
    for (const index of indexes) {
        if (!index.sql || !/\bUNIQUE\b/i.test(index.sql))
            continue;
        if (/WHERE\s+missing\s*=\s*0/i.test(index.sql))
            continue;
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(index.name))
            continue;
        db.exec(`DROP INDEX "${index.name}"`);
    }
}
/** 只插入 roots。不写 local_path，也不要求目录已经存在。 */
export function createRoot(db, input) {
    if (!input || typeof input !== 'object' || typeof input.name !== 'string') {
        throw new Error('createRoot expects { id?, name }');
    }
    if (input.id != null && typeof input.id !== 'string')
        throw new Error('root id must be a string');
    const id = input.id ?? randomUUID();
    if (id.length === 0)
        throw new Error('root id is empty');
    const exists = db.prepare(`SELECT id FROM roots WHERE id = ?`).get(id);
    if (exists)
        throw new Error(`root already exists: ${id}`);
    db.prepare(`INSERT INTO roots (id, name, created_at) VALUES (?, ?, ?)`).run(id, input.name, Date.now());
    return id;
}
export function getMount(db, rootId) {
    const row = db
        .prepare(`SELECT local_path FROM root_mounts WHERE root_id = ? AND machine_id = ?`)
        .get(rootId, machineId());
    if (!row)
        throw new Error(`root is not mounted on this machine: ${rootId}`);
    return row.local_path;
}
/** 本包唯一写入 root_mounts.local_path 的入口。目录必须已经存在。 */
export function setMount(db, rootId, localPath) {
    if (!rootRow(db, rootId))
        throw new Error(`unknown root: ${rootId}`);
    if (!fs.existsSync(localPath) || !fs.statSync(localPath).isDirectory()) {
        throw new Error('mount path is not a directory');
    }
    const abs = fs.realpathSync(localPath);
    const now = Date.now();
    const mid = machineId();
    const existing = db
        .prepare(`SELECT root_id FROM root_mounts WHERE root_id = ? AND machine_id = ?`)
        .get(rootId, mid);
    if (existing) {
        db.prepare(`UPDATE root_mounts SET local_path = ?, updated_at = ? WHERE root_id = ? AND machine_id = ?`).run(abs, now, rootId, mid);
    }
    else {
        db.prepare(`INSERT INTO root_mounts (root_id, machine_id, local_path, updated_at) VALUES (?, ?, ?, ?)`).run(rootId, mid, abs, now);
    }
}
export function loadResources(db, rootId) {
    return db.prepare(`SELECT * FROM resources WHERE root_id = ?`).all(rootId);
}
export function rowById(db, id) {
    return db.prepare(`SELECT * FROM resources WHERE id = ?`).get(id);
}
/** 同一路径可以有多条 missing=1。这里只要当前还在的那条。 */
export function rowByPathKey(db, rootId, key) {
    return db
        .prepare(`SELECT * FROM resources WHERE root_id = ? AND rel_path_key = ? AND missing = 0`)
        .get(rootId, key);
}
export function toSnapshot(row, displaced = false) {
    return {
        id: row.id,
        rootId: row.root_id,
        relPath: row.rel_path,
        displaced,
        kind: row.kind,
        size: row.size,
        mtimeMs: row.mtime_ms,
        contentHash: row.content_hash,
        fsFileId: row.fs_file_id,
        missing: row.missing,
    };
}
export function snapshotById(db, rootId) {
    const rows = loadResources(db, rootId);
    const live = new Set(rows.filter((row) => row.missing === 0).map((row) => row.rel_path_key));
    return new Map(rows.map((row) => [row.id, toSnapshot(row, row.missing === 1 && live.has(row.rel_path_key))]));
}
export function getResource(db, id) {
    const row = rowById(db, id);
    if (!row)
        return null;
    if (row.missing !== 1)
        return toSnapshot(row, false);
    const live = db
        .prepare(`SELECT 1 AS ok FROM resources WHERE root_id = ? AND rel_path_key = ? AND missing = 0 LIMIT 1`)
        .get(row.root_id, row.rel_path_key);
    return toSnapshot(row, live != null);
}
export function listResources(db, rootId) {
    return [...snapshotById(db, rootId).values()].sort((a, b) => a.relPath.localeCompare(b.relPath) || a.id.localeCompare(b.id));
}
export function rootRow(db, rootId) {
    return db.prepare(`SELECT id, name, created_at FROM roots WHERE id = ?`).get(rootId);
}
export function databasePath(db) {
    const name = db.name;
    if (!name || name === ':memory:') {
        throw new Error('reconcile requires a file-backed database');
    }
    return path.resolve(name);
}
//# sourceMappingURL=db.js.map