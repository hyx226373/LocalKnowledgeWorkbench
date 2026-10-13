import fs from 'node:fs';
import Database from 'better-sqlite3';
import { DEFAULT_CATALOG_ID } from '../../shared/catalog';
import { splitLegacyItems } from '../../shared/items';
import { mark as startupMark } from '../startupTrace';
import { reopenAfterIoError } from './openRetry';
import { migrateWebSources } from './webSources';
import { ensureRootRetirementSchema } from './rootGeneration';
import { ensureWorkspaceRootInstances } from './workspaceRootInstance';
export { WEB_SOURCES_VERSION } from './webSources';

export type DB = Database.Database;

/**
 * 数据模型要点：
 * - 路径不是身份：每个文件/目录有稳定的 resources.id（UUID），位置 = root_id + rel_path，可随重命名/移动更新。
 * - roots 只存“逻辑根”；本机实际路径放在 root_mounts（机器本地）。迁移到新电脑 = 改 root_mounts。
 * - roots.kind：folder | file（旧行 folder）。filter_json 默认 {"extensions":[]}，筛选行为不在本迁移里。
 * - resources.out_of_scope：0/1，默认 0。与 missing_since 分开。1 表示曾经登记、现在被筛选排除。
 * - favorites / 布局中的标签页 / 将来的 notes、links 一律引用 resource_id。
 */
const MIGRATIONS: Array<string | ((db: DB) => void)> = [
  `
  CREATE TABLE roots (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'folder' CHECK (kind IN ('folder','file')),
    filter_json TEXT NOT NULL DEFAULT '{"extensions":[]}'
  );
  CREATE TABLE root_mounts (
    root_id     TEXT PRIMARY KEY REFERENCES roots(id) ON DELETE CASCADE,
    local_path  TEXT NOT NULL,
    machine_id  TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE TABLE resources (
    id            TEXT PRIMARY KEY,
    root_id       TEXT NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
    rel_path      TEXT NOT NULL,
    rel_path_key  TEXT NOT NULL,
    name          TEXT NOT NULL,
    ext           TEXT NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('file','dir')),
    size          INTEGER NOT NULL DEFAULT 0,
    mtime_ms      INTEGER NOT NULL DEFAULT 0,
    file_key      TEXT,
    content_hash  TEXT,
    missing_since INTEGER,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    UNIQUE (root_id, rel_path)
  );
  CREATE INDEX resources_key ON resources(root_id, rel_path_key);
  CREATE INDEX resources_filekey ON resources(root_id, file_key);
  CREATE INDEX resources_sizemtime ON resources(root_id, size, mtime_ms);
  CREATE VIRTUAL TABLE resources_fts USING fts5(
    resource_id UNINDEXED, root_id UNINDEXED, rel_path, name, tokenize = 'trigram'
  );
  CREATE TABLE favorites (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    resource_id TEXT NOT NULL UNIQUE REFERENCES resources(id) ON DELETE CASCADE,
    label       TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE layout (
    key         TEXT PRIMARY KEY,
    json        TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE TABLE op_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    actor       TEXT NOT NULL,
    op          TEXT NOT NULL,
    resource_id TEXT,
    root_id     TEXT NOT NULL,
    rel_path    TEXT NOT NULL,
    detail_json TEXT NOT NULL,
    undone_at   INTEGER
  );
  CREATE TABLE blobs (
    hash        TEXT PRIMARY KEY,
    size        INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE index_state (
    root_id      TEXT PRIMARY KEY REFERENCES roots(id) ON DELETE CASCADE,
    last_scan_at INTEGER,
    last_error   TEXT,
    file_count   INTEGER NOT NULL DEFAULT 0
  );
  `,
  // v2：插件状态与按插件隔离的存储命名空间
  `
  CREATE TABLE plugins (
    id           TEXT PRIMARY KEY,
    version      TEXT NOT NULL,
    source       TEXT NOT NULL CHECK (source IN ('builtin','user')),
    enabled      INTEGER NOT NULL DEFAULT 1,
    granted_json TEXT NOT NULL DEFAULT '[]',   -- 用户已授予的权限
    installed_at INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );
  CREATE TABLE plugin_kv (
    plugin_id  TEXT NOT NULL,
    key        TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (plugin_id, key)
  );
  `,
  // v3：命名工作区（全局，可按项目分组，可引用多个根）。layout_json 内部自带 schema 版本号。
  `
  CREATE TABLE workspaces (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    project        TEXT NOT NULL DEFAULT '',
    layout_json    TEXT NOT NULL,
    layout_schema  INTEGER NOT NULL,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    last_opened_at INTEGER
  );
  `,
  // v4：项目表（H1）。布局 schema 3（条目内联）→ schema 4（布局只有 dock/shell，面板参数只有 itemId）；
  //     插件授权改为结构化 PermissionGrant[]（旧的字符串权限作废，重新询问）；卸载但保留数据的插件用 uninstalled_at 标记。
  (db: DB) => {
    db.exec(`
      CREATE TABLE workspace_items (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        item_id      TEXT NOT NULL,
        source_kind  TEXT NOT NULL CHECK (source_kind IN ('file','web','app')),
        adapter_id   TEXT NOT NULL,
        ref          TEXT NOT NULL,
        display_mode TEXT NOT NULL,
        state_json   TEXT,
        title        TEXT,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, item_id)
      );
      CREATE INDEX workspace_items_adapter ON workspace_items(adapter_id);
      -- plugins：source 增加 'adapter'（第三方沙箱适配器插件，开发者模式安装），新增 uninstalled_at；SQLite 不能改 CHECK，重建表
      CREATE TABLE plugins_v4 (
        id             TEXT PRIMARY KEY,
        version        TEXT NOT NULL,
        source         TEXT NOT NULL CHECK (source IN ('builtin','user','adapter')),
        enabled        INTEGER NOT NULL DEFAULT 1,
        granted_json   TEXT NOT NULL DEFAULT '[]',   -- 结构化授权 PermissionGrant[]（含 scope 与 declHash）
        installed_at   INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        uninstalled_at INTEGER
      );
      INSERT INTO plugins_v4(id, version, source, enabled, granted_json, installed_at, updated_at)
        SELECT id, version, source, enabled, '[]', installed_at, updated_at FROM plugins;
      DROP TABLE plugins;
      ALTER TABLE plugins_v4 RENAME TO plugins;
    `);
    const rows = db.prepare('SELECT id, layout_json FROM workspaces').all() as { id: string; layout_json: string }[];
    const ins = db.prepare(
      'INSERT OR REPLACE INTO workspace_items(workspace_id,item_id,source_kind,adapter_id,ref,display_mode,state_json,title,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    );
    const now = Date.now();
    for (const r of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.layout_json);
      } catch {
        continue;
      }
      const { layout, items } = splitLegacyItems(parsed);
      if (layout === parsed) continue; // 不是 schema 3：原样保留（1/2 由渲染进程打开时迁移）
      for (const it of items) ins.run(r.id, it.itemId, it.sourceKind, it.adapterId, it.ref, it.displayMode, it.state ? JSON.stringify(it.state) : null, it.title ?? null, now, now);
      db.prepare('UPDATE workspaces SET layout_json=?, layout_schema=4 WHERE id=?').run(JSON.stringify(layout), r.id);
    }
  },
  // v5（第五轮）：插件审计记录（授权拒绝、越界读取、批量计划、看门狗）。不随插件行删除（卸载保留数据时保留），删除数据时一并删除。
  `CREATE TABLE plugin_audit(
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at INTEGER NOT NULL,
     last_at INTEGER NOT NULL,
     plugin_id TEXT NOT NULL,
     adapter_id TEXT,
     kind TEXT NOT NULL,
     code TEXT,
     detail TEXT NOT NULL,
     count INTEGER NOT NULL DEFAULT 1
   );
   CREATE INDEX idx_plugin_audit ON plugin_audit(plugin_id, id);`,
];

export const DB_VERSION = MIGRATIONS.length;

/**
 * r12-P1：workspaces.catalog_id。
 * 不进入 MIGRATIONS，不改 PRAGMA user_version（仍等于 DB_VERSION，当前 5）。
 * 并行块不要复用 1201，各自用独立函数和自己的号。
 */
export const WORKSPACES_CATALOG_ID_VERSION = 1201;

export function migrateWorkspacesCatalogId(db: DB): void {
  const table = db.prepare("SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'").get() as { n: number } | undefined;
  if (!table) return;
  const cols = db.prepare('PRAGMA table_info(workspaces)').all() as { name: string }[];
  if (cols.some((c) => c.name === 'catalog_id')) return;
  if (!/^[A-Za-z0-9_-]+$/.test(DEFAULT_CATALOG_ID)) throw new Error('catalog id');
  db.exec(`ALTER TABLE workspaces ADD COLUMN catalog_id TEXT DEFAULT '${DEFAULT_CATALOG_ID}'`);
  db.prepare('UPDATE workspaces SET catalog_id = ? WHERE catalog_id IS NULL').run(DEFAULT_CATALOG_ID);
}

/** 空访问范围。筛选语义在后续块，这里只保证列上有合法 JSON。 */
export const EMPTY_ROOT_FILTER_JSON = '{"extensions":[]}';

/**
 * r12-P2 的迁移名（不是 user_version）。
 * 不占用 MIGRATIONS 下标，避免和并行块抢同一个版本号。
 */
export const ROOTS_SOURCE_MIGRATION_ID = 'r12-p2-roots-kind-filter';

/**
 * 给已有库补 roots.kind / filter_json。幂等，不改 user_version。
 * 旧 roots 没有 CHECK；当前 SQLite 能在 ADD COLUMN 上加 CHECK，不必按 v4 重建
 * （roots 被 root_mounts / resources / index_state 外键引用，重建会牵动这些表）。
 */
export function migrateRootsKindAndFilter(db: DB): void {
  const cols = db.prepare('PRAGMA table_info(roots)').all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  if (names.has('kind') && names.has('filter_json')) return;
  if (!names.has('kind')) {
    db.exec("ALTER TABLE roots ADD COLUMN kind TEXT NOT NULL DEFAULT 'folder' CHECK (kind IN ('folder','file'))");
  }
  if (!names.has('filter_json')) {
    db.exec(`ALTER TABLE roots ADD COLUMN filter_json TEXT NOT NULL DEFAULT '${EMPTY_ROOT_FILTER_JSON}'`);
  }
}

/**
 * r12-P3：resources.out_of_scope。
 * 不进入 MIGRATIONS，不改 PRAGMA user_version（仍等于 DB_VERSION，当前 5）。
 * 不复用 missing_since，不占用 1201 / 1206。
 */
export const RESOURCES_OUT_OF_SCOPE_VERSION = 1203;

export function migrateResourcesOutOfScope(db: DB): void {
  const table = db.prepare("SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = 'resources'").get() as { n: number } | undefined;
  if (!table) return;
  const cols = db.prepare('PRAGMA table_info(resources)').all() as { name: string }[];
  if (cols.some((c) => c.name === 'out_of_scope')) return;
  db.exec('ALTER TABLE resources ADD COLUMN out_of_scope INTEGER NOT NULL DEFAULT 0');
}

const OPEN_PAUSE = new Int32Array(new SharedArrayBuffer(4));

/** 上次进程被杀掉时，WAL 索引可能还被系统映射着，第一次 journal_mode 会报 IOERR_TRUNCATE。关掉重试。 */
export function openDb(file: string): DB {
  startupMark('main:db-construct');
  let last: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (attempt > 0) {
      try { fs.rmSync(`${file}-shm`, { force: true }); } catch { /* 还有人映射着就等下一次 */ }
    }
    const db = new Database(file);
    try {
      if (attempt === 0) startupMark('main:db-opened');
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      db.pragma('busy_timeout = 5000'); // 锁等待上限 5s，不是 10s
      db.pragma('temp_store = FILE');
      db.pragma('max_page_count = 4294967294');
      startupMark('main:db-pragmas');
      migrate(db);
      startupMark('main:db-migrated');
      return db;
    } catch (err) {
      last = err;
      try { db.close(); } catch { /* 连接已经坏了 */ }
      const message = String((err as Error).message ?? err);
      if (!reopenAfterIoError(message, attempt)) throw err;
      Atomics.wait(OPEN_PAUSE, 0, 0, 250);
    }
  }
  throw last;
}

/**
 * 界面读取用的第二条连接。WAL 下不拿写锁。
 * 打不开就返回 null，调用方改走写连接，避免库还不能读时整个进程起不来。
 * 不用 file: URI 的 mode=ro：Windows 上 WAL 的 shm 会 SQLITE_CANTOPEN。
 */
export function openReadDb(file: string): DB | null {
  try {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 5000');
    db.pragma('query_only = ON');
    return db;
  } catch (err) {
    console.error('[db] 只读连接打开失败，读取改走写连接', err);
    return null;
  }
}

function migrate(db: DB) {
  const v = db.pragma('user_version', { simple: true }) as number;
  for (let i = v; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      const m = MIGRATIONS[i];
      if (typeof m === 'string') db.exec(m);
      else m(db);
      db.pragma(`user_version = ${i + 1}`);
    }).immediate();
  }
  db.transaction(() => {
    migrateWorkspacesCatalogId(db);
  }).immediate();
  migrateRootsKindAndFilter(db);
  // r12-P6：web_sources 视图。不进 MIGRATIONS，不改 user_version。号是 1206，不要复用 P1 的 1201。
  db.transaction(() => {
    migrateWebSources(db);
  }).immediate();
  // r12-P3：访问范围标记。不进 MIGRATIONS，不改 user_version。号是 1203。
  db.transaction(() => {
    migrateResourcesOutOfScope(db);
  }).immediate();
  // r14：根属于工作区。不进 MIGRATIONS，不改 user_version。只插入归属，不删资料，不删引用。
  db.transaction(() => {
    migrateWorkspaceRoots(db);
  }).immediate();
  // r14-029：根退休。不进 MIGRATIONS，不改 user_version。号是 1209，不要复用 1201、1203、1206。
  ensureRootRetirementSchema(db);
  // r14-029 修订：工作区根实例。不进 MIGRATIONS，不改 user_version。号是 1210。
  ensureWorkspaceRootInstances(db);
}

/** 打开库时记下来的、无法判断归属而归到上次打开的工作区的根。 */
export const WORKSPACE_ROOT_FALLBACK_KEY = 'meta.workspaceRootFallback';

export interface WorkspaceRootFallback {
  rootId: string;
  name: string;
  workspaceId: string;
  workspaceName: string;
}

export function migrateWorkspaceRoots(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_roots (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      root_id TEXT NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
      PRIMARY KEY (workspace_id, root_id)
    );
    CREATE INDEX IF NOT EXISTS workspace_roots_root ON workspace_roots(root_id);
  `);
  const fallback = lastOpenedWorkspace(db);
  if (fallback) claimUnownedRoots(db, fallback.id);
}

export function workspaceRootFallbacks(db: DB): WorkspaceRootFallback[] {
  const row = db.prepare('SELECT json FROM layout WHERE key = ?').get(WORKSPACE_ROOT_FALLBACK_KEY) as { json: string } | undefined;
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item && typeof item.rootId === 'string' && typeof item.workspaceId === 'string') as WorkspaceRootFallback[];
  } catch {
    return [];
  }
}

/** 还没有归属的根：能从条目或引用看出来的，登记到那些工作区；看不出来的归到 fallback。hidden = 1 的退休根不挂回去。 */
export function claimUnownedRoots(db: DB, fallbackWorkspaceId: string): WorkspaceRootFallback[] {
  const fallback = db.prepare('SELECT id, name FROM workspaces WHERE id = ?').get(fallbackWorkspaceId) as { id: string; name: string } | undefined;
  if (!fallback) return [];
  const retirementReady = db.prepare(
    "SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = 'root_retirements'",
  ).get() as { n: number } | undefined;
  const roots = db.prepare(
    `SELECT r.id, r.name FROM roots r
     WHERE NOT EXISTS (SELECT 1 FROM workspace_roots wr WHERE wr.root_id = r.id)
     ${retirementReady ? 'AND NOT EXISTS (SELECT 1 FROM root_retirements rr WHERE rr.root_id = r.id AND rr.hidden = 1)' : ''}`,
  ).all() as { id: string; name: string }[];
  if (!roots.length) return [];
  const ins = db.prepare('INSERT OR IGNORE INTO workspace_roots(workspace_id, root_id) VALUES (?, ?)');
  const fallen: WorkspaceRootFallback[] = [];
  for (const root of roots) {
    const owners = workspacesReferencingRoot(db, root.id);
    if (owners.length) {
      for (const workspaceId of owners) ins.run(workspaceId, root.id);
      continue;
    }
    ins.run(fallback.id, root.id);
    fallen.push({ rootId: root.id, name: root.name, workspaceId: fallback.id, workspaceName: fallback.name });
  }
  if (fallen.length) rememberRootFallback(db, fallen);
  ensureWorkspaceRootInstances(db);
  return fallen;
}

function lastOpenedWorkspace(db: DB): { id: string } | undefined {
  const current = db.prepare("SELECT json FROM layout WHERE key = 'workspace.current'").get() as { json: string } | undefined;
  if (current) {
    try {
      const id = JSON.parse(current.json);
      if (typeof id === 'string' && db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(id)) return { id };
    } catch {
      /* 当前工作区记坏了就看上次打开 */
    }
  }
  return db.prepare('SELECT id FROM workspaces ORDER BY last_opened_at DESC NULLS LAST, updated_at DESC LIMIT 1').get() as { id: string } | undefined;
}

function workspacesReferencingRoot(db: DB, rootId: string): string[] {
  const ids = new Set<string>();
  const fromItems = db.prepare(
    `SELECT DISTINCT wi.workspace_id AS id
     FROM workspace_items wi
     JOIN resources r ON r.id = wi.ref
     WHERE wi.source_kind = 'file' AND r.root_id = ?`,
  ).all(rootId) as { id: string }[];
  for (const row of fromItems) ids.add(row.id);
  const resourceIds = new Set((db.prepare('SELECT id FROM resources WHERE root_id = ?').all(rootId) as { id: string }[]).map((row) => row.id));
  if (!resourceIds.size) return [...ids];
  const refs = db.prepare("SELECT key, json FROM layout WHERE key LIKE 'workspace.refs:%'").all() as { key: string; json: string }[];
  for (const row of refs) {
    const workspaceId = row.key.slice('workspace.refs:'.length);
    if (!workspaceId || ids.has(workspaceId)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.json);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    if (parsed.some((item) => item && typeof item === 'object' && resourceIds.has(String((item as { id?: unknown }).id ?? '')))) ids.add(workspaceId);
  }
  const layouts = db.prepare('SELECT id, layout_json FROM workspaces').all() as { id: string; layout_json: string }[];
  for (const workspace of layouts) {
    if (ids.has(workspace.id)) continue;
    if (layoutMentionsResources(workspace.layout_json, resourceIds)) ids.add(workspace.id);
  }
  return [...ids];
}

function layoutMentionsResources(json: string, resourceIds: Set<string>): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return false;
  }
  const found: string[] = [];
  collectResourceRefs(parsed, found);
  return found.some((id) => resourceIds.has(id));
}

function collectResourceRefs(node: unknown, found: string[]): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectResourceRefs(item, found);
    return;
  }
  const record = node as Record<string, unknown>;
  if (typeof record.resourceId === 'string') found.push(record.resourceId);
  if (record.sourceKind === 'file' && typeof record.ref === 'string') found.push(record.ref);
  for (const value of Object.values(record)) collectResourceRefs(value, found);
}

function rememberRootFallback(db: DB, rows: WorkspaceRootFallback[]): void {
  const merged = workspaceRootFallbacks(db);
  const seen = new Set(merged.map((row) => row.rootId));
  for (const row of rows) {
    if (seen.has(row.rootId)) continue;
    seen.add(row.rootId);
    merged.push(row);
  }
  db.prepare(
    `INSERT INTO layout(key, json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
  ).run(WORKSPACE_ROOT_FALLBACK_KEY, JSON.stringify(merged), Date.now());
}
