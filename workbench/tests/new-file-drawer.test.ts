import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { DirEntry, Root } from '../src/shared/types';
import type { BlankFileCreated } from '../src/shared/blankFile';

const bridge = vi.hoisted(() => ({
  useState: (initial: unknown) => [initial, (_value: unknown) => undefined] as [unknown, (value: unknown) => void],
  useEffect: (_fn: () => void | (() => void), _deps?: unknown[]) => undefined,
  useRef: (initial: unknown) => ({ current: initial }),
}));

const kbState = vi.hoisted(() => ({
  listDir: vi.fn(async (_rootId: string, _relPath: string): Promise<DirEntry[]> => []),
  listRoots: vi.fn(async (): Promise<Root[]> => []),
  resourceAbsPath: vi.fn(async (_id: string) => ''),
  createBlankFile: vi.fn(async (_input?: { dir: string; name: string; ext: string }): Promise<BlankFileCreated> => ({
    resourceId: 'made',
    rootId: 'r1',
    name: '笔记.md',
    absPath: '/data/root/笔记.md',
    placed: 'indexed',
    expandIds: ['r1'],
  })),
  pickFolder: vi.fn(async () => '/should-not-open'),
}));

vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>();
  return {
    ...actual,
    useState: (initial: unknown) => bridge.useState(initial),
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => bridge.useEffect(fn, deps),
    useRef: (initial: unknown) => bridge.useRef(initial),
  };
});

vi.mock('../src/renderer/kb', () => ({
  kb: {
    listDir: (rootId: string, relPath: string) => kbState.listDir(rootId, relPath),
    listRoots: () => kbState.listRoots(),
    resourceAbsPath: (id: string) => kbState.resourceAbsPath(id),
    createBlankFile: (input: { dir: string; name: string; ext: 'md' | 'txt' }) => kbState.createBlankFile(input),
    pickFolder: () => kbState.pickFolder(),
  },
}));

import { NewFileDrawer } from '../src/renderer/dir-view/newFileDrawer';

const OURS = new Set(['NewFileDrawer', 'RootBranch', 'FolderLevel', 'FolderNode', 'FolderRow']);

type Fx = {
  deps: unknown[] | undefined;
  fn: () => void | (() => void);
  cleanup?: () => void;
  dirty: boolean;
};
type Box = { states: unknown[]; refs: { current: unknown }[]; effects: Fx[] };
const boxes = new Map<string, Box>();

function install(box: Box) {
  let si = 0;
  let ri = 0;
  let ei = 0;
  bridge.useState = (initial: unknown) => {
    const idx = si++;
    if (box.states.length <= idx) box.states[idx] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    return [box.states[idx], (value: unknown) => {
      box.states[idx] = typeof value === 'function' ? (value as (prev: unknown) => unknown)(box.states[idx]) : value;
    }];
  };
  bridge.useRef = (initial: unknown) => {
    const idx = ri++;
    if (box.refs.length <= idx) box.refs[idx] = { current: initial };
    return box.refs[idx];
  };
  bridge.useEffect = (fn, deps) => {
    const idx = ei++;
    const prev = box.effects[idx];
    const same = !!prev && !!deps && !!prev.deps && deps.length === prev.deps.length && deps.every((dep, i) => Object.is(dep, prev.deps![i]));
    if (same) box.effects[idx] = { ...prev, dirty: false };
    else box.effects[idx] = { deps, fn, cleanup: prev?.cleanup, dirty: true };
  };
}

function callComponent(type: (props: Record<string, unknown>) => unknown, props: Record<string, unknown>, id: string) {
  let box = boxes.get(id);
  if (!box) {
    box = { states: [], refs: [], effects: [] };
    boxes.set(id, box);
  }
  install(box);
  return type(props);
}

function childrenOf(children: unknown): unknown[] {
  if (children == null || typeof children === 'boolean') return [];
  return Array.isArray(children) ? children : [children];
}

function expand(node: unknown, path: string): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap((child, index) => expand(child, `${path}/${index}`));
  if (!node || typeof node !== 'object') return [];
  const element = node as ReactElement<Record<string, unknown>>;
  const type = element.type;
  if (typeof type === 'function' && OURS.has(type.name)) {
    const id = `${path}/${type.name}`;
    const inner = callComponent(type as (props: Record<string, unknown>) => unknown, element.props ?? {}, id);
    return [element, ...expand(inner, id)];
  }
  return [element, ...childrenOf(element.props?.children).flatMap((child, index) => expand(child, `${path}/${index}`))];
}

function render(props: Record<string, unknown>) {
  return expand({ type: NewFileDrawer, props, key: null } as ReactElement<Record<string, unknown>>, 'root');
}

async function flush() {
  const pending: Fx[] = [];
  for (const box of boxes.values()) {
    for (const fx of box.effects) if (fx.dirty) pending.push(fx);
  }
  for (const fx of pending) {
    fx.cleanup?.();
    const cleanup = fx.fn();
    fx.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
    fx.dirty = false;
  }
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function clickEvent() {
  return { preventDefault() {}, stopPropagation() {} };
}

function callProp(node: ReactElement<Record<string, unknown>> | undefined, prop: string, arg?: unknown) {
  const fn = node?.props[prop];
  if (typeof fn !== 'function') throw new Error(`缺少 ${prop}`);
  return fn(arg);
}

function rootOf(partial: Pick<Root, 'id' | 'name' | 'path' | 'resourceId' | 'kind' | 'status'>): Root {
  return { workspaceRootId: partial.id, sourceId: partial.id, createdAt: 0, ...partial };
}

function entry(partial: Pick<DirEntry, 'resourceId' | 'rootId' | 'relPath' | 'name' | 'kind'>): DirEntry {
  return { size: 0, mtimeMs: 0, ext: partial.kind === 'file' ? 'md' : '', ...partial };
}

const folderRoot = rootOf({ id: 'r1', name: '资料库', path: '/data/root', resourceId: 'res-root', kind: 'folder', status: 'ok' });
const fileRoot = rootOf({ id: 'file-1', name: '单文件.md', path: '/data/solo.md', resourceId: 'res-file', kind: 'file', status: 'ok' });
const missingRoot = rootOf({ id: 'gone', name: '离线', path: '/missing', resourceId: 'res-gone', kind: 'folder', status: 'missing' });

beforeEach(() => {
  boxes.clear();
  kbState.listDir.mockReset();
  kbState.listRoots.mockReset();
  kbState.resourceAbsPath.mockReset();
  kbState.createBlankFile.mockReset();
  kbState.createBlankFile.mockImplementation(async () => ({
    resourceId: 'made',
    rootId: 'r1',
    name: '笔记.md',
    absPath: '/data/root/笔记.md',
    placed: 'indexed',
    expandIds: ['r1'],
  }));
  kbState.pickFolder.mockReset();
  kbState.resourceAbsPath.mockImplementation(async (id: string) => {
    if (id === 'res-root') return '/data/root';
    if (id === 'res-note') return '/data/root/笔记';
    if (id === 'res-sub') return '/data/root/笔记/随笔';
    return '';
  });
  kbState.listDir.mockImplementation(async (rootId: string, relPath: string) => {
    if (rootId !== 'r1') return [];
    if (relPath === '') {
      return [
        entry({ resourceId: 'res-note', rootId, relPath: '笔记', name: '笔记', kind: 'dir' }),
        entry({ resourceId: 'res-proj', rootId, relPath: '项目', name: '项目', kind: 'dir' }),
        entry({ resourceId: 'res-md', rootId, relPath: 'readme.md', name: 'readme.md', kind: 'file' }),
      ];
    }
    if (relPath === '笔记') {
      return [entry({ resourceId: 'res-sub', rootId, relPath: '笔记/随笔', name: '随笔', kind: 'dir' })];
    }
    return [];
  });
});

it('抽屉先只列根下第一层文件夹，展开箭头才加载下一层，点名称才选中', async () => {
  const onCreated = vi.fn();
  let view = render({ roots: [fileRoot, missingRoot, folderRoot], onCancel: () => undefined, onCreated });
  await flush();
  view = render({ roots: [fileRoot, missingRoot, folderRoot], onCancel: () => undefined, onCreated });

  expect(kbState.listDir.mock.calls).toEqual([['r1', '']]);
  expect(kbState.pickFolder).not.toHaveBeenCalled();
  const rows = view.filter((node) => node.props['data-testid'] === 'new-file-folder-row');
  expect(rows.map((node) => node.props['data-relpath'])).toEqual(['', '笔记', '项目']);
  expect(rows.map((node) => node.props['data-depth'])).toEqual([0, 1, 1]);
  expect(view.some((node) => node.props['data-relpath'] === '笔记/随笔')).toBe(false);
  expect(view.some((node) => String(node.props.children ?? '').includes('readme.md') || node.props['data-relpath'] === 'readme.md')).toBe(false);
  expect(view.some((node) => node.props['data-root-id'] === 'file-1' || node.props['data-root-id'] === 'gone')).toBe(false);

  const expandNote = view.find((node) => node.props['data-testid'] === 'new-file-folder-expand' && node.props['data-relpath'] === '笔记');
  expect(expandNote?.props['aria-expanded']).toBe(false);
  callProp(expandNote, 'onClick', clickEvent());
  view = render({ roots: [fileRoot, missingRoot, folderRoot], onCancel: () => undefined, onCreated });
  await flush();
  view = render({ roots: [fileRoot, missingRoot, folderRoot], onCancel: () => undefined, onCreated });

  expect(kbState.listDir.mock.calls).toEqual([['r1', ''], ['r1', '笔记']]);
  expect(view.some((node) => node.props['data-relpath'] === '笔记/随笔')).toBe(true);
  expect(kbState.listDir.mock.calls.some((call) => call[1] === '笔记/随笔')).toBe(false);
  const noteRow = view.find((node) => node.props['data-testid'] === 'new-file-folder-row' && node.props['data-relpath'] === '笔记');
  expect(noteRow?.props['aria-selected']).toBe('false');
  expect(view.find((node) => node.props['data-testid'] === 'new-file-dir')?.props.value).toBe('');

  const noteName = view.find((node) => node.props['data-testid'] === 'new-file-folder-name' && node.props['data-relpath'] === '笔记');
  callProp(noteName, 'onClick', clickEvent());
  await flush();
  view = render({ roots: [fileRoot, missingRoot, folderRoot], onCancel: () => undefined, onCreated });
  expect(view.find((node) => node.props['data-testid'] === 'new-file-folder-row' && node.props['data-relpath'] === '笔记')?.props['aria-selected']).toBe('true');
  expect(view.find((node) => node.props['data-testid'] === 'new-file-dir')?.props.value).toBe('/data/root/笔记');
  expect(kbState.listDir.mock.calls).toEqual([['r1', ''], ['r1', '笔记']]);

  callProp(view.find((node) => node.props['data-testid'] === 'new-file-name'), 'onChange', { target: { value: '周记' } });
  view = render({ roots: [fileRoot, missingRoot, folderRoot], onCancel: () => undefined, onCreated });
  const ok = view.find((node) => node.props['data-testid'] === 'new-file-ok');
  expect(ok?.props.disabled).toBe(false);
  await callProp(ok, 'onClick', clickEvent());
  expect(kbState.createBlankFile).toHaveBeenCalledWith({ dir: '/data/root/笔记', name: '周记', ext: 'md' });
  expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ resourceId: 'made', name: '笔记.md' }));
  expect(kbState.pickFolder).not.toHaveBeenCalled();
});

it('点根目录名称选中根本身，空目录不继续请求子层', async () => {
  kbState.listDir.mockImplementation(async () => []);
  const onCreated = vi.fn();
  render({ roots: [folderRoot], onCancel: () => undefined, onCreated });
  await flush();
  let view = render({ roots: [folderRoot], onCancel: () => undefined, onCreated });
  expect(view.some((node) => node.props['data-testid'] === 'new-file-folder-empty' && node.props['data-relpath'] === '')).toBe(true);
  expect(kbState.listDir.mock.calls).toEqual([['r1', '']]);
  callProp(view.find((node) => node.props['data-testid'] === 'new-file-folder-name' && node.props['data-relpath'] === ''), 'onClick', clickEvent());
  await flush();
  view = render({ roots: [folderRoot], onCancel: () => undefined, onCreated });
  expect(view.find((node) => node.props['data-testid'] === 'new-file-dir')?.props.value).toBe('/data/root');
  expect(view.find((node) => node.props['data-testid'] === 'new-file-folder-row' && node.props['data-relpath'] === '')?.props['aria-selected']).toBe('true');
});

it('导出到根目录模式：支持 initialName, fixedExt, submitText, 且 onSubmit 失败时在抽屉显示错误', async () => {
  const onSubmit = vi.fn().mockRejectedValue(new Error('不能在应用数据目录里新建文件'));
  let view = render({
    roots: [folderRoot],
    title: '导出到根目录',
    submitText: '导出',
    initialName: 'R1-设计方案.md',
    fixedExt: 'md',
    onCancel: () => undefined,
    onSubmit,
  });
  await flush();
  view = render({
    roots: [folderRoot],
    title: '导出到根目录',
    submitText: '导出',
    initialName: 'R1-设计方案.md',
    fixedExt: 'md',
    onCancel: () => undefined,
    onSubmit,
  });

  const drawer = view.find((node) => node.props['data-testid'] === 'new-file-drawer');
  expect(drawer?.props['aria-label']).toBe('导出到根目录');

  const nameInput = view.find((node) => node.props['data-testid'] === 'new-file-name');
  expect(nameInput?.props.value).toBe('R1-设计方案.md');

  const extSelect = view.find((node) => node.props['data-testid'] === 'new-file-ext');
  expect(extSelect?.props.disabled).toBe(true);
  expect(extSelect?.props.value).toBe('md');

  // 选中根目录
  callProp(view.find((node) => node.props['data-testid'] === 'new-file-folder-name' && node.props['data-relpath'] === ''), 'onClick', clickEvent());
  await flush();
  view = render({
    roots: [folderRoot],
    title: '导出到根目录',
    submitText: '导出',
    initialName: 'R1-设计方案.md',
    fixedExt: 'md',
    onCancel: () => undefined,
    onSubmit,
  });

  const ok = view.find((node) => node.props['data-testid'] === 'new-file-ok');
  expect(ok?.props.children).toBe('导出');
  expect(ok?.props.disabled).toBe(false);

  // 点击导出触发 onSubmit
  await callProp(ok, 'onClick', clickEvent());
  expect(onSubmit).toHaveBeenCalledWith({ dir: '/data/root', name: 'R1-设计方案.md', ext: 'md' });
  expect(kbState.createBlankFile).not.toHaveBeenCalled();

  // 重新渲染显示错误
  view = render({
    roots: [folderRoot],
    title: '导出到根目录',
    submitText: '导出',
    initialName: 'R1-设计方案.md',
    fixedExt: 'md',
    onCancel: () => undefined,
    onSubmit,
  });
  const err = view.find((node) => node.props['data-testid'] === 'new-file-error');
  expect(err?.props.children).toContain('不能在应用数据目录里新建文件');
});
