import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ReconcileCancelledError } from './errors.ts';
import { fileIdFromStat, hashFile, mtimeMsFromStat, sizeFromStat } from './fsinfo.ts';
import { pathKey } from './pathutil.ts';
import { getMount, loadResources, type Db } from './db.ts';
import { jobLock, withJobLock } from './job-lock.ts';
import type { DbResource, FsCapabilities, ReconcileProgress, ReconcileResult, ResourceKind } from './types.ts';

export interface DiskNode {
  relPath: string;
  pathKey: string;
  kind: ResourceKind;
  size: number;
  mtimeMs: number;
  fsFileId: string | null;
  absPath: string;
}

interface Pairing {
  row: DbResource;
  disk: DiskNode;
  reason: 'ino' | 'triple' | 'inplace';
}

interface PlanUpdate {
  id: string;
  relPath: string;
  pathKey: string;
  kind: ResourceKind;
  size: number;
  mtimeMs: number;
  hash: string | null;
  fsFileId: string | null;
  pathChanged: boolean;
}

interface PlanMissing {
  id: string;
  wasMissing: boolean;
}

interface PlanInsert {
  relPath: string;
  pathKey: string;
  kind: ResourceKind;
  size: number;
  mtimeMs: number;
  hash: string | null;
  fsFileId: string | null;
}

interface Plan {
  updates: PlanUpdate[];
  missing: PlanMissing[];
  inserts: PlanInsert[];
}

export interface JobOptions {
  caps: FsCapabilities;
  cancel?: () => boolean;
  delayMs?: number;
  onProgress?: (progress: ReconcileProgress) => void;
  /** 与另一次对账共用。不传则按数据库文件取进程内的锁。 */
  lock?: Int32Array;
}

function throwIfCancelled(cancel: () => boolean): void {
  if (cancel()) throw new ReconcileCancelledError();
}

function pause(ms: number, cancel: () => boolean): void {
  const end = Date.now() + ms;
  const sab = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < end) {
    throwIfCancelled(cancel);
    try {
      Atomics.wait(sab, 0, 0, 10);
    } catch {
      const sliceEnd = Math.min(end, Date.now() + 10);
      while (Date.now() < sliceEnd) {
        /* 主线程不允许 Atomics.wait 时退回忙等 */
      }
    }
  }
}

export function scanTree(rootAbs: string, caps: FsCapabilities, options: JobOptions): DiskNode[] {
  const cancel = () => options.cancel?.() ?? false;
  const out: DiskNode[] = [];
  const stack: string[] = [''];
  let seen = 0;
  options.onProgress?.({ phase: 'scan', seen: 0, total: null });
  while (stack.length > 0) {
    throwIfCancelled(cancel);
    const parent = stack.pop() ?? '';
    const absDir = parent === '' ? rootAbs : path.join(rootAbs, ...parent.split('/'));
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EPERM' || code === 'EACCES') continue;
      throw error;
    }
    for (const dirent of dirents) {
      throwIfCancelled(cancel);
      if (options.delayMs && options.delayMs > 0) pause(options.delayMs, cancel);
      if (dirent.name.includes('\0')) continue;
      if (dirent.name.startsWith('.kb-watch-arm-')) continue;
      // junction / symlink 不跟随，避免扫到根外。
      if (dirent.isSymbolicLink()) continue;
      const kind: ResourceKind | null = dirent.isDirectory() ? 'dir' : dirent.isFile() ? 'file' : null;
      if (!kind) continue;
      const name = dirent.name.normalize('NFC');
      const relPath = parent === '' ? name : `${parent}/${name}`;
      const absPath = path.join(absDir, dirent.name);
      let st: fs.BigIntStats;
      try {
        st = fs.statSync(absPath, { bigint: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') continue;
        throw error;
      }
      out.push({
        relPath,
        pathKey: pathKey(relPath),
        kind,
        size: sizeFromStat(st),
        mtimeMs: mtimeMsFromStat(st),
        fsFileId: fileIdFromStat(st, caps.fileIdReliable),
        absPath,
      });
      seen += 1;
      if (seen % 25 === 0) options.onProgress?.({ phase: 'scan', seen, total: null });
      if (kind === 'dir') stack.push(relPath);
    }
  }
  options.onProgress?.({ phase: 'scan', seen, total: seen });
  return out;
}

function tripleKey(size: number, mtimeMs: number, hash: string): string {
  return `${size}|${mtimeMs}|${hash}`;
}

export function buildPlan(
  rows: DbResource[],
  disk: DiskNode[],
  caps: FsCapabilities,
  options: JobOptions,
): Plan {
  const cancel = () => options.cancel?.() ?? false;
  const hashCache = new Map<string, string>();
  let hashed = 0;
  const hashOf = (node: DiskNode): string => {
    const cached = hashCache.get(node.absPath);
    if (cached) return cached;
    throwIfCancelled(cancel);
    const value = hashFile(node.absPath, cancel);
    hashCache.set(node.absPath, value);
    hashed += 1;
    if (hashed % 25 === 0) options.onProgress?.({ phase: 'hash', seen: hashed, total: null });
    return value;
  };
  const hashFor = (row: DbResource | null, node: DiskNode): string | null => {
    if (node.kind !== 'file') return null;
    if (
      row &&
      row.kind === 'file' &&
      row.content_hash &&
      row.size === node.size &&
      row.mtime_ms === node.mtimeMs
    ) {
      return row.content_hash;
    }
    return hashOf(node);
  };

  options.onProgress?.({ phase: 'hash', seen: 0, total: null });
  const diskByKey = new Map<string, DiskNode>();
  const diskByIno = new Map<string, DiskNode[]>();
  for (const node of disk) {
    diskByKey.set(node.pathKey, node);
    if (caps.fileIdReliable && node.fsFileId && node.fsFileId !== '0') {
      const list = diskByIno.get(node.fsFileId) ?? [];
      list.push(node);
      diskByIno.set(node.fsFileId, list);
    }
  }
  const dbByIno = new Map<string, DbResource[]>();
  if (caps.fileIdReliable) {
    for (const row of rows) {
      if (!row.fs_file_id || row.fs_file_id === '0') continue;
      const list = dbByIno.get(row.fs_file_id) ?? [];
      list.push(row);
      dbByIno.set(row.fs_file_id, list);
    }
  }

  const pairedDb = new Set<string>();
  const pairedDisk = new Set<string>();
  const pairings: Pairing[] = [];
  const pair = (row: DbResource, node: DiskNode, reason: Pairing['reason']): boolean => {
    if (pairedDb.has(row.id) || pairedDisk.has(node.pathKey)) return false;
    pairedDb.add(row.id);
    pairedDisk.add(node.pathKey);
    pairings.push({ row, disk: node, reason });
    return true;
  };

  // 1. 唯一 fs_file_id。同大小文件互换靠这一步，不能只按路径或大小。
  if (caps.fileIdReliable) {
    for (const [ino, dList] of diskByIno) {
      throwIfCancelled(cancel);
      const rList = (dbByIno.get(ino) ?? []).filter((row) => !pairedDb.has(row.id));
      const dFree = dList.filter((node) => !pairedDisk.has(node.pathKey));
      if (rList.length === 1 && dFree.length === 1) {
        pair(rList[0], dFree[0], 'ino');
      } else if (rList.length >= 1 && dFree.length >= 1) {
        for (const row of rList) {
          const same = dFree.find((node) => node.pathKey === row.rel_path_key && !pairedDisk.has(node.pathKey));
          if (same) pair(row, same, 'ino');
        }
      }
    }
  }

  // 2. 剩下的文件：size + mtime_ms + sha256 必须三者都等，且唯一。不接受只比哈希。
  const diskGroups = new Map<string, DiskNode[]>();
  const rowGroups = new Map<string, DbResource[]>();
  for (const node of disk) {
    if (pairedDisk.has(node.pathKey) || node.kind !== 'file') continue;
    throwIfCancelled(cancel);
    const key = tripleKey(node.size, node.mtimeMs, hashOf(node));
    const list = diskGroups.get(key) ?? [];
    list.push(node);
    diskGroups.set(key, list);
  }
  for (const row of rows) {
    if (pairedDb.has(row.id) || row.kind !== 'file') continue;
    if (row.content_hash == null || row.size == null || row.mtime_ms == null) continue;
    const key = tripleKey(row.size, row.mtime_ms, row.content_hash);
    const list = rowGroups.get(key) ?? [];
    list.push(row);
    rowGroups.set(key, list);
  }
  for (const [key, dList] of diskGroups) {
    const rList = rowGroups.get(key) ?? [];
    if (dList.length === 1 && rList.length === 1) pair(rList[0], dList[0], 'triple');
  }

  // 3. 记录还不是 missing、旧 inode 已消失、路径上仍是同种类条目：视为原地修改，保留 id。
  //    已经 missing=1 的记录不会走这里，避免同名新文件复用旧 id。
  for (const row of rows) {
    if (pairedDb.has(row.id) || row.missing !== 0) continue;
    const node = diskByKey.get(row.rel_path_key);
    if (!node || pairedDisk.has(node.pathKey) || node.kind !== row.kind) continue;
    pair(row, node, 'inplace');
  }

  const updates: PlanUpdate[] = pairings.map((pairing) => ({
    id: pairing.row.id,
    relPath: pairing.disk.relPath,
    pathKey: pairing.disk.pathKey,
    kind: pairing.disk.kind,
    size: pairing.disk.size,
    mtimeMs: pairing.disk.mtimeMs,
    hash: hashFor(pairing.row, pairing.disk),
    fsFileId: caps.fileIdReliable ? pairing.disk.fsFileId : null,
    pathChanged: pairing.row.rel_path_key !== pairing.disk.pathKey,
  }));

  const inserts: PlanInsert[] = [];
  for (const node of disk) {
    if (pairedDisk.has(node.pathKey)) continue;
    inserts.push({
      relPath: node.relPath,
      pathKey: node.pathKey,
      kind: node.kind,
      size: node.size,
      mtimeMs: node.mtimeMs,
      hash: node.kind === 'file' ? hashOf(node) : null,
      fsFileId: caps.fileIdReliable ? node.fsFileId : null,
    });
  }

  const missing: PlanMissing[] = [];
  for (const row of rows) {
    if (pairedDb.has(row.id)) continue;
    missing.push({
      id: row.id,
      wasMissing: row.missing === 1,
    });
  }

  options.onProgress?.({ phase: 'hash', seen: hashed, total: hashed });
  return { updates, missing, inserts };
}

export function applyPlan(db: Db, rootId: string, plan: Plan): void {
  const now = Date.now();
  const tx = db.transaction(() => {
    // 部分唯一索引只覆盖 missing=0。先让出活路径，不改 rel_path，失联行才能留在原路径上。
    const park = db.prepare(`UPDATE resources SET missing = 1, updated_at = ? WHERE id = ? AND missing = 0`);
    for (const update of plan.updates) {
      if (update.pathChanged) park.run(now, update.id);
    }
    for (const item of plan.missing) park.run(now, item.id);
    const upd = db.prepare(
      `UPDATE resources
       SET rel_path = ?, rel_path_key = ?, kind = ?, size = ?, mtime_ms = ?, content_hash = ?, fs_file_id = ?, missing = 0, updated_at = ?
       WHERE id = ?`,
    );
    for (const update of plan.updates) {
      upd.run(
        update.relPath,
        update.pathKey,
        update.kind,
        update.size,
        update.mtimeMs,
        update.hash,
        update.fsFileId,
        now,
        update.id,
      );
    }
    const ins = db.prepare(
      `INSERT INTO resources (
         id, root_id, rel_path, rel_path_key, kind, size, mtime_ms, content_hash, fs_file_id, missing, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    );
    for (const insert of plan.inserts) {
      ins.run(
        randomUUID(),
        rootId,
        insert.relPath,
        insert.pathKey,
        insert.kind,
        insert.size,
        insert.mtimeMs,
        insert.hash,
        insert.fsFileId,
        now,
        now,
      );
    }
  });
  tx();
}

export function runJob(db: Db, rootId: string, options: JobOptions): ReconcileResult {
  const lock = options.lock ?? jobLock(db);
  let result: ReconcileResult | undefined;
  withJobLock(lock, () => {
    result = runJobLocked(db, rootId, options);
  });
  return result as ReconcileResult;
}

function runJobLocked(db: Db, rootId: string, options: JobOptions): ReconcileResult {
  const cancel = () => options.cancel?.() ?? false;
  throwIfCancelled(cancel);
  const mount = getMount(db, rootId);
  if (!fs.existsSync(mount)) throw new Error('mounted path does not exist');
  const rootAbs = fs.realpathSync(mount);
  const disk = scanTree(rootAbs, options.caps, options);
  const rows = loadResources(db, rootId);
  const plan = buildPlan(rows, disk, options.caps, options);
  throwIfCancelled(cancel);
  options.onProgress?.({ phase: 'write', seen: disk.length, total: disk.length });
  applyPlan(db, rootId, plan);
  options.onProgress?.({ phase: 'done', seen: disk.length, total: disk.length });
  return {
    scanned: disk.length,
    moved: plan.updates.filter((update) => update.pathChanged).length,
    updated: plan.updates.filter((update) => !update.pathChanged).length,
    missing: plan.missing.filter((item) => !item.wasMissing).length,
    created: plan.inserts.length,
    fileSystem: options.caps.name,
    fileIdReliable: options.caps.fileIdReliable,
  };
}
