/**
 * r11-E：只读双库诊断（主库 workbench.db resources.id vs modules.sqlite resources.id）。
 * 对同一 rootId+relPath，两库必须给出同一 resourceId；对同一 resourceId，规范化路径必须一致。
 * 仅开发模式或 e2e（KB_E2E=1 / !packaged）可调用。
 */
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { KbStack } from './kbStack';

export interface DualDbMismatch {
  resourceId: string;
  mainPath: string;
  modulesPath: string | null;
}

export interface DualDbCheckResult {
  ok: boolean;
  mismatched: DualDbMismatch[];
  checked: number;
  rootId?: string;
}

function normPath(p: string): string {
  return path.normalize(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function debugDualDbCheck(
  mainDb: Database.Database,
  stack: KbStack | null,
  roots: Array<{ id: string; path: string }>,
  rootId?: string,
): DualDbCheckResult {
  if (!stack) {
    return {
      ok: false,
      mismatched: [{ resourceId: '*', mainPath: '(modules stack unavailable)', modulesPath: null }],
      checked: 0,
      rootId,
    };
  }
  const rootFilter = rootId ? roots.filter((r) => r.id === rootId) : roots;
  const rootPathById = new Map(rootFilter.map((r) => [r.id, r.path]));
  const mismatched: DualDbMismatch[] = [];
  let checked = 0;

  const mainSql = rootId
    ? `SELECT id AS resourceId, root_id AS rootId, rel_path AS relPath FROM resources WHERE kind='file' AND missing_since IS NULL AND root_id=?`
    : `SELECT id AS resourceId, root_id AS rootId, rel_path AS relPath FROM resources WHERE kind='file' AND missing_since IS NULL`;
  const mainRows = mainDb.prepare(mainSql).all(...(rootId ? [rootId] : [])) as Array<{
    resourceId: string;
    rootId: string;
    relPath: string;
  }>;

  const modById = stack.db.prepare(
    `SELECT id AS resourceId, root_id AS rootId, rel_path AS relPath, missing FROM resources WHERE id = ?`,
  );
  const modByPath = stack.db.prepare(
    `SELECT id AS resourceId, root_id AS rootId, rel_path AS relPath FROM resources
     WHERE root_id = ? AND rel_path = ? AND missing = 0 LIMIT 1`,
  );
  const mountStmt = stack.db.prepare(
    `SELECT local_path AS localPath FROM root_mounts WHERE root_id = ? ORDER BY updated_at DESC LIMIT 1`,
  );

  for (const row of mainRows) {
    const rootPath = rootPathById.get(row.rootId);
    if (!rootPath) continue;
    checked++;
    const mainAbs = normPath(path.join(rootPath, row.relPath));

    const byId = modById.get(row.resourceId) as
      | { resourceId: string; rootId: string; relPath: string; missing: number }
      | undefined;
    let modulesAbs: string | null = null;
    if (byId && byId.missing === 0) {
      const mount = mountStmt.get(byId.rootId) as { localPath: string } | undefined;
      if (mount) modulesAbs = normPath(path.join(mount.localPath, byId.relPath));
    }

    // 同路径不同 id
    const byPath = modByPath.get(row.rootId, row.relPath) as
      | { resourceId: string; rootId: string; relPath: string }
      | undefined;
    if (byPath && byPath.resourceId !== row.resourceId) {
      const mount = mountStmt.get(byPath.rootId) as { localPath: string } | undefined;
      const p = mount ? normPath(path.join(mount.localPath, byPath.relPath)) : null;
      mismatched.push({
        resourceId: row.resourceId,
        mainPath: mainAbs,
        modulesPath: p ? `${p} (modules id=${byPath.resourceId})` : `(modules id=${byPath.resourceId})`,
      });
      continue;
    }

    if (!modulesAbs || modulesAbs !== mainAbs) {
      mismatched.push({ resourceId: row.resourceId, mainPath: mainAbs, modulesPath: modulesAbs });
    }
  }

  return { ok: mismatched.length === 0, mismatched, checked, rootId };
}
