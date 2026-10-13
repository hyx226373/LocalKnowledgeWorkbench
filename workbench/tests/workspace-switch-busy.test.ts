import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { makeService, waitFor } from './helpers';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

it('写锁被占时切换工作区立刻返回，并先记住目标', async () => {
  const { svc, dataDir } = await makeService();
  cleanups.push(() => svc.close());
  const first = svc.getCurrentWorkspaceId();
  const next = svc.createWorkspace('切换锁', '');
  const other = new Database(path.join(dataDir, 'workbench.db'));
  other.pragma('journal_mode = WAL');
  other.pragma('busy_timeout = 0');
  cleanups.push(() => {
    try {
      if (other.inTransaction) other.exec('ROLLBACK');
    } catch { /* 已经结束 */ }
    other.close();
  });
  other.exec('BEGIN IMMEDIATE');
  const started = Date.now();
  const switched = svc.setCurrentWorkspace(next.id);
  expect(Date.now() - started).toBeLessThan(200);
  expect(switched.attached).toEqual([]);
  expect(svc.getCurrentWorkspaceId()).toBe(next.id);
  other.exec('COMMIT');
  await waitFor(() => svc.getLayout('workspace.current') === next.id);
  expect(svc.getCurrentWorkspaceId()).toBe(next.id);
  expect(svc.getCurrentWorkspaceId()).not.toBe(first);
});
