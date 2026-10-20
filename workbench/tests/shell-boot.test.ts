import { describe, expect, it } from 'vitest';
import {
  patchLayoutSnapshot,
  readLayoutSnapshot,
  readUiSnapshot,
  shellInteractiveMark,
  snapshotToWorkspace,
  writeLayoutSnapshot,
  writeUiSnapshot,
} from '../src/renderer/layoutSnapshot';
import type { WorkspaceItem } from '../src/shared/items';

function memory() {
  const bag = new Map<string, string>();
  return {
    getItem: (k: string) => bag.get(k) ?? null,
    setItem: (k: string, v: string) => {
      bag.set(k, v);
    },
  };
}

const item = { itemId: 'i1', sourceKind: 'file', ref: 'r1', title: '笔记' } as WorkspaceItem;

describe('布局快照与可交互', () => {
  it('快照能来回读写，画界面不需要数据库', () => {
    const store = memory();
    writeLayoutSnapshot(
      { id: 'ws-1', name: '专业课', project: '示例分类', layoutSchema: 4, layout: { schema: 4, dock: { grid: {} }, shell: { sidebarWidth: 280 } }, items: [item], rootIds: ['root-a'] },
      store,
    );
    const snap = readLayoutSnapshot(store);
    expect(snap?.workspaceId).toBe('ws-1');
    expect(snap?.name).toBe('专业课');
    const dto = snapshotToWorkspace(snap!);
    expect(dto.layout).toEqual(snap?.layout);
    expect(dto.items).toEqual([item]);
    expect(dto.id).toBe('ws-1');
  });

  it('坏掉的快照当成没有，不抛', () => {
    const store = memory();
    store.setItem('kb.layoutSnapshot.v1', '{');
    expect(readLayoutSnapshot(store)).toBeNull();
    store.setItem('kb.layoutSnapshot.v1', JSON.stringify({ v: 1 }));
    expect(readLayoutSnapshot(store)).toBeNull();
  });

  it('保存布局时只更新同一工作区的快照', () => {
    const store = memory();
    writeLayoutSnapshot({ id: 'ws-1', name: '专业课', project: '', layoutSchema: 4, layout: { schema: 4 }, items: [], rootIds: [] }, store);
    patchLayoutSnapshot('ws-other', { schema: 4, dock: { changed: true } }, [item], store);
    expect(readLayoutSnapshot(store)?.layout).toEqual({ schema: 4 });
    patchLayoutSnapshot('ws-1', { schema: 4, dock: { changed: true } }, [item], store);
    expect(readLayoutSnapshot(store)?.items).toEqual([item]);
    expect((readLayoutSnapshot(store)?.layout as { dock: unknown }).dock).toEqual({ changed: true });
  });

  it('界面快照记住外观和侧栏宽度', () => {
    const store = memory();
    writeUiSnapshot({ appearance: { chrome: 'pro', reading: 'pro', scheme: 'dark' }, focus: false, expanded: ['a'], sidebarWidth: 320 }, store);
    expect(readUiSnapshot(store)?.sidebarWidth).toBe(320);
    expect(readUiSnapshot(store)?.appearance.scheme).toBe('dark');
  });

  it('可见内容超时不是可交互', () => {
    expect(shellInteractiveMark('shell')).toBe('interactive');
    expect(shellInteractiveMark('visible-content-timeout')).toBeNull();
    expect(shellInteractiveMark('visible-content-loaded')).toBeNull();
  });
});
