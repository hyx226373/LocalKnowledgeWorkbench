import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/renderer/kb', () => ({ kb: {} }));

import { readKbPayload } from '../src/renderer/dnd/drag';
import { readDrag } from '../src/renderer/dir-view/dnd';
import { payloadFor } from '../src/renderer/dnd/selection';
import { piecesFromTransfer } from '../src/renderer/agent-live/dropIn';
import { commitTreeFileDrag } from '../src/renderer/nativeDrag/commit';
import { setNativeDragRootIndex } from '../src/renderer/nativeDrag/paths';
import { clearNativeDragSession, peekNativeDragSession } from '../src/renderer/nativeDrag/session';
import { setNativeDragSender } from '../src/renderer/nativeDrag/start';
import { clearTreeMulti, prepareTreeDrag, toggleTreeMulti } from '../src/renderer/nativeDrag/treeDrag';
import type { KbDragPayload } from '../src/renderer/dir-view/dnd';

function item(over: Partial<KbDragPayload['items'][number]> & Pick<KbDragPayload['items'][number], 'resourceId' | 'entry'>): KbDragPayload {
  return {
    v: 1,
    items: [{
      sourceKind: 'file',
      from: { kind: 'root', rootId: 'root-1', relPath: over.relPath ?? '' },
      rootId: 'root-1',
      ...over,
    }],
  };
}

function transfer() {
  const data = new Map<string, string>();
  return {
    data,
    dt: {
      setData(type: string, value: string) { data.set(type, value); },
      getData(type: string) { return data.get(type) ?? ''; },
      effectAllowed: 'copyMove',
      types: [] as string[],
    },
  };
}

afterEach(() => {
  clearTreeMulti();
  clearNativeDragSession();
  setNativeDragSender(null);
  setNativeDragRootIndex([]);
});

describe('目录树拖出路径', () => {
  it('根目录、子文件夹和文件都能拼进同一次 files，未选中的不带上', () => {
    setNativeDragRootIndex([
      { id: 'root-1', path: 'C:\\Data\\Root', kind: 'folder' },
      { id: 'root-2', path: 'D:\\Other\\', kind: 'folder' },
    ]);
    const folder = item({ resourceId: 'dir-1', entry: 'dir-entry', relPath: '论文', name: '论文' });
    const file = item({ resourceId: 'file-1', entry: 'file', relPath: '笔记.md', name: '笔记.md' });
    const root = item({
      resourceId: 'root-res',
      entry: 'dir-entry',
      from: { kind: 'roots-list' },
      rootId: 'root-2',
      relPath: '',
      name: 'Other',
    });
    toggleTreeMulti(file);
    toggleTreeMulti(folder);
    toggleTreeMulti(root);

    const dragged = prepareTreeDrag(folder, ['C:\\Data\\Root\\论文\\']);
    expect(dragged.paths).toEqual(['C:\\Data\\Root\\论文', 'C:\\Data\\Root\\笔记.md', 'D:\\Other']);
    expect(dragged.payload.items.map((row) => row.resourceId)).toEqual(['dir-1', 'file-1', 'root-res']);
    expect(dragged.payload.items.map((row) => row.entry)).toEqual(['dir-entry', 'file', 'dir-entry']);

    const alone = prepareTreeDrag(item({ resourceId: 'other', entry: 'file', relPath: 'a.md' }), []);
    expect(alone.paths).toEqual(['C:\\Data\\Root\\a.md']);
    expect(alone.payload.items).toHaveLength(1);

    expect(payloadFor({
      resourceId: 'file-1',
      sourceKind: 'file',
      from: { kind: 'root', rootId: 'root-1', relPath: '笔记.md' },
      entry: 'file',
    }).items.map((row) => row.resourceId)).toEqual(['file-1']);
  });

  it('dragstart 先 preventDefault 再把文件夹和多选交给 startDrag，拖回仍是目录条目', () => {
    setNativeDragRootIndex([{ id: 'root-1', path: 'D:\\notes', kind: 'folder' }]);
    const folder = item({ resourceId: 'dir-1', entry: 'dir-entry', relPath: '论文', name: '论文', rootId: 'root-1', from: { kind: 'root', rootId: 'root-1', relPath: '论文' } });
    const file = item({ resourceId: 'file-1', entry: 'file', relPath: '笔记.md', name: '笔记.md', rootId: 'root-1', from: { kind: 'root', rootId: 'root-1', relPath: '笔记.md' } });
    toggleTreeMulti(folder);
    toggleTreeMulti(file);
    const prepared = prepareTreeDrag(folder, ['D:\\notes\\论文']);

    const order: string[] = [];
    setNativeDragSender((paths) => {
      order.push('send:' + paths.join('|'));
      expect(peekNativeDragSession()?.kb?.items[0]?.entry).toBe('dir-entry');
    });
    const box = transfer();
    const kind = commitTreeFileDrag({
      preventDefault: () => { order.push('prevent'); },
      dataTransfer: box.dt,
    }, prepared.payload, prepared.paths, () => { order.push('html5'); }, 'file');

    expect(kind).toBe('file');
    expect(order).toEqual(['prevent', 'send:D:\\notes\\论文|D:\\notes\\笔记.md']);
    expect(box.data.size).toBe(0);
    const session = peekNativeDragSession();
    expect(session?.paths).toEqual(['D:\\notes\\论文', 'D:\\notes\\笔记.md']);
    expect(session?.kb?.items.map((row) => row.entry)).toEqual(['dir-entry', 'file']);

    const dt = {
      types: ['Files'],
      getData: () => '',
    } as unknown as DataTransfer;
    expect(readKbPayload(dt)?.items[0]?.entry).toBe('dir-entry');
    expect(readDrag({ dataTransfer: dt } as Parameters<typeof readDrag>[0])?.items.map((row) => row.resourceId)).toEqual(['dir-1', 'file-1']);
    expect(piecesFromTransfer(['Files'], () => '', dt).map((piece) => piece.kind)).toEqual(['dir', undefined]);
  });

  it('路径模式不调用 startDrag，多条绝对路径按行写入', () => {
    setNativeDragRootIndex([{ id: 'root-1', path: 'D:\\notes', kind: 'folder' }]);
    const folder = item({ resourceId: 'dir-1', entry: 'dir-entry', relPath: '', name: 'notes' });
    const sent: string[][] = [];
    setNativeDragSender((paths) => { sent.push([...paths]); });
    const box = transfer();
    let wrote = false;
    const prepared = prepareTreeDrag(folder, ['D:\\notes']);
    const kind = commitTreeFileDrag({
      preventDefault: () => undefined,
      dataTransfer: box.dt,
    }, prepared.payload, prepared.paths, () => { wrote = true; }, 'path');
    expect(kind).toBe('path');
    expect(wrote).toBe(true);
    expect(sent).toEqual([]);
    expect(box.data.get('text/plain')).toBe('D:\\notes');
    expect(peekNativeDragSession()).toBeNull();
  });
});
