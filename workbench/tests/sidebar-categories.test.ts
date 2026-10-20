import { expect, it } from 'vitest';
import { parseSidebarPrefs } from '../src/renderer/drawer/sidebarPrefs';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { DrawerCards } from '../src/renderer/drawer/cards';
it('分类默认展开，收起偏好可往返且丢弃非法值', () => {
  expect(parseSidebarPrefs(null).categoriesCollapsed).toBe(false);
  expect(parseSidebarPrefs({ categoriesCollapsed: 'false' }).categoriesCollapsed).toBe(false);
  expect(parseSidebarPrefs(JSON.parse(JSON.stringify({ categoriesCollapsed: true }))).categoriesCollapsed).toBe(true);
});
it('折叠控件具有展开状态，六个入口保留启用状态', () => {
  const html = renderToStaticMarkup(createElement(DrawerCards, { selection: ['root'], onToggle: () => {} }));
  expect(html).toContain('aria-expanded="true"');
  expect(html.match(/data-testid="drawer-card-/g)).toHaveLength(6);
  expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
});
it('排布默认网格，列表偏好序列化往返，非法排布回到网格', () => {
  expect(parseSidebarPrefs(null).categoriesLayout).toBe('grid');
  expect(parseSidebarPrefs(JSON.parse(JSON.stringify({ categoriesLayout: 'list' }))).categoriesLayout).toBe('list');
  expect(parseSidebarPrefs({ categoriesLayout: 'other' }).categoriesLayout).toBe('grid');
});
it('收起和列表渲染保留启用状态，并只写 UI 偏好键', async () => {
  const { updateSidebarPrefs, SIDEBAR_PREFS_KEY } = await import('../src/renderer/drawer/sidebarPrefs');
  const writes = new Map<string, string>();
  const old = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { setItem: (key: string, value: string) => writes.set(key, value) } });
  try {
    updateSidebarPrefs({ categoriesCollapsed: true, categoriesLayout: 'list' });
    const html = renderToStaticMarkup(createElement(DrawerCards, { selection: ['root', 'web'], onToggle: () => {} }));
    expect(html).not.toContain('kb-drawer-cats-head');
    expect(html).toContain('data-layout="list"');
    expect(html).not.toContain('inert=""');
    expect(html).toContain('data-testid="ribbon-panel-toggle"');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(3);
    expect([...writes.keys()]).toEqual([SIDEBAR_PREFS_KEY]);
    expect(parseSidebarPrefs(JSON.parse(writes.get(SIDEBAR_PREFS_KEY)!)).categoriesCollapsed).toBe(true);
  } finally {
    updateSidebarPrefs({ categoriesCollapsed: false, categoriesLayout: 'grid' });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: old });
  }
});

it('列表只显示六个 lucide 图标，以中文提供提示和无障碍名；切回网格保持文字与对勾', async () => {
  const { updateSidebarPrefs } = await import('../src/renderer/drawer/sidebarPrefs');
  const { DRAWER_MODULE_IDS, DRAWER_MODULE_LABEL } = await import('../src/renderer/drawer/order');
  try {
    updateSidebarPrefs({ categoriesLayout: 'list' });
    const html = renderToStaticMarkup(createElement(DrawerCards, { selection: ['root'], onToggle: () => {} }));
    expect(html.match(/data-testid="drawer-card-/g)).toHaveLength(6);
    expect(html.match(/class="lucide lucide-(?:folder-tree|bookmark|globe|files|bot|puzzle)"/g)).toHaveLength(6);
    expect(html).not.toContain('kb-drawer-card-name');
    expect(html).not.toContain('kb-drawer-card-check');
    for (const id of DRAWER_MODULE_IDS) {
      expect(html).toContain(`title="${DRAWER_MODULE_LABEL[id]}　左键：第 1 栏　右键：第 2 栏　中键：第 3 栏"`);
      expect(html).toContain(`aria-label="${DRAWER_MODULE_LABEL[id]}"`);
    }
    expect(html).toContain('kb-drawer-card on');
    updateSidebarPrefs({ categoriesLayout: 'grid' });
    const grid = renderToStaticMarkup(createElement(DrawerCards, { selection: ['root'], onToggle: () => {} }));
    expect(grid.match(/kb-drawer-card-name/g)).toHaveLength(6);
    expect(grid.match(/kb-drawer-card-check/g)).toHaveLength(1);
  } finally {
    updateSidebarPrefs({ categoriesLayout: 'grid' });
  }
});


it('ribbon 点击沿用网格勾选，再点只隐藏这一块，点另一个切换，收起后再点则展开', async () => {
  const { ribbonClick, ribbonActive } = await import('../src/renderer/drawer/ribbon');
  const { toggleDrawerSelection } = await import('../src/renderer/drawer/order');
  const { updateSidebarPrefs, SIDEBAR_PREFS_KEY } = await import('../src/renderer/drawer/sidebarPrefs');
  const { SingleDrawer: Drawer } = await import('../src/renderer/drawer/Drawer');
  const writes = new Map<string, string>();
  const old = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: (key: string, value: string) => writes.set(key, value) } });
  const props = { open: true, onWidth: () => {}, selection: ['root', 'web'] as const, onSelectionChange: () => {}, slots: { root: '根内容', web: '网络内容' } };
  try {
    const first = ribbonClick(['root', 'web'], null, false, 'bench');
    expect(first.selection).toEqual(toggleDrawerSelection(['root', 'web'], 'bench'));
    expect(first).toEqual({ selection: ['root', 'web', 'bench'], active: 'bench', collapsed: false });
    const second = ribbonClick(first.selection, first.active, first.collapsed, 'bench');
    expect(second.selection).toEqual(toggleDrawerSelection(first.selection, 'bench'));
    expect(second).toEqual({ selection: ['root', 'web'], active: 'bench', collapsed: false });
    const fromCollapsed = ribbonClick(second.selection, second.active, true, 'bench');
    expect(fromCollapsed.selection).toEqual(toggleDrawerSelection(second.selection, 'bench'));
    expect(fromCollapsed).toEqual({ selection: ['root', 'web', 'bench'], active: 'bench', collapsed: false });
    const other = ribbonClick(['root'], 'root', true, 'agent');
    expect(other.selection).toEqual(toggleDrawerSelection(['root'], 'agent'));
    expect(other).toEqual({ selection: ['root', 'agent'], active: 'agent', collapsed: false });
    const reveal = ribbonClick(['root', 'web'], 'root', true, 'web');
    expect(reveal).toEqual({ selection: ['root', 'web'], active: 'web', collapsed: false });
    const hide = ribbonClick(reveal.selection, reveal.active, reveal.collapsed, 'web');
    expect(hide.selection).toEqual(toggleDrawerSelection(reveal.selection, 'web'));
    expect(hide).toEqual({ selection: ['root'], active: 'web', collapsed: false });
    const hideOther = ribbonClick(['root', 'web'], 'web', false, 'root');
    expect(hideOther.selection).toEqual(toggleDrawerSelection(['root', 'web'], 'root'));
    expect(hideOther).toEqual({ selection: ['web'], active: 'root', collapsed: false });
    const cleared = ribbonClick(['root'], 'root', false, 'root');
    expect(cleared.selection).toEqual(toggleDrawerSelection(['root'], 'root'));
    expect(cleared).toEqual({ selection: [], active: 'root', collapsed: false });
    const switched = ribbonClick(first.selection, first.active, false, 'agent');
    expect(switched.selection).toEqual(toggleDrawerSelection(first.selection, 'agent'));
    expect(switched).toEqual({ selection: ['root', 'web', 'bench', 'agent'], active: 'agent', collapsed: false });
    expect(ribbonActive('web', ['root'])).toBe(null);
    expect(ribbonActive('root', ['root'])).toBe('root');
    expect(parseSidebarPrefs({ ribbonCollapsed: 'true' }).ribbonCollapsed).toBe(false);
    expect(parseSidebarPrefs(JSON.parse(JSON.stringify({ ribbonCollapsed: true }))).ribbonCollapsed).toBe(true);

    updateSidebarPrefs({ categoriesLayout: 'list', ribbonCollapsed: true });
    const collapsedHtml = renderToStaticMarkup(createElement(Drawer, props));
    expect(collapsedHtml).toContain('width:44px');
    expect(collapsedHtml).toContain('hidden=""');
    updateSidebarPrefs({ ribbonCollapsed: fromCollapsed.collapsed });
    const opened = renderToStaticMarkup(createElement(Drawer, props));
    expect(opened).toContain('width:360px');
    expect(opened).not.toContain('hidden=""');
    expect(opened).toContain('data-panel-collapsed="false"');
    expect(opened).toContain('drawer-slot-web');
    const stored = parseSidebarPrefs(JSON.parse(writes.get(SIDEBAR_PREFS_KEY)!));
    expect(stored.ribbonCollapsed).toBe(false);
    expect(stored.categoriesLayout).toBe('list');
  } finally {
    updateSidebarPrefs({ categoriesLayout: 'grid', ribbonCollapsed: false });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: old });
  }
});

it('grid 模式顶栏开关收起整栏，且不写 ribbon 收起偏好', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const appSrc = readFileSync(join(__dirname, '../src/renderer/MainShell.tsx'), 'utf8');
  expect(appSrc).toContain('data-testid="drawer-toggle"');
  expect(appSrc).toContain('onClick={toggleDrawer}');
  expect(appSrc).toContain('const toggleDrawer = () => toggleDockedDrawer(panelManager);');
  expect(appSrc).toContain('open={shellOpen}');
  expect(appSrc).toContain('resolveListDrawerWidth(drawerOpen, listWidthMemory.current, sidebarWidth)');
  expect(appSrc).toContain('panelManager.resize(SIDEBAR_ID, { width: w })');

  const { updateSidebarPrefs, SIDEBAR_PREFS_KEY } = await import('../src/renderer/drawer/sidebarPrefs');
  const { toggleDockedDrawer } = await import('../src/renderer/drawer/drawerToggle');
  const g = globalThis as unknown as Record<string, unknown>;
  const hadWindow = 'window' in g;
  const hadDocument = 'document' in g;
  const prevWindow = g.window;
  const prevDocument = g.document;
  if (!g.window || !g.document) {
    const listen = () => ({ addEventListener() {}, removeEventListener() {} });
    g.window = listen();
    g.document = { ...listen(), querySelector: () => null, querySelectorAll: () => [] };
    g.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  }
  const { PanelManager } = await import('../src/renderer/panel-manager/PanelManager');
  const { SIDEBAR_ID } = await import('../src/renderer/panel-manager/types');
  const pm = new PanelManager();
  const store = new Map<string, string>();
  const old = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    },
  });
  const drawerOpen = () => !pm.sidebarState().collapsed;
  try {
    updateSidebarPrefs({ categoriesLayout: 'grid', ribbonCollapsed: false });
    const before = store.get(SIDEBAR_PREFS_KEY);
    expect(parseSidebarPrefs(JSON.parse(before!)).ribbonCollapsed).toBe(false);
    expect(drawerOpen()).toBe(true);
    toggleDockedDrawer(pm);
    expect(pm.isCollapsed(SIDEBAR_ID)).toBe(true);
    expect(drawerOpen()).toBe(false);
    expect(pm.bubbles().some((b) => b.id === SIDEBAR_ID)).toBe(false);
    expect(store.get(SIDEBAR_PREFS_KEY)).toBe(before);
    toggleDockedDrawer(pm);
    expect(pm.isCollapsed(SIDEBAR_ID)).toBe(false);
    expect(drawerOpen()).toBe(true);
    expect(pm.sidebarState().mode).toBe('docked');
    expect(store.get(SIDEBAR_PREFS_KEY)).toBe(before);
  } finally {
    updateSidebarPrefs({ categoriesLayout: 'grid', ribbonCollapsed: false });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: old });
    if (!hadWindow) delete g.window;
    else g.window = prevWindow;
    if (!hadDocument) delete g.document;
    else g.document = prevDocument;
  }
});

function buttonBlock(html: string, testId: string) {
  const marker = `data-testid="${testId}"`;
  const at = html.indexOf(marker);
  expect(at).toBeGreaterThanOrEqual(0);
  const start = html.lastIndexOf('<button', at);
  const end = html.indexOf('</button>', at);
  return html.slice(start, end);
}

function elementOpenTag(html: string, testId: string) {
  const marker = `data-testid="${testId}"`;
  const at = html.indexOf(marker);
  expect(at).toBeGreaterThanOrEqual(0);
  const start = html.lastIndexOf('<', at);
  const end = html.indexOf('>', at);
  return html.slice(start, end + 1);
}

it('ribbon 顶部按钮与顶栏开关同步收起和展开，分区图标再点只隐藏板块', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { SingleDrawer: Drawer } = await import('../src/renderer/drawer/Drawer');
  const { getSidebarPrefs, updateSidebarPrefs } = await import('../src/renderer/drawer/sidebarPrefs');
  const { dockedDrawerChrome, drawerContentOpen, toggleDockedDrawer } = await import('../src/renderer/drawer/drawerToggle');
  const { ribbonClick } = await import('../src/renderer/drawer/ribbon');
  const appSrc = readFileSync(join(__dirname, '../src/renderer/MainShell.tsx'), 'utf8');
  const drawerSrc = readFileSync(join(__dirname, '../src/renderer/drawer/Drawer.tsx'), 'utf8');
  expect(appSrc).toContain('onTogglePanel={toggleDrawer}');
  expect(appSrc).toContain('const toggleDrawer = () => toggleDockedDrawer(panelManager);');
  expect(appSrc).toContain('aria-pressed={drawerChrome.pressed}');
  expect(appSrc).toContain('dockedDrawerChrome(drawerOpen)');
  expect(appSrc).toContain('drawerContentOpen(shellCollapsed, sidebarPrefs)');
  expect(appSrc).toContain('useSidebarPrefs()');
  expect(drawerSrc).toContain('panelOpen={open && !collapsed}');
  expect(drawerSrc).toContain('if (collapsed && !next.collapsed) updateSidebarPrefs({ ribbonCollapsed: false })');

  const g = globalThis as unknown as Record<string, unknown>;
  const hadWindow = 'window' in g;
  const hadDocument = 'document' in g;
  const prevWindow = g.window;
  const prevDocument = g.document;
  if (!g.window || !g.document) {
    const listen = () => ({ addEventListener() {}, removeEventListener() {} });
    g.window = listen();
    g.document = { ...listen(), querySelector: () => null, querySelectorAll: () => [] };
    g.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  }
  const { PanelManager } = await import('../src/renderer/panel-manager/PanelManager');
  const { SIDEBAR_ID } = await import('../src/renderer/panel-manager/types');
  const pm = new PanelManager();
  const props = { open: true, onWidth: () => {}, selection: ['root', 'web'] as const, onSelectionChange: () => {}, slots: { root: '根内容', web: '网络内容' } };
  const view = () => renderToStaticMarkup(createElement(Drawer, { ...props, open: !pm.isCollapsed(SIDEBAR_ID), onTogglePanel: () => toggleDockedDrawer(pm) }));
  try {
    updateSidebarPrefs({ categoriesLayout: 'list', ribbonCollapsed: false });
    expect(pm.isCollapsed(SIDEBAR_ID)).toBe(false);
    const openedChrome = dockedDrawerChrome(drawerContentOpen(pm.isCollapsed(SIDEBAR_ID), getSidebarPrefs()));
    const opened = buttonBlock(view(), 'ribbon-panel-toggle');
    expect(opened).toContain(`aria-pressed="${openedChrome.pressed}"`);
    expect(opened).toContain(`aria-label="${openedChrome.ribbonLabel}"`);
    expect(opened).toContain(`title="${openedChrome.ribbonLabel}"`);
    expect(opened).toContain('lucide-panel-left-close');
    expect(opened).not.toContain('lucide-panel-left-open');
    expect(view()).toContain('kb-ribbon-sep');
    expect(openedChrome.drawerLabel).toBe('收起资料抽屉');
    expect(openedChrome.pressed).toBe(true);

    const same = ribbonClick(['root', 'web'], 'web', false, 'web');
    expect(same).toEqual({ selection: ['root'], active: 'web', collapsed: false });
    expect(pm.isCollapsed(SIDEBAR_ID)).toBe(false);
    expect(getSidebarPrefs().ribbonCollapsed).toBe(false);

    toggleDockedDrawer(pm);
    expect(pm.isCollapsed(SIDEBAR_ID)).toBe(false);
    expect(pm.sidebarState().mode).toBe('docked');
    expect(getSidebarPrefs().ribbonCollapsed).toBe(true);
    const closedChrome = dockedDrawerChrome(drawerContentOpen(pm.isCollapsed(SIDEBAR_ID), getSidebarPrefs()));
    const closedHtml = view();
    const closed = buttonBlock(closedHtml, 'ribbon-panel-toggle');
    expect(closed).toContain(`aria-pressed="${closedChrome.pressed}"`);
    expect(closed).toContain('aria-label="展开侧栏"');
    expect(closed).toContain('title="展开侧栏"');
    expect(closed).toContain('lucide-panel-left-open');
    expect(closed).not.toContain('lucide-panel-left-close');
    expect(closedChrome.drawerLabel).toBe('展开资料抽屉');
    expect(closedChrome.pressed).toBe(false);
    expect(closedChrome.icon).toBe('panel-left-open');
    expect(closedChrome.ribbonLabel).toBe('展开侧栏');

    toggleDockedDrawer(pm);
    expect(pm.isCollapsed(SIDEBAR_ID)).toBe(false);
    expect(pm.sidebarState().mode).toBe('docked');
    expect(getSidebarPrefs().ribbonCollapsed).toBe(false);
    const again = buttonBlock(view(), 'ribbon-panel-toggle');
    expect(again).toContain('aria-pressed="true"');
    expect(again).toContain('收起侧栏');
    expect(again).toContain('lucide-panel-left-close');
    expect(dockedDrawerChrome(drawerContentOpen(false, getSidebarPrefs())).drawerLabel).toBe('收起资料抽屉');
  } finally {
    updateSidebarPrefs({ categoriesLayout: 'grid', ribbonCollapsed: false });
    if (!hadWindow) delete g.window;
    else g.window = prevWindow;
    if (!hadDocument) delete g.document;
    else g.document = prevDocument;
  }
});

it('list 模式收起后 ribbon 仍渲染且可点，点图标展开内容面板', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { SingleDrawer: Drawer } = await import('../src/renderer/drawer/Drawer');
  const { getSidebarPrefs, updateSidebarPrefs } = await import('../src/renderer/drawer/sidebarPrefs');
  const { dockedDrawerChrome, drawerContentOpen, toggleDockedDrawer } = await import('../src/renderer/drawer/drawerToggle');
  const { ribbonClick } = await import('../src/renderer/drawer/ribbon');
  const { DRAWER_MODULE_IDS } = await import('../src/renderer/drawer/order');
  const drawerSrc = readFileSync(join(__dirname, '../src/renderer/drawer/Drawer.tsx'), 'utf8');
  expect(drawerSrc).toContain('setHighlight');
  expect(drawerSrc).toContain('if (collapsed && !next.collapsed) updateSidebarPrefs({ ribbonCollapsed: false })');

  const g = globalThis as unknown as Record<string, unknown>;
  const hadWindow = 'window' in g;
  const hadDocument = 'document' in g;
  const prevWindow = g.window;
  const prevDocument = g.document;
  if (!g.window || !g.document) {
    const listen = () => ({ addEventListener() {}, removeEventListener() {} });
    g.window = listen();
    g.document = { ...listen(), querySelector: () => null, querySelectorAll: () => [] };
    g.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  }
  const { PanelManager } = await import('../src/renderer/panel-manager/PanelManager');
  const { SIDEBAR_ID } = await import('../src/renderer/panel-manager/types');
  const pm = new PanelManager();
  const slots = { root: '根', fav: '藏', web: '网', bench: '台', agent: '智', plugin: '插' };
  const selection = ['root', 'web'] as const;
  const view = (nextSelection: readonly string[] = selection) => renderToStaticMarkup(createElement(Drawer, {
    open: !pm.isCollapsed(SIDEBAR_ID),
    onWidth: () => {},
    selection: nextSelection,
    onSelectionChange: () => {},
    onTogglePanel: () => toggleDockedDrawer(pm),
    slots,
  }));
  try {
    updateSidebarPrefs({ categoriesLayout: 'list', ribbonCollapsed: false });
    toggleDockedDrawer(pm);
    expect(pm.isCollapsed(SIDEBAR_ID)).toBe(false);
    expect(getSidebarPrefs().ribbonCollapsed).toBe(true);
    expect(drawerContentOpen(pm.isCollapsed(SIDEBAR_ID), getSidebarPrefs())).toBe(false);

    const html = view();
    const drawer = elementOpenTag(html, 'kb-drawer');
    expect(drawer).toContain('data-open="true"');
    expect(drawer).toContain('width:44px');
    expect(drawer).toContain('data-panel-collapsed="true"');
    expect(drawer).toContain('data-layout="list"');
    expect(drawer).not.toContain('inert');
    expect(drawer).not.toContain('aria-hidden');
    expect(html).toContain('data-testid="ribbon-panel-toggle"');
    expect(html).toContain('kb-ribbon-sep');
    expect(html).toContain('切换为网格');
    expect(html.match(/data-testid="drawer-card-/g)).toHaveLength(DRAWER_MODULE_IDS.length);
    const hiddenAt = html.indexOf('hidden=""');
    expect(hiddenAt).toBeGreaterThan(html.indexOf('data-testid="ribbon-panel-toggle"'));
    expect(hiddenAt).toBeGreaterThan(html.lastIndexOf('data-testid="drawer-card-'));
    const toggle = buttonBlock(html, 'ribbon-panel-toggle');
    expect(toggle).not.toContain('disabled');
    expect(toggle).toContain('aria-pressed="false"');
    expect(toggle).toContain('aria-label="展开侧栏"');
    const card = buttonBlock(html, 'drawer-card-web');
    expect(card).not.toContain('disabled');
    expect(card).toContain('<button');
    expect(dockedDrawerChrome(false).drawerLabel).toBe('展开资料抽屉');
    expect(dockedDrawerChrome(false).ribbonLabel).toBe('展开侧栏');

    const clicked = ribbonClick(selection, 'root', true, 'agent');
    expect(clicked).toEqual({ selection: ['root', 'web', 'agent'], active: 'agent', collapsed: false });
    updateSidebarPrefs({ ribbonCollapsed: clicked.collapsed });
    expect(getSidebarPrefs().ribbonCollapsed).toBe(false);
    expect(pm.isCollapsed(SIDEBAR_ID)).toBe(false);
    const opened = view(clicked.selection);
    const openedTag = elementOpenTag(opened, 'kb-drawer');
    expect(openedTag).toContain('width:360px');
    expect(openedTag).toContain('data-open="true"');
    expect(openedTag).toContain('data-panel-collapsed="false"');
    expect(openedTag).not.toContain('inert');
    expect(opened).not.toContain('hidden=""');
    expect(opened).toContain('drawer-slot-agent');
    expect(buttonBlock(opened, 'ribbon-panel-toggle')).toContain('aria-label="收起侧栏"');
    expect(buttonBlock(opened, 'ribbon-panel-toggle')).toContain('aria-pressed="true"');
    expect(drawerContentOpen(false, getSidebarPrefs())).toBe(true);
    expect(dockedDrawerChrome(true).pressed).toBe(true);

    const again = ribbonClick(clicked.selection, clicked.active, false, 'agent');
    expect(again).toEqual({ selection: ['root', 'web'], active: 'agent', collapsed: false });
    updateSidebarPrefs({ ribbonCollapsed: again.collapsed });
    expect(getSidebarPrefs().ribbonCollapsed).toBe(false);
    expect(pm.isCollapsed(SIDEBAR_ID)).toBe(false);
    const stayed = view(again.selection);
    const stayedTag = elementOpenTag(stayed, 'kb-drawer');
    expect(stayedTag).toContain('width:360px');
    expect(stayedTag).toContain('data-panel-collapsed="false"');
    expect(stayed).not.toContain('hidden=""');
    expect(stayed).toContain('drawer-slot-root');
    expect(stayed).toContain('drawer-slot-web');
    expect(stayed).not.toContain('drawer-slot-agent');
    const hideRoot = ribbonClick(['root'], 'root', false, 'root');
    expect(hideRoot).toEqual({ selection: [], active: 'root', collapsed: false });
    updateSidebarPrefs({ ribbonCollapsed: hideRoot.collapsed });
    const empty = view(hideRoot.selection);
    const emptyTag = elementOpenTag(empty, 'kb-drawer');
    expect(emptyTag).toContain('width:360px');
    expect(emptyTag).toContain('data-panel-collapsed="false"');
    expect(empty).toContain('data-testid="drawer-card-root"');
    expect(empty).toContain('data-testid="ribbon-panel-toggle"');
    expect(empty).not.toContain('width:44px');
    expect(empty).not.toContain('hidden=""');
    expect(empty).not.toContain('drawer-modules');
    expect(empty).not.toContain('drawer-slot-');
  } finally {
    updateSidebarPrefs({ categoriesLayout: 'grid', ribbonCollapsed: false });
    if (!hadWindow) delete g.window;
    else g.window = prevWindow;
    if (!hadDocument) delete g.document;
    else g.document = prevDocument;
  }
});

it('ribbon 保留多个堆叠分区，过滤不存在的入口，收起后切回网格仍展示内容', async () => {
  const { SingleDrawer: Drawer } = await import('../src/renderer/drawer/Drawer');
  const { updateSidebarPrefs } = await import('../src/renderer/drawer/sidebarPrefs');
  const props = { open: true, onWidth: () => {}, selection: ['root', 'web'] as const, onSelectionChange: () => {}, slots: { root: '根内容', web: '网络内容', agent: false } };
  try {
    updateSidebarPrefs({ categoriesLayout: 'list', ribbonCollapsed: false });
    const html = renderToStaticMarkup(createElement(Drawer, props));
    expect(html.match(/data-testid="drawer-card-/g)).toHaveLength(2);
    expect(html).toContain('drawer-slot-root');
    expect(html).toContain('drawer-slot-web');
    expect(html).not.toContain('drawer-card-agent');
    expect(html).not.toContain('kb-sbb-name');
    expect(html).toContain('kb-sbb-chev');
    expect(html).toContain('sidebar-block-bar-root');
    expect(html).toContain('切换为网格');
    expect(html.indexOf('data-testid="ribbon-panel-toggle"')).toBeGreaterThan(-1);
    expect(html.indexOf('kb-ribbon-sep')).toBeGreaterThan(html.indexOf('data-testid="ribbon-panel-toggle"'));
    expect(html.indexOf('data-testid="drawer-card-')).toBeGreaterThan(html.indexOf('kb-ribbon-sep'));
    updateSidebarPrefs({ ribbonCollapsed: true });
    const collapsed = renderToStaticMarkup(createElement(Drawer, props));
    expect(collapsed).toContain('width:44px');
    expect(collapsed).toContain('hidden=""');
    updateSidebarPrefs({ categoriesLayout: 'grid' });
    const grid = renderToStaticMarkup(createElement(Drawer, props));
    expect(grid).toContain('width:360px');
    expect(grid).not.toContain('hidden=""');
    expect(grid).not.toContain('ribbon-panel-toggle');
    expect(grid).toContain('drawer-slot-root');
    expect(grid).toContain('drawer-slot-web');
    expect(grid).toContain('drawer-card-fav');
    expect(grid).not.toContain('drawer-card-agent');
    expect(grid).not.toContain('drawer-slot-agent');
    expect(grid.match(/data-testid="drawer-card-/g)).toHaveLength(5);
  } finally { updateSidebarPrefs({ categoriesLayout: 'grid', ribbonCollapsed: false }); }
});

it('list 收起再展开恢复收起前宽度，连续 toggle 每次都改状态和宽度', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { SingleDrawer: Drawer } = await import('../src/renderer/drawer/Drawer');
  const { getSidebarPrefs, updateSidebarPrefs } = await import('../src/renderer/drawer/sidebarPrefs');
  const { drawerContentOpen, resolveListDrawerWidth, toggleDockedDrawer, usableListContentWidth } = await import('../src/renderer/drawer/drawerToggle');
  const { DRAWER_WIDTH_MIN } = await import('../src/renderer/drawer/order');
  const css = readFileSync(join(__dirname, '../src/renderer/drawer/drawer.css'), 'utf8');
  expect(css).toContain('.kb-drawer[data-layout="list"] { transition: none; }');
  expect(css).toContain('.kb-sidebar:has(.kb-drawer[data-layout="list"]) { transition: none; }');
  expect(css).toContain('min-width: 300px;');
  expect(usableListContentWidth(44)).toBeUndefined();
  expect(usableListContentWidth(83)).toBeUndefined();
  expect(resolveListDrawerWidth(true, undefined, undefined)).toBe(DRAWER_WIDTH_MIN);
  expect(resolveListDrawerWidth(true, undefined, 44)).toBe(DRAWER_WIDTH_MIN);
  expect(resolveListDrawerWidth(true, 360, 44)).toBe(360);
  expect(resolveListDrawerWidth(false, 360, 360)).toBe(44);

  const g = globalThis as unknown as Record<string, unknown>;
  const hadWindow = 'window' in g;
  const hadDocument = 'document' in g;
  const prevWindow = g.window;
  const prevDocument = g.document;
  if (!g.window || !g.document) {
    const listen = () => ({ addEventListener() {}, removeEventListener() {} });
    g.window = listen();
    g.document = { ...listen(), querySelector: () => null, querySelectorAll: () => [] };
    g.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  }
  const { PanelManager } = await import('../src/renderer/panel-manager/PanelManager');
  const { SIDEBAR_ID } = await import('../src/renderer/panel-manager/types');
  const pm = new PanelManager();
  let memory: number | undefined;
  let fallback = 320;
  const remember = () => {
    const open = drawerContentOpen(pm.isCollapsed(SIDEBAR_ID), getSidebarPrefs());
    if (getSidebarPrefs().categoriesLayout === 'list' && open) memory = resolveListDrawerWidth(true, memory, fallback);
  };
  const widthNow = () => resolveListDrawerWidth(drawerContentOpen(pm.isCollapsed(SIDEBAR_ID), getSidebarPrefs()), memory, fallback);
  const props = { open: true, onWidth: () => {}, selection: ['root', 'web'] as const, onSelectionChange: () => {}, slots: { root: '根', web: '网' } };
  try {
    updateSidebarPrefs({ categoriesLayout: 'list', ribbonCollapsed: false });
    remember();
    expect(widthNow()).toBe(320);
    expect(elementOpenTag(renderToStaticMarkup(createElement(Drawer, { ...props, width: widthNow() })), 'kb-drawer')).toContain('width:320px');

    toggleDockedDrawer(pm);
    fallback = 44;
    remember();
    expect(pm.isCollapsed(SIDEBAR_ID)).toBe(false);
    expect(getSidebarPrefs().ribbonCollapsed).toBe(true);
    expect(widthNow()).toBe(44);
    expect(elementOpenTag(renderToStaticMarkup(createElement(Drawer, { ...props, width: 320 })), 'kb-drawer')).toContain('width:44px');

    toggleDockedDrawer(pm);
    remember();
    expect(getSidebarPrefs().ribbonCollapsed).toBe(false);
    expect(widthNow()).toBe(320);
    expect(widthNow()).not.toBe(44);
    const restored = elementOpenTag(renderToStaticMarkup(createElement(Drawer, { ...props, width: widthNow() })), 'kb-drawer');
    expect(restored).toContain('width:320px');
    expect(restored).toContain('data-panel-collapsed="false"');
    expect(restored).not.toContain('width:44px');

    const seen: { open: boolean; width: number }[] = [];
    for (let i = 0; i < 4; i++) {
      toggleDockedDrawer(pm);
      const open = drawerContentOpen(pm.isCollapsed(SIDEBAR_ID), getSidebarPrefs());
      if (!open) fallback = 44;
      else fallback = widthNow();
      remember();
      seen.push({ open, width: widthNow() });
    }
    expect(seen).toEqual([
      { open: false, width: 44 },
      { open: true, width: 320 },
      { open: false, width: 44 },
      { open: true, width: 320 },
    ]);
    expect(pm.isCollapsed(SIDEBAR_ID)).toBe(false);
    expect(pm.sidebarState().mode).toBe('docked');
  } finally {
    updateSidebarPrefs({ categoriesLayout: 'grid', ribbonCollapsed: false });
    if (!hadWindow) delete g.window;
    else g.window = prevWindow;
    if (!hadDocument) delete g.document;
    else g.document = prevDocument;
  }
});
