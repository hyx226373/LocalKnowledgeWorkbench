/**
 * 外贴 29：根退休代次。
 * 短事务只改登记和退休行。不删 resources_fts，不删 roots，不挪磁盘。
 */
import type { RootOpKind, RootPublishSnapshot, RootTask, RootTaskState } from '../../shared/rootTask';
import { shouldPublish } from '../../shared/rootTask';
import type { DB } from './db';
import { syncInstanceGate } from './workspaceRootInstance';

export const ROOT_RETIREMENT_VERSION = 1209;

export interface RetireRootInput {
  rootId: string;
  workspaceId: string;
  kind: RootOpKind;
  diskPath: string;
  taskId: string;
  /** 只有当前资料源已经没有其他存活实例时，调用方才传 true。缺省不打全局 missing_since。 */
  markMissing?: boolean;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS root_retirements (
  root_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  kind TEXT NOT NULL,
  hidden INTEGER NOT NULL,
  publishable INTEGER NOT NULL,
  phase_text TEXT NOT NULL,
  error TEXT,
  task_id TEXT NOT NULL,
  disk_path TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (root_id, workspace_id)
);
`;

interface RetirementRow {
  root_id: string;
  workspace_id: string;
  generation: number;
  kind: string;
  hidden: number;
  publishable: number;
  phase_text: string;
  error: string | null;
  task_id: string;
  disk_path: string;
  state: string;
  created_at: number;
  updated_at: number;
}

const SELECT_ROW = `SELECT root_id, workspace_id, generation, kind, hidden, publishable, phase_text, error, task_id, disk_path, state, created_at, updated_at FROM root_retirements`;

export function ensureRootRetirementSchema(db: DB): void {
  db.exec(SCHEMA_SQL);
}

function readRow(db: DB, rootId: string, workspaceId: string): RetirementRow | undefined {
  return db.prepare(`${SELECT_ROW} WHERE root_id = ? AND workspace_id = ?`).get(rootId, workspaceId) as RetirementRow | undefined;
}

function mapTask(row: RetirementRow): RootTask {
  return {
    taskId: row.task_id,
    rootId: row.root_id,
    workspaceId: row.workspace_id,
    generation: row.generation,
    kind: row.kind as RootOpKind,
    state: row.state as RootTaskState,
    phaseText: row.phase_text,
    error: row.error,
    diskPath: row.disk_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 只写传入的那一个工作区，并把代次抄到该工作区的实例上。 */
function writeHidden(db: DB, input: RetireRootInput, workspaceId: string, now: number): RootTask {
  const existing = readRow(db, input.rootId, workspaceId);
  const generation = (existing?.generation ?? 0) + 1;
  const createdAt = existing?.created_at ?? now;
  db.prepare(
    `INSERT INTO root_retirements (
       root_id, workspace_id, generation, kind, hidden, publishable,
       phase_text, error, task_id, disk_path, state, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 1, 0, '', NULL, ?, ?, 'queued', ?, ?)
     ON CONFLICT(root_id, workspace_id) DO UPDATE SET
       generation = excluded.generation,
       kind = excluded.kind,
       hidden = 1,
       publishable = 0,
       phase_text = '',
       error = NULL,
       task_id = excluded.task_id,
       disk_path = excluded.disk_path,
       state = 'queued',
       updated_at = excluded.updated_at`,
  ).run(input.rootId, workspaceId, generation, input.kind, input.taskId, input.diskPath, createdAt, now);
  syncInstanceGate(db, input.rootId, workspaceId, generation, true);
  return mapTask(readRow(db, input.rootId, workspaceId)!);
}

export function readPublishSnapshot(db: DB, rootId: string, workspaceId: string): RootPublishSnapshot | null {
  ensureRootRetirementSchema(db);
  const found = db.prepare(
    'SELECT generation, publishable FROM root_retirements WHERE root_id = ? AND workspace_id = ?',
  ).get(rootId, workspaceId) as { generation: number; publishable: number } | undefined;
  if (!found) return null;
  return { generation: found.generation, publishable: found.publishable === 1 };
}

export function retireRoot(db: DB, input: RetireRootInput): { generation: number; task: RootTask } {
  ensureRootRetirementSchema(db);
  const run = db.transaction(() => {
    const now = Date.now();
    if (input.kind === 'delete-disk') {
      const current = writeHidden(db, input, input.workspaceId, now);
      return { generation: current.generation, task: current };
    }
    db.prepare('DELETE FROM workspace_roots WHERE root_id = ? AND workspace_id = ?').run(input.rootId, input.workspaceId);
    const task = writeHidden(db, input, input.workspaceId, now);
    if (input.markMissing) {
      db.prepare('UPDATE resources SET missing_since = COALESCE(missing_since, ?) WHERE root_id = ?').run(now, input.rootId);
    }
    return { generation: task.generation, task };
  });
  // immediate() 即 BEGIN IMMEDIATE：读旧代次和写入同一把写锁。
  return run.immediate();
}

export function patchRootTask(
  db: DB,
  taskId: string,
  patch: Partial<Pick<RootTask, 'state' | 'phaseText' | 'error'>>,
): RootTask | null {
  ensureRootRetirementSchema(db);
  const run = db.transaction(() => {
    const rows = db.prepare(`${SELECT_ROW} WHERE task_id = ? ORDER BY workspace_id`).all(taskId) as RetirementRow[];
    if (!rows.length) return null;
    const now = Date.now();
    const update = db.prepare(
      `UPDATE root_retirements
       SET state = ?, phase_text = ?, error = ?, updated_at = ?
       WHERE root_id = ? AND workspace_id = ?`,
    );
    for (const item of rows) {
      update.run(
        patch.state ?? item.state,
        patch.phaseText ?? item.phase_text,
        patch.error !== undefined ? patch.error : item.error,
        now,
        item.root_id,
        item.workspace_id,
      );
    }
    const next = db.prepare(`${SELECT_ROW} WHERE task_id = ? ORDER BY workspace_id LIMIT 1`).get(taskId) as RetirementRow;
    return mapTask(next);
  });
  return run.immediate();
}

export function listRootTasks(db: DB): RootTask[] {
  ensureRootRetirementSchema(db);
  const rows = db.prepare(`${SELECT_ROW} ORDER BY updated_at DESC, root_id, workspace_id`).all() as RetirementRow[];
  return rows.map(mapTask);
}

export function hiddenRootIds(db: DB, workspaceId: string | null): Set<string> {
  ensureRootRetirementSchema(db);
  if (workspaceId === null) {
    const rows = db.prepare(
      `SELECT DISTINCT rr.root_id AS root_id
       FROM root_retirements rr
       WHERE rr.hidden = 1
         AND NOT EXISTS (SELECT 1 FROM workspace_roots wr WHERE wr.root_id = rr.root_id)`,
    ).all() as { root_id: string }[];
    return new Set(rows.map((item) => item.root_id));
  }
  const rows = db.prepare(
    'SELECT root_id FROM root_retirements WHERE workspace_id = ? AND hidden = 1',
  ).all(workspaceId) as { root_id: string }[];
  return new Set(rows.map((item) => item.root_id));
}

export function restoreRootRecord(db: DB, rootId: string, workspaceId: string): { generation: number } | null {
  ensureRootRetirementSchema(db);
  const run = db.transaction(() => {
    const existing = readRow(db, rootId, workspaceId);
    if (!existing) return null;
    const generation = existing.generation + 1;
    db.prepare(
      `UPDATE root_retirements
       SET hidden = 0, publishable = 1, generation = ?, state = 'cancelled', updated_at = ?
       WHERE root_id = ? AND workspace_id = ?`,
    ).run(generation, Date.now(), rootId, workspaceId);
    syncInstanceGate(db, rootId, workspaceId, generation, false);
    return { generation };
  });
  return run.immediate();
}

export function acceptRootResult(
  db: DB,
  rootId: string,
  workspaceId: string,
  capturedGeneration: number,
  apply: () => void,
): 'applied' | 'dropped' {
  if (!shouldPublish(readPublishSnapshot(db, rootId, workspaceId), capturedGeneration)) return 'dropped';
  apply();
  return 'applied';
}
