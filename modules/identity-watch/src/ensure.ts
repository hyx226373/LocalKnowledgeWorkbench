import fs from 'node:fs';
import { rowByPathKey, getMount, type Db } from './db.ts';
import { runJob } from './engine.ts';
import { detectFileSystem } from './fsinfo.ts';
import { normalizeRelPath, pathKey } from './pathutil.ts';
import { resolveInsideRoot } from './resolve.ts';

/** 路径必须已存在。会按与 reconcile 相同的规则对齐整棵树，再返回该相对路径的 id。 */
export function ensureResource(db: Db, rootId: string, relPath: string): string {
  const rel = normalizeRelPath(relPath);
  if (rel === '') throw new Error('root directory is not a resource');
  const resolved = resolveInsideRoot(db, rootId, rel);
  if (!fs.existsSync(resolved.absPath)) throw new Error(`not found: ${rel}`);
  const caps = detectFileSystem(getMount(db, rootId));
  runJob(db, rootId, { caps });
  const keys = [pathKey(resolved.relPath), pathKey(rel)];
  for (const key of keys) {
    const row = rowByPathKey(db, rootId, key);
    if (row) return row.id;
  }
  throw new Error(`failed to ensure ${rel}`);
}
