// 工作区根实例：筛选和排序各自保存，补实例不覆盖已有行。
import { afterEach, expect, it } from 'vitest';
import { makeService, tmpDir, write } from './helpers';
import type { WorkbenchService } from '../src/main/service/WorkbenchService';
import { WORKSPACE_ROOT_INSTANCE_VERSION } from '../src/main/service/workspaceRootInstance';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const EMPTY = { schema: 4, dock: null, shell: { sidebarWidth: 280 } };

function instanceOf(svc: WorkbenchService, workspaceId: string, sourceId: string) {
  return svc.db.prepare(
    'SELECT name, filter_json, sort_order FROM workspace_root_instances WHERE workspace_id = ? AND source_id = ?',
  ).get(workspaceId, sourceId) as { name: string; filter_json: string; sort_order: number };
}

it('两个工作区的筛选和排序互不覆盖，已有实例不被补写盖掉', async () => {
  const { svc } = await makeService();
  cleanups.push(() => svc.close());
  expect(WORKSPACE_ROOT_INSTANCE_VERSION).toBe(1210);
  expect(svc.db.pragma('user_version', { simple: true })).toBe(5);

  const dir = tmpDir('kb-inst-');
  write(`${dir}/note.md`, '笔记');
  write(`${dir}/note.txt`, '文本');
  const other = tmpDir('kb-inst-b-');
  write(`${other}/a.md`, '另一份');

  const a = svc.createWorkspace('工作区A', '', EMPTY, []).id;
  const b = svc.createWorkspace('工作区B', '', EMPTY, []).id;
  svc.setCurrentWorkspace(a);
  const added = svc.addRoot(dir, '甲', ['txt']);
  svc.setCurrentWorkspace(b);
  svc.addRoot(dir, '乙', ['md']);

  expect(instanceOf(svc, a, added.id)).toMatchObject({ name: '甲', filter_json: '{"extensions":["txt"]}' });
  expect(instanceOf(svc, b, added.id)).toMatchObject({ name: '乙', filter_json: '{"extensions":["md"]}' });
  expect(svc.db.prepare('SELECT name, filter_json FROM roots WHERE id = ?').get(added.id)).toEqual({
    name: '甲',
    filter_json: '{"extensions":["txt"]}',
  });

  svc.setCurrentWorkspace(a);
  svc.setSourceFilter(added.id, ['pdf']);
  expect(instanceOf(svc, a, added.id).filter_json).toBe('{"extensions":["pdf"]}');
  expect(instanceOf(svc, b, added.id).filter_json).toBe('{"extensions":["md"]}');
  expect(svc.db.prepare('SELECT filter_json FROM roots WHERE id = ?').get(added.id)).toEqual({
    filter_json: '{"extensions":["txt"]}',
  });

  svc.db.prepare('UPDATE workspace_root_instances SET name = ? WHERE workspace_id = ? AND source_id = ?').run('改过', b, added.id);
  svc.setCurrentWorkspace(b);
  svc.rootsToWatch();
  expect(instanceOf(svc, b, added.id).name).toBe('改过');
  expect(svc.rootsToWatch().find((root) => root.id === added.id)?.name).toBe('改过');

  svc.db.prepare('UPDATE workspace_root_instances SET sort_order = ? WHERE workspace_id = ? AND source_id = ?').run(5, b, added.id);
  const second = svc.addRoot(other, '后加');
  const names = svc.rootsToWatch().map((root) => root.name);
  expect(names).toEqual(['后加', '改过']);
  expect(instanceOf(svc, b, second.id).sort_order).toBe(0);
  expect(instanceOf(svc, b, added.id).sort_order).toBe(5);
});
