export interface DualDb {
  prepare(sql: string): { all(...args: unknown[]): unknown[] };
}

export interface DualMismatch {
  resourceId: string;
  mainPath: string | null;
  modulesPath: string | null;
}

interface PathRow {
  id: string;
  rel_path: string;
}

function livePaths(db: DualDb, rootId?: string): Map<string, string> {
  const sql = rootId
    ? `SELECT id, rel_path FROM resources WHERE root_id = ? AND (missing = 0 OR missing IS NULL)`
    : `SELECT id, rel_path FROM resources WHERE missing = 0 OR missing IS NULL`;
  const rows = (rootId ? db.prepare(sql).all(rootId) : db.prepare(sql).all()) as PathRow[];
  const out = new Map<string, string>();
  for (const row of rows) out.set(row.id, row.rel_path);
  return out;
}

/** 只读。同一 resourceId 在主库和 modules 库的相对路径必须一致。 */
export function debugDualDbCheck(main: DualDb, modules: DualDb, rootId?: string): { mismatched: DualMismatch[] } {
  const left = livePaths(main, rootId);
  const right = livePaths(modules, rootId);
  const ids = new Set<string>([...left.keys(), ...right.keys()]);
  const mismatched: DualMismatch[] = [];
  for (const resourceId of ids) {
    const mainPath = left.get(resourceId) ?? null;
    const modulesPath = right.get(resourceId) ?? null;
    if (mainPath !== modulesPath) mismatched.push({ resourceId, mainPath, modulesPath });
  }
  mismatched.sort((a, b) => a.resourceId.localeCompare(b.resourceId));
  return { mismatched };
}
