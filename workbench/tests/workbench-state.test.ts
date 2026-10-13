import { describe, expect, it } from 'vitest';
import { readSavedWorkbenchState } from '../src/main/agent-bridge/workbenchState';

describe('已保存工作区快照', () => {
  it('只读出稳定 id，丢掉路径式引用', () => {
    const calls: string[] = [];
    const snap = readSavedWorkbenchState({
      getLayout(key) {
        calls.push(key);
        return key === 'workspace.current' ? 'ws-1' : null;
      },
      getWorkspace(id) {
        calls.push(id);
        return {
          id,
          name: '默认',
          items: [
            { itemId: 'item-1', sourceKind: 'file', ref: '22222222-2222-4222-8222-222222222222', adapterId: 'builtin.md', title: '笔记' },
            { itemId: 'item-2', sourceKind: 'file', ref: 'D:\\secret\\should-not-leak\\a.md', adapterId: 'builtin.md', title: '路径' },
            { itemId: 'item-3', sourceKind: 'web', ref: 'https://example.com/a', adapterId: 'web.generic', title: '网页' },
          ],
          layout: {
            dock: {
              panels: {
                p1: { id: 'p1', params: { itemId: 'item-1' } },
                p2: { id: 'p2', params: { itemId: 'item-2' } },
              },
            },
          },
        };
      },
    });
    expect(calls).toEqual(['workspace.current', 'ws-1']);
    expect(snap.workspace?.workspaceId).toBe('ws-1');
    expect(snap.resources.map((row) => row.resourceId)).toEqual(['22222222-2222-4222-8222-222222222222']);
    expect(snap.panels[0]?.resourceId).toBe('22222222-2222-4222-8222-222222222222');
    expect(snap.panels[1]?.resourceId).toBeUndefined();
    expect(snap.unsaved).toEqual([]);
    expect(JSON.stringify(snap)).not.toContain('should-not-leak');
  });

  it('没有当前工作区时不读取工作区', () => {
    const snap = readSavedWorkbenchState({
      getLayout: () => null,
      getWorkspace: () => {
        throw new Error('不应读取工作区');
      },
    });
    expect(snap.workspace).toBeNull();
    expect(snap.resources).toEqual([]);
    expect(snap.panels).toEqual([]);
  });
});
