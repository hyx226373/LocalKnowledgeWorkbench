/**
 * 从根目录移除：只记在 layout 里的相对路径，不碰磁盘。
 * 空相对路径是根本身，不能进这份列表。
 */
import path from 'node:path';
import type { DB } from './db';
import { disk } from './disk';
import { normalizeRelPath } from './paths';

export const HIDDEN_LAYOUT_KEY = 'roots.hiddenItems';

export function parseHiddenMap(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [rootId, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!rootId || !Array.isArray(list)) continue;
    const rels: string[] = [];
    for (const item of list) {
      if (typeof item !== 'string' || !item) continue;
      try {
        const rel = normalizeRelPath(item);
        if (rel && !rels.includes(rel)) rels.push(rel);
      } catch {
        /* 坏记录丢掉，不当成隐藏 */
      }
    }
    if (rels.length) out[rootId] = rels;
  }
  return out;
}

export function readHiddenMap(db: DB): Record<string, string[]> {
  const row = db.prepare('SELECT json FROM layout WHERE key = ?').get(HIDDEN_LAYOUT_KEY) as { json: string } | undefined;
  if (!row) return {};
  try {
    return parseHiddenMap(JSON.parse(row.json));
  } catch {
    return {};
  }
}

export function hiddenRelSet(db: DB, rootId: string): string[] {
  return readHiddenMap(db)[rootId] ?? [];
}

/** 精确命中，或落在已隐藏目录之下。空路径（根本身）永不隐藏。 */
export function isHiddenRel(hidden: readonly string[], rel: string): boolean {
  const norm = String(rel ?? '').replace(/\\/g, '/');
  if (!norm) return false;
  for (const item of hidden) {
    if (!item) continue;
    if (norm === item || norm.startsWith(`${item}/`)) return true;
  }
  return false;
}

export function likePrefix(rel: string): string {
  return `${rel.replace(/[\\%_]/g, (ch) => `\\${ch}`)}/%`;
}

/** 去掉全文索引。不删资源行，也不标缺失。 */
export function forgetIndexUnder(db: DB, rootId: string, rel: string): void {
  const rows = db
    .prepare(`SELECT id FROM resources WHERE root_id = ? AND (rel_path = ? OR rel_path LIKE ? ESCAPE '\\')`)
    .all(rootId, rel, likePrefix(rel)) as { id: string }[];
  const del = db.prepare('DELETE FROM resources_fts WHERE resource_id = ?');
  for (const row of rows) del.run(row.id);
}

/** 标上 missing_since，让下一次扫描把这些行当成重新见到并重建全文索引。 */
export function stampReindexUnder(db: DB, rootId: string, rel: string, now = Date.now()): void {
  db.prepare(
    `UPDATE resources SET missing_since = ? WHERE root_id = ? AND (rel_path = ? OR rel_path LIKE ? ESCAPE '\\')`,
  ).run(now, rootId, rel, likePrefix(rel));
}

/**
 * 仍在磁盘上的隐藏资料预先记入 seen。
 * 扫描末尾不会把它们标成缺失。磁盘上已经没了的不预置，留给扫描标缺失。
 */
export function seedHiddenSeen(db: DB, rootId: string, rootPath: string, seen: Set<string>): string[] {
  const hidden = hiddenRelSet(db, rootId);
  if (!hidden.length) return hidden;
  const rows = db
    .prepare('SELECT id, rel_path FROM resources WHERE root_id = ? AND missing_since IS NULL')
    .all(rootId) as { id: string; rel_path: string }[];
  for (const row of rows) {
    if (!isHiddenRel(hidden, row.rel_path)) continue;
    const abs = row.rel_path ? path.join(rootPath, ...row.rel_path.split('/')) : rootPath;
    if (disk.existsSync(abs)) seen.add(row.id);
  }
  return hidden;
}
