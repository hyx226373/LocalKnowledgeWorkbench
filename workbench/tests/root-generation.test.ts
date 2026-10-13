import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claimUnownedRoots, openDb, type DB } from '../src/main/service/db';
import {
  acceptRootResult,
  hiddenRootIds,
  listRootTasks,
  patchRootTask,
  readPublishSnapshot,
  restoreRootRecord,
  retireRoot,
  ROOT_RETIREMENT_VERSION,
} from '../src/main/service/rootGeneration';
import { shouldPublish } from '../src/shared/rootTask';

const opened: DB[] = [];
const dirs: string[] = [];

afterEach(() => {
  while (opened.length) {
    try {
      opened.pop()!.close();
    } catch {
      /* 已经关掉 */
    }
  }
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function openTemp(): { db: DB; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-retire-'));
  dirs.push(dir);
  const file = path.join(dir, 'workbench.db');
  const db = openDb(file);
  opened.push(db);
  return { db, file };
}

function reopen(file: string, db: DB): DB {
  db.close();
  const index = opened.indexOf(db);
  if (index >= 0) opened.splice(index, 1);
  const next = openDb(file);
  opened.push(next);
  return next;
}

function userVersion(db: DB): number {
  return db.pragma('user_version', { simple: true }) as number;
}

function workspace(db: DB, id: string, name: string, openedAt: number) {
  db.prepare(
    `INSERT INTO workspaces(id, name, project, layout_json, layout_schema, created_at, updated_at, last_opened_at)
     VALUES (?, ?, '', '{}', 4, 1, 1, ?)`,
  ).run(id, name, openedAt);
}

function rootRow(db: DB, id: string, name: string) {
  db.prepare('INSERT INTO roots(id, name, created_at) VALUES (?, ?, 1)').run(id, name);
}

function link(db: DB, workspaceId: string, rootId: string) {
  db.prepare('INSERT INTO workspace_roots(workspace_id, root_id) VALUES (?, ?)').run(workspaceId, rootId);
}

function resource(db: DB, id: string, rootId: string, rel: string, missing: number | null) {
  db.prepare(
    `INSERT INTO resources(id, root_id, rel_path, rel_path_key, name, ext, kind, size, mtime_ms, missing_since, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'md', 'file', 1, 1, ?, 1, 1)`,
  ).run(id, rootId, rel, rel, rel, missing);
  db.prepare('INSERT INTO resources_fts(resource_id, root_id, rel_path, name) VALUES (?, ?, ?, ?)').run(id, rootId, rel, rel);
}

function linksOf(db: DB, rootId: string): string[] {
  return (db.prepare('SELECT workspace_id FROM workspace_roots WHERE root_id = ? ORDER BY workspace_id').all(rootId) as { workspace_id: string }[])
    .map((row) => row.workspace_id);
}

describe('根退休代次', () => {
  it('建表不进 user_version，detach 递增代次并丢弃旧结果', () => {
    const { db } = openTemp();
    expect(ROOT_RETIREMENT_VERSION).toBe(1209);
    expect(userVersion(db)).toBe(5);
    expect(db.prepare('PRAGMA foreign_key_list(root_retirements)').all()).toEqual([]);
    workspace(db, 'ws-a', '甲区', 20);
    workspace(db, 'ws-b', '乙区', 10);
    rootRow(db, 'root-1', '资料');
    link(db, 'ws-a', 'root-1');
    link(db, 'ws-b', 'root-1');
    resource(db, 'res-new', 'root-1', 'a.md', null);
    resource(db, 'res-old', 'root-1', 'b.md', 50);

    const input = { rootId: 'root-1', workspaceId: 'ws-a', kind: 'detach' as const, diskPath: 'D:/data', taskId: 't1' };
    const first = retireRoot(db, input);
    expect(first.generation).toBe(1);
    expect(first.task).toMatchObject({
      taskId: 't1',
      rootId: 'root-1',
      workspaceId: 'ws-a',
      generation: 1,
      kind: 'detach',
      state: 'queued',
      phaseText: '',
      error: null,
      diskPath: 'D:/data',
    });
    expect(linksOf(db, 'root-1')).toEqual(['ws-b']);
    expect(hiddenRootIds(db, 'ws-a').has('root-1')).toBe(true);
    expect(hiddenRootIds(db, 'ws-b').has('root-1')).toBe(false);
    expect(hiddenRootIds(db, null).has('root-1')).toBe(false);
    expect(readPublishSnapshot(db, 'root-1', 'ws-b')).toBeNull();
    const hidden = readPublishSnapshot(db, 'root-1', 'ws-a');
    expect(hidden).toEqual({ generation: 1, publishable: false });
    expect(shouldPublish(hidden, 0)).toBe(false);
    expect(shouldPublish(hidden, 1)).toBe(false);
    let applied = 0;
    expect(acceptRootResult(db, 'root-1', 'ws-a', 0, () => { applied += 1; })).toBe('dropped');
    expect(acceptRootResult(db, 'root-1', 'ws-a', 1, () => { applied += 1; })).toBe('dropped');
    expect(applied).toBe(0);
    expect(db.prepare('SELECT id FROM roots').all()).toEqual([{ id: 'root-1' }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM resources_fts').get()).toEqual({ n: 2 });
    expect(db.prepare('SELECT missing_since FROM resources WHERE id = ?').get('res-new')).toEqual({ missing_since: null });
    expect(db.prepare('SELECT missing_since FROM resources WHERE id = ?').get('res-old')).toEqual({ missing_since: 50 });
    expect(userVersion(db)).toBe(5);
    const createdAt = first.task.createdAt;

    const second = retireRoot(db, { ...input, taskId: 't2' });
    expect(second.generation).toBe(2);
    expect(second.task.createdAt).toBe(createdAt);
    expect(second.task.updatedAt).toBeGreaterThanOrEqual(createdAt);
    expect(db.prepare('SELECT missing_since FROM resources WHERE id = ?').get('res-new')).toEqual({ missing_since: null });
    expect(linksOf(db, 'root-1')).toEqual(['ws-b']);
    expect(listRootTasks(db).map((task) => task.workspaceId)).toEqual(['ws-a']);

    expect(restoreRootRecord(db, 'missing', 'ws-a')).toBeNull();
    expect(restoreRootRecord(db, 'root-1', 'ws-a')).toEqual({ generation: 3 });
    const restored = readPublishSnapshot(db, 'root-1', 'ws-a');
    expect(restored).toEqual({ generation: 3, publishable: true });
    expect(shouldPublish(restored, 3)).toBe(true);
    expect(shouldPublish(restored, 0)).toBe(false);
    expect(shouldPublish(restored, 1)).toBe(false);
    expect(shouldPublish(restored, 2)).toBe(false);
    expect(hiddenRootIds(db, 'ws-a').has('root-1')).toBe(false);
    expect(acceptRootResult(db, 'root-1', 'ws-a', 2, () => { applied += 1; })).toBe('dropped');
    expect(applied).toBe(0);
    expect(acceptRootResult(db, 'root-1', 'ws-a', 3, () => { applied += 1; })).toBe('applied');
    expect(applied).toBe(1);
    expect(listRootTasks(db)[0]?.state).toBe('cancelled');
    expect(linksOf(db, 'root-1')).toEqual(['ws-b']);
    expect(db.prepare("SELECT local_path FROM root_mounts WHERE root_id = 'root-1'").get()).toBeUndefined();
    expect(userVersion(db)).toBe(5);

    expect(readPublishSnapshot(db, 'root-2', 'ws-a')).toBeNull();
    expect(shouldPublish(null, 0)).toBe(true);
    expect(acceptRootResult(db, 'root-2', 'ws-a', 0, () => { applied += 1; })).toBe('applied');
    expect(acceptRootResult(db, 'root-2', 'ws-a', 1, () => { applied += 1; })).toBe('dropped');
    expect(applied).toBe(2);
  });

  it('markMissing 才给资料打 missing_since，且不波及已有时间戳', () => {
    const { db } = openTemp();
    workspace(db, 'ws-a', '甲区', 20);
    rootRow(db, 'root-1', '资料');
    link(db, 'ws-a', 'root-1');
    resource(db, 'res-new', 'root-1', 'a.md', null);
    resource(db, 'res-old', 'root-1', 'b.md', 50);
    const marked = retireRoot(db, {
      rootId: 'root-1',
      workspaceId: 'ws-a',
      kind: 'detach',
      diskPath: 'D:/data',
      taskId: 't-mark',
      markMissing: true,
    });
    expect(marked.generation).toBe(1);
    const stamped = db.prepare('SELECT missing_since FROM resources WHERE id = ?').get('res-new') as { missing_since: number };
    expect(typeof stamped.missing_since).toBe('number');
    expect(db.prepare('SELECT missing_since FROM resources WHERE id = ?').get('res-old')).toEqual({ missing_since: 50 });
    expect(linksOf(db, 'root-1')).toEqual([]);
  });

  it('delete-disk 只隐藏当前工作区，不删登记、不删根', () => {
    const { db } = openTemp();
    workspace(db, 'ws-a', '甲区', 20);
    workspace(db, 'ws-b', '乙区', 10);
    rootRow(db, 'root-1', '资料');
    link(db, 'ws-a', 'root-1');
    link(db, 'ws-b', 'root-1');
    resource(db, 'res-1', 'root-1', 'a.md', null);
    const version = userVersion(db);

    const done = retireRoot(db, {
      rootId: 'root-1',
      workspaceId: 'ws-a',
      kind: 'delete-disk',
      diskPath: 'D:/data',
      taskId: 't-del',
    });
    expect(done.generation).toBe(1);
    expect(done.task.kind).toBe('delete-disk');
    expect(done.task.phaseText).toBe('');
    expect(linksOf(db, 'root-1')).toEqual(['ws-a', 'ws-b']);
    expect(hiddenRootIds(db, 'ws-a').has('root-1')).toBe(true);
    expect(hiddenRootIds(db, 'ws-b').has('root-1')).toBe(false);
    expect(hiddenRootIds(db, null).has('root-1')).toBe(false);
    const generations = db.prepare(
      'SELECT workspace_id, generation, publishable, state FROM root_retirements WHERE root_id = ? ORDER BY workspace_id',
    ).all('root-1') as { workspace_id: string; generation: number; publishable: number; state: string }[];
    expect(generations).toEqual([
      { workspace_id: 'ws-a', generation: 1, publishable: 0, state: 'queued' },
    ]);
    expect(db.prepare('SELECT id FROM roots WHERE id = ?').get('root-1')).toEqual({ id: 'root-1' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM resources_fts').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT missing_since FROM resources WHERE id = ?').get('res-1')).toEqual({ missing_since: null });
    expect(userVersion(db)).toBe(version);

    expect(patchRootTask(db, 'missing', { state: 'failed' })).toBeNull();
    const patched = patchRootTask(db, 't-del', { state: 'running', phaseText: '文件删除中', error: null });
    expect(patched?.state).toBe('running');
    expect(patched?.phaseText).toBe('文件删除中');
    expect(listRootTasks(db)).toHaveLength(1);
    expect(listRootTasks(db).every((task) => task.state === 'running' && task.phaseText === '文件删除中')).toBe(true);
    patchRootTask(db, 't-del', { state: 'failed', error: '占用' });
    expect(listRootTasks(db).every((task) => task.error === '占用' && task.phaseText === '文件删除中')).toBe(true);
    patchRootTask(db, 't-del', { error: null });
    expect(listRootTasks(db).every((task) => task.error === null && task.state === 'failed')).toBe(true);
  });

  it('先 detach 再 delete-disk 只推进当前工作区的代次', () => {
    const { db } = openTemp();
    workspace(db, 'ws-a', '甲区', 20);
    workspace(db, 'ws-b', '乙区', 10);
    rootRow(db, 'root-1', '资料');
    link(db, 'ws-a', 'root-1');
    link(db, 'ws-b', 'root-1');
    retireRoot(db, { rootId: 'root-1', workspaceId: 'ws-a', kind: 'detach', diskPath: 'D:/data', taskId: 't-off' });
    expect(linksOf(db, 'root-1')).toEqual(['ws-b']);
    retireRoot(db, { rootId: 'root-1', workspaceId: 'ws-a', kind: 'delete-disk', diskPath: 'D:/data', taskId: 't-del' });
    const generations = db.prepare(
      'SELECT workspace_id, generation, kind, hidden FROM root_retirements WHERE root_id = ? ORDER BY workspace_id',
    ).all('root-1') as { workspace_id: string; generation: number; kind: string; hidden: number }[];
    expect(generations).toEqual([
      { workspace_id: 'ws-a', generation: 2, kind: 'delete-disk', hidden: 1 },
    ]);
    expect(hiddenRootIds(db, 'ws-b').has('root-1')).toBe(false);
    expect(linksOf(db, 'root-1')).toEqual(['ws-b']);
    expect(db.prepare('SELECT id FROM roots WHERE id = ?').get('root-1')).toEqual({ id: 'root-1' });
  });

  it('claimUnownedRoots 不把 hidden 根重新挂到工作区', () => {
    const { db, file } = openTemp();
    expect(userVersion(db)).toBe(5);
    workspace(db, 'ws-a', '甲区', 30);
    workspace(db, 'ws-b', '乙区', 10);
    db.prepare("INSERT INTO layout(key, json, updated_at) VALUES ('workspace.current', ?, 1)").run(JSON.stringify('ws-a'));
    rootRow(db, 'root-h', '已退休');
    rootRow(db, 'root-free', '无主');
    rootRow(db, 'root-back', '已恢复');
    link(db, 'ws-a', 'root-h');
    link(db, 'ws-a', 'root-back');
    resource(db, 'res-h', 'root-h', 'h.md', null);
    db.prepare(
      `INSERT INTO workspace_items(workspace_id, item_id, source_kind, adapter_id, ref, display_mode, created_at, updated_at)
       VALUES ('ws-b', 'item-h', 'file', 'auto', 'res-h', 'in-app-reader', 1, 1)`,
    ).run();

    retireRoot(db, { rootId: 'root-h', workspaceId: 'ws-a', kind: 'detach', diskPath: 'D:/hidden', taskId: 't-h' });
    retireRoot(db, { rootId: 'root-back', workspaceId: 'ws-a', kind: 'detach', diskPath: 'D:/back', taskId: 't-back' });
    expect(linksOf(db, 'root-h')).toEqual([]);
    expect(linksOf(db, 'root-back')).toEqual([]);
    expect(restoreRootRecord(db, 'root-back', 'ws-a')).toEqual({ generation: 2 });
    expect(hiddenRootIds(db, null).has('root-h')).toBe(true);
    expect(hiddenRootIds(db, 'ws-a').has('root-h')).toBe(true);

    const fallen = claimUnownedRoots(db, 'ws-b');
    expect(fallen.map((item) => item.rootId).sort()).toEqual(['root-back', 'root-free']);
    expect(linksOf(db, 'root-h')).toEqual([]);
    expect(linksOf(db, 'root-free')).toEqual(['ws-b']);
    expect(linksOf(db, 'root-back')).toEqual(['ws-b']);
    expect(userVersion(db)).toBe(5);

    const again = reopen(file, db);
    expect(userVersion(again)).toBe(5);
    expect(linksOf(again, 'root-h')).toEqual([]);
    expect(linksOf(again, 'root-free')).toEqual(['ws-b']);
    claimUnownedRoots(again, 'ws-a');
    expect(linksOf(again, 'root-h')).toEqual([]);
    expect(again.prepare('SELECT id FROM roots WHERE id = ?').get('root-h')).toEqual({ id: 'root-h' });
  });
});
