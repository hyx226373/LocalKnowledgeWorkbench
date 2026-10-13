// 修订 C3：同一 realpath 是一份资料源，每个工作区有自己的根实例。
// A 移除只隐藏 A 的实例，B 的名称、登记和磁盘文件都还在。
import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeService, tmpDir, write } from './helpers';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const EMPTY = { schema: 4, dock: null, shell: { sidebarWidth: 280 } };

function sameDir(a: string, b: string) {
  if (!a || !b) return false;
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

it('跨工作区移除共享根后，另一工作区仍看到该目录且名称为乙，磁盘文件还在', async () => {
  const { svc } = await makeService();
  cleanups.push(() => svc.close());
  const dir = tmpDir('kb-cross-ws-');
  const note = path.join(dir, 'note.md');
  write(note, '共享笔记');

  const a = svc.createWorkspace('工作区A', '', EMPTY, []).id;
  const b = svc.createWorkspace('工作区B', '', EMPTY, []).id;
  svc.setCurrentWorkspace(a);
  const addedA = svc.addRoot(dir, '甲');
  svc.setCurrentWorkspace(b);
  const addedB = svc.addRoot(dir, '乙');

  expect.soft(addedA.sourceId).toBe(addedA.id);
  expect.soft(addedB.sourceId).toBe(addedA.id);
  expect.soft(addedB.workspaceRootId).not.toBe(addedA.workspaceRootId);
  expect.soft(svc.rootsToWatch().map((root) => root.name)).toContain('乙');
  expect.soft(svc.db.prepare('SELECT name FROM roots WHERE id = ?').get(addedA.id)).toEqual({ name: '甲' });

  svc.setCurrentWorkspace(a);
  svc.addRoot(dir, '丙');
  svc.setCurrentWorkspace(b);
  expect.soft(
    svc.rootsToWatch().filter((root) => sameDir(root.path, dir)).map((root) => root.name),
  ).toEqual(['乙']);

  svc.setCurrentWorkspace(a);
  svc.removeRoot(addedA.id);
  svc.setCurrentWorkspace(b);
  expect.soft(
    svc.rootsToWatch().filter((root) => sameDir(root.path, dir)).map((root) => root.name),
  ).toEqual(['乙']);
  expect.soft(fs.existsSync(note)).toBe(true);
  expect.soft(svc.resourceIdFor(addedB.id, 'note.md')).toBeTruthy();
  const still = svc.db.prepare(
    'SELECT workspace_id FROM workspace_roots WHERE root_id = ? ORDER BY workspace_id',
  ).all(addedA.id) as { workspace_id: string }[];
  expect.soft(still.map((row) => row.workspace_id)).toEqual([b]);
});
