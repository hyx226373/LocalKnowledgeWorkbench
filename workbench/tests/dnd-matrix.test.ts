import { describe, expect, it } from 'vitest';
import { HINT_ALREADY, HINT_BAD_ENTRY, HINT_CLASSIFY, HINT_CLASSIFY_ALT, HINT_CLASSIFY_COPY, HINT_DIR_OPEN, HINT_FLOAT, HINT_INVALID, HINT_NO_ORIGIN, HINT_SELF, HINT_SPLIT, HINT_TAB, HINT_VFOLDER_NODE, HINT_WEB_DISK, WILL_MOVE_FILE } from '../src/renderer/dnd/copy';
import { performDrop, removeFromFolderFlow, removeFromWorkspaceFlow, type FlowPorts } from '../src/renderer/dnd/flow';
import { readerZone } from '../src/renderer/dnd/geometry';
import { interpretDirTarget } from '../src/renderer/dnd/interpret';
import { attachDisk, parseDragPayload } from '../src/renderer/dnd/mime';
import { uniqueName } from '../src/renderer/dnd/names';
import { orderRoots } from '../src/renderer/dnd/rootOrder';
import { onDropTarget } from '../src/renderer/dnd/resolve';
import { payloadFor, rememberDragItem, toggleSelected } from '../src/renderer/dnd/selection';
import type { DragPayload, DropTarget } from '../src/renderer/dnd/types';
import { foldersOf, removeFromOneFolder, setMembership } from '../src/main/service/workspaceRefs';
import { addToFolder, removeFromAllFolders, removeFromFolder, shiftInto, emptyRefs } from '../src/renderer/dnd/vfolders';

const file = (over: Partial<DragPayload['items'][0]> = {}): DragPayload => ({
  v: 1,
  items: [
    {
      resourceId: 'r1',
      sourceKind: 'file',
      from: { kind: 'root', rootId: 'A', relPath: '笔记/a.md' },
      entry: 'file',
      name: 'a.md',
      rootId: 'A',
      relPath: '笔记/a.md',
      size: 4,
      ...over,
    },
  ],
});

const disk = (relPath: string, childNames?: string[], rootId = 'A'): DropTarget => ({ kind: 'disk-dir', rootId, relPath, childNames });

describe('落点矩阵', () => {
  it('磁盘文件 → 另一真实文件夹：真移动，文案含将移动原文件', () => {
    const d = onDropTarget(disk('归档'), file());
    expect(d.action.type).toBe('move');
    expect(d.dropEffect).toBe('move');
    expect(d.hint).toContain(WILL_MOVE_FILE);
    if (d.action.type === 'move') {
      expect(d.action.crossRoot).toBe(false);
      expect(d.action.ops[0].toRelPath).toBe('归档/a.md');
    }
  });

  it('自建目录里的文件条目 → 真实文件夹：同样真移动', () => {
    const d = onDropTarget(
      disk('归档', undefined, 'B'),
      file({ from: { kind: 'vfolder', folderId: 'f1' }, rootId: 'A', relPath: '笔记/a.md' }),
    );
    expect(d.action.type).toBe('move');
    expect(d.hint).toContain(WILL_MOVE_FILE);
    if (d.action.type === 'move') expect(d.action.crossRoot).toBe(true);
  });

  it('自建目录节点 → 磁盘：禁止，且不写一律禁止', () => {
    const d = onDropTarget(disk('归档'), file({ entry: 'vfolder-node', folderId: 'f1', resourceId: '' }));
    expect(d.action).toEqual({ type: 'reject', reason: HINT_VFOLDER_NODE });
    expect(d.hint).not.toMatch(/一律禁止/);
    expect(HINT_VFOLDER_NODE).not.toMatch(/一律禁止/);
  });

  it('资料 → 自建目录：加入；Alt 移出原目录', () => {
    const add = onDropTarget({ kind: 'vfolder', folderId: 'f2' }, file());
    expect(add.action).toMatchObject({ type: 'classify-add', folderId: 'f2', alsoRemoveOtherFolders: false });
    expect(add.hint).toBe(HINT_CLASSIFY);
    const alt = onDropTarget({ kind: 'vfolder', folderId: 'f2' }, file(), { alt: true });
    expect(alt.action).toMatchObject({ type: 'classify-add', alsoRemoveOtherFolders: true });
    expect(alt.hint).toBe(HINT_CLASSIFY_ALT);
  });

  it('自建目录之间：默认改归类，Ctrl 复制归属', () => {
    const payload = file({ from: { kind: 'vfolder', folderId: 'f1' } });
    const move = onDropTarget({ kind: 'vfolder', folderId: 'f2' }, payload);
    expect(move.action).toMatchObject({ type: 'classify-shift', copy: false, sourceFolderIds: ['f1'] });
    const copy = onDropTarget({ kind: 'vfolder', folderId: 'f2' }, payload, { ctrl: true });
    expect(copy.action).toMatchObject({ type: 'classify-shift', copy: true });
    expect(copy.hint).toBe(HINT_CLASSIFY_COPY);
  });

  it('资料 → 本工作的资料：加引用；文件夹不加', () => {
    const d = onDropTarget({ kind: 'workspace-refs', workspaceId: 'ws' }, file());
    expect(d.action).toMatchObject({ type: 'add-ref', workspaceId: 'ws', resourceIds: ['r1'] });
    expect(d.dropEffect).toBe('link');
    expect(onDropTarget({ kind: 'workspace-refs', workspaceId: 'ws' }, file({ entry: 'dir-entry' })).action.type).toBe('reject');
  });

  it('阅读区中央=标签，边缘=分屏，空白=浮窗', () => {
    expect(onDropTarget({ kind: 'reader', zone: 'center' }, file()).action).toMatchObject({ type: 'open', place: 'tab' });
    expect(onDropTarget({ kind: 'reader', zone: 'center' }, file()).hint).toBe(HINT_TAB);
    expect(onDropTarget({ kind: 'reader', zone: 'left' }, file()).hint).toContain(HINT_SPLIT);
    expect(onDropTarget({ kind: 'reader', zone: 'right' }, file()).action).toMatchObject({ place: 'right' });
    expect(onDropTarget({ kind: 'reader', zone: 'up' }, file()).action).toMatchObject({ place: 'up' });
    expect(onDropTarget({ kind: 'reader', zone: 'down' }, file()).action).toMatchObject({ place: 'down' });
    expect(onDropTarget({ kind: 'workbench-blank' }, file()).action).toMatchObject({ type: 'open', place: 'float' });
    expect(onDropTarget({ kind: 'workbench-blank' }, file()).hint).toBe(HINT_FLOAT);
  });

  it('文件夹不能丢进阅读区', () => {
    expect(onDropTarget({ kind: 'reader', zone: 'center' }, file({ entry: 'dir-entry' })).hint).toBe(HINT_DIR_OPEN);
  });

  it('根列表只接受根，并按落下的位置重排', () => {
    const roots = file({ entry: 'dir-entry', resourceId: 'res-b', rootId: 'B', from: { kind: 'roots-list' }, relPath: '' });
    const d = onDropTarget({ kind: 'roots-list', rootIds: ['A', 'B', 'C'], index: 0 }, roots);
    expect(d.action).toEqual({ type: 'reorder-roots', ids: ['B', 'A', 'C'] });
    expect(onDropTarget({ kind: 'roots-list', rootIds: ['A'], index: 0 }, file()).action.type).toBe('reject');
  });

  it('网络资料 → 磁盘：请先保存到本地', () => {
    const d = onDropTarget(disk('归档'), file({ sourceKind: 'web' }));
    expect(d.action).toEqual({ type: 'reject', reason: HINT_WEB_DISK });
  });

  it('自身、子目录、已在此文件夹、无效落点', () => {
    expect(onDropTarget(disk('笔记/a.md'), file({ entry: 'dir-entry', relPath: '笔记', from: { kind: 'root', rootId: 'A', relPath: '笔记' }, rootId: 'A' })).hint).toBe(HINT_SELF);
    expect(onDropTarget(disk('笔记'), file()).hint).toBe(HINT_ALREADY);
    expect(onDropTarget({ kind: 'invalid' }, file()).hint).toBe(HINT_INVALID);
    expect(onDropTarget(disk('归档'), null).action.type).toBe('reject');
  });

  it('同名标记，不覆盖', () => {
    const d = onDropTarget(disk('归档', ['a.md']), file());
    expect(d.action.type).toBe('move');
    if (d.action.type === 'move') expect(d.action.nameClash).toBe(true);
    expect(d.hint).toContain('同名');
  });

  it('Ctrl 多选拖其中一项时合成一个载荷', () => {
    const a = file().items[0];
    const b = { ...a, resourceId: 'r2', name: 'b.md', relPath: '笔记/b.md' };
    rememberDragItem(a);
    rememberDragItem(b);
    toggleSelected(a.resourceId);
    toggleSelected(b.resourceId);
    expect(payloadFor(a).items.map((i) => i.resourceId)).toEqual(['r1', 'r2']);
    expect(payloadFor({ ...a, resourceId: 'r9' }).items).toHaveLength(1);
  });

  it('多选合成一次移动', () => {
    const payload: DragPayload = {
      v: 1,
      items: [
        file().items[0],
        { ...file().items[0], resourceId: 'r2', name: 'b.md', relPath: '笔记/b.md', from: { kind: 'root', rootId: 'A', relPath: '笔记/b.md' } },
      ],
    };
    const d = onDropTarget(disk('归档'), payload);
    expect(d.action.type).toBe('move');
    if (d.action.type === 'move') expect(d.action.ops).toHaveLength(2);
  });

  it('坏 MIME 拒绝', () => {
    expect(parseDragPayload('{')).toBeNull();
    expect(parseDragPayload(JSON.stringify({ v: 1, items: [{ resourceId: 'x', sourceKind: 'file', from: { kind: 'roots-list' } }] }))?.items).toHaveLength(1);
  });

  it('缺 entry 时拒绝，不当成文件', () => {
    const payload = file();
    delete payload.items[0].entry;
    const d = onDropTarget(disk('归档'), payload);
    expect(d.action).toEqual({ type: 'reject', reason: HINT_BAD_ENTRY });
    expect(d.action.type).not.toBe('move');
    expect(d.dropEffect).toBe('none');
  });

  it('未知 entry 拒绝，不当成文件', () => {
    const raw = JSON.stringify({
      v: 1,
      items: [{ resourceId: 'r1', sourceKind: 'file', from: { kind: 'root', rootId: 'A', relPath: '笔记/a.md' }, entry: 'folder', name: 'a.md', rootId: 'A', relPath: '笔记/a.md' }],
    });
    const parsed = parseDragPayload(raw);
    expect(parsed?.items).toHaveLength(1);
    const d = onDropTarget(disk('归档'), parsed);
    expect(d.action.type).toBe('reject');
    expect(d.action.type).not.toBe('move');
    expect(d.hint).toBe(HINT_BAD_ENTRY);
  });

  it('目录条目拖到磁盘文件夹是真移动', () => {
    const d = onDropTarget(
      disk('归档'),
      file({ entry: 'dir-entry', name: '笔记', relPath: '笔记', from: { kind: 'root', rootId: 'A', relPath: '笔记' }, rootId: 'A' }),
    );
    expect(d.action.type).toBe('move');
    expect(d.hint).toContain(WILL_MOVE_FILE);
    if (d.action.type === 'move') {
      expect(d.action.ops[0].toRelPath).toBe('归档/笔记');
      expect(d.action.ops[0].entryKind).toBe('dir');
    }
  });

  it('自建目录文件没有磁盘位置时拒绝，解析到路径后才真移动', () => {
    const bare = file({ from: { kind: 'vfolder', folderId: 'f1' }, rootId: undefined, relPath: undefined }).items[0];
    expect(onDropTarget(disk('归档'), { v: 1, items: [bare] }).hint).toBe(HINT_NO_ORIGIN);
    const filled = attachDisk(bare, { rootId: 'A', relPath: '笔记/a.md', name: 'a.md', size: 4 });
    const d = onDropTarget(disk('归档', undefined, 'B'), { v: 1, items: [filled] });
    expect(d.action.type).toBe('move');
    expect(d.hint).toContain(WILL_MOVE_FILE);
  });
});

describe('阅读区几何', () => {
  const rect = { left: 0, top: 0, width: 400, height: 300 };
  it('中央与四边', () => {
    expect(readerZone(rect, 200, 150)).toBe('center');
    expect(readerZone(rect, 4, 150)).toBe('left');
    expect(readerZone(rect, 390, 150)).toBe('right');
    expect(readerZone(rect, 200, 4)).toBe('up');
    expect(readerZone(rect, 200, 290)).toBe('down');
  });
});

describe('C 落点翻译', () => {
  const item = file().items[0];
  it('文件落到文件上是无效落点', () => {
    const d = interpretDirTarget({ kind: 'root', rootId: 'A', relPath: '笔记/c.md' }, [item], ['A'], { kind: 'file' }, []);
    expect(d.kind).toBe('invalid');
  });
  it('根拖到另一根是调序，拖到子目录则无效', () => {
    const root = file({ entry: 'dir-entry', resourceId: 'res-b', rootId: 'B', from: { kind: 'roots-list' }, relPath: '' }).items[0];
    const onto = interpretDirTarget({ kind: 'root', rootId: 'A', relPath: '' }, [root], ['A', 'B'], null, []);
    expect(onto).toEqual({ kind: 'roots-list', rootIds: ['A', 'B'], index: 0 });
    expect(interpretDirTarget({ kind: 'root', rootId: 'A', relPath: '笔记' }, [root], ['A', 'B'], { kind: 'dir' }, []).kind).toBe('invalid');
  });
  it('自建目录虚拟根不是归类落点', () => {
    expect(interpretDirTarget({ kind: 'vfolder', folderId: null }, [item], [], null, []).kind).toBe('invalid');
    expect(interpretDirTarget({ kind: 'vfolder', folderId: 'f2' }, [item], [], null, [])).toEqual({ kind: 'vfolder', folderId: 'f2' });
  });
});

describe('归类与根排序纯函数', () => {
  it('加入、Alt 清空其他目录、目录间移动与复制', () => {
    let refs = emptyRefs();
    refs = addToFolder(refs, 'f1', ['r1']);
    refs = addToFolder(refs, 'f2', ['r1']);
    expect(refs.byFolder.f1).toEqual(['r1']);
    refs = removeFromAllFolders(refs, ['r1']);
    refs = addToFolder(refs, 'f2', ['r1']);
    expect(refs.byFolder.f1).toEqual([]);
    expect(refs.byFolder.f2).toEqual(['r1']);
    const shifted = shiftInto(addToFolder(emptyRefs(), 'f1', ['r1']), 'f2', ['r1'], ['f1'], false);
    expect(shifted.byFolder.f1).toEqual([]);
    expect(shifted.byFolder.f2).toEqual(['r1']);
    const copied = shiftInto(addToFolder(emptyRefs(), 'f1', ['r1']), 'f2', ['r1'], ['f1'], true);
    expect(copied.byFolder.f1).toEqual(['r1']);
    expect(copied.byFolder.f2).toEqual(['r1']);
    expect(removeFromFolder(copied, 'f2', ['r1']).byFolder.f1).toEqual(['r1']);
  });

  it('虚拟根与目标目录不会同时留下同一条资料', () => {
    const known = new Set(['f1', 'f2']);
    let refs = setMembership({ v: 1, byFolder: { '': ['r1'], f1: ['r1'] } }, known, 'r1', ['f2']);
    expect(refs.byFolder[''] ?? []).not.toContain('r1');
    expect(refs.byFolder.f1 ?? []).not.toContain('r1');
    expect(refs.byFolder.f2).toContain('r1');
    expect(foldersOf(refs, 'r1')).toEqual(['f2']);
    refs = removeFromOneFolder(refs, 'r1', 'f2');
    expect(foldersOf(refs, 'r1')).toEqual([]);
    expect(refs.byFolder['']).toContain('r1');
    expect(refs.byFolder.f2 ?? []).not.toContain('r1');
  });

  it('根顺序：未知 id 留在后面', () => {
    expect(orderRoots([{ id: 'a' }, { id: 'b' }, { id: 'c' }], ['c', 'a']).map((r) => r.id)).toEqual(['c', 'a', 'b']);
  });

  it('同名改名为 (2)，不覆盖', () => {
    expect(uniqueName(new Set(['a.md']), 'a.md')).toBe('a (2).md');
    expect(uniqueName(new Set(['a.md', 'a (2).md']), 'a.md')).toBe('a (3).md');
  });
});

function ports(over: Partial<FlowPorts> = {}): FlowPorts & { approved: boolean; proposed: unknown[] } {
  const bag = { approved: false, proposed: [] as unknown[] };
  const base: FlowPorts = {
    propose: async (_t, ops) => {
      bag.proposed = ops;
      return { planId: 'p1', contentHash: 'h1', ops: ops.map((_, i) => ({ opId: 'op' + (i + 1) })) };
    },
    approve: async () => {
      bag.approved = true;
    },
    getLayout: async () => null,
    setLayout: async () => {},
    addWorkspaceRefs: async () => {},
    removeWorkspaceRef: async () => {},
    open: async () => {},
    confirmMove: async (m) => (m.nameClash ? 'rename' : 'move'),
    confirm: async () => true,
    alert: async () => {},
    childNames: async () => [],
    ...over,
  };
  return Object.assign(bag, base);
}

describe('真移动确认链', () => {
  it('无同名：先 propose 再确认再 approve，且不直接写盘', async () => {
    const d = onDropTarget(disk('归档'), file());
    const p = ports();
    const r = await performDrop(d, p);
    expect(r.status).toBe('done');
    expect(p.approved).toBe(true);
    expect(p.proposed).toEqual([{ kind: 'move', resourceId: 'r1', toRelPath: '归档/a.md' }]);
  });

  it('同名选择改名后才 propose，取消则不批准', async () => {
    const d = onDropTarget(disk('归档', ['a.md']), file());
    const renamed = ports({ childNames: async () => ['a.md'] });
    const ok = await performDrop(d, renamed);
    expect(ok.status).toBe('done');
    expect(renamed.proposed).toEqual([{ kind: 'move', resourceId: 'r1', toRelPath: '归档/a (2).md' }]);
    const cancelled = ports({
      childNames: async () => ['a.md'],
      confirmMove: async () => 'cancel',
    });
    const no = await performDrop(d, cancelled);
    expect(no.status).toBe('cancel');
    expect(cancelled.approved).toBe(false);
    expect(cancelled.proposed).toEqual([]);
  });

  it('用户在确认移动时取消：计划已提出但不批准', async () => {
    const d = onDropTarget(disk('归档'), file());
    let n = 0;
    const p = ports({
      confirmMove: async () => {
        n += 1;
        return 'cancel';
      },
    });
    const r = await performDrop(d, p);
    expect(r.status).toBe('cancel');
    expect(p.approved).toBe(false);
    expect(p.proposed).toHaveLength(1);
    expect(n).toBe(1);
  });

  it('归类调用 setMembership，不写 library.vfolderRefs', async () => {
    const sets: [string, string[]][] = [];
    const layouts: string[] = [];
    const membership: Record<string, string[]> = { r1: ['f1'] };
    const p = ports({
      listMembership: async (id) => membership[id] ?? [],
      setMembership: async (id, ids) => {
        membership[id] = ids;
        sets.push([id, ids]);
      },
      setLayout: async (k) => {
        layouts.push(k);
      },
    });
    const shifted = onDropTarget({ kind: 'vfolder', folderId: 'f2' }, file({ from: { kind: 'vfolder', folderId: 'f1' } }));
    expect((await performDrop(shifted, p)).status).toBe('done');
    expect(sets).toEqual([['r1', ['f2']]]);
    const copied = onDropTarget({ kind: 'vfolder', folderId: 'f1' }, file({ from: { kind: 'vfolder', folderId: 'f2' } }), { ctrl: true });
    membership.r1 = ['f2'];
    expect((await performDrop(copied, p)).status).toBe('done');
    expect(sets[1]).toEqual(['r1', ['f2', 'f1']]);
    const added = onDropTarget({ kind: 'vfolder', folderId: 'f2' }, file(), { alt: true });
    expect((await performDrop(added, p)).status).toBe('done');
    expect(sets[2]).toEqual(['r1', ['f2']]);
    expect(layouts).not.toContain('library.vfolderRefs');
  });

  it('这一批里自己重名也要先改名，不覆盖', async () => {
    const payload: DragPayload = {
      v: 1,
      items: [
        file().items[0],
        { ...file().items[0], resourceId: 'r2', name: 'a.md', relPath: '其他/a.md', from: { kind: 'root', rootId: 'A', relPath: '其他/a.md' } },
      ],
    };
    const d = onDropTarget(disk('归档'), payload);
    const p = ports({ childNames: async () => [] });
    const r = await performDrop(d, p);
    expect(r.status).toBe('done');
    expect(p.proposed).toEqual([
      { kind: 'move', resourceId: 'r1', toRelPath: '归档/a.md' },
      { kind: 'move', resourceId: 'r2', toRelPath: '归档/a (2).md' },
    ]);
  });
});

describe('两种移除文案', () => {
  it('从该目录移除只解归类，不关面板', async () => {
    let closed = 0;
    let body = '';
    let removed: { id: string; folder: string | null } | null = null;
    const layouts: string[] = [];
    const p = ports({
      setLayout: async (k) => {
        layouts.push(k);
      },
      confirm: async (_t, b) => {
        body = b;
        return true;
      },
      closePanels: async () => {
        closed += 1;
      },
      removeMembership: async (id, folder) => {
        removed = { id, folder };
      },
    });
    const r = await removeFromFolderFlow(p, 'f1', 'r1', 'a.md');
    expect(r.status).toBe('done');
    expect(body).toContain('不关闭已打开的面板');
    expect(body).not.toContain('从本工作区移除');
    expect(closed).toBe(0);
    expect(removed).toEqual({ id: 'r1', folder: 'f1' });
    expect(layouts).not.toContain('library.vfolderRefs');
  });

  it('从本工作区移除关本区面板，保留他区与归类', async () => {
    let closed = '';
    let removed = false;
    let body = '';
    let membershipTouched = 0;
    const layouts: string[] = [];
    const p = ports({
      setLayout: async (k) => {
        layouts.push(k);
      },
      confirm: async (t, b) => {
        body = t + '\n' + b;
        return true;
      },
      removeWorkspaceRef: async () => {
        removed = true;
      },
      closePanels: async (id) => {
        closed = id;
      },
      isDirty: () => true,
      otherWorkspaceNames: async () => ['另一项工作'],
      removeMembership: async () => {
        membershipTouched += 1;
      },
      setMembership: async () => {
        membershipTouched += 1;
      },
    });
    const r = await removeFromWorkspaceFlow(p, 'ws', 'r1', 'a.md');
    expect(r.status).toBe('done');
    expect(body).toContain('从本工作区移除');
    expect(body).toContain('会关闭本工作区里已打开的面板');
    expect(body).toContain('另一项工作');
    expect(body).toContain('未保存');
    expect(removed).toBe(true);
    expect(closed).toBe('r1');
    expect(membershipTouched).toBe(0);
    expect(layouts).not.toContain('library.vfolderRefs');
  });
});
