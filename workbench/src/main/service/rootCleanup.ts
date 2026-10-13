import { ROOT_CLEANUP_BATCH, type RootOpKind } from '../../shared/rootTask';
import type { DB } from './db';
import { countLiveInstances } from './workspaceRootInstance';

export type RootCleanupOutcome = 'done' | 'stopped' | 'kept';

/**
 * 按批删 resources_fts。每批一个短事务，批与批之间让出写锁。
 * 还有存活实例时不删索引、不删 roots。
 * 只在 detach 且已经没有存活实例时才 DELETE roots。
 * delete-disk 在没有存活实例时清索引，但不删 roots 行（撤销还要 rootPath）。
 */
export async function cleanupRetiredRoot(opts: {
  db: DB;
  rootId: string;
  kind: RootOpKind;
  shouldStop: () => boolean;
}): Promise<RootCleanupOutcome> {
  const { db, rootId, kind, shouldStop } = opts;
  if (kind !== 'detach' && kind !== 'delete-disk') return 'kept';
  if (shouldStop()) return 'stopped';
  if (countLiveInstances(db, rootId) > 0) return 'kept';

  const select = db.prepare('SELECT rowid FROM resources_fts WHERE root_id = ? LIMIT ?');
  const del = db.prepare('DELETE FROM resources_fts WHERE rowid = ?');
  for (;;) {
    if (shouldStop()) return 'stopped';
    if (countLiveInstances(db, rootId) > 0) return 'kept';
    const rows = select.all(rootId, ROOT_CLEANUP_BATCH) as { rowid: number }[];
    if (rows.length === 0) break;
    db.transaction(() => {
      for (const row of rows) del.run(row.rowid);
    }).immediate();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  if (shouldStop()) return 'stopped';
  if (countLiveInstances(db, rootId) > 0) return 'kept';
  if (kind === 'detach') {
    const instances = db.prepare(
      "SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = 'workspace_root_instances'",
    ).get();
    if (instances) db.prepare('DELETE FROM workspace_root_instances WHERE source_id = ?').run(rootId);
    db.prepare('DELETE FROM roots WHERE id = ?').run(rootId);
  }
  return 'done';
}
