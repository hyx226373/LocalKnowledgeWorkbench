import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_PINNED_LAYOUT_PREFIX } from '../src/main/service/WorkbenchService';
import { WORKSPACE_ROOT_FALLBACK_KEY } from '../src/main/service/db';
import { disk, diskPromises } from '../src/main/service/disk';
import {
  DELETE_WORKSPACE_CONFIRM_BODY,
  requestDeleteWorkspace,
  type WorkspaceDeletePorts,
  type WorkspaceDeleteTarget,
} from '../src/renderer/workspace-picker/deleteWorkspace';
import { makeRoot, makeService, write } from './helpers';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const FILE_DELETE_NAMES = ['rmSync', 'unlinkSync', 'rmdirSync', 'rm', 'unlink'] as const;

function spyFileDeletes(target: object): Array<ReturnType<typeof vi.spyOn>> {
  return FILE_DELETE_NAMES.filter((name) => typeof (target as Record<string, unknown>)[name] === 'function').map((name) => vi.spyOn(target as never, name as never));
}

describe('删除工作区确认', () => {
  function ports(list: WorkspaceDeleteTarget[], current = list[0]?.id ?? '') {
    let currentId = current;
    const calls: string[] = [];
    const confirm = vi.fn(async () => true);
    const api: WorkspaceDeletePorts = {
      confirm,
      workspaces: () => list,
      currentId: () => currentId,
      switchTo: async (id) => {
        calls.push(`switch:${id}`);
        currentId = id;
      },
      deleteWorkspace: async (id) => {
        calls.push(`delete:${id}`);
      },
    };
    return { api, calls, confirm, current: () => currentId };
  }

  it('确认后删除当前工作区，并先切到另一个', async () => {
    const bundle = ports(
      [
        { id: 'a', name: '考研 数学' },
        { id: 'b', name: '英语' },
      ],
      'a',
    );
    const result = await requestDeleteWorkspace('a', bundle.api);
    expect(result).toBe('deleted');
    expect(bundle.confirm).toHaveBeenCalledWith({
      title: '删除工作区「考研 数学」？',
      body: DELETE_WORKSPACE_CONFIRM_BODY,
      ok: '删除',
      danger: true,
    });
    expect(bundle.calls).toEqual(['switch:b', 'delete:a']);
    expect(bundle.current()).toBe('b');
  });

  it('删的不是当前工作区时不切换', async () => {
    const bundle = ports(
      [
        { id: 'a', name: '考研 数学' },
        { id: 'b', name: '英语' },
      ],
      'b',
    );
    await requestDeleteWorkspace('a', bundle.api);
    expect(bundle.calls).toEqual(['delete:a']);
    expect(bundle.current()).toBe('b');
  });

  it('取消确认不删除、不切换', async () => {
    const bundle = ports(
      [
        { id: 'a', name: '考研 数学' },
        { id: 'b', name: '英语' },
      ],
      'a',
    );
    bundle.confirm.mockResolvedValue(false);
    const result = await requestDeleteWorkspace('a', bundle.api);
    expect(result).toBe('cancelled');
    expect(bundle.calls).toEqual([]);
    expect(bundle.confirm).toHaveBeenCalledTimes(1);
  });

  it('只剩最后一个工作区时不弹确认、不删除', async () => {
    const bundle = ports([{ id: 'a', name: '考研 数学' }], 'a');
    const result = await requestDeleteWorkspace('a', bundle.api);
    expect(result).toBe('blocked');
    expect(bundle.confirm).not.toHaveBeenCalled();
    expect(bundle.calls).toEqual([]);
  });
});

describe('deleteWorkspace 只删库内记录', () => {
  it('删掉工作区及其关联，留下资料源和磁盘文件；最后一个拒绝', async () => {
    const { svc } = await makeService();
    const dir = makeRoot();
    cleanups.push(() => {
      try {
        svc.close();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
    const keep = svc.getCurrentWorkspaceId();
    const note = path.join(dir, '笔记/读书笔记.md');
    write(note, '# 标题\n留给磁盘');
    const root = svc.addRoot(dir);
    await svc.scanRoot(root.id);
    const doomed = svc.createWorkspace('考研 数学', '考研');
    svc.setCurrentWorkspace(doomed.id);
    const now = Date.now();
    svc.db.prepare('INSERT OR IGNORE INTO workspace_roots(workspace_id, root_id) VALUES (?, ?)').run(doomed.id, root.id);
    svc.db
      .prepare(
        `INSERT INTO workspace_root_instances (
           id, workspace_id, source_id, name, sort_order, filter_json,
           generation, hidden, publishable, created_at, updated_at
         ) VALUES (?, ?, ?, '考研数学', 1, '{"extensions":[]}', 0, 0, 1, ?, ?)`,
      )
      .run('inst-doomed', doomed.id, root.id, now, now);
    svc.db
      .prepare(
        `INSERT INTO workspace_items(
           workspace_id, item_id, source_kind, adapter_id, ref, display_mode, state_json, title, created_at, updated_at
         ) VALUES (?, 'item-1', 'web', 'web.generic', 'https://example.com/a', 'in-app-web', NULL, '页', ?, ?)`,
      )
      .run(doomed.id, now, now);
    svc.db
      .prepare(
        `INSERT INTO root_retirements (
           root_id, workspace_id, generation, kind, hidden, publishable,
           phase_text, error, task_id, disk_path, state, created_at, updated_at
         ) VALUES (?, ?, 1, 'detach', 1, 0, '', NULL, 'task-doomed', ?, 'queued', ?, ?)`,
      )
      .run(root.id, doomed.id, dir, now, now);
    svc.setLayout(`workspace.refs:${doomed.id}`, [{ id: 'ref-1', at: now }]);
    svc.setLayout(AGENT_PINNED_LAYOUT_PREFIX + doomed.id, [{ resourceId: 'pinned-1' }]);
    svc.setLayout(WORKSPACE_ROOT_FALLBACK_KEY, [
      { rootId: root.id, name: root.name, workspaceId: doomed.id, workspaceName: doomed.name },
      { rootId: root.id, name: root.name, workspaceId: keep, workspaceName: '默认工作区' },
    ]);

    const spies = [
      ...spyFileDeletes(fs),
      ...spyFileDeletes(fs.promises),
      ...(disk === fs ? [] : spyFileDeletes(disk)),
      ...(diskPromises === fs.promises ? [] : spyFileDeletes(diskPromises)),
    ];
    try {
      svc.deleteWorkspace(doomed.id);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    expect(fs.readFileSync(note, 'utf8')).toContain('留给磁盘');
    expect(svc.getCurrentWorkspaceId()).toBe(keep);
    expect(svc.listWorkspaces().map((row) => row.id)).toEqual([keep]);
    expect(() => svc.getWorkspace(doomed.id)).toThrow(/不存在/);
    const count = (sql: string, id: string) => (svc.db.prepare(sql).get(id) as { n: number }).n;
    expect(count('SELECT COUNT(*) AS n FROM workspace_roots WHERE workspace_id=?', doomed.id)).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM workspace_roots WHERE workspace_id=?', keep)).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM workspace_root_instances WHERE workspace_id=?', doomed.id)).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM workspace_root_instances WHERE workspace_id=?', keep)).toBeGreaterThan(0);
    expect(count('SELECT COUNT(*) AS n FROM workspace_items WHERE workspace_id=?', doomed.id)).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM root_retirements WHERE workspace_id=?', doomed.id)).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM roots WHERE id=?', root.id)).toBe(1);
    expect(svc.db.prepare('SELECT local_path FROM root_mounts WHERE root_id=?').get(root.id)).toEqual({ local_path: dir });
    expect(svc.getLayout(`workspace.refs:${doomed.id}`)).toBeNull();
    expect(svc.getLayout(AGENT_PINNED_LAYOUT_PREFIX + doomed.id)).toBeNull();
    expect(svc.workspaceRootFallbacks().map((row) => row.workspaceId)).toEqual([keep]);
    expect(() => svc.deleteWorkspace(keep)).toThrow(/至少需要保留一个/);
    expect(fs.existsSync(note)).toBe(true);
  });

  it('服务方法正文不调用文件删除', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/main/service/WorkbenchService.ts'), 'utf8');
    const start = src.indexOf('deleteWorkspace(id: string)');
    const end = src.indexOf('private dropWorkspaceFallback', start);
    const body = src.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(body).not.toMatch(/unlink|rmSync|rmdir|trash\(|deleteRootFolder|fs\./);
  });
});
