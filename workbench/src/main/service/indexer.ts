/**
 * 索引核心逻辑（纯 Node，无 Electron 依赖）。
 * 在应用中由 indexWorker（worker_threads）调用，主进程只做编排；单元测试可直接调用。
 *
 * 身份识别规则（upsertSeen）：
 *   1. 同 root + 同路径 已有资源 → 复用（包括之前标记为 missing 的：编辑器“写临时文件再替换”会换 inode，但路径连续）
 *   2. 同 root 内 file_key（Windows: 卷序列号:NTFS 文件索引；其他: dev:ino）相同，且旧路径已不存在 → 视为重命名/移动
 *   3. 回退：同 kind、同 size、同 mtime，旧路径已不存在，且（若双方都有）content_hash 相同，候选唯一 → 视为重命名/移动
 *   4. 否则新建资源
 */
import { referencedResourceIds } from './workspaceRefs';
import type { BigIntStats, Dirent } from 'node:fs';
import path from 'node:path';
import { disk as fs, diskPromises as fsp } from './disk';
import crypto from 'node:crypto';
import type { DB } from './db';
import { extOf } from './paths';
import { extensionsFromFilterJson, inAccessScope, normalizeExtensions, type AccessScope } from '../../shared/sourceFilter';

export const HASH_MAX_BYTES = 4 * 1024 * 1024;
export const DEFAULT_IGNORES = new Set(['.git', 'node_modules', '$RECYCLE.BIN', 'System Volume Information', '.DS_Store', 'Thumbs.db', 'desktop.ini']);
/** 索引、监听、目录树共用的忽略规则（目录树可在设置中改为“显示被忽略的项”） */
export function isIgnoredName(name: string): boolean {
  return DEFAULT_IGNORES.has(name);
}

export interface SeenStat {
  kind: 'file' | 'dir';
  size: number;
  mtimeMs: number;
  fileKey: string | null;
  hash?: string | null;
}

export function fileKeyOf(st: BigIntStats): string | null {
  if (!st.ino || st.ino === 0n) return null;
  return `${st.dev}:${st.ino}`;
}

export function statForIndex(abs: string, withHash = false): SeenStat | null {
  let st: BigIntStats;
  try {
    st = fs.lstatSync(abs, { bigint: true });
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) return null; // v1 不跟随符号链接
  const kind = st.isDirectory() ? 'dir' : 'file';
  const size = Number(st.size);
  let hash: string | null = null;
  if (withHash && kind === 'file' && size <= HASH_MAX_BYTES) hash = hashFileSync(abs);
  return { kind, size: kind === 'dir' ? 0 : size, mtimeMs: Math.floor(Number(st.mtimeMs)), fileKey: fileKeyOf(st), hash };
}

export function hashFileSync(abs: string): string | null {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  } catch {
    return null;
  }
}

export function relKey(rel: string): string {
  return rel.toLowerCase();
}

interface ResRow {
  id: string;
  rel_path: string;
  kind: string;
  size: number;
  mtime_ms: number;
  file_key: string | null;
  content_hash: string | null;
  missing_since: number | null;
}

function setFts(db: DB, id: string, rootId: string, rel: string, name: string) {
  db.prepare('DELETE FROM resources_fts WHERE resource_id = ?').run(id);
  if (rel !== '') db.prepare('INSERT INTO resources_fts(resource_id, root_id, rel_path, name) VALUES (?,?,?,?)').run(id, rootId, rel, name);
}

function pathGone(rootPath: string, rel: string): boolean {
  return !fs.existsSync(path.join(rootPath, ...rel.split('/').filter(Boolean)));
}

function scopeOfRoot(db: DB, rootId: string): AccessScope {
  const row = db.prepare('SELECT kind, filter_json FROM roots WHERE id=?').get(rootId) as { kind?: string; filter_json?: string } | undefined;
  return {
    sourceKind: row?.kind === 'file' ? 'file' : 'folder',
    extensions: extensionsFromFilterJson(row?.filter_json),
  };
}

function extensionGate(scope: AccessScope, kind: 'file' | 'dir', rel: string): boolean {
  const name = rel === '' ? '' : rel.split('/').pop()!;
  return inAccessScope(scope, { kind, relPath: rel, ext: kind === 'file' ? extOf(name) : '' });
}

/**
 * 记录“在 rel 位置看到了一个条目”。返回资源 id 以及是否发生了重命名匹配。
 */
export function upsertSeen(
  db: DB,
  rootId: string,
  rootPath: string,
  rel: string,
  st: SeenStat,
  now = Date.now(),
): { id: string; renamedFrom?: string; created: boolean } {
  // 单文件来源挂载点就是文件本身（rel_path=''），名称/扩展名取自挂载路径，供阅读器匹配。
  const name = rel === '' ? (st.kind === 'file' ? path.basename(rootPath) : '') : rel.split('/').pop()!;
  const ext = st.kind === 'file' ? extOf(name) : '';
  const byPath = db.prepare('SELECT * FROM resources WHERE root_id = ? AND rel_path = ?').get(rootId, rel) as ResRow | undefined;
  if (byPath) {
    const metaStale = byPath.name !== name || byPath.ext !== ext || byPath.kind !== st.kind;
    const changed =
      byPath.size !== st.size || byPath.mtime_ms !== st.mtimeMs || byPath.file_key !== st.fileKey || byPath.missing_since !== null || metaStale;
    if (changed) {
      const keepHash = byPath.size === st.size && byPath.mtime_ms === st.mtimeMs ? byPath.content_hash : null;
      db.prepare(
        'UPDATE resources SET kind=?, name=?, ext=?, size=?, mtime_ms=?, file_key=?, content_hash=?, missing_since=NULL, updated_at=? WHERE id=?',
      ).run(st.kind, name, ext, st.size, st.mtimeMs, st.fileKey, st.hash ?? keepHash, now, byPath.id);
      if (byPath.missing_since !== null || metaStale) setFts(db, byPath.id, rootId, rel, name);
    } else if (st.hash && !byPath.content_hash) {
      db.prepare('UPDATE resources SET content_hash=? WHERE id=?').run(st.hash, byPath.id);
    }
    return { id: byPath.id, created: false };
  }

  // 2. file_key 匹配
  let match: ResRow | undefined;
  if (st.fileKey) {
    const cands = db
      .prepare('SELECT * FROM resources WHERE root_id = ? AND file_key = ? AND kind = ?')
      .all(rootId, st.fileKey, st.kind) as ResRow[];
    match = cands.find((c) => c.missing_since !== null || pathGone(rootPath, c.rel_path));
  }
  // 3. size + mtime (+hash) 回退
  if (!match && st.kind === 'file') {
    const cands = (
      db.prepare('SELECT * FROM resources WHERE root_id = ? AND kind = ? AND size = ? AND mtime_ms = ?').all(rootId, 'file', st.size, st.mtimeMs) as ResRow[]
    ).filter((c) => c.missing_since !== null || pathGone(rootPath, c.rel_path));
    let filtered = cands;
    if (cands.length > 0 && cands.some((c) => c.content_hash)) {
      const h = st.hash ?? (st.size <= HASH_MAX_BYTES ? hashFileSync(path.join(rootPath, ...rel.split('/'))) : null);
      if (h) {
        st.hash = h;
        filtered = cands.filter((c) => c.content_hash === h);
      }
    }
    if (filtered.length === 1) match = filtered[0];
  }
  if (match) {
    db.prepare(
      'UPDATE resources SET rel_path=?, rel_path_key=?, name=?, ext=?, size=?, mtime_ms=?, file_key=?, content_hash=COALESCE(?, content_hash), missing_since=NULL, updated_at=? WHERE id=?',
    ).run(rel, relKey(rel), name, ext, st.size, st.mtimeMs, st.fileKey, st.hash ?? null, now, match.id);
    setFts(db, match.id, rootId, rel, name);
    return { id: match.id, renamedFrom: match.rel_path, created: false };
  }

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO resources(id, root_id, rel_path, rel_path_key, name, ext, kind, size, mtime_ms, file_key, content_hash, missing_since, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)`,
  ).run(id, rootId, rel, relKey(rel), name, ext, st.kind, st.size, st.mtimeMs, st.fileKey, st.hash ?? null, now, now);
  setFts(db, id, rootId, rel, name);
  return { id, created: true };
}

/** 标记路径（及其子路径）为缺失；不立即删除，以便之后的重命名匹配和收藏的“失联”展示 */
export function markMissing(db: DB, rootId: string, rel: string, now = Date.now()) {
  const rows = db
    .prepare(`SELECT id FROM resources WHERE root_id = ? AND missing_since IS NULL AND (rel_path = ? OR rel_path LIKE ? ESCAPE '\\')`)
    .all(rootId, rel, likePrefix(rel)) as { id: string }[];
  const upd = db.prepare('UPDATE resources SET missing_since = ? WHERE id = ?');
  const del = db.prepare('DELETE FROM resources_fts WHERE resource_id = ?');
  for (const r of rows) {
    upd.run(now, r.id);
    del.run(r.id);
  }
  return rows.length;
}

function likePrefix(rel: string) {
  return rel.replace(/[\\%_]/g, (m) => '\\' + m) + '/%';
}

/** 清理：缺失超过 retention 且未被收藏、也未被任何工作区条目引用的资源（被引用的缺失资源保留为可修复的引用，docs/12 §7） */
export function purgeMissing(db: DB, rootId: string, retentionMs: number, now = Date.now()) {
  // 保留：被收藏、被工作区条目（标签）引用、或只被工作资料（集合，layout 键 workspace.refs:*）引用的缺失资源
  const refd = referencedResourceIds(db);
  const ids = (
    db
      .prepare(
        `SELECT r.id FROM resources r LEFT JOIN favorites f ON f.resource_id = r.id
       WHERE r.root_id = ? AND r.missing_since IS NOT NULL AND r.missing_since < ? AND f.id IS NULL
         AND NOT EXISTS (SELECT 1 FROM workspace_items w WHERE w.source_kind = 'file' AND w.ref = r.id)`,
      )
      .all(rootId, now - retentionMs) as { id: string }[]
  ).filter((r) => !refd.has(r.id));
  const del = db.prepare('DELETE FROM resources WHERE id = ?');
  const delF = db.prepare('DELETE FROM resources_fts WHERE resource_id = ?');
  for (const r of ids) {
    del.run(r.id);
    delF.run(r.id);
  }
  return ids.length;
}

export interface ScanOptions {
  isCancelled: () => boolean;
  onProgress: (processed: number) => void;
  batchSize?: number;
  retentionMs?: number;
}

export interface ScanChange {
  id: string;
  relPath: string;
  type: 'add' | 'change' | 'unlink';
}

export interface ScanResult {
  processed: number;
  cancelled: boolean;
  missing: number;
  renamed: number;
  created: number;
  /** 这次扫描真正发生变化的资料。空数组表示不要刷新界面。 */
  changed: ScanChange[];
}

/**
 * 启动对账扫描：异步遍历（每批之间让出事件循环，以便处理取消消息），批量事务写库。
 * 取消时不做“标记缺失”，避免把未扫描到的部分误判为删除。
 */
export async function reconcileScan(db: DB, rootId: string, rootPath: string, opts: ScanOptions): Promise<ScanResult> {
  const batchSize = opts.batchSize ?? 80;
  const scanStart = Date.now();
  const res: ScanResult = { processed: 0, cancelled: false, missing: 0, renamed: 0, created: 0, changed: [] };
  const seen = new Set<string>();
  let batch: { rel: string; abs: string }[] = [];

  const flush = () => {
    if (batch.length === 0) return;
    const items = batch;
    batch = [];
    // 写事务一律 BEGIN IMMEDIATE：索引 worker 与主进程同时写库（WAL）时，延迟事务“先读后写”会直接报 database is locked（busy_timeout 不生效）
    // 哈希在事务外计算（较慢）；只对与库中记录不一致的小文件计算
    const getRow = db.prepare('SELECT id, size, mtime_ms, content_hash, missing_since FROM resources WHERE root_id=? AND rel_path=?');
    const stats = items.map((it) => {
      const st = statForIndex(it.abs, false);
      if (st && st.kind === 'file' && st.size <= HASH_MAX_BYTES) {
        const row = getRow.get(rootId, it.rel) as { id: string; size: number; mtime_ms: number; content_hash: string | null; missing_since: number | null } | undefined;
        if (!row || row.size !== st.size || row.mtime_ms !== st.mtimeMs || !row.content_hash) st.hash = hashFileSync(it.abs);
      }
      return st;
    });
    db.transaction(() => {
      const scope = scopeOfRoot(db, rootId);
      const findExisting = db.prepare('SELECT id FROM resources WHERE root_id=? AND rel_path=?');
      items.forEach((it, i) => {
        const st = stats[i];
        if (!st) return;
        // 筛选外的新文件不调用 upsertSeen。已有行仍走原配对，本块不改 out_of_scope。
        if (!extensionGate(scope, st.kind, it.rel) && !findExisting.get(rootId, it.rel)) return;
        const before = getRow.get(rootId, it.rel) as { id: string; size: number; mtime_ms: number; content_hash: string | null; missing_since: number | null } | undefined;
        const r = upsertSeen(db, rootId, rootPath, it.rel, st);
        seen.add(r.id);
        if (r.renamedFrom !== undefined) res.renamed++;
        if (r.created) res.created++;
        const metaChanged = !before || before.missing_since != null || before.size !== st.size || before.mtime_ms !== st.mtimeMs;
        if (r.created || r.renamedFrom !== undefined || metaChanged) {
          res.changed.push({ id: r.id, relPath: it.rel, type: r.created ? 'add' : 'change' });
        }
      });
    }).immediate();
    res.processed += items.length;
    opts.onProgress(res.processed);
  };

  const rootStat = statForIndex(rootPath);
  if (!rootStat) throw new Error(`根目录不可访问: ${rootPath}`);
  seen.add(upsertSeen(db, rootId, rootPath, '', rootStat).id);

  const stack: string[] = [''];
  while (stack.length) {
    if (opts.isCancelled()) {
      res.cancelled = true;
      return res;
    }
    const rel = stack.pop()!;
    const abs = rel === '' ? rootPath : path.join(rootPath, ...rel.split('/'));
    let ents: Dirent[];
    try {
      ents = await fsp.readdir(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (isIgnoredName(e.name) || e.isSymbolicLink()) continue;
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
      batch.push({ rel: childRel, abs: path.join(abs, e.name) });
      if (e.isDirectory()) stack.push(childRel);
      if (batch.length >= batchSize) {
        flush();
        await new Promise((r) => setImmediate(r));
        if (opts.isCancelled()) {
          res.cancelled = true;
          return res;
        }
      }
    }
  }
  flush();

  // 未见到的资源 → 缺失
  db.transaction(() => {
    const rows = db.prepare('SELECT id, rel_path FROM resources WHERE root_id = ? AND missing_since IS NULL').all(rootId) as { id: string; rel_path: string }[];
    const upd = db.prepare('UPDATE resources SET missing_since = ? WHERE id = ?');
    const delF = db.prepare('DELETE FROM resources_fts WHERE resource_id = ?');
    for (const r of rows) {
      if (!seen.has(r.id)) {
        upd.run(scanStart, r.id);
        delF.run(r.id);
        res.missing++;
        res.changed.push({ id: r.id, relPath: r.rel_path, type: 'unlink' });
      }
    }
    purgeMissing(db, rootId, opts.retentionMs ?? 30 * 24 * 3600 * 1000);
    const count = (db.prepare("SELECT COUNT(*) c FROM resources WHERE root_id=? AND missing_since IS NULL AND kind='file'").get(rootId) as { c: number }).c;
    db.prepare(
      `INSERT INTO index_state(root_id, last_scan_at, last_error, file_count) VALUES (?,?,NULL,?)
       ON CONFLICT(root_id) DO UPDATE SET last_scan_at=excluded.last_scan_at, last_error=NULL, file_count=excluded.file_count`,
    ).run(rootId, Date.now(), count);
  }).immediate();
  return res;
}

export interface FsEvent {
  type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';
  relPath: string;
}

/**
 * 应用一批文件监听事件。先处理新增（便于在旧路径仍在库中时就做 file_key 匹配），再处理删除。
 */
export function applyEvents(db: DB, rootId: string, rootPath: string, events: FsEvent[]) {
  const adds = events.filter((e) => e.type === 'add' || e.type === 'addDir' || e.type === 'change');
  const dels = events.filter((e) => e.type === 'unlink' || e.type === 'unlinkDir');
  let renamed = 0;
  const changed: ScanChange[] = [];
  adds.sort((a, b) => a.relPath.split('/').length - b.relPath.split('/').length);
  const prepared = adds.map((e) => ({ e, st: statForIndex(path.join(rootPath, ...e.relPath.split('/')), false) }));
  // Windows 递归监听只报“变了”。文件已经不在，就按删除处理，好让改名仍能先配对再标缺失。
  const gone = [
    ...dels.filter((e) => !fs.existsSync(path.join(rootPath, ...e.relPath.split('/')))),
    ...prepared.filter(({ e, st }) => !st && (e.type === 'change' || e.type === 'add' || e.type === 'addDir')).map(({ e }) => e),
  ];
  db.transaction(() => {
    const scope = scopeOfRoot(db, rootId);
    const findExisting = db.prepare('SELECT id FROM resources WHERE root_id=? AND rel_path=?');
    for (const { e, st } of prepared) {
      if (!st) continue;
      if (!extensionGate(scope, st.kind, e.relPath) && !findExisting.get(rootId, e.relPath)) continue;
      const r = upsertSeen(db, rootId, rootPath, e.relPath, st);
      if (r.renamedFrom !== undefined) renamed++;
      changed.push({ id: r.id, relPath: e.relPath, type: r.created ? 'add' : 'change' });
    }
    for (const e of gone) {
      const rows = db
        .prepare(`SELECT id, rel_path FROM resources WHERE root_id = ? AND missing_since IS NULL AND (rel_path = ? OR rel_path LIKE ? ESCAPE '\\')`)
        .all(rootId, e.relPath, likePrefix(e.relPath)) as { id: string; rel_path: string }[];
      markMissing(db, rootId, e.relPath);
      for (const row of rows) changed.push({ id: row.id, relPath: row.rel_path, type: 'unlink' });
    }
    const count = (db.prepare("SELECT COUNT(*) c FROM resources WHERE root_id=? AND missing_since IS NULL AND kind='file'").get(rootId) as { c: number }).c;
    db.prepare(
      `INSERT INTO index_state(root_id, file_count) VALUES (?,?) ON CONFLICT(root_id) DO UPDATE SET file_count=excluded.file_count`,
    ).run(rootId, count);
  }).immediate();
  return { renamed, changed };
}

interface ScopeRow {
  id: string;
  rel_path: string;
  name: string;
  kind: string;
  out_of_scope: number;
}

function ignoredRel(rel: string): boolean {
  return rel.split('/').some((seg) => seg !== '' && isIgnoredName(seg));
}

function fileAllowed(allowed: readonly string[], rel: string): boolean {
  if (allowed.length === 0) return true;
  const name = rel.split('/').pop() ?? rel;
  return allowed.includes(extOf(name));
}

interface FilterNode {
  rel: string;
  abs: string;
  stat: SeenStat;
}

/** 磁盘上要纳入的节点。DEFAULT_IGNORES 与符号链接不进入列表，和 reconcileScan 一样。 */
function listInScopeNodes(rootPath: string, allowed: readonly string[]): FilterNode[] {
  const rootStat = statForIndex(rootPath);
  if (!rootStat || rootStat.kind !== 'dir') throw new Error(`根目录不可访问: ${rootPath}`);
  const out: FilterNode[] = [{ rel: '', abs: rootPath, stat: rootStat }];
  const stack: string[] = [''];
  while (stack.length) {
    const rel = stack.pop()!;
    const abs = rel === '' ? rootPath : path.join(rootPath, ...rel.split('/'));
    let ents: Dirent[];
    try {
      ents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (isIgnoredName(e.name) || e.isSymbolicLink()) continue;
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
      const childAbs = path.join(abs, e.name);
      const st = statForIndex(childAbs);
      if (!st) continue;
      const inScope = st.kind === 'dir' || fileAllowed(allowed, childRel);
      if (st.kind === 'dir') stack.push(childRel);
      if (!inScope) continue;
      out.push({ rel: childRel, abs: childAbs, stat: st });
    }
  }
  return out;
}

/**
 * 按新扩展名对账一个来源。扩展名先小写、去点、去重；空列表不限制。
 * 已有行只改 out_of_scope / FTS，不调用 upsertSeen（避免另造 ID）。没有旧行才 upsertSeen。
 * 不删行，不改 missing_since，不碰收藏和引用。目录始终在范围内。单文件来源不按扩展名排除。
 */
export function reconcileFilter(db: DB, rootId: string, extensions: readonly string[]): void {
  const allowed = normalizeExtensions(extensions);
  const root = db.prepare('SELECT kind FROM roots WHERE id=?').get(rootId) as { kind?: string } | undefined;
  if (!root) throw new Error(`根不存在: ${rootId}`);
  const mount = db.prepare('SELECT local_path FROM root_mounts WHERE root_id=?').get(rootId) as { local_path: string } | undefined;
  if (!mount?.local_path) throw new Error(`根未挂载: ${rootId}`);
  const rootPath = mount.local_path;
  if (root.kind === 'file') {
    db.transaction(() => {
      const row = db.prepare('SELECT id, rel_path, name, out_of_scope FROM resources WHERE root_id=? AND rel_path=?').get(rootId, '') as ScopeRow | undefined;
      if (!row || row.out_of_scope !== 1) return;
      db.prepare('UPDATE resources SET out_of_scope=0 WHERE id=?').run(row.id);
      setFts(db, row.id, rootId, row.rel_path, row.name);
    }).immediate();
    return;
  }

  const rows = db.prepare('SELECT id, rel_path, name, kind, out_of_scope FROM resources WHERE root_id=?').all(rootId) as ScopeRow[];
  const excludeIds: string[] = [];
  for (const row of rows) {
    if (row.kind !== 'file' || row.rel_path === '' || ignoredRel(row.rel_path)) continue;
    if (fileAllowed(allowed, row.rel_path)) continue;
    const abs = path.join(rootPath, ...row.rel_path.split('/'));
    const st = statForIndex(abs);
    if (!st || st.kind !== 'file') continue;
    excludeIds.push(row.id);
  }
  const nodes = listInScopeNodes(rootPath, allowed);

  db.transaction(() => {
    const markOut = db.prepare('UPDATE resources SET out_of_scope=1 WHERE id=?');
    const markIn = db.prepare('UPDATE resources SET out_of_scope=0 WHERE id=?');
    const delFts = db.prepare('DELETE FROM resources_fts WHERE resource_id=?');
    const find = db.prepare('SELECT id, rel_path, name, kind, out_of_scope FROM resources WHERE root_id=? AND rel_path=?');
    for (const id of excludeIds) {
      markOut.run(id);
      delFts.run(id);
    }
    for (const node of nodes) {
      const row = find.get(rootId, node.rel) as ScopeRow | undefined;
      if (row) {
        if (row.out_of_scope === 1) {
          markIn.run(row.id);
          const name = node.rel === '' ? row.name : (node.rel.split('/').pop() ?? row.name);
          setFts(db, row.id, rootId, node.rel, name);
        }
        continue;
      }
      const saved = upsertSeen(db, rootId, rootPath, node.rel, node.stat);
      const flagged = db.prepare('SELECT out_of_scope, name FROM resources WHERE id=?').get(saved.id) as { out_of_scope: number; name: string } | undefined;
      if (flagged?.out_of_scope === 1) {
        markIn.run(saved.id);
        const name = node.rel === '' ? flagged.name : (node.rel.split('/').pop() ?? flagged.name);
        setFts(db, saved.id, rootId, node.rel, name);
      }
    }
  }).immediate();
}
