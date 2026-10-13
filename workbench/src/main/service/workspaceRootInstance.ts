/**
 * 外贴 29 修订 C3：工作区根实例。
 * 资料源仍是 roots.id。每个工作区对同一资料源有自己的名称、排序和筛选。
 * 不进 MIGRATIONS，不改 user_version。号是 1210。
 */
import crypto from 'node:crypto';
import type { DB } from './db';

export const WORKSPACE_ROOT_INSTANCE_VERSION = 1210;

const EMPTY_FILTER = '{"extensions":[]}';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workspace_root_instances (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  filter_json TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  publishable INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (workspace_id, source_id)
);
CREATE INDEX IF NOT EXISTS workspace_root_instances_source ON workspace_root_instances(source_id);
`;

interface InstanceRow {
  id: string;
  workspace_id: string;
  source_id: string;
  name: string;
  sort_order: number;
  filter_json: string;
  generation: number;
  hidden: number;
  publishable: number;
  created_at: number;
  updated_at: number;
}

export interface WorkspaceRootInstance {
  id: string;
  workspaceId: string;
  sourceId: string;
  name: string;
  sortOrder: number;
  filterJson: string;
  generation: number;
  hidden: boolean;
  publishable: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface InstancePatch {
  name?: string;
  filterJson?: string;
  sortOrder?: number;
  /** 重新登记时揭开本工作区实例。改筛选不要传。 */
  reveal?: boolean;
}

function tableReady(db: DB): boolean {
  return Boolean(db.prepare("SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = 'workspace_root_instances'").get());
}

function mapRow(row: InstanceRow): WorkspaceRootInstance {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sourceId: row.source_id,
    name: row.name,
    sortOrder: row.sort_order,
    filterJson: row.filter_json,
    generation: row.generation,
    hidden: row.hidden === 1,
    publishable: row.publishable === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 建表，并把还没有实例的 workspace_roots 补上。已有实例不覆盖。 */
export function ensureWorkspaceRootInstances(db: DB): void {
  db.exec(SCHEMA_SQL);
  const missing = db.prepare(
    `SELECT wr.workspace_id, wr.root_id, r.name, r.filter_json
     FROM workspace_roots wr
     JOIN roots r ON r.id = wr.root_id
     WHERE NOT EXISTS (
       SELECT 1 FROM workspace_root_instances i
       WHERE i.workspace_id = wr.workspace_id AND i.source_id = wr.root_id
     )`,
  ).all() as { workspace_id: string; root_id: string; name: string; filter_json: string | null }[];
  if (!missing.length) return;
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO workspace_root_instances (
       id, workspace_id, source_id, name, sort_order, filter_json,
       generation, hidden, publishable, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 0, ?, 0, 0, 1, ?, ?)`,
  );
  for (const row of missing) {
    insert.run(crypto.randomUUID(), row.workspace_id, row.root_id, row.name, row.filter_json || EMPTY_FILTER, now, now);
  }
}

export function readInstance(db: DB, workspaceId: string, sourceId: string): WorkspaceRootInstance | null {
  if (!tableReady(db)) return null;
  const row = db.prepare(
    `SELECT id, workspace_id, source_id, name, sort_order, filter_json, generation, hidden, publishable, created_at, updated_at
     FROM workspace_root_instances WHERE workspace_id = ? AND source_id = ?`,
  ).get(workspaceId, sourceId) as InstanceRow | undefined;
  return row ? mapRow(row) : null;
}

/**
 * 登记或更新当前工作区的实例。不写 roots.name，不改其他工作区。
 * 没有行时，缺的名称和筛选从资料源复制。
 */
export function upsertInstance(db: DB, workspaceId: string, sourceId: string, patch: InstancePatch = {}): WorkspaceRootInstance {
  ensureWorkspaceRootInstances(db);
  const now = Date.now();
  const existing = readInstance(db, workspaceId, sourceId);
  if (!existing) {
    const root = db.prepare('SELECT name, filter_json FROM roots WHERE id = ?').get(sourceId) as { name: string; filter_json: string | null } | undefined;
    const name = patch.name ?? root?.name ?? '';
    const filterJson = patch.filterJson ?? root?.filter_json ?? EMPTY_FILTER;
    const sortOrder = patch.sortOrder ?? 0;
    db.prepare(
      `INSERT INTO workspace_root_instances (
         id, workspace_id, source_id, name, sort_order, filter_json,
         generation, hidden, publishable, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 1, ?, ?)`,
    ).run(crypto.randomUUID(), workspaceId, sourceId, name, sortOrder, filterJson, now, now);
  } else {
    const reveal = patch.reveal ? 1 : 0;
    db.prepare(
      `UPDATE workspace_root_instances
       SET name = COALESCE(?, name),
           filter_json = COALESCE(?, filter_json),
           sort_order = COALESCE(?, sort_order),
           hidden = CASE WHEN ? = 1 THEN 0 ELSE hidden END,
           publishable = CASE WHEN ? = 1 THEN 1 ELSE publishable END,
           updated_at = ?
       WHERE workspace_id = ? AND source_id = ?`,
    ).run(
      patch.name ?? null,
      patch.filterJson ?? null,
      patch.sortOrder ?? null,
      reveal,
      reveal,
      now,
      workspaceId,
      sourceId,
    );
  }
  return readInstance(db, workspaceId, sourceId)!;
}

/** 除了当前工作区，还有几个未隐藏的实例。没有实例行的 workspace_roots 也算存活。 */
export function liveOtherCount(db: DB, sourceId: string, workspaceId: string): number {
  if (!tableReady(db)) {
    const row = db.prepare('SELECT COUNT(*) AS n FROM workspace_roots WHERE root_id = ? AND workspace_id <> ?').get(sourceId, workspaceId) as { n: number };
    return row.n;
  }
  const live = db.prepare(
    'SELECT COUNT(*) AS n FROM workspace_root_instances WHERE source_id = ? AND workspace_id <> ? AND hidden = 0',
  ).get(sourceId, workspaceId) as { n: number };
  const bare = db.prepare(
    `SELECT COUNT(*) AS n FROM workspace_roots wr
     WHERE wr.root_id = ? AND wr.workspace_id <> ?
       AND NOT EXISTS (
         SELECT 1 FROM workspace_root_instances i
         WHERE i.workspace_id = wr.workspace_id AND i.source_id = wr.root_id
       )`,
  ).get(sourceId, workspaceId) as { n: number };
  return live.n + bare.n;
}

/** 还有没有工作区在用这份资料。隐藏实例不算。没有实例表时退回 workspace_roots。 */
export function countLiveInstances(db: DB, sourceId: string): number {
  if (!tableReady(db)) {
    const row = db.prepare('SELECT COUNT(*) AS n FROM workspace_roots WHERE root_id = ?').get(sourceId) as { n: number };
    return row.n;
  }
  const live = db.prepare(
    'SELECT COUNT(*) AS n FROM workspace_root_instances WHERE source_id = ? AND hidden = 0',
  ).get(sourceId) as { n: number };
  const bare = db.prepare(
    `SELECT COUNT(*) AS n FROM workspace_roots wr
     WHERE wr.root_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM workspace_root_instances i
         WHERE i.workspace_id = wr.workspace_id AND i.source_id = wr.root_id
       )`,
  ).get(sourceId) as { n: number };
  return live.n + bare.n;
}

/** 退休代次写完后，把同一个数抄到已有实例上。没有实例则不动。 */
export function syncInstanceGate(db: DB, sourceId: string, workspaceId: string, generation: number, hidden: boolean): void {
  if (!tableReady(db)) return;
  db.prepare(
    `UPDATE workspace_root_instances
     SET generation = ?, hidden = ?, publishable = ?, updated_at = ?
     WHERE source_id = ? AND workspace_id = ?`,
  ).run(generation, hidden ? 1 : 0, hidden ? 0 : 1, Date.now(), sourceId, workspaceId);
}
