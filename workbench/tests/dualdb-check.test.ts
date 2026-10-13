import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { makeService, tmpDir, write } from './helpers';
import { debugDualDbCheck } from '../src/main/backend/dualDbCheck';
import { openKbStack, type KbStackDeps } from '../src/main/backend/kbStack';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function loadDeps(): Promise<KbStackDeps | null> {
  try {
    const Database = (await import('better-sqlite3')).default;
    const iw = await import('@kb/identity-watch');
    const indexer = await import('@kb/indexer');
    const fileops = await import('@kb/fileops');
    const plan = await import('@kb/plan');
    const sync = await import('@kb/sync');
    return {
      Database,
      migrateIdentity: iw.migrate,
      setMount: iw.setMount,
      machineId: iw.machineId,
      resolveInsideRoot: iw.resolveInsideRoot as KbStackDeps['resolveInsideRoot'],
      ensureResource: iw.ensureResource,
      migrateIndexer: indexer.migrate,
      searchGrouped: indexer.searchGrouped,
      startIndex: indexer.startIndex,
      closeIndexer: indexer.closeIndexer,
      createFileOps: fileops.createFileOps,
      createPlanService: plan.createPlanService,
      createSync: sync.createSync,
    };
  } catch {
    return null;
  }
}

describe('debugDualDbCheck', () => {
  it('无 stack 时返回 mismatched', async () => {
    const { svc } = await makeService();
    cleanups.push(() => svc.close());
    const mainDb = (svc as unknown as { db: import('better-sqlite3').Database }).db;
    const r = debugDualDbCheck(mainDb, null, []);
    expect(r.ok).toBe(false);
    expect(r.mismatched.length).toBeGreaterThan(0);
  });

  it('接口可调用：镜像根后 checked>0', async () => {
    const deps = await loadDeps();
    if (!deps) return;
    const { svc, dataDir } = await makeService();
    cleanups.push(() => svc.close());
    const dir = tmpDir('dualdb-');
    write(path.join(dir, 'a.md'), 'hello\n');
    const root = svc.addRoot(dir);
    await svc.scanRoot(root.id);
    const stack = openKbStack(dataDir, deps);
    cleanups.push(() => stack.close());
    stack.mirrorRoot(root.id, root.name, root.path);
    const mainDb = (svc as unknown as { db: import('better-sqlite3').Database }).db;
    const result = debugDualDbCheck(mainDb, stack, [{ id: root.id, path: root.path }], root.id);
    expect(result.checked).toBeGreaterThan(0);
    expect(Array.isArray(result.mismatched)).toBe(true);
  });
});
