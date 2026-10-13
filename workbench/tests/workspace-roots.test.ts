import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { claimUnownedRoots, WORKSPACE_ROOT_FALLBACK_KEY } from '../src/main/service/db';
import { WorkbenchService } from '../src/main/service/WorkbenchService';
import { ingestWatch, WATCH_QUEUE_CAP } from '../src/main/service/watcher';
import { makeService, tmpDir, write, waitFor } from './helpers';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const shell = { schema: 4, dock: null, shell: { sidebarWidth: 280 } };
const fileItem = (ref: string) => ({ itemId: 'item-' + ref.slice(0, 8), sourceKind: 'file', adapterId: 'auto', ref, displayMode: 'in-app-reader' });

it('引用过的根登记到那些工作区，看不出来的归到上次打开的工作区，不删资料', async () => {
  const { svc, dataDir } = await makeService();
  cleanups.push(() => svc.close());
  const dirA = tmpDir('ws-root-a-');
  const dirB = tmpDir('ws-root-b-');
  write(path.join(dirA, 'a.md'), '甲文件正文');
  write(path.join(dirB, 'b.md'), '乙文件正文');
  const rootA = svc.addRoot(dirA, '甲根');
  const rootB = svc.addRoot(dirB, '乙根');
  await svc.scanRoot(rootA.id);
  await svc.scanRoot(rootB.id);
  const fileA = svc.db.prepare("SELECT id FROM resources WHERE root_id = ? AND rel_path = 'a.md'").get(rootA.id) as { id: string };
  const wsA = svc.createWorkspace('甲区', '');
  const wsB = svc.createWorkspace('乙区', '');
  svc.setCurrentWorkspace(wsB.id);
  await svc.saveWorkspaceLayout(wsA.id, shell, [fileItem(fileA.id)]);
  await svc.saveWorkspaceLayout(wsB.id, shell, [fileItem(fileA.id)]);
  const resourcesBefore = (svc.db.prepare('SELECT COUNT(*) AS n FROM resources').get() as { n: number }).n;
  const itemsBefore = (svc.db.prepare('SELECT COUNT(*) AS n FROM workspace_items').get() as { n: number }).n;
  svc.db.prepare('DELETE FROM workspace_roots').run();
  svc.db.prepare('DELETE FROM layout WHERE key = ?').run(WORKSPACE_ROOT_FALLBACK_KEY);
  const fallen = claimUnownedRoots(svc.db, wsB.id);
  expect(svc.workspaceRootIds(wsA.id).sort()).toEqual([rootA.id].sort());
  expect(svc.workspaceRootIds(wsB.id).sort()).toEqual([rootA.id, rootB.id].sort());
  expect(fallen).toEqual([{ rootId: rootB.id, name: '乙根', workspaceId: wsB.id, workspaceName: '乙区' }]);
  expect(svc.workspaceRootFallbacks()).toEqual(fallen);
  expect((svc.db.prepare('SELECT COUNT(*) AS n FROM resources').get() as { n: number }).n).toBe(resourcesBefore);
  expect((svc.db.prepare('SELECT COUNT(*) AS n FROM workspace_items').get() as { n: number }).n).toBe(itemsBefore);
  expect(svc.db.prepare('SELECT id FROM resources WHERE id = ?').get(fileA.id)).toEqual({ id: fileA.id });

  const hash = svc.db.prepare("SELECT content_hash FROM resources WHERE root_id = ? AND rel_path = 'a.md'").get(rootA.id) as { content_hash: string | null };
  svc.setCurrentWorkspace(wsA.id);
  expect(svc.rootsToWatch().map((root) => root.id)).toEqual([rootA.id]);
  const back = svc.setCurrentWorkspace(wsB.id);
  expect(back.attached.sort()).toEqual([rootB.id].sort());
  const again = await svc.scanRoot(rootB.id);
  expect(again?.changed.filter((change) => change.relPath === 'b.md')).toEqual([]);
  const hashAfter = svc.db.prepare("SELECT content_hash FROM resources WHERE root_id = ? AND rel_path = 'a.md'").get(rootA.id) as { content_hash: string | null };
  expect(hashAfter).toEqual(hash);

  await svc.close();
  cleanups.pop();
  const svc2 = new WorkbenchService({ dataDir });
  cleanups.push(() => svc2.close());
  expect((svc2.db.prepare('SELECT COUNT(*) AS n FROM resources').get() as { n: number }).n).toBe(resourcesBefore);
  expect((svc2.db.prepare('SELECT COUNT(*) AS n FROM workspace_items').get() as { n: number }).n).toBe(itemsBefore);
  expect(svc2.workspaceRootIds(wsB.id).sort()).toEqual([rootA.id, rootB.id].sort());
});

async function openWatched() {
  const indexer = await import('@kb/indexer');
  const { svc } = await makeService();
  const dir = tmpDir('ws-watch-');
  write(path.join(dir, 'note.md'), '原来的句子');
  const root = svc.addRoot(dir, '监听根');
  await svc.scanRoot(root.id);
  indexer.migrate(svc.db);
  const live = new (await import('../src/main/backend/liveContent')).LiveContentIndex(svc, svc.db, indexer.indexOne, indexer.removeOne, 20);
  svc.on('fs-change', live.enqueue);
  cleanups.push(async () => {
    svc.off('fs-change', live.enqueue);
    await live.close();
    // PDF 线程还在加载时关索引进程，shutdown 不会结束。等它就绪再关。
    await indexer.indexerReady();
    await indexer.closeIndexer();
    await svc.close();
  });
  const hits = (word: string) => indexer.searchGrouped(svc.db, word).hits;
  return { svc, dir, root, live, hits };
}

it('外部修改进得了索引', async () => {
  const { svc, dir, root, live, hits } = await openWatched();
  fs.appendFileSync(path.join(dir, 'note.md'), '\n外部改写词');
  await svc.applyFsEvents(root.id, [{ type: 'change', relPath: 'note.md' }]);
  await live.flush();
  await waitFor(() => hits('外部改写词').length === 1);
}, 30000);

it('队列清空之后比对仍然找得到', async () => {
  const { svc, dir, root, live, hits } = await openWatched();
  const queue = new Map<string, { type: 'change'; relPath: string }>();
  for (let i = 0; i < WATCH_QUEUE_CAP; i += 1) ingestWatch(queue, { type: 'change', relPath: `pad/${i}.md` });
  expect(ingestWatch(queue, { type: 'change', relPath: 'overflow.md' }).rescan).toBe(true);
  expect(queue.size).toBe(0);
  write(path.join(dir, 'overflow.md'), '溢出比对词');
  const scanned = await svc.scanRoot(root.id);
  expect(scanned?.changed.some((change) => change.relPath === 'overflow.md')).toBe(true);
  await live.flush();
  await waitFor(() => hits('溢出比对词').length === 1);
}, 30000);
