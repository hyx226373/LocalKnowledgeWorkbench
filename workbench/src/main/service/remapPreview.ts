/**
 * 重映射预览（冻结草案第 3 节）。不写 root_mounts，也不改 resources。
 * 只对文件走四步，命中即停；日常 upsertSeen 的顺序不在这里。
 *
 * 1. file_key 非空，且新旧两边都只出现一次
 * 2. content_hash 与 size 都相等，且这一对在两边都唯一。缺哈希且大小 ≤ 4 MiB 时现算；更大且没有哈希则跳过
 * 3. size 与 mtime_ms 都相等，候选唯一，且已有哈希不互相矛盾
 * 4. 相对路径只进 pathHints，默认不配对
 *
 * 目录不参与 1–3。同相对路径仍在的目录不进预览（apply 时只刷新统计）。
 * 哈希 / 大小时间要求两边都唯一，避免按遍历顺序把同一旧行配给多个新文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DB } from './db';
import { extOf } from './paths';
import { HASH_MAX_BYTES, hashFileSync, isIgnoredName, statForIndex, type SeenStat } from './indexer';
import { markRemapPending } from '../migration/repair';

export const REMAP_PREVIEW_FORMAT = 'kb-workbench.remap-preview' as const;
export const REMAP_PREVIEW_VERSION = 1 as const;

export type RemapMatchBy = 'file_key' | 'content_hash' | 'size_mtime';

export interface RemapPair {
  resourceId: string;
  by: RemapMatchBy;
  oldRel: string;
  newRel: string;
  pathHint: false;
}

export interface RemapPathHint {
  resourceId: string;
  oldRel: string;
  newRel: string;
}

export interface RemapPending {
  resourceId: string;
  oldRel: string;
}

export interface RemapUnassigned {
  newRel: string;
  size: number;
  mtimeMs: number;
}

export interface RemapPreview {
  format: typeof REMAP_PREVIEW_FORMAT;
  formatVersion: typeof REMAP_PREVIEW_VERSION;
  sourceId: string;
  pairs: RemapPair[];
  pathHints: RemapPathHint[];
  pending: RemapPending[];
  unassigned: RemapUnassigned[];
}

export interface RemapSelection {
  pairIds: string[];
  pathHintIds: string[];
  newRels: string[];
}

interface Side {
  id: string;
  rel: string;
  kind: 'file' | 'dir';
  size: number;
  mtimeMs: number;
  fileKey: string | null;
  hash: string | null;
  abs?: string;
}

function relKey(rel: string): string {
  return rel.toLowerCase();
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function holdRel(id: string): string {
  return `.kb-remap-hold/${id}`;
}

function nameOf(rel: string): string {
  return rel === '' ? '' : rel.split('/').pop()!;
}

function hashesContradict(a: string | null, b: string | null): boolean {
  return !!a && !!b && a !== b;
}

function walkNew(rootAbs: string): Side[] {
  const out: Side[] = [];
  const stack: string[] = [''];
  while (stack.length) {
    const rel = stack.pop()!;
    const abs = rel === '' ? rootAbs : path.join(rootAbs, ...rel.split('/'));
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (e.isSymbolicLink() || isIgnoredName(e.name)) continue;
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
      const childAbs = path.join(abs, e.name);
      const st = statForIndex(childAbs, false);
      if (!st) continue;
      out.push({
        id: '',
        rel: childRel,
        kind: st.kind,
        size: st.size,
        mtimeMs: st.mtimeMs,
        fileKey: st.fileKey,
        hash: null,
        abs: childAbs,
      });
      if (st.kind === 'dir') stack.push(childRel);
    }
  }
  return out;
}

function loadOld(db: DB, sourceId: string): Side[] {
  const rows = db
    .prepare(
      `SELECT id, rel_path, kind, size, mtime_ms, file_key, content_hash
       FROM resources WHERE root_id=? AND rel_path<>''`,
    )
    .all(sourceId) as {
    id: string;
    rel_path: string;
    kind: 'file' | 'dir';
    size: number;
    mtime_ms: number;
    file_key: string | null;
    content_hash: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    rel: r.rel_path,
    kind: r.kind,
    size: r.size,
    mtimeMs: r.mtime_ms,
    fileKey: r.file_key || null,
    hash: r.content_hash || null,
  }));
}

function fillHash(side: Side, oldRoot: string | null, fromOld: boolean): void {
  if (side.hash || side.kind !== 'file') return;
  if (side.size > HASH_MAX_BYTES) return;
  const abs = fromOld
    ? oldRoot
      ? path.join(oldRoot, ...side.rel.split('/').filter(Boolean))
      : ''
    : side.abs;
  if (!abs || !fs.existsSync(abs)) return;
  side.hash = hashFileSync(abs);
}

/** 同一个键在新旧两边都恰好一条才配对。 */
function pairUnique(news: Side[], olds: Side[], keyOf: (s: Side) => string | null): { n: Side; o: Side }[] {
  const nGroups = new Map<string, Side[]>();
  const oGroups = new Map<string, Side[]>();
  for (const n of news) {
    const k = keyOf(n);
    if (!k) continue;
    const arr = nGroups.get(k) ?? [];
    arr.push(n);
    nGroups.set(k, arr);
  }
  for (const o of olds) {
    const k = keyOf(o);
    if (!k) continue;
    const arr = oGroups.get(k) ?? [];
    arr.push(o);
    oGroups.set(k, arr);
  }
  const out: { n: Side; o: Side }[] = [];
  for (const [k, ns] of nGroups) {
    const os = oGroups.get(k);
    if (ns.length === 1 && os && os.length === 1) out.push({ n: ns[0]!, o: os[0]! });
  }
  return out;
}

function pairSizeMtime(news: Side[], olds: Side[]): { n: Side; o: Side }[] {
  const tentative: { n: Side; o: Side }[] = [];
  for (const n of news) {
    const cands = olds.filter((o) => o.size === n.size && o.mtimeMs === n.mtimeMs && !hashesContradict(o.hash, n.hash));
    if (cands.length === 1) tentative.push({ n, o: cands[0]! });
  }
  const byOld = new Map<string, { n: Side; o: Side }[]>();
  for (const t of tentative) {
    const arr = byOld.get(t.o.id) ?? [];
    arr.push(t);
    byOld.set(t.o.id, arr);
  }
  return [...byOld.values()].filter((arr) => arr.length === 1).map((arr) => arr[0]!);
}

function dropUsed(news: Side[], olds: Side[], used: { n: Side; o: Side }[]): { news: Side[]; olds: Side[] } {
  const ns = new Set(used.map((u) => u.n));
  const os = new Set(used.map((u) => u.o));
  return { news: news.filter((n) => !ns.has(n)), olds: olds.filter((o) => !os.has(o)) };
}

export function buildRemapPreview(db: DB, sourceId: string, oldRootPath: string | null, newAbs: string): RemapPreview {
  const old = loadOld(db, sourceId);
  const discovered = walkNew(newAbs);
  let newFiles = discovered.filter((s) => s.kind === 'file');
  let oldFiles = old.filter((s) => s.kind === 'file');
  const newDirs = discovered.filter((s) => s.kind === 'dir');
  const oldDirs = old.filter((s) => s.kind === 'dir');

  const taken: { n: Side; o: Side; by: RemapMatchBy }[] = [];
  const take = (found: { n: Side; o: Side }[], by: RemapMatchBy) => {
    for (const p of found) taken.push({ ...p, by });
    const next = dropUsed(newFiles, oldFiles, found);
    newFiles = next.news;
    oldFiles = next.olds;
  };

  take(
    pairUnique(newFiles, oldFiles, (s) => s.fileKey),
    'file_key',
  );

  for (const n of newFiles) fillHash(n, null, false);
  for (const o of oldFiles) fillHash(o, oldRootPath, true);
  take(
    pairUnique(newFiles, oldFiles, (s) => (s.hash ? `${s.hash}\0${s.size}` : null)),
    'content_hash',
  );

  take(pairSizeMtime(newFiles, oldFiles), 'size_mtime');

  const oldFileByRel = new Map(oldFiles.map((o) => [o.rel, o]));
  const hintedOld = new Set<string>();
  const hintedNew = new Set<Side>();
  const pathHints: RemapPathHint[] = [];
  for (const n of newFiles) {
    const o = oldFileByRel.get(n.rel);
    if (!o || hintedOld.has(o.id)) continue;
    hintedOld.add(o.id);
    hintedNew.add(n);
    pathHints.push({ resourceId: o.id, oldRel: o.rel, newRel: n.rel });
  }

  const pending: RemapPending[] = [];
  for (const o of oldFiles) {
    if (hintedOld.has(o.id)) continue;
    pending.push({ resourceId: o.id, oldRel: o.rel });
  }
  const newDirRels = new Set(newDirs.map((d) => d.rel));
  const oldDirRels = new Set(oldDirs.map((d) => d.rel));
  for (const o of oldDirs) {
    if (newDirRels.has(o.rel)) continue;
    pending.push({ resourceId: o.id, oldRel: o.rel });
  }

  const unassigned: RemapUnassigned[] = [];
  for (const n of newFiles) {
    if (hintedNew.has(n)) continue;
    unassigned.push({ newRel: n.rel, size: n.size, mtimeMs: n.mtimeMs });
  }
  for (const d of newDirs) {
    if (oldDirRels.has(d.rel)) continue;
    unassigned.push({ newRel: d.rel, size: d.size, mtimeMs: d.mtimeMs });
  }

  pending.sort((a, b) => cmp(a.oldRel, b.oldRel));
  pathHints.sort((a, b) => cmp(a.oldRel, b.oldRel) || cmp(a.newRel, b.newRel));
  unassigned.sort((a, b) => cmp(a.newRel, b.newRel));
  const pairs: RemapPair[] = taken
    .map((p) => ({ resourceId: p.o.id, by: p.by, oldRel: p.o.rel, newRel: p.n.rel, pathHint: false as const }))
    .sort((a, b) => cmp(a.oldRel, b.oldRel) || cmp(a.newRel, b.newRel));

  return {
    format: REMAP_PREVIEW_FORMAT,
    formatVersion: REMAP_PREVIEW_VERSION,
    sourceId,
    pairs,
    pathHints,
    pending,
    unassigned,
  };
}

function uniq(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

function setFts(db: DB, id: string, rootId: string, rel: string, name: string) {
  db.prepare('DELETE FROM resources_fts WHERE resource_id=?').run(id);
  if (rel.startsWith('.kb-remap-hold/')) return;
  // 与 indexer.setFts 一致：单文件来源 rel 为空时仍按文件名入库。
  if (rel === '') {
    const row = db.prepare('SELECT kind FROM resources WHERE id=?').get(id) as { kind?: string } | undefined;
    if (row?.kind !== 'file' || !name) return;
  }
  db.prepare('INSERT INTO resources_fts(resource_id, root_id, rel_path, name) VALUES (?,?,?,?)').run(id, rootId, rel, name);
}

function hashForStat(abs: string, st: SeenStat, prev: { size: number; mtime_ms: number; content_hash: string | null } | undefined): string | null {
  if (st.kind === 'file' && st.size <= HASH_MAX_BYTES) return hashFileSync(abs);
  if (prev && prev.size === st.size && prev.mtime_ms === st.mtimeMs) return prev.content_hash;
  return null;
}

export function applyRemapPreview(
  db: DB,
  sourceId: string,
  newAbs: string,
  machineId: string,
  preview: RemapPreview,
  selection: RemapSelection,
  now = Date.now(),
): void {
  if (preview.format !== REMAP_PREVIEW_FORMAT || preview.formatVersion !== REMAP_PREVIEW_VERSION) throw new Error('无法识别的重映射预览');
  if (preview.sourceId !== sourceId) throw new Error('预览与来源不一致');
  if (!selection || !Array.isArray(selection.pairIds) || !Array.isArray(selection.pathHintIds) || !Array.isArray(selection.newRels)) {
    throw new Error('重映射勾选无效');
  }
  const pairById = new Map(preview.pairs.map((p) => [p.resourceId, p]));
  const hintById = new Map(preview.pathHints.map((p) => [p.resourceId, p]));
  const unByRel = new Map(preview.unassigned.map((u) => [u.newRel, u]));
  const pairIds = uniq(selection.pairIds);
  const hintIds = uniq(selection.pathHintIds);
  const newRels = uniq(selection.newRels);
  for (const id of pairIds) if (!pairById.has(id)) throw new Error(`预览中没有这项配对: ${id}`);
  for (const id of hintIds) if (!hintById.has(id)) throw new Error(`预览中没有这项路径提示: ${id}`);
  for (const rel of newRels) if (!unByRel.has(rel)) throw new Error(`预览中没有这个未分配项: ${rel}`);

  const moves: { id: string; newRel: string }[] = [
    ...pairIds.map((id) => ({ id, newRel: pairById.get(id)!.newRel })),
    ...hintIds.map((id) => ({ id, newRel: hintById.get(id)!.newRel })),
  ];
  const dests = new Set<string>();
  for (const m of moves) {
    if (dests.has(m.newRel)) throw new Error(`多个配对指向同一路径: ${m.newRel}`);
    dests.add(m.newRel);
  }
  for (const rel of newRels) {
    if (dests.has(rel)) throw new Error(`新文件与配对路径冲突: ${rel}`);
    dests.add(rel);
  }
  const movedIds = new Set(moves.map((m) => m.id));
  if (pairIds.some((id) => hintIds.includes(id))) throw new Error('同一资源不能既接受配对又接受路径提示');

  const planned = moves.map((m) => {
    const abs = path.join(newAbs, ...m.newRel.split('/'));
    const st = statForIndex(abs, false);
    if (!st) throw new Error(`配对的目标已不存在: ${m.newRel}`);
    return { ...m, abs, st };
  });
  const inserts = newRels.map((rel) => {
    const abs = path.join(newAbs, ...rel.split('/'));
    const st = statForIndex(abs, false);
    if (!st) throw new Error(`未分配的目标已不存在: ${rel}`);
    return { rel, abs, st, id: crypto.randomUUID() };
  });

  const oldRelOf = new Map<string, string>();
  for (const p of preview.pending) oldRelOf.set(p.resourceId, p.oldRel);
  for (const p of preview.pairs) oldRelOf.set(p.resourceId, p.oldRel);
  for (const p of preview.pathHints) oldRelOf.set(p.resourceId, p.oldRel);
  const missingIds = new Set<string>(preview.pending.map((p) => p.resourceId));
  for (const p of preview.pairs) if (!movedIds.has(p.resourceId)) missingIds.add(p.resourceId);
  for (const p of preview.pathHints) if (!movedIds.has(p.resourceId)) missingIds.add(p.resourceId);

  const setRel = db.prepare('UPDATE resources SET rel_path=?, rel_path_key=? WHERE id=?');
  const byRel = db.prepare('SELECT id FROM resources WHERE root_id=? AND rel_path=?');
  const park = (id: string) => {
    const rel = holdRel(id);
    setRel.run(rel, relKey(rel), id);
  };

  db.transaction(() => {
    db.prepare(
      `INSERT INTO root_mounts(root_id, local_path, machine_id, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(root_id) DO UPDATE SET local_path=excluded.local_path, machine_id=excluded.machine_id, updated_at=excluded.updated_at`,
    ).run(sourceId, newAbs, machineId, now);

    for (const m of planned) park(m.id);
    for (const rel of dests) {
      const occ = byRel.get(sourceId, rel) as { id: string } | undefined;
      if (occ && !planned.some((m) => m.id === occ.id)) park(occ.id);
    }

    const prevStmt = db.prepare('SELECT size, mtime_ms, content_hash FROM resources WHERE id=?');
    const upd = db.prepare(
      `UPDATE resources SET rel_path=?, rel_path_key=?, name=?, ext=?, kind=?, size=?, mtime_ms=?, file_key=?, content_hash=?, missing_since=NULL, updated_at=? WHERE id=?`,
    );
    for (const m of planned) {
      const prev = prevStmt.get(m.id) as { size: number; mtime_ms: number; content_hash: string | null } | undefined;
      if (!prev) throw new Error(`资源不存在: ${m.id}`);
      const name = nameOf(m.newRel);
      const ext = m.st.kind === 'file' ? extOf(name) : '';
      const hash = hashForStat(m.abs, m.st, prev);
      upd.run(m.newRel, relKey(m.newRel), name, ext, m.st.kind, m.st.size, m.st.mtimeMs, m.st.fileKey, hash, now, m.id);
      setFts(db, m.id, sourceId, m.newRel, name);
    }

    const ins = db.prepare(
      `INSERT INTO resources(id, root_id, rel_path, rel_path_key, name, ext, kind, size, mtime_ms, file_key, content_hash, missing_since, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)`,
    );
    for (const it of inserts) {
      const occ = byRel.get(sourceId, it.rel) as { id: string } | undefined;
      if (occ) throw new Error(`路径上仍有资源，不能分配新 ID: ${it.rel}`);
      const name = nameOf(it.rel);
      const ext = it.st.kind === 'file' ? extOf(name) : '';
      const hash = hashForStat(it.abs, it.st, undefined);
      ins.run(it.id, sourceId, it.rel, relKey(it.rel), name, ext, it.st.kind, it.st.size, it.st.mtimeMs, it.st.fileKey, hash, now, now);
      setFts(db, it.id, sourceId, it.rel, name);
    }

    const curRel = db.prepare('SELECT rel_path FROM resources WHERE id=?');
    for (const [id, oldRel] of oldRelOf) {
      if (movedIds.has(id)) continue;
      const cur = curRel.get(id) as { rel_path: string } | undefined;
      if (!cur || cur.rel_path === oldRel) continue;
      const occ = byRel.get(sourceId, oldRel) as { id: string } | undefined;
      if (!occ) setRel.run(oldRel, relKey(oldRel), id);
    }

    const dirRows = db.prepare(`SELECT id, rel_path FROM resources WHERE root_id=? AND kind='dir' AND rel_path<>''`).all(sourceId) as { id: string; rel_path: string }[];
    const touchDir = db.prepare(
      `UPDATE resources SET kind='dir', size=?, mtime_ms=?, file_key=?, ext='', missing_since=NULL, updated_at=? WHERE id=?`,
    );
    for (const d of dirRows) {
      if (missingIds.has(d.id) || movedIds.has(d.id)) continue;
      const abs = path.join(newAbs, ...d.rel_path.split('/'));
      const st = statForIndex(abs, false);
      if (st?.kind === 'dir') {
        touchDir.run(st.size, st.mtimeMs, st.fileKey, now, d.id);
        setFts(db, d.id, sourceId, d.rel_path, nameOf(d.rel_path));
      } else missingIds.add(d.id);
    }

    const root = db.prepare(`SELECT id FROM resources WHERE root_id=? AND rel_path=''`).get(sourceId) as { id: string } | undefined;
    const rootSt = statForIndex(newAbs, false);
    if (root && rootSt) {
      db.prepare(`UPDATE resources SET kind='dir', size=?, mtime_ms=?, file_key=?, missing_since=NULL, updated_at=? WHERE id=?`).run(
        rootSt.size,
        rootSt.mtimeMs,
        rootSt.fileKey,
        now,
        root.id,
      );
      setFts(db, root.id, sourceId, '', '');
    }

    markRemapPending(db, [...missingIds], now);

    const fileCount = (db.prepare(`SELECT COUNT(*) c FROM resources WHERE root_id=? AND missing_since IS NULL AND kind='file'`).get(sourceId) as { c: number }).c;
    db.prepare(
      `INSERT INTO index_state(root_id, file_count) VALUES (?,?)
       ON CONFLICT(root_id) DO UPDATE SET file_count=excluded.file_count`,
    ).run(sourceId, fileCount);
  }).immediate();
}
