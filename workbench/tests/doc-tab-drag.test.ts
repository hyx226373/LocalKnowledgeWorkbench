import { describe, expect, it } from 'vitest';
import type { MaterialRef } from '../src/shared/agentLive/types';
import { createMemoryAgentLive } from '../src/renderer/agent-live/memoryClient';
import type { AgentLiveHost } from '../src/renderer/agent-live/host';
import { KB_RESOURCE_MIME } from '../src/renderer/dnd/types';
import {
  DOC_TAB_MIME,
  applyDocTabDrag,
  commitDocTabDrop,
  docTabDragFromPanel,
  docTabDropTarget,
  handleDocTabDragOver,
  handleDocTabDrop,
  hasDocTabMime,
  interceptDocTabDrop,
  parseDocTabDrag,
  type DocTabDragPayload,
} from '../src/renderer/dnd/docTabDrag';

const FILE = {
  v: 1 as const,
  resourceId: 'res-07',
  panelId: 'panel-07',
  itemId: 'panel-07',
  name: '07-离散控制系统.md',
  absPath: 'D:\\notes\\07-离散控制系统.md',
  relPath: 'notes/07-离散控制系统.md',
  sourceId: 'root-1',
};

function host(over: Partial<AgentLiveHost> = {}): AgentLiveHost {
  return {
    workspaceId: () => 'ws',
    currentReading: () => ({ absPath: 'D:\\active.md', name: 'active.md', resourceId: 'res-active' }),
    readingForPanel: () => null,
    selection: () => [],
    hostedForeground: () => false,
    notify: () => undefined,
    confirm: async () => true,
    writeClipboard: async () => undefined,
    bridgeEntryPath: async () => 'D:\\bridge\\ENTRY.md',
    workspaceEntryPath: async (id) => `D:\\bridge\\${id}\\ENTRY.md`,
    pickFile: async () => null,
    ...over,
  };
}

function dropHost() {
  const attrs = new Map<string, string>();
  return {
    attrs,
    el: {
      setAttribute(name: string, value: string) { attrs.set(name, value); },
      removeAttribute(name: string) { attrs.delete(name); },
    },
  };
}

describe('文档标签 MIME', () => {
  it('解析文件标签，拒绝坏载荷', () => {
    expect(parseDocTabDrag(JSON.stringify(FILE))).toEqual(FILE);
    expect(parseDocTabDrag('')).toBeNull();
    expect(parseDocTabDrag('{')).toBeNull();
    expect(parseDocTabDrag(JSON.stringify({ v: 2, resourceId: 'x', panelId: 'p', itemId: 'p' }))).toBeNull();
    expect(parseDocTabDrag(JSON.stringify({ v: 1, panelId: 'p', itemId: 'p' }))).toBeNull();
    expect(parseDocTabDrag(JSON.stringify({ v: 1, resourceId: '  ', panelId: 'p', itemId: 'p' }))).toBeNull();
  });

  it('只从文件面板组载荷', () => {
    expect(docTabDragFromPanel({
      panelId: 'panel-07',
      itemId: 'panel-07',
      title: '07-离散控制系统.md',
      item: { sourceKind: 'file', ref: 'res-07' },
      reading: { absPath: FILE.absPath, name: FILE.name, relPath: FILE.relPath, sourceId: 'root-1' },
    })).toEqual(FILE);
    expect(docTabDragFromPanel({ panelId: 'p', item: { sourceKind: 'web', ref: 'https://example.test' }, title: '网页' })).toBeNull();
    expect(docTabDragFromPanel({ panelId: 'p', item: { sourceKind: 'app', ref: 'app-1' } })).toBeNull();
    expect(docTabDragFromPanel({ panelId: 'p', item: { sourceKind: 'file', ref: '' } })).toBeNull();
    expect(docTabDragFromPanel({ panelId: 'p', item: null })).toBeNull();
  });

  it('追加自定义 MIME，保留 dockview 已写入的 text/plain', () => {
    const data = new Map<string, string>([['text/plain', '']]);
    const transfer = {
      setData(type: string, value: string) { data.set(type, value); },
    };
    applyDocTabDrag(transfer, FILE);
    expect(data.get('text/plain')).toBe('');
    expect(parseDocTabDrag(data.get(DOC_TAB_MIME) ?? '')).toEqual(FILE);
    expect([...data.keys()]).toEqual(['text/plain', DOC_TAB_MIME]);
  });

  it('识别 MIME，非自定义类型不拦截也不高亮', () => {
    const foreign = ['text/plain', 'Files', KB_RESOURCE_MIME, 'text/uri-list', 'application/x-kb-agent-material+json'];
    expect(hasDocTabMime(foreign)).toBe(false);
    expect(hasDocTabMime([DOC_TAB_MIME, 'text/plain'])).toBe(true);
    const ignored = dropHost();
    let prevented = false;
    let stopped = false;
    expect(handleDocTabDragOver({
      dataTransfer: { types: foreign },
      preventDefault: () => { prevented = true; },
      stopPropagation: () => { stopped = true; },
      currentTarget: ignored.el,
    })).toBe(false);
    expect(prevented).toBe(false);
    expect(stopped).toBe(false);
    expect(ignored.attrs.size).toBe(0);
    expect(interceptDocTabDrop(foreign, () => { throw new Error('不应读取'); })).toEqual({ claimed: false, payload: null });
    expect(handleDocTabDrop({
      dataTransfer: { types: foreign, getData: () => { throw new Error('不应读取'); } },
      preventDefault: () => { prevented = true; },
      stopPropagation: () => { stopped = true; },
      currentTarget: ignored.el,
    })).toEqual({ claimed: false, payload: null });

    const marked = dropHost();
    expect(handleDocTabDragOver({
      dataTransfer: { types: ['text/plain', DOC_TAB_MIME] },
      preventDefault: () => { prevented = true; },
      stopPropagation: () => { stopped = true; },
      currentTarget: marked.el,
    })).toBe(true);
    expect(prevented).toBe(true);
    expect(stopped).toBe(true);
    expect(marked.attrs.get('data-drop-active')).toBe('true');
    const raw = JSON.stringify(FILE);
    expect(interceptDocTabDrop(['text/plain', DOC_TAB_MIME], (type) => (type === DOC_TAB_MIME ? raw : ''))).toEqual({ claimed: true, payload: FILE });
    expect(handleDocTabDrop({
      dataTransfer: { types: [DOC_TAB_MIME], getData: () => '{' },
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
      currentTarget: marked.el,
    })).toEqual({ claimed: true, payload: null });
    expect(marked.attrs.has('data-drop-active')).toBe(false);
  });

  it('分类图标只有 Agent 与工作台资料接标签', () => {
    expect(docTabDropTarget('agent')).toBe('agent');
    expect(docTabDropTarget('bench')).toBe('bench');
    for (const id of ['root', 'fav', 'web', 'plugin', '']) expect(docTabDropTarget(id)).toBeNull();
  });
});

describe('文档标签落点', () => {
  it('落到 Agent 调用 addRefs，不加当前激活文件，也不调用工作台资料', async () => {
    const client = createMemoryAgentLive();
    const bench: string[][] = [];
    const result = await commitDocTabDrop('agent', FILE, {
      workspaceId: 'ws',
      binding: { client, host: host() },
      addWorkspaceRefs: async (_id, resourceIds) => { bench.push(resourceIds); },
    });
    expect(result).toBe('agent');
    expect(await client.list('ws')).toMatchObject([{ resourceId: 'res-07', absPath: FILE.absPath, name: FILE.name }]);
    expect((await client.list('ws')).some((item) => item.resourceId === 'res-active')).toBe(false);
    expect(bench).toEqual([]);
  });

  it('没有路径时仍走 addRefs，由宿主 resolve 补上', async () => {
    const client = createMemoryAgentLive();
    const seen: MaterialRef[] = [];
    const payload: DocTabDragPayload = { v: 1, resourceId: 'res-07', panelId: 'panel-07', itemId: 'panel-07', name: FILE.name };
    await commitDocTabDrop('agent', payload, {
      workspaceId: 'ws',
      binding: {
        client,
        host: host({
          resolve: async (ref) => {
            seen.push(ref);
            return { ...ref, absPath: FILE.absPath, name: ref.name || FILE.name };
          },
        }),
      },
      addWorkspaceRefs: async () => undefined,
    });
    expect(seen.map((ref) => ref.resourceId)).toEqual(['res-07']);
    expect((await client.list('ws'))[0]).toMatchObject({ resourceId: 'res-07', absPath: FILE.absPath });
  });

  it('落到工作台资料走 workspace-refs 添加', async () => {
    const calls: [string, string[]][] = [];
    const result = await commitDocTabDrop('bench', FILE, {
      workspaceId: 'ws-1',
      binding: null,
      addWorkspaceRefs: async (workspaceId, resourceIds) => { calls.push([workspaceId, resourceIds]); },
    });
    expect(result).toBe('bench');
    expect(calls).toEqual([['ws-1', ['res-07']]]);
  });

  it('没有工作区或没有载荷时不调用添加', async () => {
    const calls: string[][] = [];
    const addWorkspaceRefs = async (_workspaceId: string, resourceIds: string[]) => { calls.push(resourceIds); };
    expect(await commitDocTabDrop('bench', FILE, { workspaceId: '', binding: null, addWorkspaceRefs })).toBe('skip');
    expect(await commitDocTabDrop('agent', null, { workspaceId: 'ws', binding: { client: createMemoryAgentLive(), host: host() }, addWorkspaceRefs })).toBe('skip');
    expect(await commitDocTabDrop('agent', FILE, { workspaceId: 'ws', binding: null, addWorkspaceRefs })).toBe('skip');
    expect(calls).toEqual([]);
  });
});
