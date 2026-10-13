import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { makeService, waitFor } from './helpers';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('保存布局碰到写锁', () => {
  it('BEGIN IMMEDIATE 被占时调用立刻返回，锁放开后再写完', async () => {
    const { svc, dataDir } = await makeService();
    cleanups.push(() => svc.close());
    const ws = svc.createWorkspace('布局锁');
    const other = new Database(path.join(dataDir, 'workbench.db'));
    other.pragma('journal_mode = WAL');
    other.pragma('busy_timeout = 0');
    try {
      other.exec('BEGIN IMMEDIATE');
      const started = Date.now();
      const pending = svc.saveWorkspaceLayout(ws.id, { schema: 4, dock: null, shell: { sidebarWidth: 281 } }, []);
      const waited = Date.now() - started;
      expect(waited).toBeLessThan(100);
      expect(pending).toBeUndefined();
      other.exec('COMMIT');
      await waitFor(() => (svc.getWorkspace(ws.id).layout as { shell: { sidebarWidth: number } }).shell.sidebarWidth === 281);
      expect((svc.getWorkspace(ws.id).layout as { shell: { sidebarWidth: number } }).shell.sidebarWidth).toBe(281);
    } finally {
      try {
        if (other.inTransaction) other.exec('ROLLBACK');
      } catch { /* 已经提交或回滚 */ }
      other.close();
    }
  });

  it('锁空着时仍然同步写完，校验错误同步抛出', async () => {
    const { svc } = await makeService();
    cleanups.push(() => svc.close());
    const ws = svc.createWorkspace('布局同步');
    const ret = svc.saveWorkspaceLayout(ws.id, { schema: 4, dock: null, shell: { sidebarWidth: 280 } }, []);
    expect(ret).toBeUndefined();
    expect((svc.getWorkspace(ws.id).layout as { shell: { sidebarWidth: number } }).shell.sidebarWidth).toBe(280);
    expect(() => svc.saveWorkspaceLayout(ws.id, { schema: 4, dock: null, shell: { leaked: 'D:\\STUDY MATERIAL\\a.pdf' } }, [])).toThrow(/绝对路径/);
  });
});
