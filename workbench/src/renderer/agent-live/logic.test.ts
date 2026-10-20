import { describe, expect, it } from 'vitest';
import type { AgentMaterial, MaterialRef } from '../../shared/agentLive/types';
import { AGENT_LIVE_ACTIONS } from '../../shared/agentLive/types';
import { addCurrent, addFromDisk, addRefs, addRefsMaybeDir, clearSession, copyBridgeLink } from './actions';
import { applyCopyDrag, AGENT_COPY_MIME, nativeCopyDrag, parseCopyDrag } from './dragPolicy';
import { piecesFromPayload, piecesFromTransfer, partitionPieces } from './dropIn';
import { formatSectionHeading, formatSectionTotals, isDirMaterial, tokenBudgetHint, TOKEN_HINT_THRESHOLD } from './format';
import type { AgentLiveHost } from './host';
import { entryPaths } from './host';
import { createMemoryAgentLive } from './memoryClient';
import { MSG_ADDED, MSG_CLEARED, MSG_COPIED, MSG_DUPLICATE_PINNED, MSG_DUPLICATE_SESSION, MSG_LIMIT } from './messages';
import { refsForAddGesture } from './menu';
import { reorderWithinTier } from './order';
import { pathKey } from './paths';
import { acceleratorsForGlobalHook, decideAddCurrentBinding } from './shortcut';
import { emptyStore } from '../keybindings/store';
import type { DragPayload } from '../dnd/types';

function material(patch: Partial<AgentMaterial> & Pick<AgentMaterial, 'materialId' | 'absPath'>): AgentMaterial {
  return {
    resourceId: null,
    sourceId: null,
    relPath: patch.absPath,
    name: patch.materialId,
    purpose: null,
    order: 1,
    status: 'ok',
    contentHash: null,
    contentVersion: 0,
    readable: null,
    addedAt: '2026-10-08T00:00:00.000Z',
    tier: 'session',
    bytes: null,
    estTokens: null,
    ...patch,
  };
}

function harness(over: Partial<AgentLiveHost> = {}) {
  const notes: string[] = [];
  const host: AgentLiveHost = {
    workspaceId: () => 'ws',
    currentReading: () => null,
    readingForPanel: () => null,
    selection: () => [],
    hostedForeground: () => false,
    notify: (message) => notes.push(message),
    confirm: async () => true,
    writeClipboard: async () => undefined,
    bridgeEntryPath: async () => 'D:\\bridge\\live\\current\\ENTRY.md',
    workspaceEntryPath: async (id) => `D:\\bridge\\live\\ws\\${id}\\ENTRY.md`,
    pickFile: async () => null,
    ...over,
  };
  return { host, notes };
}

describe('区头合计', () => {
  it('12 项合计成示例文案', () => {
    const items = Array.from({ length: 12 }, (_, index) =>
      material({
        materialId: `m-${index}`,
        absPath: `D:\\f\\${index}.md`,
        bytes: index === 0 ? 3_565_158 : 0,
        estTokens: index === 0 ? 41_000 : 0,
      }),
    );
    expect(formatSectionTotals(items)).toBe('12 项 · 3.4MB · 约 41k tokens');
    expect(formatSectionHeading('本轮资料', items)).toBe('本轮资料 · 12 项 · 3.4MB · 约 41k tokens');
  });

  it('还没算完时不写成 0', () => {
    const items = [material({ materialId: 'm', absPath: 'D:\\a.md' })];
    expect(formatSectionTotals(items)).toBe('1 项 · 体积计算中 · token 计算中');
  });

  it('超过 15 万 token 只提示', () => {
    const under = [material({ materialId: 'm', absPath: 'D:\\a.md', estTokens: TOKEN_HINT_THRESHOLD, bytes: 1 })];
    const over = [material({ materialId: 'm', absPath: 'D:\\a.md', estTokens: TOKEN_HINT_THRESHOLD + 1, bytes: 1 })];
    expect(tokenBudgetHint(under)).toBeNull();
    expect(tokenBudgetHint(over)).toBe('合计超过 150k tokens，仍可继续使用');
  });
});

describe('拖出只能复制', () => {
  it('载荷是 copy，且不带目录移动用的 MIME', () => {
    const written: Record<string, string> = {};
    let effect = '';
    const payload = applyCopyDrag(
      {
        set effectAllowed(value: string) {
          effect = value;
        },
        setData: (type, value) => {
          written[type] = value;
        },
      },
      ['D:\\论文\\实验.md'],
    );
    expect(effect).toBe('copy');
    expect(payload).toEqual({ v: 1, op: 'copy', files: ['D:\\论文\\实验.md'] });
    expect(parseCopyDrag(written[AGENT_COPY_MIME])?.op).toBe('copy');
    expect(written['application/x-kb-resource+json']).toBeUndefined();
    expect(written['text/uri-list']).toContain('file:///D:/%E8%AE%BA%E6%96%87/%E5%AE%9E%E9%AA%8C.md');
    const native = nativeCopyDrag(['D:\\论文\\实验.md']);
    expect(native.op).toBe('copy');
    expect(native.deleteSource).toBe(false);
  });
});

describe('排序不带走另一区', () => {
  it('只交换本轮两项的 order 槽位', () => {
    const items = [
      material({ materialId: 's1', absPath: 'D:\\s1', order: 1, tier: 'session' }),
      material({ materialId: 'p1', absPath: 'D:\\p1', order: 2, tier: 'pinned' }),
      material({ materialId: 's2', absPath: 'D:\\s2', order: 3, tier: 'session' }),
    ];
    expect(reorderWithinTier(items, 'session', 's2', 's1')).toEqual(['s2', 'p1', 's1']);
    expect(items.find((item) => item.materialId === 'p1')?.order).toBe(2);
  });
});

describe('快捷键', () => {
  it('冲突时不占用 Ctrl+Shift+A，用户绑定保留，托管时从全局钩子拿掉', () => {
    const other = { id: 'edit.saveAs', title: '另存为', keybinding: 'Ctrl+Shift+A', when: 'global' as const };
    const blocked = decideAddCurrentBinding([other], emptyStore(), { hostedForeground: false });
    expect(blocked.keybinding).toBeUndefined();
    expect(blocked.reason).toContain('另存为');

    const store = emptyStore();
    store.overrides[AGENT_LIVE_ACTIONS.materialsAddCurrent] = 'Ctrl+Shift+K';
    const kept = decideAddCurrentBinding([], store, { hostedForeground: false });
    expect(kept.keybinding).toBe('Ctrl+Shift+K');

    store.overrides[AGENT_LIVE_ACTIONS.materialsAddCurrent] = 'Ctrl+Alt+A';
    const forbidden = decideAddCurrentBinding([], store, { hostedForeground: false });
    expect(forbidden.keybinding).toBeUndefined();

    const fresh = decideAddCurrentBinding([], emptyStore(), { hostedForeground: true });
    expect(fresh.keybinding).toBe('Ctrl+Shift+A');
    expect(fresh.when).toBe('global');
    expect(fresh.yieldToHost).toBe(true);
    const hooked = acceleratorsForGlobalHook(
      [
        { commandId: AGENT_LIVE_ACTIONS.materialsAddCurrent, key: 'Ctrl+Shift+A' },
        { commandId: 'workbench.commandPalette', key: 'Ctrl+Shift+P' },
      ],
      true,
    );
    expect(hooked.map((item) => item.commandId)).toEqual(['workbench.commandPalette']);
  });
});

describe('清单', () => {
  it('去重、固定保持固定、清空不动固定资料、不保存正文', async () => {
    const client = createMemoryAgentLive();
    const added = await client.add('ws', { absPath: 'D:\\论文\\实验.md', name: '实验.md', resourceId: 'r1' });
    expect(added).toMatchObject({ result: 'added', tier: 'session' });
    const [row] = await client.list('ws');
    expect(row?.bytes).toBeNull();
    expect(row?.contentHash).toBeNull();
    expect(row?.readable).toBeNull();
    expect('text' in (row ?? {})).toBe(false);
    await client.pin('ws', row!.materialId);
    const again = await client.add('ws', { absPath: 'D:\\别处\\实验.md', resourceId: 'r1' });
    expect(again).toMatchObject({ result: 'duplicate', tier: 'pinned', materialId: row!.materialId });
    expect((await client.list('ws')).filter((item) => item.resourceId === 'r1')).toHaveLength(1);

    const loose = await client.add('ws', { absPath: 'D:\\笔记\\A.txt' });
    expect(loose).toMatchObject({ result: 'added', tier: 'session' });
    const dupPath = await client.add('ws', { absPath: 'd:\\笔记\\a.txt\\' });
    expect(dupPath).toMatchObject({ result: 'duplicate', tier: 'session' });

    const pinned = (await client.list('ws')).find((item) => item.tier === 'pinned');
    const cleared = await client.clearSession('ws');
    const left = await client.list('ws');
    expect(cleared).not.toContain(pinned?.materialId);
    expect(left.map((item) => item.materialId)).toEqual([pinned?.materialId]);
    expect(left[0]?.absPath).toBe('D:\\论文\\实验.md');
  });

  it('重新定位保持 materialId，不写入内容副本', async () => {
    const client = createMemoryAgentLive();
    await client.add('ws', { absPath: 'D:\\旧.pdf', name: '旧.pdf' });
    const before = (await client.list('ws'))[0]!;
    before.status = 'missing';
    await client.relocate('ws', before.materialId, { absPath: 'D:\\新.pdf', name: '新.pdf', resourceId: null });
    const after = (await client.list('ws'))[0]!;
    expect(after.materialId).toBe(before.materialId);
    expect(after.absPath).toBe('D:\\新.pdf');
    expect(after.status).toBe('ok');
    expect(after.contentHash).toBeNull();
    expect(after.readable).toBeNull();
  });

  it('超过 200 项拒绝新引用', async () => {
    const client = createMemoryAgentLive();
    for (let index = 0; index < 200; index += 1) {
      await client.add('ws', { absPath: `D:\\box\\${index}.txt` });
    }
    await expect(client.add('ws', { absPath: 'D:\\box\\more.txt' })).rejects.toThrow('MAX_MATERIALS');
    expect(await client.list('ws')).toHaveLength(200);
  });
});

describe('加入反馈', () => {
  it('新文件、重复、批量、清空确认和托管让键', async () => {
    const client = createMemoryAgentLive();
    const { host, notes } = harness({
      currentReading: () => ({ absPath: 'D:\\正在读.md', name: '正在读.md' }),
    });
    await addRefs({ client, host }, [{ absPath: 'D:\\正在读.md', name: '正在读.md' }]);
    expect(notes.at(-1)).toBe(MSG_ADDED);
    const id = (await client.list('ws'))[0]!.materialId;
    await client.pin('ws', id);
    await addRefs({ client, host }, [{ absPath: 'D:\\正在读.md', name: '正在读.md' }]);
    expect(notes.at(-1)).toBe(MSG_DUPLICATE_PINNED);

    const batch = harness();
    await addRefs(
      { client, host: batch.host },
      [
        { absPath: 'D:\\一.txt', name: '一.txt' },
        { absPath: 'D:\\二.txt', name: '二.txt' },
      ],
    );
    expect(batch.notes.at(-1)).toBe('已加入本轮资料 2 项，agent 可通过已有入口读取');

    const session = harness();
    await addRefs({ client, host: session.host }, [{ absPath: 'D:\\临时.txt', name: '临时.txt' }]);
    await addRefs({ client, host: session.host }, [{ absPath: 'D:\\临时.txt', name: '临时.txt' }]);
    expect(session.notes.at(-1)).toBe(MSG_DUPLICATE_SESSION);

    const cancelled = harness({ confirm: async () => false });
    const before = (await client.list('ws')).map((item) => item.absPath);
    await clearSession({ client, host: cancelled.host });
    expect((await client.list('ws')).map((item) => item.absPath)).toEqual(before);
    expect(cancelled.notes).toEqual([]);

    const confirmed = harness({ confirm: async (spec) => spec.body.includes('不会删除原文件') });
    await clearSession({ client, host: confirmed.host });
    expect(confirmed.notes.at(-1)).toBe(MSG_CLEARED);
    expect((await client.list('ws')).every((item) => item.tier === 'pinned')).toBe(true);

    const hosted = harness({
      hostedForeground: () => true,
      currentReading: () => ({ absPath: 'D:\\不该加入.txt', name: '不该加入.txt' }),
    });
    await addCurrent({ client, host: hosted.host });
    expect(hosted.notes).toEqual([]);
    expect((await client.list('ws')).some((item) => item.absPath === 'D:\\不该加入.txt')).toBe(false);
  });

  it('满 200 项时界面提示而不加入', async () => {
    const client = createMemoryAgentLive();
    for (let index = 0; index < 200; index += 1) await client.add('ws', { absPath: `D:\\full\\${index}.txt` });
    const { host, notes } = harness();
    await addRefs({ client, host }, [{ absPath: 'D:\\full\\extra.txt', name: 'extra.txt' }]);
    expect(notes.at(-1)).toBe(MSG_LIMIT);
    expect(await client.list('ws')).toHaveLength(200);
  });

  it('复制入口后提示粘贴给 agent', async () => {
    const client = createMemoryAgentLive();
    let copied = '';
    const { host, notes } = harness({
      writeClipboard: async (text) => {
        copied = text;
      },
    });
    await copyBridgeLink({ client, host });
    expect(copied).toBe('D:\\bridge\\live\\current\\ENTRY.md');
    expect(notes.at(-1)).toBe(MSG_COPIED);
    expect(entryPaths('D:\\bridge', 'ws-1').workspace).toBe('D:\\bridge\\live\\ws\\ws-1\\ENTRY.md');
  });
});

describe('空树一键加资料', () => {
  it('无 reading 时 pickFile 加入 loose material', async () => {
    const client = createMemoryAgentLive();
    const { host, notes } = harness({
      currentReading: () => null,
      pickFile: async () => 'D:\\从磁盘选.md',
    });
    await addCurrent({ client, host });
    const rows = await client.list('ws');
    expect(rows.some((item) => item.absPath === 'D:\\从磁盘选.md' && item.resourceId == null)).toBe(true);
    expect(notes.at(-1)).toBe(MSG_ADDED);
  });

  it('取消 pickFile 不加入也不报错', async () => {
    const client = createMemoryAgentLive();
    const { host, notes } = harness({
      currentReading: () => null,
      pickFile: async () => null,
    });
    await addCurrent({ client, host });
    await addFromDisk({ client, host });
    expect(await client.list('ws')).toHaveLength(0);
    expect(notes).toEqual([]);
  });
});

describe('拖入', () => {
  it('网页与文件留下引用，文件夹也作为引用（确认在 panel）', () => {
    const payload: DragPayload = {
      v: 1,
      items: [
        { resourceId: 'web-1', sourceKind: 'web', from: { kind: 'workspace-refs', workspaceId: 'ws' }, entry: 'file', name: '页面' },
        { resourceId: 'dir-1', sourceKind: 'file', from: { kind: 'root', rootId: 'root', relPath: '章' }, entry: 'dir-entry', name: '章' },
        { resourceId: 'file-1', sourceKind: 'file', from: { kind: 'root', rootId: 'root', relPath: '章/实验.md' }, entry: 'file', name: '实验.md', relPath: '章/实验.md' },
      ],
    };
    const pieces = piecesFromPayload(payload);
    const parts = partitionPieces(pieces);
    expect(parts.reject).toBeNull();
    expect(parts.refs.map((r) => r.resourceId)).toEqual(['web-1', 'dir-1', 'file-1']);
    expect(pieces.find((p) => p.ref?.resourceId === 'dir-1')?.kind).toBe('dir');
    expect(parts.refs[2]).toEqual({ resourceId: 'file-1', relPath: '章/实验.md', name: '实验.md', absPath: '' });
    const fromUri = piecesFromTransfer(['text/uri-list'], () => 'file:///D:/%E8%AE%BA%E6%96%87/%E5%AE%9E%E9%AA%8C.md\r\n');
    expect(fromUri[0]?.ref?.absPath).toBe('D:\\论文\\实验.md');
  });

  it('accepts web resource drops into agent refs', () => {
    const payload: DragPayload = {
      v: 1,
      items: [
        { resourceId: 'web-2', sourceKind: 'web', from: { kind: 'workspace-refs', workspaceId: 'ws' }, entry: 'file', name: 'page' },
      ],
    };
    const parts = partitionPieces(piecesFromPayload(payload));
    expect(parts.reject).toBeNull();
    expect(parts.refs).toEqual([{ resourceId: 'web-2', name: 'page', absPath: '' }]);
  });


  it('多选右键加入整批，点在选区外只加入一项', () => {
    const a: MaterialRef = { resourceId: 'a', absPath: 'D:\\a.txt', name: 'a' };
    const b: MaterialRef = { resourceId: 'b', absPath: 'D:\\b.txt', name: 'b' };
    const c: MaterialRef = { resourceId: 'c', absPath: 'D:\\c.txt', name: 'c' };
    expect(refsForAddGesture(a, [a, b]).map((item) => item.resourceId)).toEqual(['a', 'b']);
    expect(refsForAddGesture(c, [a, b]).map((item) => item.resourceId)).toEqual(['c']);
  });
});

describe('路径键', () => {
  it('忽略大小写和末尾分隔符', () => {
    expect(pathKey('D:\\论文\\实验.md\\')).toBe(pathKey('d:/论文/实验.md'));
  });
});

describe('isDirMaterial', () => {
  it('目录材料：ok 且无 bytes/hash/readable', () => {
    expect(isDirMaterial(material({ materialId: 'd', absPath: 'D:\\chap', bytes: null, contentHash: null, readable: null }))).toBe(true);
  });
  it('文件材料：有 bytes 不算目录', () => {
    expect(isDirMaterial(material({ materialId: 'f', absPath: 'D:\\a.md', bytes: 12, contentHash: null, readable: null }))).toBe(false);
  });
  it('失效材料不算可展开目录', () => {
    expect(isDirMaterial(material({ materialId: 'm', absPath: 'D:\\gone', status: 'missing', bytes: null }))).toBe(false);
  });
});

describe('addRefsMaybeDir', () => {
  it('asDir 时先确认，取消则不加', async () => {
    const client = createMemoryAgentLive();
    const asks: string[] = [];
    const h = harness({
      confirm: async (spec) => {
        asks.push(spec.title);
        return false;
      },
      resolve: async (ref) => ({ ...ref, absPath: ref.absPath || 'D:\\chap' }),
    });
    const msg = await addRefsMaybeDir({ client, host: h.host }, [{ resourceId: 'd1', absPath: '', name: '章' }], { asDir: true });
    expect(msg).toBe('');
    expect(asks.length).toBe(1);
    expect(await client.list('ws')).toHaveLength(0);
  });

  it('asDir 确认后加入', async () => {
    const client = createMemoryAgentLive();
    const h = harness({
      confirm: async () => true,
      resolve: async (ref) => ({ ...ref, absPath: 'D:\\chap', name: '章' }),
    });
    await addRefsMaybeDir({ client, host: h.host }, [{ resourceId: 'd1', absPath: '', name: '章' }], { asDir: true });
    const list = await client.list('ws');
    expect(list.length).toBe(1);
  });

  it('非目录不弹确认', async () => {
    const client = createMemoryAgentLive();
    let confirms = 0;
    const h = harness({
      confirm: async () => {
        confirms += 1;
        return true;
      },
      resolve: async (ref) => ({ ...ref, absPath: 'D:\\a.md', name: 'a.md' }),
    });
    await addRefsMaybeDir({ client, host: h.host }, [{ resourceId: 'f1', absPath: '', name: 'a.md' }], { asDir: false });
    expect(confirms).toBe(0);
    expect(await client.list('ws')).toHaveLength(1);
  });
});

