/**
 * r12-P4 重映射预览。
 * remapRoot 只自动接受 file_key / content_hash / size_mtime，不接受 pathHint，不给未勾选的新文件分配 UUID。
 * 日常对账仍是 upsertSeen（同路径优先）；本文件里「扫描之后同名复用」测的是这条旧顺序，不是预览自动配对。
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeService, tmpDir, write } from './helpers';
import { HASH_MAX_BYTES, reconcileScan, statForIndex } from '../src/main/service/indexer';
import type { IndexRunner } from '../src/main/service/indexRunner';
import { listMissing } from '../src/main/migration/repair';
import type { WorkbenchService } from '../src/main/service/WorkbenchService';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function noopRunner(): IndexRunner {
  return {
    scan: async () => ({ processed: 0, cancelled: false, missing: 0, renamed: 0, created: 0, changed: [] }),
    cancel() {},
    applyEvents: async () => ({ renamed: 0, changed: [] }),
    async close() {},
  };
}

async function setup(files: Record<string, string | Buffer>) {
  const { svc } = await makeService({ createRunner: () => noopRunner() });
  cleanups.push(() => svc.close());
  const rootDir = tmpDir('kbremap-');
  for (const [rel, body] of Object.entries(files)) write(path.join(rootDir, ...rel.split('/')), body);
  const root = svc.addRoot(rootDir, '源');
  await reconcileScan(svc.db, root.id, rootDir, { isCancelled: () => false, onProgress() {} });
  return { svc, rootDir, root };
}

function stamp(p: string, ms: number) {
  const d = new Date(ms);
  fs.utimesSync(p, d, d);
}

function row(svc: WorkbenchService, id: string) {
  return svc.db.prepare('SELECT id, rel_path, missing_since, content_hash, file_key, size, mtime_ms FROM resources WHERE id=?').get(id) as {
    id: string;
    rel_path: string;
    missing_since: number | null;
    content_hash: string | null;
    file_key: string | null;
    size: number;
    mtime_ms: number;
  };
}

function idOf(svc: WorkbenchService, rootId: string, rel: string) {
  return (svc.db.prepare('SELECT id FROM resources WHERE root_id=? AND rel_path=?').get(rootId, rel) as { id: string } | undefined)?.id;
}

function countRes(svc: WorkbenchService, rootId: string) {
  return (svc.db.prepare('SELECT COUNT(*) c FROM resources WHERE root_id=?').get(rootId) as { c: number }).c;
}

const none = { pairIds: [] as string[], pathHintIds: [] as string[], newRels: [] as string[] };

describe('重映射预览', () => {
  it('预览不写挂载；同名不同哈希不进 pairs', async () => {
    const T = 1_700_000_000_000;
    const { svc, rootDir, root } = await setup({ 'note.md': 'alpha-1' });
    stamp(path.join(rootDir, 'note.md'), T);
    await reconcileScan(svc.db, root.id, rootDir, { isCancelled: () => false, onProgress() {} });
    const oldId = idOf(svc, root.id, 'note.md')!;
    const before = JSON.stringify(svc.db.prepare('SELECT id, rel_path, missing_since, content_hash FROM resources ORDER BY id').all());
    const mount = svc.getRoot(root.id).path;

    const dest = tmpDir('kbremap-dest-');
    write(path.join(dest, 'note.md'), 'alpha-2');
    stamp(path.join(dest, 'note.md'), T);
    write(path.join(dest, 'fresh.md'), 'brand-new-file');

    const preview = svc.previewRemap(root.id, dest);
    expect(svc.getRoot(root.id).path).toBe(mount);
    expect(JSON.stringify(svc.db.prepare('SELECT id, rel_path, missing_since, content_hash FROM resources ORDER BY id').all())).toBe(before);
    expect(preview.format).toBe('kb-workbench.remap-preview');
    expect(preview.formatVersion).toBe(1);
    expect(preview.sourceId).toBe(root.id);
    expect(preview.pairs).toEqual([]);
    expect(preview.pathHints).toEqual([{ resourceId: oldId, oldRel: 'note.md', newRel: 'note.md' }]);
    expect(preview.unassigned.map((u) => u.newRel)).toEqual(['fresh.md']);
    expect(preview.pending).toEqual([]);
  });

  it('remapRoot 不自动接受 pathHint：旧 ID 仍在且 missing_since 非空，未勾选的新文件没有新 UUID', async () => {
    const T = 1_700_000_000_000;
    const { svc, rootDir, root } = await setup({ 'note.md': 'alpha-1' });
    stamp(path.join(rootDir, 'note.md'), T);
    await reconcileScan(svc.db, root.id, rootDir, { isCancelled: () => false, onProgress() {} });
    const oldId = idOf(svc, root.id, 'note.md')!;
    const rootRes = svc.getRoot(root.id).resourceId;
    const before = countRes(svc, root.id);
    svc.addFavorite(oldId);

    const dest = tmpDir('kbremap-dest-');
    write(path.join(dest, 'note.md'), 'alpha-2');
    stamp(path.join(dest, 'note.md'), T);
    write(path.join(dest, 'fresh.md'), 'brand-new-file');
    fs.mkdirSync(path.join(dest, 'extra'));

    svc.remapRoot(root.id, dest);
    expect(svc.getRoot(root.id).path).toBe(dest);
    expect(countRes(svc, root.id)).toBe(before);
    expect(idOf(svc, root.id, 'fresh.md')).toBeUndefined();
    expect(idOf(svc, root.id, 'extra')).toBeUndefined();
    const kept = row(svc, oldId);
    expect(kept.id).toBe(oldId);
    expect(kept.rel_path).toBe('note.md');
    expect(kept.missing_since).not.toBeNull();
    expect(row(svc, rootRes).missing_since).toBeNull();
    expect(listMissing(svc).map((m) => m.resourceId)).toContain(oldId);
    expect(svc.listFavorites().find((f) => f.resourceId === oldId)?.missing).toBe(true);
  });

  it('唯一 file_key 配对；被盖住路径的旧 ID 仍在，引用不删', async () => {
    const { svc, rootDir, root } = await setup({ 'a.md': 'alpha-body', 'b.md': 'beta-body' });
    const aId = idOf(svc, root.id, 'a.md')!;
    const bId = idOf(svc, root.id, 'b.md')!;
    const oldKey = row(svc, aId).file_key;
    svc.addFavorite(bId);
    const ws = svc.createWorkspace('读');
    svc.addWorkspaceRefs(ws.id, [bId]);
    svc.saveWorkspaceLayout(ws.id, { schema: 4, dock: null, shell: { sidebarWidth: 280 } }, [
      { itemId: 'i-b', sourceKind: 'file', adapterId: 'auto', ref: bId, displayMode: 'in-app-reader' },
    ]);
    const folder = svc.createVirtualFolder(null, '夹');
    svc.setVfolderMembership(bId, [folder.folderId]);

    const dest = tmpDir('kbremap-dest-');
    fs.renameSync(path.join(rootDir, 'a.md'), path.join(dest, 'b.md'));
    const movedKey = statForIndex(path.join(dest, 'b.md'))!.fileKey;
    expect(movedKey).toBe(oldKey);

    const preview = svc.previewRemap(root.id, dest);
    expect(preview.pairs).toEqual([{ resourceId: aId, by: 'file_key', oldRel: 'a.md', newRel: 'b.md', pathHint: false }]);
    expect(preview.pending.map((p) => p.resourceId)).toContain(bId);
    expect(preview.pathHints).toEqual([]);

    const before = countRes(svc, root.id);
    svc.remapRoot(root.id, dest);
    expect(countRes(svc, root.id)).toBe(before);
    expect(row(svc, aId)).toMatchObject({ rel_path: 'b.md', missing_since: null });
    expect(svc.readText(aId).text).toBe('alpha-body');
    const ghost = row(svc, bId);
    expect(ghost.missing_since).not.toBeNull();
    expect(svc.listFavorites().map((f) => f.resourceId)).toContain(bId);
    expect(svc.listWorkspaceRefs(ws.id).map((r) => r.resourceId)).toContain(bId);
    expect(svc.listVfolderMembership(bId)).toEqual([folder.folderId]);
    expect(svc.getWorkspace(ws.id).items.find((i) => i.itemId === 'i-b')?.ref).toBe(bId);
    expect(listMissing(svc).map((m) => m.resourceId)).toContain(bId);
  });

  it('复制后的唯一内容哈希按 content_hash 配对，不看路径', async () => {
    const { svc, rootDir, root } = await setup({ 'a.md': 'same-bytes' });
    const aId = idOf(svc, root.id, 'a.md')!;
    const dest = tmpDir('kbremap-dest-');
    fs.copyFileSync(path.join(rootDir, 'a.md'), path.join(dest, 'moved.md'));
    stamp(path.join(dest, 'moved.md'), 1_800_000_000_000);
    const preview = svc.previewRemap(root.id, dest);
    expect(preview.pairs).toEqual([{ resourceId: aId, by: 'content_hash', oldRel: 'a.md', newRel: 'moved.md', pathHint: false }]);
    svc.remapRoot(root.id, dest);
    expect(row(svc, aId)).toMatchObject({ rel_path: 'moved.md', missing_since: null });
    expect(idOf(svc, root.id, 'a.md')).toBeUndefined();
  });

  it('旧哈希缺失且文件已不在时，唯一的 size+mtime 配对，哈希不矛盾才算', async () => {
    const T = 1_700_000_111_000;
    const { svc, rootDir, root } = await setup({ 'a.md': 'hello!' });
    stamp(path.join(rootDir, 'a.md'), T);
    await reconcileScan(svc.db, root.id, rootDir, { isCancelled: () => false, onProgress() {} });
    const aId = idOf(svc, root.id, 'a.md')!;
    svc.db.prepare('UPDATE resources SET content_hash=NULL WHERE id=?').run(aId);
    fs.rmSync(path.join(rootDir, 'a.md'));
    const dest = tmpDir('kbremap-dest-');
    write(path.join(dest, 'b.md'), 'world!');
    stamp(path.join(dest, 'b.md'), T);
    const preview = svc.previewRemap(root.id, dest);
    expect(preview.pairs).toEqual([{ resourceId: aId, by: 'size_mtime', oldRel: 'a.md', newRel: 'b.md', pathHint: false }]);
  });

  it('两边 file_key 不是各出现一次时不按 file_key 配对', async (ctx) => {
    const { svc, rootDir, root } = await setup({ 'a.md': 'link-body' });
    const dest = tmpDir('kbremap-dest-');
    try {
      fs.linkSync(path.join(rootDir, 'a.md'), path.join(dest, 'a-link.md'));
      fs.linkSync(path.join(rootDir, 'a.md'), path.join(dest, 'b-link.md'));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'ENOTSUP') return ctx.skip('本机不能创建硬链接');
      throw e;
    }
    const preview = svc.previewRemap(root.id, dest);
    expect(preview.pairs.filter((p) => p.by === 'file_key')).toEqual([]);
    expect(preview.pairs).toEqual([]);
    expect(preview.unassigned.map((u) => u.newRel).sort()).toEqual(['a-link.md', 'b-link.md']);
  });

  it('大于 4 MiB 且没有哈希时不算 content_hash', async () => {
    const big = Buffer.alloc(HASH_MAX_BYTES + 1, 7);
    const { svc, rootDir, root } = await setup({ 'big.bin': big });
    const id = idOf(svc, root.id, 'big.bin')!;
    expect(row(svc, id).content_hash).toBeNull();
    const dest = tmpDir('kbremap-dest-');
    fs.copyFileSync(path.join(rootDir, 'big.bin'), path.join(dest, 'big-moved.bin'));
    stamp(path.join(dest, 'big-moved.bin'), 1_900_000_000_000);
    const preview = svc.previewRemap(root.id, dest);
    expect(preview.pairs).toEqual([]);
    expect(preview.pending.map((p) => p.oldRel)).toContain('big.bin');
    expect(preview.unassigned.map((u) => u.newRel)).toContain('big-moved.bin');
  });

  it('勾上的 pathHint 复用 ID；勾上的 unassigned 才分配新 UUID', async () => {
    const T = 1_700_000_000_000;
    const { svc, rootDir, root } = await setup({ 'note.md': 'alpha-1' });
    stamp(path.join(rootDir, 'note.md'), T);
    await reconcileScan(svc.db, root.id, rootDir, { isCancelled: () => false, onProgress() {} });
    const oldId = idOf(svc, root.id, 'note.md')!;
    const dest = tmpDir('kbremap-dest-');
    write(path.join(dest, 'note.md'), 'alpha-2');
    stamp(path.join(dest, 'note.md'), T);
    write(path.join(dest, 'fresh.md'), 'brand-new-file');
    const preview = svc.previewRemap(root.id, dest);
    const before = new Set((svc.db.prepare('SELECT id FROM resources WHERE root_id=?').all(root.id) as { id: string }[]).map((r) => r.id));
    svc.applyRemap(root.id, dest, preview, { pairIds: [], pathHintIds: [oldId], newRels: ['fresh.md'] });
    expect(row(svc, oldId)).toMatchObject({ rel_path: 'note.md', missing_since: null });
    expect(svc.readText(oldId).text).toBe('alpha-2');
    const fresh = idOf(svc, root.id, 'fresh.md')!;
    expect(fresh).toBeTruthy();
    expect(before.has(fresh)).toBe(false);
    expect(svc.readText(fresh).text).toBe('brand-new-file');
  });

  it('同相对路径的目录节点保持原 ID，不进 pathHints', async () => {
    const { svc, rootDir, root } = await setup({ 'sub/a.md': 'old-text' });
    const dirId = idOf(svc, root.id, 'sub')!;
    const fileId = idOf(svc, root.id, 'sub/a.md')!;
    const dest = tmpDir('kbremap-dest-');
    write(path.join(dest, 'sub/a.md'), 'new-text-xx');
    stamp(path.join(dest, 'sub/a.md'), 1_800_000_000_000);
    const preview = svc.previewRemap(root.id, dest);
    expect(preview.pairs).toEqual([]);
    expect(preview.pathHints).toEqual([{ resourceId: fileId, oldRel: 'sub/a.md', newRel: 'sub/a.md' }]);
    expect(preview.pending.map((p) => p.resourceId)).not.toContain(dirId);
    svc.remapRoot(root.id, dest);
    expect(row(svc, dirId)).toMatchObject({ rel_path: 'sub', missing_since: null });
    expect(row(svc, fileId).missing_since).not.toBeNull();
  });

  it('之后的对账扫描仍按 upsertSeen 同路径复用，这不是 remapRoot 的自动配对', async () => {
    const T = 1_700_000_000_000;
    const { svc, rootDir, root } = await setup({ 'note.md': 'alpha-1' });
    stamp(path.join(rootDir, 'note.md'), T);
    await reconcileScan(svc.db, root.id, rootDir, { isCancelled: () => false, onProgress() {} });
    const oldId = idOf(svc, root.id, 'note.md')!;
    const dest = tmpDir('kbremap-dest-');
    write(path.join(dest, 'note.md'), 'alpha-2');
    stamp(path.join(dest, 'note.md'), T);
    svc.remapRoot(root.id, dest);
    expect(row(svc, oldId).missing_since).not.toBeNull();
    await reconcileScan(svc.db, root.id, dest, { isCancelled: () => false, onProgress() {} });
    expect(idOf(svc, root.id, 'note.md')).toBe(oldId);
    expect(row(svc, oldId).missing_since).toBeNull();
  });

  it('勾选对不上预览时拒绝，且不改挂载', async () => {
    const { svc, root, rootDir } = await setup({ 'a.md': 'x' });
    const dest = tmpDir('kbremap-dest-');
    write(path.join(dest, 'a.md'), 'y');
    const preview = svc.previewRemap(root.id, dest);
    expect(() => svc.applyRemap(root.id, dest, preview, { ...none, pairIds: ['not-a-pair'] })).toThrow(/预览中没有这项配对/);
    expect(svc.getRoot(root.id).path).toBe(rootDir);
  });
});
