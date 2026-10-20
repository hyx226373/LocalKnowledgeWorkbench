/**
 * 分类改名：隐藏规则只盖住 radio。点「编辑」后输入框可见、值为原名，改成「示例分类」后保存。
 * 左侧「分类」小标题仍是固定文字。
 *
 * 不用 vitest 的 jsdom 环境（本机 vitest 包不在本仓库 node_modules 里，解析不到 jsdom）。
 * 测例自己挂上本仓库的 jsdom，结束时还原全局，避免污染后面的 node 测例。
 */
import { createRequire } from 'node:module';
import module from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { OverviewBoards } from '../../src/shared/workspacePicker/overviewBoards';
import type { OverviewEntryInput } from '../../src/shared/workspacePicker/overview';

type MountedRoot = { render: (node: unknown) => void; unmount: () => void };
type JsDomInstance = { window: Window & typeof globalThis };
type JsDomCtor = new (html: string, options?: { url?: string; pretendToBeVisual?: boolean }) => JsDomInstance;

/** 非字面量动态导入。本仓库 react / jsdom 没有声明文件，字面量 import() 会多出 TS7016。 */
function loadModule(spec: string): Promise<Record<string, any>> {
  return import(spec);
}

/**
 * 本仓库顶层 lru-cache 是 v6（默认导出构造函数），jsdom 29 要的是 v11 的具名导出 LRUCache。
 * 只在 jsdom 自己 require 时补一个只用 get/set 的缓存，不改其它包拿到的 lru-cache。
 */
const Module = module.Module;
const originalRequire = Module.prototype.require;
Module.prototype.require = function patchedRequire(this: NodeModule, id: string) {
  if (id === 'lru-cache' && String(this.filename || '').includes(`${path.sep}jsdom${path.sep}`)) {
    return {
      LRUCache: class LRUCache {
        private readonly store = new Map<unknown, unknown>();
        get(key: unknown): unknown { return this.store.get(key); }
        set(key: unknown, value: unknown): this { this.store.set(key, value); return this; }
      },
    };
  }
  return originalRequire.apply(this, arguments as unknown as [string]);
};

const require = createRequire(import.meta.url);
/** jsdom 不在 package.json 里。解析不到时跳过 DOM 用例，只跑 CSS 断言，不算新增失败。 */
const HAS_JSDOM = (() => {
  try {
    require.resolve('jsdom');
    return true;
  } catch {
    return false;
  }
})();
const JSDOM = HAS_JSDOM ? (require('jsdom') as { JSDOM: JsDomCtor }).JSDOM : null;

const ORIGINAL = '课程';
const RENAMED = '示例分类';

const previous = new Map<string, PropertyDescriptor | null>();
const dom = JSDOM
  ? new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
      url: 'http://127.0.0.1/',
      pretendToBeVisual: true,
    })
  : null;
const win = dom?.window as Window & typeof globalThis;

function remember(key: string): void {
  if (previous.has(key)) return;
  previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key) ?? null);
}

function adoptDom(): void {
  const g = globalThis as Record<string, unknown>;
  const assign = (key: string, value: unknown) => {
    remember(key);
    try {
      g[key] = value;
      return;
    } catch { /* Electron 把 navigator 做成只读 getter */ }
    Object.defineProperty(g, key, { configurable: true, writable: true, value });
  };
  assign('window', win);
  assign('document', win.document);
  assign('navigator', win.navigator);
  assign('HTMLElement', win.HTMLElement);
  assign('HTMLInputElement', win.HTMLInputElement);
  assign('HTMLLabelElement', win.HTMLLabelElement);
  assign('HTMLButtonElement', win.HTMLButtonElement);
  assign('Element', win.Element);
  assign('Node', win.Node);
  assign('Text', win.Text);
  assign('Comment', win.Comment);
  assign('Document', win.Document);
  assign('DocumentFragment', win.DocumentFragment);
  assign('SVGElement', win.SVGElement);
  assign('Event', win.Event);
  assign('MouseEvent', win.MouseEvent);
  assign('KeyboardEvent', win.KeyboardEvent);
  assign('InputEvent', win.InputEvent);
  assign('FocusEvent', win.FocusEvent);
  assign('getComputedStyle', win.getComputedStyle.bind(win));
  assign('requestAnimationFrame', (cb: FrameRequestCallback) => win.setTimeout(() => cb(Date.now()), 16));
  assign('cancelAnimationFrame', (id: number) => win.clearTimeout(id));
  assign('MutationObserver', win.MutationObserver);
  assign('DOMParser', win.DOMParser);
  assign('Range', win.Range);
  assign('NodeFilter', win.NodeFilter);
  assign('IS_REACT_ACT_ENVIRONMENT', true);
}

if (HAS_JSDOM) adoptDom();

const react = await loadModule('react');
const client = await loadModule('react-dom/client');
const view = await loadModule('../../src/renderer/workspace-picker/WorkspaceOverview');
const act = react.act as (fn: () => void | Promise<void>) => Promise<void>;
const createElement = react.createElement as (type: unknown, props?: unknown) => unknown;
const createRoot = client.createRoot as (container: unknown) => MountedRoot;
const WorkspaceOverview = view.WorkspaceOverview as (props: unknown) => unknown;

const entry: OverviewEntryInput = {
  summary: {
    id: 'ws-1',
    name: '英语',
    purpose: '',
    tags: [],
    project: '',
    favorite: false,
    lastUsedAt: 1,
    counts: { files: 1, webs: 0, apps: 0, panels: 1 },
    icon: null,
    accent: null,
    coverRef: null,
    thumbVersion: 0,
  },
  thumb: { cacheKey: 'ws-1', aspect: 1.6, nodes: [] },
};

function boardsNamed(name: string): OverviewBoards {
  return {
    v: 1,
    projects: [],
    tags: [],
    allOrder: [],
    favoriteOrder: [],
    categories: [{ id: 'c-1', name, workspaceIds: [] }],
  };
}

function cssText(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), 'utf8');
}

function installOverviewCss(): void {
  const style = win.document.createElement('style');
  style.setAttribute('data-testid', 'overview-rename-css');
  style.textContent = [
    cssText('src/renderer/workspace-picker/overview.css'),
    cssText('src/renderer/ui/overview-preview.css'),
  ].join('\n');
  win.document.head.appendChild(style);
}

afterAll(() => {
  Module.prototype.require = originalRequire;
  for (const [key, desc] of previous) {
    if (!desc) {
      try { delete (globalThis as Record<string, unknown>)[key]; } catch { /* 宿主不让删 */ }
      continue;
    }
    try { Object.defineProperty(globalThis, key, desc); } catch { /* 还原失败就留下测试 DOM */ }
  }
  win?.close();
});

describe('分类改名输入框', () => {
  let root: MountedRoot | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(() => {
    if (!HAS_JSDOM) return;
    if (root) act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    win.document.querySelector('[data-testid="overview-rename-css"]')?.remove();
    vi.restoreAllMocks();
  });

  it('隐藏规则只匹配 radio，改名框不再被盖住', () => {
    const overview = cssText('src/renderer/workspace-picker/overview.css');
    const preview = cssText('src/renderer/ui/overview-preview.css');
    expect(overview).toContain('.kb-ws-overview-nav-item input[type="radio"]');
    expect(overview).not.toMatch(/\.kb-ws-overview-nav-item input\s*\{/);
    expect(preview).toContain('.kb-ws-overview label.ov-item input[type="radio"]');
    expect(preview).not.toMatch(/label\.ov-item input\s*\{/);
    expect(overview).toContain('.kb-ws-overview .ov-cat-input');
  });

  it.skipIf(!HAS_JSDOM)('点编辑后输入框可见且值为原名，改成示例分类后保存成功', async () => {
    installOverviewCss();
    const onBoardsChange = vi.fn<(next: OverviewBoards) => void>();
    const select = vi.spyOn(win.HTMLInputElement.prototype, 'select');
    const mount = win.document.createElement('div');
    host = mount;
    win.document.body.appendChild(mount);
    root = createRoot(mount);
    await act(async () => {
      root?.render(createElement(WorkspaceOverview, {
        entries: [entry],
        currentId: 'ws-1',
        boards: boardsNamed(ORIGINAL),
        onBoardsChange,
      }));
    });

    const heading = mount.querySelector('.kb-ws-overview-cats-head');
    expect(heading?.querySelector('span')?.textContent).toBe('分类');
    expect(heading?.querySelector('input')).toBeNull();

    const label = mount.querySelector('label[data-category-id="cat:c-1"]');
    expect(label).toBeInstanceOf(win.HTMLLabelElement);
    expect((label as HTMLLabelElement).htmlFor).toBe('overview-filter-cat:c-1');
    const radio = label?.querySelector('input[type="radio"]');
    expect(radio).toBeInstanceOf(win.HTMLInputElement);
    expect((radio as HTMLInputElement).matches('.kb-ws-overview-nav-item input[type="radio"]')).toBe(true);
    expect(win.getComputedStyle(radio as Element).opacity).toBe('0');
    expect(win.getComputedStyle(radio as Element).pointerEvents).toBe('none');

    await act(async () => {
      label?.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 24, clientY: 32 }));
    });
    const edit = mount.querySelector('button[data-action="edit-category"]');
    expect(edit).toBeInstanceOf(win.HTMLButtonElement);
    expect((edit as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      (edit as HTMLButtonElement).click();
    });

    const input = mount.querySelector('input[data-field="category-name"]');
    expect(input).toBeInstanceOf(win.HTMLInputElement);
    const name = input as HTMLInputElement;
    expect(name.type).toBe('text');
    expect(name.className).toContain('ov-cat-input');
    expect(name.value).toBe(ORIGINAL);
    expect(name.matches('.kb-ws-overview-nav-item input[type="radio"]')).toBe(false);
    expect(name.matches('.kb-ws-overview label.ov-item input[type="radio"]')).toBe(false);
    const shown = win.getComputedStyle(name);
    expect(shown.opacity).not.toBe('0');
    expect(shown.pointerEvents).not.toBe('none');
    expect(shown.position).not.toBe('absolute');
    expect(win.document.activeElement).toBe(name);
    expect(select).toHaveBeenCalled();
    expect(name.selectionStart).toBe(0);
    expect(name.selectionEnd).toBe(ORIGINAL.length);

    await act(async () => {
      name.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      name.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(mount.querySelector('input[data-field="category-name"]')).toBe(name);
    expect(win.document.activeElement).toBe(name);
    expect(onBoardsChange).not.toHaveBeenCalled();

    const setValue = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')?.set;
    expect(setValue).toBeTypeOf('function');
    await act(async () => {
      setValue?.call(name, RENAMED);
      name.dispatchEvent(new win.Event('input', { bubbles: true }));
    });
    expect(name.value).toBe(RENAMED);

    await act(async () => {
      name.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onBoardsChange).toHaveBeenCalledTimes(1);
    expect(onBoardsChange.mock.calls[0]?.[0].categories?.[0]).toEqual({
      id: 'c-1',
      name: RENAMED,
      workspaceIds: [],
    });
    expect(mount.querySelector('input[data-field="category-name"]')).toBeNull();
    expect(mount.querySelector('label[data-category-id="cat:c-1"] .ov-item-label')?.textContent).toBe(ORIGINAL);
  });
});
