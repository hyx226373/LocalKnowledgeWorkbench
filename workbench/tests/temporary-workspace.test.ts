import { afterEach, describe, expect, it } from 'vitest';
import { TEMPORARY_WORKSPACE_ID } from '../src/shared/temporaryWorkspace';
import { makeRoot, makeService } from './helpers';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const EMPTY = { schema: 4, dock: null, shell: { sidebarWidth: 280 } };

describe('临时现场', () => {
  it('加根和切到已保存工作区都不把临时 id 当成已保存工作区', async () => {
    const { svc } = await makeService();
    cleanups.push(() => svc.close());
    const before = svc.listWorkspaces().map((w) => w.id);
    expect(before.includes(TEMPORARY_WORKSPACE_ID)).toBe(false);

    expect(svc.listWorkspaceRefs(TEMPORARY_WORKSPACE_ID)).toEqual([]);
    svc.addRoot(makeRoot());
    expect(svc.listWorkspaceRefs(TEMPORARY_WORKSPACE_ID)).toEqual([]);
    expect(svc.addWorkspaceRefs(TEMPORARY_WORKSPACE_ID, ['missing-resource'])).toEqual([]);
    expect(svc.removeWorkspaceRef(TEMPORARY_WORKSPACE_ID, 'missing-resource')).toEqual([]);

    const saved = svc.createWorkspace('已保存', '', EMPTY, []);
    expect(svc.listWorkspaceRefs(saved.id)).toEqual([]);
    expect(svc.listWorkspaceRefs(TEMPORARY_WORKSPACE_ID)).toEqual([]);
    expect(svc.listWorkspaces().some((w) => w.id === TEMPORARY_WORKSPACE_ID)).toBe(false);
    expect(svc.listWorkspaces().some((w) => w.id === saved.id)).toBe(true);
    expect(svc.listWorkspaces().map((w) => w.id).filter((id) => before.includes(id) || id === saved.id).length).toBe(before.length + 1);
  });
});
