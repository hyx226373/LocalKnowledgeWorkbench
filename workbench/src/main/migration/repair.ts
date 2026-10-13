/**
 * 导入后（或任何时候）修复引用：列出缺失的资源、把缺失的文件重新定位到新位置（保留资源 UUID，收藏与工作区引用不变）。
 * 记录从不因为“找不到”而删除；未映射的根可以随时用 WorkbenchService.remapRoot 映射。
 * 重映射的 pending，以及用户没留下的配对 / 没勾上的路径提示，只靠 missing_since 进下面的缺失列表。
 * 不删资源行，也不删收藏、工作区条目、工作资料或自建目录引用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { statForIndex, upsertSeen } from '../service/indexer';
import { toRelPath } from '../service/paths';
import type { DB } from '../service/db';
import type { WorkbenchService } from '../service/WorkbenchService';
import { listTables } from './snapshot';
import { referencedResourceIds, replaceRefId, workspacesByRef } from '../service/workspaceRefs';

/**
 * 把重映射后仍未确认的资源标成缺失。已有 missing_since 的时间戳保持不变。
 * 只删 FTS。收藏、workspace_items、collection_items、layout 里的引用一律不动。
 */
export function markRemapPending(db: DB, resourceIds: string[], now = Date.now()): void {
  const sel = db.prepare('SELECT missing_since FROM resources WHERE id=?');
  const upd = db.prepare('UPDATE resources SET missing_since=? WHERE id=? AND missing_since IS NULL');
  const del = db.prepare('DELETE FROM resources_fts WHERE resource_id=?');
  for (const id of resourceIds) {
    const row = sel.get(id) as { missing_since: number | null } | undefined;
    if (!row) throw new Error(`待定资源不存在: ${id}`);
    if (row.missing_since == null) upd.run(now, id);
    del.run(id);
  }
}

export interface MissingResource {
  resourceId: string;
  rootId: string;
  rootName: string;
  /** 根的状态：ok = 已映射且在线；offline = 已映射但文件夹不在；unmapped = 本机没有映射 */
  rootStatus: 'ok' | 'offline' | 'unmapped';
  relPath: string;
  name: string;
  kind: 'file' | 'dir';
  favorite: boolean;
  /** 在标签里打开它的工作区（名称） */
  workspaces: string[];
  /** 把它列入“本工作的资料”（集合引用）的工作区（名称）；第 9 轮合并新增 */
  collections: string[];
  missingSince: number | null;
}

export interface RootMountStatus {
  rootId: string;
  name: string;
  path: string | null;
  status: 'ok' | 'offline' | 'unmapped';
  missing: number;
  missingReferenced: number;
}

export function rootStatuses(svc: WorkbenchService): RootMountStatus[] {
  const refd = referencedResourceIds(svc.db);
  const missingRefd = new Map<string, number>();
  if (refd.size) {
    const q = svc.db.prepare('SELECT root_id FROM resources WHERE id=? AND missing_since IS NOT NULL AND NOT EXISTS (SELECT 1 FROM favorites f WHERE f.resource_id=resources.id) AND NOT EXISTS (SELECT 1 FROM workspace_items w WHERE w.source_kind=\'file\' AND w.ref=resources.id)');
    for (const id of refd) {
      const r = q.get(id) as { root_id: string } | undefined;
      if (r) missingRefd.set(r.root_id, (missingRefd.get(r.root_id) ?? 0) + 1);
    }
  }
  const rows = svc.db
    .prepare(
      `SELECT r.id, r.name, m.local_path,
         (SELECT COUNT(*) FROM resources x WHERE x.root_id=r.id AND x.missing_since IS NOT NULL) AS missing,
         (SELECT COUNT(*) FROM resources x WHERE x.root_id=r.id AND x.missing_since IS NOT NULL AND (
            EXISTS (SELECT 1 FROM favorites f WHERE f.resource_id=x.id) OR
            EXISTS (SELECT 1 FROM workspace_items w WHERE w.source_kind='file' AND w.ref=x.id))) AS mref
       FROM roots r LEFT JOIN root_mounts m ON m.root_id=r.id ORDER BY r.created_at`,
    )
    .all() as { id: string; name: string; local_path: string | null; missing: number; mref: number }[];
  return rows.map((r) => ({
    rootId: r.id,
    name: r.name,
    path: r.local_path,
    status: !r.local_path ? 'unmapped' : isDir(r.local_path) ? 'ok' : 'offline',
    missing: r.missing,
    // 被引用 = 被收藏、在标签中打开、或被列入工作资料（集合）
    missingReferenced: r.mref + (missingRefd.get(r.id) ?? 0),
  }));
}

/**
 * 缺失的资源。referencedOnly（默认）只列被收藏或被工作区引用的（这些是用户能看到“缺失”的地方）；
 * 根未映射/离线时，其下被引用的资源也算缺失。
 * 重映射 pending 走同一条 missing_since 条件，本函数不删除任何引用。
 */
export function listMissing(svc: WorkbenchService, opts: { referencedOnly?: boolean; limit?: number } = {}): MissingResource[] {
  const status = new Map(rootStatuses(svc).map((r) => [r.rootId, r]));
  const refOnly = opts.referencedOnly !== false;
  const rows = svc.db
    .prepare(
      `SELECT r.id, r.root_id, r.rel_path, r.name, r.kind, r.missing_since,
         EXISTS (SELECT 1 FROM favorites f WHERE f.resource_id=r.id) AS fav
       FROM resources r
       WHERE r.rel_path <> '' AND (r.missing_since IS NOT NULL OR r.root_id IN (SELECT id FROM roots WHERE id NOT IN (SELECT root_id FROM root_mounts)))
       ORDER BY r.root_id, r.rel_path LIMIT ?`,
    )
    .all(opts.limit ?? 5000) as { id: string; root_id: string; rel_path: string; name: string; kind: 'file' | 'dir'; missing_since: number | null; fav: number }[];
  const wsOf = svc.db.prepare(`SELECT DISTINCT w.name FROM workspace_items i JOIN workspaces w ON w.id=i.workspace_id WHERE i.source_kind='file' AND i.ref=? ORDER BY w.name`);
  const refWs = workspacesByRef(svc.db);
  const wsName = new Map((svc.db.prepare('SELECT id, name FROM workspaces').all() as { id: string; name: string }[]).map((w) => [w.id, w.name]));
  const out: MissingResource[] = [];
  for (const r of rows) {
    const workspaces = (wsOf.all(r.id) as { name: string }[]).map((x) => x.name);
    const collections = [...new Set((refWs.get(r.id) ?? []).map((id) => wsName.get(id)).filter((n): n is string => !!n))].sort();
    if (refOnly && !r.fav && !workspaces.length && !collections.length) continue;
    const st = status.get(r.root_id);
    out.push({
      resourceId: r.id,
      rootId: r.root_id,
      rootName: st?.name ?? '',
      rootStatus: st?.status ?? 'unmapped',
      relPath: r.rel_path,
      name: r.name,
      kind: r.kind,
      favorite: !!r.fav,
      workspaces,
      collections,
      missingSince: r.missing_since,
    });
  }
  return out;
}

/**
 * 重新定位一个缺失的文件：newAbs 必须位于某个已映射的根内。资源 UUID 不变（收藏、工作区条目、阅读状态都还指向它）。
 * 如果扫描已经为新位置建了另一条资源记录，把那条记录上的收藏/工作区引用并到原记录上，再删掉那条重复记录。
 */
export function relocateResource(svc: WorkbenchService, resourceId: string, newAbs: string) {
  const row = svc.db.prepare('SELECT id, root_id, rel_path, kind FROM resources WHERE id=?').get(resourceId) as { id: string; root_id: string; rel_path: string; kind: string } | undefined;
  if (!row) throw new Error(`资源不存在: ${resourceId}`);
  if (row.rel_path === '') throw new Error('根目录本身请用“重新映射”');
  if (row.kind !== 'file') throw new Error('文件夹请通过重新映射根目录来修复（文件夹下的所有资源会一起恢复）');
  const st = statForIndex(path.resolve(newAbs));
  if (!st || st.kind !== 'file') throw new Error(`不是可访问的文件：${newAbs}`);
  const real = fs.realpathSync.native(newAbs);
  let target: { rootId: string; rel: string; rootPath: string } | null = null;
  for (const r of svc.listRoots()) {
    if (r.status !== 'ok') continue;
    const rel = toRelPath(fs.realpathSync.native(r.path), real);
    if (rel !== null && rel !== '') {
      target = { rootId: r.id, rel, rootPath: r.path };
      break;
    }
  }
  if (!target) throw new Error('新位置必须在某个已映射的根目录内（先映射或添加该根）');
  const t = target;
  const hasCollections = listTables(svc.db).tables.includes('collection_items');
  svc.db.transaction(() => {
    const dup = svc.db.prepare('SELECT id FROM resources WHERE root_id=? AND rel_path=?').get(t.rootId, t.rel) as { id: string } | undefined;
    if (dup && dup.id !== resourceId) {
      const favMine = svc.db.prepare('SELECT 1 FROM favorites WHERE resource_id=?').get(resourceId);
      if (favMine) svc.db.prepare('DELETE FROM favorites WHERE resource_id=?').run(dup.id);
      else svc.db.prepare('UPDATE favorites SET resource_id=? WHERE resource_id=?').run(resourceId, dup.id);
      svc.db.prepare("UPDATE workspace_items SET ref=? WHERE source_kind='file' AND ref=?").run(resourceId, dup.id);
      if (hasCollections) svc.db.prepare('UPDATE OR IGNORE collection_items SET resource_id=? WHERE resource_id=?').run(resourceId, dup.id);
      replaceRefId(svc.db, dup.id, resourceId); // 工作资料（集合）引用也并过来
      svc.db.prepare('DELETE FROM resources_fts WHERE resource_id=?').run(dup.id);
      svc.db.prepare('DELETE FROM resources WHERE id=?').run(dup.id);
    }
    const name = t.rel.split('/').pop()!;
    const i = name.lastIndexOf('.');
    svc.db
      .prepare('UPDATE resources SET root_id=?, rel_path=?, rel_path_key=?, name=?, ext=?, updated_at=? WHERE id=?')
      .run(t.rootId, t.rel, t.rel.toLowerCase(), name, i > 0 ? name.slice(i + 1).toLowerCase() : '', Date.now(), resourceId);
    upsertSeen(svc.db, t.rootId, t.rootPath, t.rel, st); // 刷新大小/时间，清除 missing_since，写回 FTS
  }).immediate();
  svc.emit('fs-change', [{ rootId: t.rootId, relPath: t.rel, type: 'add' }]);
  svc.emit('favorites-changed');
  return svc.getResource(resourceId);
}

function isDir(p: string) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
