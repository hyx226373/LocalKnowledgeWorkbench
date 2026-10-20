/**
 * 插件开关两处：关掉「网络资料」后侧栏区块和「添加」整块消失；关掉「通用网页」后已打开的直链面板立刻变成不可用占位，重新打开可以重载。
 * SidebarPlugins 仍排除 web.resources，避免和抽屉 slot 各画一份。
 */
import { readFileSync } from 'node:fs';
import { createElement, act, type ComponentType } from 'react';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { permissionDeclHash } from '../src/shared/adapter-sdk/policy';
import { HOST_API_VERSION } from '../src/shared/hostApi';
import type { AdapterPluginDto } from '../src/shared/pluginIpc';
import type { AdapterPluginManifest, PermissionGrant } from '../src/shared/adapter-sdk/types';
import type { ResourceInfo } from '../src/shared/types';
import type { FetchCacheResult, WebResource } from '../src/shared/webResources';
import type { PluginModule } from '../src/renderer/plugin-host/types';

const kbState = vi.hoisted(() => ({
  registerPlugin: vi.fn(async (id: string, version: string) => ({ id, version, source: 'builtin' as const, enabled: true, granted: [] as unknown[], installedAt: 1 })),
  setPluginEnabled: vi.fn(async () => undefined),
  setAdapterPluginEnabled: vi.fn(async () => undefined),
  listAdapterPlugins: vi.fn(async () => [] as AdapterPluginDto[]),
  webResourceList: vi.fn(async () => [] as WebResource[]),
  onWebResourcesChange: vi.fn(() => () => undefined),
  webResourceAdd: vi.fn(async (input: { url: string }) => ({ resourceId: 'res-1', url: input.url })),
  webFetchCache: vi.fn(async (_id: string, _opts?: { force?: boolean }): Promise<FetchCacheResult> => {
    throw new Error('webFetchCache 未准备');
  }),
  getResource: vi.fn(async (_id: string): Promise<ResourceInfo | null> => null),
}));

vi.mock('../src/renderer/kb', () => ({ kb: kbState }));

class DomNode {
  nodeType: number;
  nodeName: string;
  parentNode: DomNode | null = null;
  childNodes: DomNode[] = [];
  ownerDocument: Doc;
  nodeValue: string | null;
  constructor(doc: Doc, nodeType: number, nodeName: string, nodeValue: string | null = null) {
    this.ownerDocument = doc;
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.nodeValue = nodeValue;
  }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling(): DomNode | null {
    const kids = this.parentNode?.childNodes;
    if (!kids) return null;
    const i = kids.indexOf(this);
    return i >= 0 ? (kids[i + 1] ?? null) : null;
  }
  get textContent(): string {
    if (this.nodeType === 3 || this.nodeType === 8) return this.nodeValue ?? '';
    return this.childNodes.map((child) => child.textContent).join('');
  }
  set textContent(value: string) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    if (value) this.appendChild(this.ownerDocument.createTextNode(value));
  }
  appendChild<T extends DomNode>(child: T): T {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  insertBefore<T extends DomNode>(child: T, ref: DomNode | null): T {
    if (!ref) return this.appendChild(child);
    if (child.parentNode) child.parentNode.removeChild(child);
    const at = this.childNodes.indexOf(ref);
    child.parentNode = this;
    if (at < 0) this.childNodes.push(child);
    else this.childNodes.splice(at, 0, child);
    return child;
  }
  removeChild<T extends DomNode>(child: T): T {
    const at = this.childNodes.indexOf(child);
    if (at >= 0) this.childNodes.splice(at, 1);
    child.parentNode = null;
    return child;
  }
  contains(node: DomNode | null): boolean {
    let cur = node;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }
  addEventListener() {}
  removeEventListener() {}
}

class DomEl extends DomNode {
  tagName: string;
  namespaceURI = 'http://www.w3.org/1999/xhtml';
  attrs = new Map<string, string>();
  dataset: Record<string, string> = {};
  classList = {
    toggle: (name: string, force?: boolean) => {
      const on = force ?? !this.classList.contains(name);
      if (on) this.classList.add(name);
      else this.classList.remove(name);
      return on;
    },
    add: (...names: string[]) => { for (const name of names) this.attrs.set('class', `${this.getAttribute('class') ?? ''} ${name}`.trim()); },
    remove: (name: string) => { this.attrs.set('class', (this.getAttribute('class') ?? '').split(/\s+/).filter((part) => part && part !== name).join(' ')); },
    contains: (name: string) => (this.getAttribute('class') ?? '').split(/\s+/).includes(name),
  };
  style = { setProperty() {}, getPropertyValue: () => '', removeProperty: () => '' };
  onclick: (() => void) | null = null;
  constructor(doc: Doc, tag: string) {
    super(doc, 1, tag.toUpperCase());
    this.tagName = tag.toUpperCase();
  }
  setAttribute(name: string, value: unknown) { this.attrs.set(name, String(value)); }
  getAttribute(name: string) { return this.attrs.has(name) ? this.attrs.get(name)! : null; }
  removeAttribute(name: string) { this.attrs.delete(name); }
  hasAttribute(name: string) { return this.attrs.has(name); }
  setAttributeNS(_ns: string, name: string, value: unknown) { this.setAttribute(name, value); }
  set innerHTML(_value: string) { this.textContent = ''; }
  get innerHTML() { return this.textContent; }
}

class Doc extends DomNode {
  documentElement: DomEl;
  body: DomEl;
  head: DomEl;
  activeElement: DomEl | null = null;
  defaultView: unknown;
  constructor() {
    super(null as unknown as Doc, 9, '#document');
    this.ownerDocument = this;
    this.documentElement = new DomEl(this, 'html');
    this.head = new DomEl(this, 'head');
    this.body = new DomEl(this, 'body');
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.defaultView = null;
    this.activeElement = this.body;
  }
  createElement(tag: string) { return new DomEl(this, tag); }
  createElementNS(_ns: string, tag: string) { return new DomEl(this, tag); }
  createTextNode(text: string) { return new DomNode(this, 3, '#text', String(text)); }
  createComment(text: string) { return new DomNode(this, 8, '#comment', String(text)); }
}

function installDom() {
  // pdfjs-dist 在模块初始化时读 Iterator.prototype（Node 20 还没有这个全局）。
  const g = globalThis as { Iterator?: unknown };
  if (typeof g.Iterator !== 'function') g.Iterator = class {};
  const doc = new Doc();
  const win = {
    document: doc,
    navigator: { userAgent: 'node', language: 'zh-CN' },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number,
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    getSelection: () => null,
    HTMLElement: class HTMLElement {},
    HTMLIFrameElement: class HTMLIFrameElement {},
    Node: DomNode,
    Element: DomEl,
    Document: Doc,
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };
  doc.defaultView = win;
  // Electron（ELECTRON_RUN_AS_NODE）里 navigator 等是不可写 getter，赋值会抛。能写的才换上测试 DOM。
  const globals: Record<string, unknown> = {
    window: win,
    document: doc,
    navigator: win.navigator,
    MutationObserver: win.MutationObserver,
    matchMedia: win.matchMedia,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(globals)) {
    try {
      (globalThis as Record<string, unknown>)[key] = value;
    } catch {
      /* 只读全局留着宿主自己的 */
    }
  }
  return doc;
}

function elements(root: DomNode): DomEl[] {
  const out: DomEl[] = [];
  const visit = (node: DomNode) => {
    if (node instanceof DomEl) out.push(node);
    for (const child of node.childNodes) visit(child);
  };
  visit(root);
  return out;
}

function byTestId(root: DomNode, id: string): DomEl[] {
  return elements(root).filter((el) => el.getAttribute('data-testid') === id);
}

const CACHED: WebResource = {
  resourceId: 'res-1',
  url: 'https://example.com/a.pdf',
  title: 'a.pdf',
  contentType: 'application/pdf',
  adapterId: 'web.file',
  ext: 'pdf',
  addedAt: 1,
  lastOpenedAt: 1,
  favorite: false,
  favoriteAt: null,
  cached: true,
  cacheBytes: 12,
  cachedAt: 1,
  host: 'example.com',
};

const FILE: ResourceInfo = {
  resourceId: 'res-1',
  rootId: 'web-cache',
  relPath: 'a.pdf',
  name: 'a.pdf',
  kind: 'file',
  size: 12,
  mtimeMs: 1,
  ext: 'pdf',
  exists: true,
  readerType: 'pdf',
};

function genericDto(enabled: boolean): AdapterPluginDto {
  const manifest = JSON.parse(readFileSync(new URL('../resources/builtin-adapters/web.generic/manifest.json', import.meta.url), 'utf8')) as AdapterPluginManifest;
  const perm = manifest.contributes.adapters[0]!.permissions[0]!;
  const grant: PermissionGrant = {
    pluginId: 'web.generic',
    adapterId: 'web.generic',
    permissionId: perm.id,
    decision: 'granted',
    declHash: permissionDeclHash(perm),
    grantedHosts: ['example.com'],
    decidedAt: 1,
  };
  return {
    id: 'web.generic',
    name: '通用网页',
    version: manifest.version,
    source: 'builtin',
    manifest,
    errors: [],
    enabled,
    installedAt: 1,
    grants: [grant],
    storageBytes: 0,
    storageKeys: 0,
    mainUrl: 'kbplugin://web.generic/dist/index.js',
  };
}

let doc: Doc;
let WebResourcesSidebarSection: ComponentType;
let SidebarPlugins: ComponentType;
let WebFileView: typeof import('../src/renderer/web-resources/WebFileView').WebFileView;
let pluginHost: typeof import('../src/renderer/plugin-host/host').pluginHost;
let createRoot: typeof import('react-dom/client').createRoot;

beforeAll(async () => {
  doc = installDom();
  ({ createRoot } = await import('react-dom/client'));
  ({ WebResourcesSidebarSection } = await import('../src/renderer/MainShell'));
  ({ SidebarPlugins } = await import('../src/renderer/dir-view/Sidebar'));
  ({ WebFileView } = await import('../src/renderer/web-resources/WebFileView'));
  ({ pluginHost } = await import('../src/renderer/plugin-host/host'));
  const webResources = (await import('../src/renderer/web-resources')).default;
  const extra: PluginModule = {
    manifest: { id: 'builtin.extra-side', name: '额外', version: '1.0.0', engines: { workbench: `^${HOST_API_VERSION}` } },
    activate(api) {
      api.panels.register({ id: 'extra.side', title: '额外', location: 'sidebar', order: 80, component: () => createElement('div', { 'data-testid': 'extra-panel' }, '额外') });
    },
  };
  await pluginHost.load([{ module: webResources, source: 'builtin' }, { module: extra, source: 'builtin' }]);
}, 60_000);

afterAll(() => {
  pluginHost?.loadSandboxed([]);
});

async function settle() {
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
}

it('关掉网络资料后侧栏区块和添加入口整块隐藏，重新打开恢复，且不从插件面板再画一份', async () => {
  const sidebar = readFileSync(new URL('../src/renderer/dir-view/Sidebar.tsx', import.meta.url), 'utf8');
  expect(sidebar).toContain("new Set(['web.resources', 'workbench.plugins'])");

  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => {
    root.render(createElement('div', null, createElement(WebResourcesSidebarSection), createElement(SidebarPlugins)));
  });
  await settle();

  expect(byTestId(container, 'panel-web.resources')).toHaveLength(1);
  expect(byTestId(container, 'web-open-url-head')).toHaveLength(1);
  expect(byTestId(container, 'web-module-h').length).toBeGreaterThan(0);
  expect(container.textContent).toContain('添加');
  expect(byTestId(container, 'panel-extra.side')).toHaveLength(1);

  await act(async () => { await pluginHost.setEnabled('builtin.web-resources', false); });
  await settle();
  expect(pluginHost.get('builtin.web-resources')?.status).toBe('disabled');
  expect(byTestId(container, 'panel-web.resources')).toHaveLength(0);
  expect(byTestId(container, 'web-open-url-head')).toHaveLength(0);
  expect(byTestId(container, 'web-module-h')).toHaveLength(0);
  expect(byTestId(container, 'panel-extra.side')).toHaveLength(1);

  await act(async () => { await pluginHost.setEnabled('builtin.web-resources', true); });
  await settle();
  expect(pluginHost.get('builtin.web-resources')?.status).toBe('active');
  expect(byTestId(container, 'panel-web.resources')).toHaveLength(1);
  expect(byTestId(container, 'web-open-url-head')).toHaveLength(1);
  expect(container.textContent).toContain('添加');
  expect(byTestId(container, 'panel-extra.side')).toHaveLength(1);

  root.unmount();
  container.parentNode?.removeChild(container);
}, 60_000);

it('大图标模式下关掉网络资料后板块卡片整张消失且不可点，重新打开后恢复', async () => {
  const { SingleDrawer: Drawer } = await import('../src/renderer/drawer/Drawer');
  const { updateSidebarPrefs } = await import('../src/renderer/drawer/sidebarPrefs');
  const { useWebResourcesEnabled } = await import('../src/renderer/MainShell');
  updateSidebarPrefs({ categoriesLayout: 'grid', ribbonCollapsed: false, categoriesCollapsed: false });

  function GridCards() {
    const on = useWebResourcesEnabled();
    return createElement(Drawer, {
      open: true,
      onWidth: () => {},
      onSelectionChange: () => {},
      selection: ['web'],
      slots: {
        root: '根',
        fav: '藏',
        web: on ? createElement('div', { 'data-testid': 'web-slot-body' }, '网络内容') : null,
        bench: '台',
        agent: '智',
        plugin: '插',
      },
    });
  }

  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  try {
    await act(async () => { await pluginHost.setEnabled('builtin.web-resources', true); });
    await act(async () => { root.render(createElement(GridCards)); });
    await settle();
    const onCard = byTestId(container, 'drawer-card-web');
    expect(onCard).toHaveLength(1);
    expect(onCard[0]!.tagName).toBe('BUTTON');
    expect(onCard[0]!.hasAttribute('disabled')).toBe(false);
    expect(byTestId(container, 'drawer-slot-web')).toHaveLength(1);
    expect(byTestId(container, 'web-slot-body')).toHaveLength(1);

    await act(async () => { await pluginHost.setEnabled('builtin.web-resources', false); });
    await settle();
    expect(pluginHost.get('builtin.web-resources')?.status).toBe('disabled');
    expect(byTestId(container, 'drawer-card-web')).toHaveLength(0);
    expect(byTestId(container, 'drawer-slot-web')).toHaveLength(0);
    expect(byTestId(container, 'drawer-pending-web')).toHaveLength(0);
    expect(byTestId(container, 'drawer-modules')).toHaveLength(0);
    expect(byTestId(container, 'drawer-card-root')).toHaveLength(1);
    expect(container.textContent).not.toContain('网络资料');

    await act(async () => { await pluginHost.setEnabled('builtin.web-resources', true); });
    await settle();
    expect(pluginHost.get('builtin.web-resources')?.status).toBe('active');
    expect(byTestId(container, 'drawer-card-web')).toHaveLength(1);
    expect(byTestId(container, 'drawer-slot-web')).toHaveLength(1);
    expect(byTestId(container, 'web-slot-body')).toHaveLength(1);
  } finally {
    await act(async () => { await pluginHost.setEnabled('builtin.web-resources', true); });
    root.unmount();
    container.parentNode?.removeChild(container);
    updateSidebarPrefs({ categoriesLayout: 'grid', ribbonCollapsed: false, categoriesCollapsed: false });
  }
}, 60_000);

it('关掉通用网页后已打开的直链面板立刻变成不可用占位，重新打开会重载', async () => {
  kbState.webFetchCache.mockResolvedValue({ ok: true, kind: 'cached', resource: CACHED });
  kbState.getResource.mockResolvedValue(FILE);
  pluginHost.loadSandboxed([genericDto(true)]);

  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  const view = createElement(WebFileView, {
    item: { itemId: 'item-1', sourceKind: 'web', adapterId: 'web.file', ref: 'https://example.com/a.pdf', displayMode: 'in-app-web', title: 'a.pdf' },
    resource: FILE,
    state: undefined,
    setState: () => undefined,
    api: pluginHost.apiFor('builtin.web-resources'),
  });
  await act(async () => { root.render(view); });
  await settle();

  const phase = () => byTestId(container, 'webfile-view')[0]?.getAttribute('data-phase');
  expect(phase()).toBe('ready');
  expect(byTestId(container, 'webfile-reader').length + byTestId(container, 'webfile-no-reader').length).toBeGreaterThan(0);
  expect(byTestId(container, 'placeholder')).toHaveLength(0);
  const fetchesAtReady = kbState.webFetchCache.mock.calls.length;
  expect(fetchesAtReady).toBeGreaterThan(0);

  pluginHost.loadSandboxed([genericDto(true)]);
  await act(async () => { await Promise.resolve(); });
  await settle();
  expect(phase()).toBe('ready');
  expect(kbState.webFetchCache.mock.calls.length).toBe(fetchesAtReady);

  await act(async () => { pluginHost.loadSandboxed([genericDto(false)]); });
  await settle();
  expect(phase()).toBe('unavailable');
  expect(byTestId(container, 'webfile-reader')).toHaveLength(0);
  expect(byTestId(container, 'webfile-no-reader')).toHaveLength(0);
  const placeholder = byTestId(container, 'placeholder');
  expect(placeholder).toHaveLength(1);
  expect(placeholder[0]!.getAttribute('data-kind')).toBe('web-unavailable');
  expect(placeholder[0]!.textContent).toContain('已禁用');
  expect(kbState.webFetchCache.mock.calls.length).toBe(fetchesAtReady);

  await act(async () => { pluginHost.loadSandboxed([genericDto(true)]); });
  await settle();
  expect(phase()).toBe('ready');
  expect(kbState.webFetchCache.mock.calls.length).toBeGreaterThan(fetchesAtReady);
  expect(byTestId(container, 'placeholder')).toHaveLength(0);

  root.unmount();
  container.parentNode?.removeChild(container);
  pluginHost.loadSandboxed([]);
}, 60_000);
