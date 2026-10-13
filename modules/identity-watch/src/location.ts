import { rowById, type Db } from './db.ts';
import { normalizeRelPath, pathKey } from './pathutil.ts';
import type { ResourceLocation } from './types.ts';

/**
 * 调用方把 W3 的 onMoved(resourceId, before, after) 转到这里。
 * 更新这一条的 root_id、rel_path、rel_path_key，missing 置 0，并刷新 updated_at。
 * 不插入新行，不改 size、mtime、哈希、fs_file_id，不读磁盘。跨根规则见 README v1.2。
 */
export function updateLocation(
  db: Db,
  resourceId: string,
  before: ResourceLocation,
  after: ResourceLocation,
): void {
  const tx = db.transaction(() => {
    const row = rowById(db, resourceId);
    if (!row) throw new Error(`unknown resource: ${resourceId}`);
    if (before.rootId !== row.root_id) throw new Error('before.rootId does not match the resource');
    const root = db.prepare(`SELECT id FROM roots WHERE id = ?`).get(after.rootId) as { id: string } | undefined;
    if (!root) throw new Error('after.rootId is not a known root');
    const beforeRel = normalizeRelPath(before.relPath);
    const afterRel = normalizeRelPath(after.relPath);
    if (beforeRel === '' || afterRel === '') throw new Error('root directory is not a resource');
    if (pathKey(beforeRel) !== row.rel_path_key) throw new Error('before.relPath does not match the resource');
    const afterKey = pathKey(afterRel);
    const clash = db
      .prepare(
        `SELECT id FROM resources WHERE root_id = ? AND rel_path_key = ? AND missing = 0 AND id != ?`,
      )
      .get(after.rootId, afterKey, resourceId) as { id: string } | undefined;
    if (clash) throw new Error(`live resource already uses this path: ${afterRel}`);
    db.prepare(
      `UPDATE resources
       SET root_id = ?, rel_path = ?, rel_path_key = ?, missing = 0, updated_at = ?
       WHERE id = ?`,
    ).run(after.rootId, afterRel, afterKey, Date.now(), resourceId);
  });
  tx();
}
