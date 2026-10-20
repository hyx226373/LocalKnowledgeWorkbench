import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { makeService, tmpDir, write } from './helpers';
import { setContentArea } from '../src/main/backend/contentScope';
import {
  LIVE_INDEX_BATCH,
  LiveContentIndex,
  resetLiveIndexCompactForTests,
  type LiveIndexMany,
} from '../src/main/backend/liveContent';
import type { ContentScope } from '@kb/indexer';
import type { WorkbenchService } from '../src/main/service/WorkbenchService';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  resetLiveIndexCompactForTests();
  while (cleanups.length) await cleanups.pop()!();
});

function ensureIndexTable(db: WorkbenchService['db']) {
  db.exec(`CREATE TABLE IF NOT EXISTS indexer_files (
    resource_id TEXT PRIMARY KEY,
    root_id TEXT,
    rel_path TEXT,
    size INTEGER,
    mtime_ms REAL,
    body_indexed INTEGER
  )`);
}

function stampBody(db: WorkbenchService['db'], id: string, rootId: string, rel: string, abs: string, body: 0 | 1) {
  const st = fs.statSync(abs);
  db.prepare(
    `INSERT INTO indexer_files (resource_id, root_id, rel_path, size, mtime_ms, body_indexed)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(resource_id) DO UPDATE SET
       rel_path = excluded.rel_path,
       size = excluded.size,
       mtime_ms = excluded.mtime_ms,
       body_indexed = excluded.body_indexed`,
  ).run(id, rootId, rel, st.size, st.mtimeMs, body);
}

type Seen = { rel: string; include: string[] };

function liveWithMany(
  svc: WorkbenchService,
  indexMany: LiveIndexMany,
  indexOne?: () => Promise<void>,
) {
  const removed: string[] = [];
  const live = new LiveContentIndex(
    svc,
    svc.db,
    (async () => { if (indexOne) await indexOne(); }) as never,
    ((_db: unknown, id: string) => { removed.push(id); }) as never,
    10,
    undefined,
    undefined,
    indexMany,
  );
  cleanups.push(async () => { await live.close(); await svc.close(); });
  return { live, removed };
}

it('2000 个无 prior 的图片只调用 indexMany，且每批不超过 200', async () => {
  const { svc } = await makeService();
  const dir = tmpDir('idx-img-');
  const n = 2000;
  for (let i = 0; i < n; i += 1) write(path.join(dir, `p${i}.png`), 'x');
  const root = svc.addRoot(dir);
  await svc.scanRoot(root.id);
  ensureIndexTable(svc.db);
  const batches: number[] = [];
  let oneCalls = 0;
  const { live } = liveWithMany(
    svc,
    (async (_db, items) => { batches.push(items.length); }) as LiveIndexMany,
    async () => { oneCalls += 1; },
  );
  const files = svc.db.prepare(
    `SELECT rel_path FROM resources WHERE root_id=? AND kind='file'`,
  ).all(root.id) as Array<{ rel_path: string }>;
  expect(files).toHaveLength(n);
  live.enqueue(files.map((row) => ({ rootId: root.id, relPath: row.rel_path, type: 'change' })));
  await live.flush();
  expect(oneCalls).toBe(0);
  expect(batches.reduce((sum, size) => sum + size, 0)).toBe(n);
  expect(batches.length).toBe(Math.ceil(n / LIVE_INDEX_BATCH));
  for (const size of batches) {
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThanOrEqual(LIVE_INDEX_BATCH);
  }
}, 120000);

it('范围键已更新后，对账仍会把扫描期间打开的文件正文写回去', async () => {
  const { svc } = await makeService();
  const dir = tmpDir('idx-open-');
  const abs = path.join(dir, 'note.md');
  write(abs, '正文');
  const root = svc.addRoot(dir);
  await svc.scanRoot(root.id);
  ensureIndexTable(svc.db);
  const row = svc.db.prepare(`SELECT id FROM resources WHERE root_id=? AND rel_path='note.md'`).get(root.id) as { id: string };
  stampBody(svc.db, row.id, root.id, 'note.md', abs, 0);
  const seen: Seen[] = [];
  const { live } = liveWithMany(svc, (async (_db, _items, opts) => {
    const scope = opts?.contentScope as ContentScope | undefined;
    seen.push({ rel: 'note.md', include: [...(scope?.includeRelPaths ?? [])] });
  }) as LiveIndexMany);
  setContentArea(svc, 'agent-materials', { resourceIds: [row.id] });
  live.dropOutOfScope();
  await live.flush();
  expect(seen.at(-1)?.include).toContain('note.md');
  seen.length = 0;
  stampBody(svc.db, row.id, root.id, 'note.md', abs, 0);
  live.dropOutOfScope();
  await live.flush();
  expect(seen).toEqual([]);
  live.reconcileRoot(root.id);
  await live.flush();
  expect(seen).toHaveLength(1);
  expect(seen[0]?.include).toContain('note.md');
});

it('范围键已更新后，对账会清掉扫描期间移出 Agent 资料的正文', async () => {
  const { svc } = await makeService();
  const dir = tmpDir('idx-move-');
  const abs = path.join(dir, 'note.md');
  write(abs, '正文');
  const root = svc.addRoot(dir);
  await svc.scanRoot(root.id);
  ensureIndexTable(svc.db);
  const row = svc.db.prepare(`SELECT id FROM resources WHERE root_id=? AND rel_path='note.md'`).get(root.id) as { id: string };
  stampBody(svc.db, row.id, root.id, 'note.md', abs, 1);
  const seen: Seen[] = [];
  const { live, removed } = liveWithMany(svc, (async (_db, _items, opts) => {
    const scope = opts?.contentScope as ContentScope | undefined;
    seen.push({ rel: 'note.md', include: [...(scope?.includeRelPaths ?? [])] });
  }) as LiveIndexMany);
  setContentArea(svc, 'agent-materials', { resourceIds: [row.id] });
  live.dropOutOfScope();
  await live.flush();
  setContentArea(svc, 'agent-materials', {});
  live.dropOutOfScope();
  await live.flush();
  expect(seen.at(-1)?.include).not.toContain('note.md');
  seen.length = 0;
  stampBody(svc.db, row.id, root.id, 'note.md', abs, 1);
  live.dropOutOfScope();
  await live.flush();
  expect(seen).toEqual([]);
  live.reconcileRoot(root.id);
  await live.flush();
  expect(removed).toEqual([]);
  expect(seen).toHaveLength(1);
  expect(seen[0]?.include ?? []).not.toContain('note.md');
});

it('冷启动对账把范围外的陈旧正文改成仅文件名，并补上没有 indexer 行的文本', async () => {
  const { svc } = await makeService();
  const dir = tmpDir('idx-cold-');
  const staleAbs = path.join(dir, 'stale.md');
  const missingAbs = path.join(dir, 'missing.md');
  const pngAbs = path.join(dir, 'pic.png');
  write(staleAbs, '旧正文');
  write(missingAbs, '还没有行');
  write(pngAbs, 'x');
  const root = svc.addRoot(dir);
  await svc.scanRoot(root.id);
  ensureIndexTable(svc.db);
  const rows = svc.db.prepare(
    `SELECT id, rel_path FROM resources WHERE root_id=? AND kind='file'`,
  ).all(root.id) as Array<{ id: string; rel_path: string }>;
  const byRel = new Map(rows.map((row) => [row.rel_path, row.id]));
  stampBody(svc.db, byRel.get('stale.md')!, root.id, 'stale.md', staleAbs, 1);
  const seen: string[] = [];
  const { live, removed } = liveWithMany(svc, (async (_db, items, opts) => {
    const scope = opts?.contentScope as ContentScope | undefined;
    expect(scope?.includeRelPaths ?? []).toEqual([]);
    for (const item of items) seen.push(item.relPath);
  }) as LiveIndexMany);
  live.reconcileRoot(root.id);
  await live.flush();
  expect(removed).toEqual([]);
  expect(seen.slice().sort()).toEqual(['missing.md', 'stale.md']);
  expect(seen).not.toContain('pic.png');
});

it('indexMany 报 SQLITE_FULL 时压实成功会重放这一批', async () => {
  resetLiveIndexCompactForTests();
  const { svc } = await makeService();
  const dir = tmpDir('idx-full-');
  write(path.join(dir, 'a.md'), '甲');
  const root = svc.addRoot(dir);
  await svc.scanRoot(root.id);
  ensureIndexTable(svc.db);
  let calls = 0;
  let compacts = 0;
  const live = new LiveContentIndex(
    svc,
    svc.db,
    (async () => { throw new Error('不应退回 indexOne'); }) as never,
    (() => undefined) as never,
    10,
    async () => {
      compacts += 1;
      return { ok: true, steps: 2 };
    },
    undefined,
    (async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('full'), { code: 'SQLITE_FULL' });
    }) as LiveIndexMany,
  );
  cleanups.push(async () => { await live.close(); await svc.close(); });
  live.enqueue([{ rootId: root.id, relPath: 'a.md', type: 'change' }]);
  await live.flush();
  const start = Date.now();
  while (calls < 2 && Date.now() - start < 2000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(compacts).toBe(1);
  expect(calls).toBe(2);
});

it('装配在批量结束和启动扫描后对账', () => {
  const wire = fs.readFileSync(path.join(process.cwd(), 'src/main/backend/wire.ts'), 'utf8');
  const entry = fs.readFileSync(path.join(process.cwd(), 'src/main/data/entry.ts'), 'utf8');
  const types = fs.readFileSync(path.join(process.cwd(), 'src/types/kb-indexer.d.ts'), 'utf8');
  expect(wire).toContain('reconcileRoot(rootId)');
  expect(wire).toContain('indexMany');
  expect(wire).toContain('compactTextIndexUntilWritable');
  expect(entry).toContain('reconcileContentRoot(root.id)');
  expect(types).toContain('indexMany');
  expect(types).toContain('compactTextIndexUntilWritable');
});

it('对账一根不会吞掉别的根尚未处理的范围变化', async () => {
  const { svc } = await makeService();
  const dirA = tmpDir('idx-a-');
  const dirB = tmpDir('idx-b-');
  write(path.join(dirA, 'a.md'), '甲');
  const absB = path.join(dirB, 'b.md');
  write(absB, '乙');
  const rootA = svc.addRoot(dirA);
  const rootB = svc.addRoot(dirB);
  await svc.scanRoot(rootA.id);
  await svc.scanRoot(rootB.id);
  ensureIndexTable(svc.db);
  const rowA = svc.db.prepare(`SELECT id FROM resources WHERE root_id=? AND rel_path='a.md'`).get(rootA.id) as { id: string };
  const rowB = svc.db.prepare(`SELECT id FROM resources WHERE root_id=? AND rel_path='b.md'`).get(rootB.id) as { id: string };
  stampBody(svc.db, rowA.id, rootA.id, 'a.md', path.join(dirA, 'a.md'), 0);
  stampBody(svc.db, rowB.id, rootB.id, 'b.md', absB, 0);
  const seen: Array<{ root: string; rel: string }> = [];
  const { live } = liveWithMany(svc, (async (_db, items) => {
    for (const item of items) seen.push({ root: item.rootId, rel: item.relPath });
  }) as LiveIndexMany);
  live.dropOutOfScope();
  await live.flush();
  seen.length = 0;
  // B 的范围变了，但还没来得及 dropOutOfScope，A 的批量就结束并对账。
  // setContentArea 会同步发事件，这里先摘掉监听，模拟事件还没处理。
  svc.removeAllListeners('content-scope-changed');
  setContentArea(svc, 'agent-materials', { resourceIds: [rowB.id] });
  live.reconcileRoot(rootA.id);
  await live.flush();
  live.dropOutOfScope();
  await live.flush();
  expect(seen).toContainEqual({ root: rootB.id, rel: 'b.md' });
});
