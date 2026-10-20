import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/renderer/kb', () => ({ kb: {} }));
import { DOC_TAB_MIME, applyDocTabDrag, type DocTabDragPayload } from '../src/renderer/dnd/docTabDrag';
import { isKbDrag, readKbPayload, readKbPayloadJson } from '../src/renderer/dnd/drag';
import { KB_DRAG_MIME } from '../src/renderer/dir-view/dnd';
import { piecesFromTransfer } from '../src/renderer/agent-live/dropIn';
import { commitTreeFileDrag } from '../src/renderer/nativeDrag/commit';
import { commitDocTabDragStart } from '../src/renderer/nativeDrag/docTabStart';
import {
  NATIVE_DRAG_SESSION_MS,
  beginNativeDragSession,
  clearNativeDragSession,
  noteNativeDragDrop,
  noteNativeDragEnd,
  peekNativeDragSession,
} from '../src/renderer/nativeDrag/session';
import { beginFileDrag, dragAgentMaterial, setNativeDragSender, writePathDrag } from '../src/renderer/nativeDrag/start';
import type { DragPayload } from '../src/renderer/dnd/types';
import type { KbDragPayload } from '../src/renderer/dir-view/dnd';

const PAYLOAD: DragPayload = {
  v: 1,
  items: [{
    resourceId: 'res-1',
    sourceKind: 'file',
    from: { kind: 'root', rootId: 'root-1', relPath: '笔记.md' },
    entry: 'file',
    name: '笔记.md',
    rootId: 'root-1',
    relPath: '笔记.md',
  }],
};

const SEED: KbDragPayload = {
  v: 1,
  items: [{
    resourceId: 'res-1',
    sourceKind: 'file',
    from: { kind: 'root', rootId: 'root-1', relPath: '笔记.md' },
    entry: 'file',
    name: '笔记.md',
    rootId: 'root-1',
    relPath: '笔记.md',
  }],
};

const TAB: DocTabDragPayload = {
  v: 1,
  resourceId: 'res-1',
  panelId: 'panel-1',
  itemId: 'panel-1',
  name: '笔记.md',
  absPath: 'D:\\notes\\笔记.md',
  relPath: '笔记.md',
  sourceId: 'root-1',
};

function transfer() {
  const data = new Map<string, string>();
  let effect = '';
  return {
    data,
    dt: {
      setData(type: string, value: string) { data.set(type, value); },
      getData(type: string) { return data.get(type) ?? ''; },
      get effectAllowed() { return effect; },
      set effectAllowed(value: string) { effect = value; },
      types: [] as string[],
    },
  };
}

function filesDt(extra: Record<string, string> = {}): DataTransfer {
  const data = new Map<string, string>(Object.entries(extra));
  const types = ['Files', ...data.keys()];
  return {
    types,
    getData: (type: string) => data.get(type) ?? '',
    setData(type: string, value: string) { data.set(type, value); },
  } as unknown as DataTransfer;
}

afterEach(() => {
  clearNativeDragSession();
  setNativeDragSender(null);
  vi.useRealTimers();
});

describe('原生拖动会话', () => {
  it('存取、过期和清理', () => {
    expect(peekNativeDragSession()).toBeNull();
    beginNativeDragSession({ paths: [' D:\\a.md ', 'D:\\a.md'], kb: PAYLOAD, now: 1_000 });
    const live = peekNativeDragSession(1_000);
    expect(live?.paths).toEqual(['D:\\a.md']);
    expect(live?.kb?.items[0]?.resourceId).toBe('res-1');
    expect(peekNativeDragSession(1_000 + NATIVE_DRAG_SESSION_MS - 1)?.kb).not.toBeNull();
    expect(peekNativeDragSession(1_000 + NATIVE_DRAG_SESSION_MS)).toBeNull();

    beginNativeDragSession({ paths: ['D:\\b.md'], kb: PAYLOAD, now: 5_000 });
    noteNativeDragEnd();
    expect(peekNativeDragSession(5_000)?.paths).toEqual(['D:\\b.md']);
    noteNativeDragEnd();
    expect(peekNativeDragSession()).toBeNull();

    vi.useFakeTimers();
    beginNativeDragSession({ paths: ['D:\\c.md'], kb: PAYLOAD });
    noteNativeDragDrop();
    expect(peekNativeDragSession()?.paths).toEqual(['D:\\c.md']);
    vi.runAllTimers();
    expect(peekNativeDragSession()).toBeNull();
  });
});

describe('文件模式 dragstart', () => {
  it('preventDefault 并发送 IPC，不写 dataTransfer', () => {
    const sent: string[][] = [];
    setNativeDragSender((paths) => { sent.push([...paths]); });
    const box = transfer();
    let prevented = false;
    let wrote = false;
    const kind = commitTreeFileDrag({
      preventDefault: () => { prevented = true; },
      dataTransfer: box.dt,
    }, SEED, ['D:\\notes\\笔记.md'], () => { wrote = true; }, 'file');
    expect(kind).toBe('file');
    expect(prevented).toBe(true);
    expect(wrote).toBe(false);
    expect(box.data.size).toBe(0);
    expect(sent).toEqual([['D:\\notes\\笔记.md']]);
    expect(peekNativeDragSession()?.kb?.items[0]?.resourceId).toBe('res-1');
  });

  it('路径模式不发 IPC，只写 text/plain', () => {
    const sent: string[][] = [];
    setNativeDragSender((paths) => { sent.push([...paths]); });
    const box = transfer();
    let prevented = false;
    let wrote = false;
    const kind = commitTreeFileDrag({
      preventDefault: () => { prevented = true; },
      dataTransfer: box.dt,
    }, SEED, ['D:\\notes\\笔记.md', 'D:\\notes\\笔记.md'], () => {
      wrote = true;
      box.dt.setData(KB_DRAG_MIME, '{"v":1}');
    }, 'path');
    expect(kind).toBe('path');
    expect(prevented).toBe(false);
    expect(wrote).toBe(true);
    expect(sent).toEqual([]);
    expect(box.data.get('text/plain')).toBe('D:\\notes\\笔记.md');
    expect(box.data.get(KB_DRAG_MIME)).toBe('{"v":1}');
    expect(peekNativeDragSession()).toBeNull();
  });

  it('beginFileDrag 没有路径时不阻止默认，资料复制拖出也不写 dataTransfer', () => {
    const sent: string[][] = [];
    setNativeDragSender((paths) => { sent.push([...paths]); });
    let prevented = false;
    expect(beginFileDrag({ preventDefault: () => { prevented = true; } }, [], { kb: PAYLOAD })).toBe(false);
    expect(prevented).toBe(false);
    expect(sent).toEqual([]);

    const box = transfer();
    const nativeSent: string[][] = [];
    let copied = false;
    const kind = dragAgentMaterial({
      event: { preventDefault: () => { prevented = true; }, dataTransfer: box.dt },
      mode: 'file',
      absPath: 'D:\\论文\\实验.md',
      native: true,
      writeCopy: () => { copied = true; },
      sendNative: (files) => { nativeSent.push([...files]); },
    });
    expect(kind).toBe('file');
    expect(copied).toBe(false);
    expect(box.data.size).toBe(0);
    expect(nativeSent).toEqual([['D:\\论文\\实验.md']]);
    expect(peekNativeDragSession()?.kb).toBeNull();
    expect(peekNativeDragSession()?.copyFiles).toEqual(['D:\\论文\\实验.md']);

    clearNativeDragSession();
    const pathBox = transfer();
    const pathSent: string[][] = [];
    writePathDrag(pathBox.dt, ['D:\\notes\\a.md']);
    dragAgentMaterial({
      event: { preventDefault: () => { prevented = true; }, dataTransfer: pathBox.dt },
      mode: 'path',
      absPath: 'D:\\论文\\实验.md',
      native: true,
      writeCopy: (dt) => { dt.setData('application/x-kb-agent-material+json', '{"op":"copy"}'); },
      sendNative: (files) => { pathSent.push([...files]); },
    });
    expect(pathSent).toEqual([]);
    expect(pathBox.data.get('text/plain')).toBe('D:\\论文\\实验.md');
  });
});

describe('Files 与会话', () => {
  it('有会话时返回载荷，无会话时不把 Files 当成应用内拖动', () => {
    const dt = filesDt();
    expect(isKbDrag(dt)).toBe(false);
    expect(readKbPayload(dt)).toBeNull();
    expect(readKbPayloadJson(dt)).toBe('');

    beginNativeDragSession({ paths: ['D:\\notes\\笔记.md'], kb: PAYLOAD, now: 10 });
    expect(isKbDrag(dt, 10)).toBe(true);
    expect(readKbPayload(dt, 10)?.items[0]?.resourceId).toBe('res-1');
    expect(readKbPayloadJson(dt, 10)).toContain('res-1');
    beginNativeDragSession({ paths: ['D:\\notes\\笔记.md'], kb: PAYLOAD });
    const pieces = piecesFromTransfer(['Files'], () => '', dt);
    expect(pieces.map((piece) => piece.ref?.resourceId)).toEqual(['res-1']);
    beginNativeDragSession({ paths: ['D:\\notes\\笔记.md'], kb: PAYLOAD, now: 10 });

    expect(isKbDrag(dt, 10 + NATIVE_DRAG_SESSION_MS)).toBe(false);
    expect(readKbPayload(dt, 10 + NATIVE_DRAG_SESSION_MS)).toBeNull();

    beginNativeDragSession({ paths: ['D:\\论文\\实验.md'], kb: null, copyFiles: ['D:\\论文\\实验.md'] });
    expect(isKbDrag(dt)).toBe(false);
    expect(readKbPayload(dt)).toBeNull();
    expect(piecesFromTransfer(['Files'], () => 'should-not-read', dt).map((piece) => piece.ref?.absPath)).toEqual(['D:\\论文\\实验.md']);
  });

  it('有自定义 MIME 时不用会话', () => {
    beginNativeDragSession({
      paths: ['D:\\other.md'],
      kb: { v: 1, items: [{ ...PAYLOAD.items[0]!, resourceId: 'other' }] },
      now: 30,
    });
    const raw = JSON.stringify(PAYLOAD);
    const dt = {
      types: ['application/x-kb-resource+json', 'Files'],
      getData: (type: string) => (type === 'application/x-kb-resource+json' ? raw : ''),
    } as unknown as DataTransfer;
    expect(readKbPayload(dt, 30)?.items[0]?.resourceId).toBe('res-1');
    expect(isKbDrag(dt, 30)).toBe(true);
  });
});

describe('Alt 标签拖出', () => {
  it('按住 Alt 才原生拖出；松开和路径模式保持 HTML5', () => {
    const sent: string[][] = [];
    setNativeDragSender((paths) => { sent.push([...paths]); });

    const nativeBox = transfer();
    let prevented = false;
    const native = commitDocTabDragStart({
      event: { altKey: true, preventDefault: () => { prevented = true; }, dataTransfer: nativeBox.dt },
      payload: TAB,
      mode: 'file',
      absPath: TAB.absPath!,
      native: true,
      writeTab: applyDocTabDrag,
    });
    expect(native).toBe('native');
    expect(prevented).toBe(true);
    expect(nativeBox.data.has(DOC_TAB_MIME)).toBe(false);
    expect(sent).toEqual([[TAB.absPath]]);
    expect(peekNativeDragSession()?.kb?.items[0]?.resourceId).toBe('res-1');

    clearNativeDragSession();
    const plain = transfer();
    prevented = false;
    const html5 = commitDocTabDragStart({
      event: { altKey: false, preventDefault: () => { prevented = true; }, dataTransfer: plain.dt },
      payload: TAB,
      mode: 'file',
      absPath: TAB.absPath!,
      native: true,
      writeTab: applyDocTabDrag,
    });
    expect(html5).toBe('html5');
    expect(prevented).toBe(false);
    expect(plain.data.get(DOC_TAB_MIME)).toContain('res-1');
    expect(sent).toEqual([[TAB.absPath]]);

    const pathBox = transfer();
    const before = sent.length;
    const path = commitDocTabDragStart({
      event: { altKey: true, preventDefault: () => { prevented = true; }, dataTransfer: pathBox.dt },
      payload: TAB,
      mode: 'path',
      absPath: TAB.absPath!,
      native: true,
      writeTab: applyDocTabDrag,
    });
    expect(path).toBe('path');
    expect(pathBox.data.get(DOC_TAB_MIME)).toContain('res-1');
    expect(pathBox.data.get('text/plain')).toBe(TAB.absPath);
    expect(sent.length).toBe(before);
  });
});
