import { describe, expect, it } from 'vitest';
import { buildConsoleDraft, type ConsoleIndexItem, type ResourceDragItem } from '../src/shared/consoleSchema';
import type { ResourceInfo } from '../src/shared/types';
import { appendDragToIndex } from '../src/renderer/console/open/dropIndex';
import { createConsoleOpener, type ConsoleDock } from '../src/renderer/console/open/opener';
import { shouldReusePanel } from '../src/renderer/console/open/reuse';
import { formatOpenGroupResult } from '../src/renderer/console/open/summary';

const RID = '11111111-1111-4111-8111-111111111111';
const RID2 = '22222222-2222-4222-8222-222222222222';
const ROOT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function file(resourceId: string, relPath = '笔记.md'): ResourceInfo {
  return {
    resourceId,
    rootId: ROOT,
    relPath,
    name: relPath.slice(relPath.lastIndexOf('/') + 1),
    kind: 'file',
    size: 4,
    mtimeMs: 10,
    ext: 'md',
    readerType: 'markdown',
    exists: true,
  };
}

function entry(partial: Partial<ConsoleIndexItem> & Pick<ConsoleIndexItem, 'id' | 'title' | 'order' | 'openAs'>): ConsoleIndexItem {
  return { ref: { type: 'resource', resourceId: RID }, ...partial };
}

function fakeDock(): ConsoleDock & { panels: Array<{ id: string; position?: unknown; api: { setActive(): void } }> } {
  const panels: Array<{ id: string; position?: unknown; api: { setActive(): void } }> = [];
  let active: { id: string } | undefined;
  return {
    get panels() {
      return panels;
    },
    get activePanel() {
      return active;
    },
    getPanel(id: string) {
      return panels.find((panel) => panel.id === id);
    },
    addPanel(panel) {
      const created = {
        id: panel.id,
        position: panel.position,
        api: {
          setActive() {
            active = created;
          },
        },
      };
      panels.push(created);
      active = created;
    },
  };
}

function hostFor(overrides: {
  resources?: Record<string, ResourceInfo | null>;
  resolve?: (rootId: string, relPath: string) => Promise<string>;
  dock?: ConsoleDock | null;
  dirs?: Record<string, ResourceInfo[]>;
} = {}) {
  const dock = overrides.dock === undefined ? fakeDock() : overrides.dock;
  const resources = overrides.resources ?? { [RID]: file(RID) };
  const floats: string[] = [];
  const expanded: string[] = [];
  const items = { current: {} as Record<string, { itemId: string; sourceKind: string; ref: string }> };
  const opener = createConsoleOpener({
    getDock: () => dock,
    items: items as never,
    panelManager: { float: (id) => floats.push(id) },
    kb: {
      getResource: async (id) => (id in resources ? resources[id]! : file(id)),
      listRoots: async () => [{ id: ROOT, sourceId: ROOT, workspaceRootId: 'ws-root', name: '样例', path: 'C:/样例', resourceId: 'root-res', status: 'ok', createdAt: 1, kind: 'folder' }],
      listDir: async (_rootId, relPath) => overrides.dirs?.[relPath] ?? [],
      consoleResolvePath: overrides.resolve ?? (async () => RID2),
    },
    adapters: {
      get: (id) => (id === 'web.demo' ? { sourceKinds: ['web'] } : id === 'builtin.markdown' ? { sourceKinds: ['file'] } : undefined),
      best: () => ({ id: 'builtin.markdown' }),
    },
    expand: (id) => expanded.push(id),
  });
  return { opener, dock: dock as ReturnType<typeof fakeDock> | null, floats, expanded, items };
}

describe('控制台打开', () => {
  it('tab 复用已有面板，分屏和自由窗口再开一份', async () => {
    expect(shouldReusePanel({ openAs: 'tab', resourceId: RID, panels: [{ itemId: 'it-1', resourceId: RID }] })).toEqual({ kind: 'focus', itemId: 'it-1' });
    expect(shouldReusePanel({ openAs: 'split-right', resourceId: RID, panels: [{ itemId: 'it-1', resourceId: RID }] })).toEqual({ kind: 'create' });
    expect(shouldReusePanel({ openAs: 'float', resourceId: RID, panels: [{ itemId: 'it-1', resourceId: RID }] })).toEqual({ kind: 'create' });

    const env = hostFor();
    await env.opener.openItem(entry({ id: 'a', title: '笔记', order: 1, openAs: 'tab' }));
    await env.opener.openItem(entry({ id: 'a2', title: '笔记', order: 2, openAs: 'tab' }));
    expect(env.dock?.panels).toHaveLength(1);
    await env.opener.openItem(entry({ id: 'b', title: '再开', order: 3, openAs: 'split-right' }));
    expect(env.dock?.panels).toHaveLength(2);
    expect(env.dock?.panels[1].position).toMatchObject({ direction: 'right' });
    expect(env.items.current[env.dock!.panels[0].id].ref).toBe(RID);
    expect(env.items.current[env.dock!.panels[1].id].ref).toBe(RID);
    expect(env.dock?.panels[0].id).not.toBe(env.dock?.panels[1].id);
    await env.opener.openItem(entry({ id: 'c', title: '浮窗', order: 4, openAs: 'float' }));
    expect(env.floats).toEqual([env.dock?.panels[2].id]);
  });

  it('targetPanel 只聚焦；reveal-only 不建面板；网页适配器不打开', async () => {
    const env = hostFor();
    env.dock?.addPanel({ id: 'already', component: 'view', title: '已有', params: { itemId: 'already' } });
    await env.opener.openItem(entry({ id: 't', title: '聚焦', order: 1, openAs: 'split-right', targetPanel: { itemId: 'already' } }));
    expect(env.dock?.panels).toHaveLength(1);
    expect(env.dock?.activePanel?.id).toBe('already');

    const reveal = hostFor({
      resources: { [RID]: file(RID, '目录/笔记.md') },
      dirs: { '': [{ ...file('dir-1', '目录'), kind: 'dir', ext: '', readerType: 'unsupported' }] },
    });
    await reveal.opener.openItem(entry({ id: 'r', title: '揭示', order: 1, openAs: 'reveal-only' }));
    expect(reveal.dock?.panels).toHaveLength(0);
    expect(reveal.expanded).toEqual(['root-res', 'dir-1']);

    const web = hostFor();
    await expect(
      web.opener.openItem(entry({ id: 'w', title: '网页', order: 1, openAs: 'tab', targetPanel: { adapterId: 'web.demo' } })),
    ).rejects.toThrow(/A 未合入/);
    expect(web.dock?.panels).toHaveLength(0);
  });

  it('整组按顺序返回失败摘要，同时打开受 maxConcurrent 限制', async () => {
    const env = hostFor({ resources: { [RID]: file(RID), '00000000-0000-4000-8000-000000000099': null } });
    const result = await env.opener.openGroup({
      items: [
        entry({ id: 'skip', title: '跳过', order: 1, openAs: 'tab', includeInGroupOpen: false }),
        entry({ id: 'bad-as', title: '方式', order: 2, openAs: 'popup' }),
        entry({ id: 'ok', title: '笔记', order: 3, openAs: 'tab' }),
        entry({ id: 'missing', title: '缺失', order: 4, openAs: 'tab', ref: { type: 'resource', resourceId: '00000000-0000-4000-8000-000000000099' } }),
      ],
    });
    expect(result.ok).toEqual(['ok']);
    expect(result.failed.map((item) => item.id)).toEqual(['bad-as', 'missing']);
    expect(formatOpenGroupResult(result)).toContain('失败 2 项');
    expect(env.dock?.panels).toHaveLength(1);

    let inflight = 0;
    let max = 0;
    const gates: Array<() => void> = [];
    const dock = fakeDock();
    const opener = createConsoleOpener({
      getDock: () => dock,
      items: { current: {} } as never,
      panelManager: { float() {} },
      kb: {
        getResource: (id) => {
          inflight += 1;
          max = Math.max(max, inflight);
          return new Promise((resolve) => {
            gates.push(() => {
              inflight -= 1;
              resolve(file(id));
            });
          });
        },
        listRoots: async () => [],
        listDir: async () => [],
        consoleResolvePath: async () => RID,
      },
      adapters: { get: () => undefined, best: () => ({ id: 'builtin.markdown' }) },
      expand() {},
    });
    const ids = ['a', 'b', 'c', 'd'];
    const pending = opener.openGroup({
      openGroup: { mode: 'simultaneous', maxConcurrent: 2 },
      items: ids.map((id, index) => entry({ id, title: id, order: index + 1, openAs: 'tab', ref: { type: 'resource', resourceId: `33333333-3333-4333-8333-33333333333${index}` } })),
    });
    await viWait(() => gates.length === 2);
    expect(max).toBe(2);
    gates.splice(0).forEach((release) => release());
    await viWait(() => gates.length === 2);
    expect(max).toBe(2);
    gates.splice(0).forEach((release) => release());
    const done = await pending;
    expect(done.ok).toEqual(ids);
    expect(done.failed).toEqual([]);
    expect(dock.panels).toHaveLength(4);
  });

  it('拖入索引只追加文本', () => {
    const text = buildConsoleDraft({ title: '周复盘', items: [entry({ id: 'a', title: '甲', order: 1, openAs: 'tab' })] });
    const drag: ResourceDragItem = {
      resourceId: RID2,
      sourceKind: 'file',
      from: { kind: 'root', rootId: ROOT, relPath: '附件.md' },
    };
    const next = appendDragToIndex(text, [drag], () => '附件.md', () => 'item-b');
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.added).toBe(1);
    expect(next.text).toContain('附件.md');
    expect(next.text).toContain(RID2);
    expect(text).not.toContain(RID2);
  });
});

async function viWait(pred: () => boolean) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > 1000) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
