/** 气泡：收起后能按原位置打开，序列化往返保留标题和类型，旧的 unknown 记录可迁移。 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { migratePanelLayout } from '../src/renderer/panel-manager/serialize';
import { SIDEBAR_ID, type BubbleKind, type CollapsedInfo } from '../src/renderer/panel-manager/types';
import { RestoreBar } from '../src/renderer/workspace-picker/RestoreBar';

type Box = { left: number; top: number; width: number; height: number };
type Loc = 'grid' | 'floating';

interface ScrollEl {
  isConnected: boolean;
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  clientHeight: number;
  clientWidth: number;
  getBoundingClientRect(): { width: number; height: number; left: number; top: number; right: number; bottom: number; x: number; y: number };
  querySelectorAll(sel: string): unknown[];
  querySelector(): null;
  closest(sel: string): null;
}

interface FakePanel {
  id: string;
  title: string;
  params: Record<string, unknown>;
  group: FakeGroup;
  view?: { content: { element: ScrollEl } };
  api: {
    setActive(): void;
    moveTo(opts: { group?: FakeGroup; position?: string }): void;
    close(): void;
  };
}

interface FakeGroup {
  id: string;
  panels: FakePanel[];
  element: { getBoundingClientRect(): { left: number; top: number; width: number; height: number; right: number; bottom: number; x: number; y: number } };
  header: { hidden: boolean };
  api: {
    location: { type: Loc };
    isMaximized(): boolean;
    setSize(): void;
    moveTo(opts: { position?: string }): void;
    locked: unknown;
  };
}

interface FakeWindow {
  group: FakeGroup;
  bounds: Box;
  overlay: {
    element: {
      setAttribute(k: string, v: string): void;
      getAttribute(k: string): string | null;
      hasAttribute(k: string): boolean;
      removeAttribute(k: string): void;
      getBoundingClientRect(): { left: number; top: number; width: number; height: number; right: number; bottom: number; x: number; y: number };
    };
    isVisible: boolean;
    setBounds(b: Partial<Box>): void;
    setVisible(v: boolean): void;
    bringToFront(): void;
  };
}

let PanelManager: typeof import('../src/renderer/panel-manager/PanelManager').PanelManager;
const rafQueue = new Map<number, FrameRequestCallback>();
let rafSeq = 1;

function flushRaf(times = 1) {
  for (let i = 0; i < times; i++) {
    const batch = [...rafQueue.values()];
    rafQueue.clear();
    for (const cb of batch) cb(0);
  }
}

function installDom() {
  const listen = () => {
    const map = new Map<string, Set<(...args: never[]) => void>>();
    return {
      addEventListener(type: string, fn: (...args: never[]) => void) {
        let set = map.get(type);
        if (!set) map.set(type, (set = new Set()));
        set.add(fn);
      },
      removeEventListener(type: string, fn: (...args: never[]) => void) {
        map.get(type)?.delete(fn);
      },
    };
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = listen();
  g.document = {
    ...listen(),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  g.CSS = { escape: (s: string) => s };
  g.ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
  g.requestAnimationFrame = (cb: FrameRequestCallback) => {
    const id = rafSeq++;
    rafQueue.set(id, cb);
    return id;
  };
  g.cancelAnimationFrame = (id: number) => {
    rafQueue.delete(id);
  };
}

beforeAll(async () => {
  installDom();
  ({ PanelManager } = await import('../src/renderer/panel-manager/PanelManager'));
});

function domRect(b: Box) {
  return { left: b.left, top: b.top, width: b.width, height: b.height, right: b.left + b.width, bottom: b.top + b.height, x: b.left, y: b.top, toJSON() { return {}; } };
}

function makeDock() {
  const panels = new Map<string, FakePanel>();
  const groups: FakeGroup[] = [];
  const floating: FakeWindow[] = [];
  const created: string[] = [];
  let gid = 1;
  const container = { getBoundingClientRect: () => domRect({ left: 0, top: 0, width: 1200, height: 800 }) };
  const on = () => {
    const fns = new Set<(...args: any[]) => void>();
    return {
      sub(fn: (...args: any[]) => void) {
        fns.add(fn);
        return { dispose: () => void fns.delete(fn) };
      },
      fire(...args: any[]) {
        for (const fn of [...fns]) fn(...args);
      },
    };
  };
  const added = on();
  const removed = on();
  const moved = on();
  const layout = on();
  const active = on();
  const max = on();
  const will = on();
  const did = on();

  function dropEmpty(group: FakeGroup) {
    if (group.panels.length) return;
    const gi = groups.indexOf(group);
    if (gi >= 0) groups.splice(gi, 1);
    const wi = floating.findIndex((w) => w.group === group);
    if (wi >= 0) floating.splice(wi, 1);
  }

  function detach(panel: FakePanel) {
    const group = panel.group;
    if (!group) return;
    group.panels = group.panels.filter((p) => p !== panel);
    dropEmpty(group);
  }

  function makeGroup(loc: Loc, box: Box): FakeGroup {
    const group: FakeGroup = {
      id: `g${gid++}`,
      panels: [],
      element: { getBoundingClientRect: () => domRect(box) },
      header: { hidden: false },
      api: {
        location: { type: loc },
        isMaximized: () => false,
        setSize() {},
        moveTo() {
          group.api.location.type = 'grid';
          const wi = floating.findIndex((w) => w.group === group);
          if (wi >= 0) floating.splice(wi, 1);
          const panel = group.panels[0];
          if (panel) moved.fire({ panel });
        },
        locked: undefined,
      },
    };
    groups.push(group);
    return group;
  }

  function makeWindow(group: FakeGroup, box: Box): FakeWindow {
    const bounds = { ...box };
    const attrs = new Map<string, string>();
    const win: FakeWindow = {
      group,
      bounds,
      overlay: {
        element: {
          setAttribute(k, v) { attrs.set(k, v); },
          getAttribute(k) { return attrs.get(k) ?? null; },
          hasAttribute(k) { return attrs.has(k); },
          removeAttribute(k) { attrs.delete(k); },
          getBoundingClientRect: () => domRect(bounds),
        },
        isVisible: true,
        setBounds(b) { Object.assign(bounds, b); },
        setVisible(v) { win.overlay.isVisible = v; },
        bringToFront() { attrs.set('aria-level', '1'); },
      },
    };
    floating.push(win);
    return win;
  }

  function makePanel(id: string, title: string, loc: Loc, box: Box): FakePanel {
    created.push(id);
    const group = makeGroup(loc, box);
    const panel = {
      id,
      title,
      params: { itemId: id },
      group,
      api: {
        setActive() {},
        moveTo(opts: { group?: FakeGroup; position?: string }) {
          const edge = opts.position === 'left' || opts.position === 'right' || opts.position === 'top' || opts.position === 'bottom';
          // 唯一文档拖到自己所在组的边缘：dockview 不拆出第二份
          if (edge && (!opts.group || opts.group === panel.group) && panel.group.panels.length === 1) return;
          if (edge && opts.group && opts.group !== panel.group) {
            detach(panel);
            const next = makeGroup('grid', { left: 0, top: 0, width: 480, height: 360 });
            next.panels.push(panel);
            panel.group = next;
            moved.fire({ panel });
            return;
          }
          if (!opts.group || opts.group === panel.group) return;
          detach(panel);
          opts.group.panels.push(panel);
          panel.group = opts.group;
          moved.fire({ panel });
        },
        close() {
          detach(panel);
          panels.delete(id);
          removed.fire(panel);
        },
      },
    } as FakePanel;
    group.panels.push(panel);
    panels.set(id, panel);
    if (loc === 'floating') makeWindow(group, box);
    return panel;
  }

  const api = {
    panels: [] as FakePanel[],
    groups,
    activePanel: null as FakePanel | null,
    component: {
      floatingGroups: floating,
      getFloatingWindowForGroup: (g: FakeGroup) => floating.find((w) => w.group === g),
      getFloatingContainer: () => container,
    },
    updateOptions() {},
    getPanel: (id: string) => panels.get(id),
    addPanel(opts: { id: string; title?: string }) {
      const panel = makePanel(opts.id, opts.title || opts.id, 'grid', { left: 0, top: 0, width: 600, height: 400 });
      api.panels = [...panels.values()];
      added.fire(panel);
      layout.fire();
      return panel;
    },
    addFloatingGroup(panel: FakePanel, pos?: { x?: number; y?: number; width?: number; height?: number }) {
      const box = {
        left: pos?.x ?? 24,
        top: pos?.y ?? 24,
        width: pos?.width ?? 480,
        height: pos?.height ?? 360,
      };
      detach(panel);
      const group = makeGroup('floating', box);
      group.panels.push(panel);
      panel.group = group;
      makeWindow(group, box);
      api.panels = [...panels.values()];
      moved.fire({ panel });
      layout.fire();
    },
    exitMaximizedGroup() {},
    maximizeGroup() {},
    adjacentGroupInDirection: () => undefined,
    onDidAddPanel: (fn: (p: FakePanel) => void) => added.sub(fn as never),
    onDidRemovePanel: (fn: (p: FakePanel) => void) => removed.sub(fn as never),
    onDidMovePanel: (fn: (e: { panel: FakePanel }) => void) => moved.sub(fn as never),
    onDidActiveGroupChange: (fn: () => void) => active.sub(fn as never),
    onDidLayoutChange: (fn: () => void) => layout.sub(fn as never),
    onWillMutateLayout: (fn: () => void) => will.sub(fn as never),
    onDidMutateLayout: (fn: () => void) => did.sub(fn as never),
    onDidMaximizedGroupChange: (fn: () => void) => max.sub(fn as never),
  };

  return {
    api: api as unknown as import('dockview-react').DockviewApi,
    seed(id: string, title: string, loc: Loc, box?: Box) {
      const panel = makePanel(id, title, loc, box ?? { left: 40, top: 30, width: 500, height: 320 });
      api.panels = [...panels.values()];
      return panel;
    },
    panel: (id: string) => panels.get(id),
    created,
  };
}

function scrollHost(): ScrollEl {
  return {
    isConnected: true,
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: 1000,
    clientHeight: 200,
    clientWidth: 400,
    getBoundingClientRect: () => domRect({ left: 0, top: 0, width: 400, height: 200 }),
    querySelectorAll: () => [],
    querySelector: () => null,
    closest: () => null,
  };
}

const managers: InstanceType<typeof import('../src/renderer/panel-manager/PanelManager').PanelManager>[] = [];
afterEach(() => {
  while (managers.length) managers.pop()!.detach();
  rafQueue.clear();
});

function hostFor(meta: Record<string, { title: string; kind: BubbleKind }>, ensured?: (id: string, info: CollapsedInfo) => void) {
  return {
    persist() {},
    sidebarWidth: () => 280,
    panelMeta: (id: string) => meta[id],
    ensurePanel: ensured,
  };
}

const KINDS: { kind: BubbleKind; title: string }[] = [
  { kind: 'file', title: '版本计划.md' },
  { kind: 'web', title: 'www.iana.org' },
  { kind: 'app', title: '记事本' },
  { kind: 'native-host', title: '本机宿主' },
];

describe('气泡收起后能打开', () => {
  for (const spec of KINDS) {
    it(`${spec.kind}：停靠收起后恢复到分屏，标题不是 unknown`, async () => {
      const dock = makeDock();
      const pm = new PanelManager();
      managers.push(pm);
      const id = `${spec.kind}-dock`;
      pm.setHost(hostFor({ [id]: spec }));
      pm.attach(dock.api);
      dock.seed(id, spec.title, 'grid');
      pm.collapseToBubble(id);
      const bubble = pm.bubbles().find((b) => b.id === id);
      expect(bubble).toMatchObject({ title: spec.title, kind: spec.kind });
      expect(bubble?.title).not.toBe('unknown');
      expect(bubble?.kind).not.toBe('unknown');
      pm.restoreFromBubble(id);
      expect(pm.isCollapsed(id)).toBe(false);
      expect(pm.get(id)?.mode).toBe('docked');
    });

    it(`${spec.kind}：浮动收起 → 序列化 → 反序列化 → 恢复到原矩形`, async () => {
      const box = { left: 100, top: 80, width: 520, height: 360 };
      const id = `${spec.kind}-float`;
      const first = makeDock();
      const a = new PanelManager();
      managers.push(a);
      a.setHost(hostFor({ [id]: spec }));
      a.attach(first.api);
      first.seed(id, spec.title, 'floating', box);
      a.collapseToBubble(id);
      expect(a.bubbles().find((b) => b.id === id)).toMatchObject({ title: spec.title, kind: spec.kind });
      const raw = a.serialize();
      expect(raw.collapsed[id]).toMatchObject({ from: 'floating', title: spec.title, kind: spec.kind, bounds: box });
      const migrated = migratePanelLayout(JSON.parse(JSON.stringify(raw))).layout;
      expect(migrated.collapsed[id]).toEqual(raw.collapsed[id]);

      const second = makeDock();
      const b = new PanelManager();
      managers.push(b);
      b.setHost(hostFor({ [id]: spec }));
      b.attach(second.api);
      second.seed(id, 'unknown', 'floating', { left: 12, top: 12, width: 480, height: 320 });
      b.restoreLayout(migrated);
      expect(b.bubbles().find((item) => item.id === id)).toMatchObject({ title: spec.title, kind: spec.kind });
      expect(b.bubbles().some((item) => item.title === 'unknown' || item.kind === 'unknown')).toBe(false);
      b.restoreFromBubble(id);
      expect(b.isCollapsed(id)).toBe(false);
      expect(b.get(id)?.mode).toBe('floating');
      expect(b.get(id)?.bounds).toEqual(box);
    });
  }

  it('文件面板收起期间滚动被清零，恢复后写回', () => {
    const dock = makeDock();
    const pm = new PanelManager();
    managers.push(pm);
    pm.setHost(hostFor({ note: { title: '版本计划.md', kind: 'file' } }));
    pm.attach(dock.api);
    const panel = dock.seed('note', '版本计划.md', 'grid');
    const scroller = scrollHost();
    scroller.scrollTop = 180;
    panel.view = { content: { element: scroller } };
    pm.collapseToBubble('note');
    scroller.scrollTop = 0;
    pm.restoreFromBubble('note');
    flushRaf(2);
    expect(scroller.scrollTop).toBe(180);
    expect(pm.get('note')?.mode).toBe('docked');
  });

  it('停靠面板收起再序列化，在已浮动的布局上恢复后仍回到分屏', () => {
    const id = 'note';
    const dock = makeDock();
    const pm = new PanelManager();
    managers.push(pm);
    pm.setHost(hostFor({ [id]: { title: '版本计划.md', kind: 'file' } }));
    pm.attach(dock.api);
    dock.seed(id, '版本计划.md', 'grid');
    pm.collapseToBubble(id);
    const raw = pm.serialize();
    expect(raw.collapsed[id]?.from).toBe('grid');

    const nextDock = makeDock();
    const next = new PanelManager();
    managers.push(next);
    next.setHost(hostFor({ [id]: { title: '版本计划.md', kind: 'file' } }));
    next.attach(nextDock.api);
    nextDock.seed(id, '版本计划.md', 'floating', { left: 30, top: 40, width: 400, height: 300 });
    next.restoreLayout(raw);
    expect(next.bubbles()[0]).toMatchObject({ id, title: '版本计划.md', kind: 'file' });
    next.restoreFromBubble(id);
    expect(next.get(id)?.mode).toBe('docked');
    expect(next.serialize().collapsed[id]).toBeUndefined();
  });

  it('侧栏收起后隐藏且不进气泡，恢复后停靠', () => {
    const dock = makeDock();
    const pm = new PanelManager();
    managers.push(pm);
    pm.setHost(hostFor({ note: { title: '版本计划.md', kind: 'file' } }));
    pm.attach(dock.api);
    dock.seed('note', '版本计划.md', 'grid');
    pm.collapseToBubble('note');
    pm.collapseToBubble(SIDEBAR_ID);
    expect(pm.isCollapsed(SIDEBAR_ID)).toBe(true);
    expect(pm.get(SIDEBAR_ID)?.mode).toBe('collapsed');
    expect(pm.bubbles().some((b) => b.id === SIDEBAR_ID || b.kind === 'sidebar')).toBe(false);
    expect(pm.bubbles()).toEqual([expect.objectContaining({ id: 'note', title: '版本计划.md', kind: 'file' })]);
    pm.restoreFromBubble(SIDEBAR_ID);
    expect(pm.isCollapsed(SIDEBAR_ID)).toBe(false);
    expect(pm.sidebarState().mode).toBe('docked');
    expect(pm.bubbles()[0]).toMatchObject({ id: 'note', title: '版本计划.md', kind: 'file' });
    pm.restoreFromBubble('note');
    expect(pm.isCollapsed('note')).toBe(false);
    expect(pm.bubbles()).toEqual([]);
  });

  it('面板标题是 unknown 时用条目标题', () => {
    const dock = makeDock();
    const pm = new PanelManager();
    managers.push(pm);
    pm.setHost(hostFor({ note: { title: '真正标题', kind: 'file' } }));
    pm.attach(dock.api);
    dock.seed('note', 'unknown', 'grid');
    pm.collapseToBubble('note');
    expect(pm.bubbles()[0]).toMatchObject({ title: '真正标题', kind: 'file' });
  });
});

describe('旧布局里的 unknown 气泡', () => {
  it('没有 from 的 unknown 记录会补上位置并保留标题；无法恢复的记录仍丢弃', () => {
    const { layout } = migratePanelLayout({
      v: 1,
      viewport: { width: 1200, height: 800 },
      collapsed: {
        old: { kind: 'unknown', title: '旧笔记', seq: 2 },
        bad: { from: 'nowhere' },
        path: { from: 'floating', title: 'C:\\secret\\a.md', seq: 1 },
        url: { title: 'https://example.com/a', kind: 'web', seq: 3 },
      },
      sidebar: { mode: 'docked' },
    });
    expect(layout.collapsed.old).toEqual({ from: 'floating', seq: 2, title: '旧笔记', kind: 'unknown' });
    expect(layout.collapsed.bad).toBeUndefined();
    expect(layout.collapsed.path).toEqual({ from: 'floating', seq: 1 });
    expect(layout.collapsed.url).toEqual({ from: 'floating', seq: 3, kind: 'web' });
    expect(JSON.stringify(layout)).not.toMatch(/secret|https:\/\/example/);
  });

  it('面板不在 dock 里时补出来再打开，收起记录不丢', () => {
    const dock = makeDock();
    const added: string[] = [];
    const pm = new PanelManager();
    managers.push(pm);
    pm.setHost(hostFor({ 'old-1': { title: '旧笔记', kind: 'file' } }, (id) => {
      dock.seed(id, '旧笔记', 'grid');
      added.push(id);
    }));
    pm.attach(dock.api);
    pm.restoreLayout({
      v: 1,
      viewport: { width: 1200, height: 800 },
      collapsed: { 'old-1': { kind: 'unknown', title: '旧笔记', seq: 2 } },
      sidebar: { mode: 'docked' },
    });
    expect(added).toEqual(['old-1']);
    expect(pm.bubbles()[0]).toMatchObject({ id: 'old-1', title: '旧笔记', kind: 'file' });
    expect(pm.serialize().collapsed['old-1']?.title).toBe('旧笔记');
    pm.restoreFromBubble('old-1');
    expect(pm.isCollapsed('old-1')).toBe(false);
    expect(pm.get('old-1')?.mode).toBe('floating');
  });

  it('补不出面板时点击不删除收起记录', () => {
    const dock = makeDock();
    const pm = new PanelManager();
    managers.push(pm);
    pm.setHost({ persist() {}, sidebarWidth: () => 280 });
    pm.attach(dock.api);
    pm.restoreLayout({
      v: 1,
      viewport: { width: 1200, height: 800 },
      collapsed: { ghost: { kind: 'unknown', title: '旧笔记', seq: 1 } },
      sidebar: { mode: 'docked' },
    });
    expect(pm.bubbles()[0]).toMatchObject({ title: '旧笔记', kind: 'panel' });
    pm.restoreFromBubble('ghost');
    expect(pm.isCollapsed('ghost')).toBe(true);
    expect(pm.bubbles()[0]?.title).toBe('旧笔记');
  });

  it('恢复条在阶段为 unknown 时不占底部，也不把 unknown 写成可见文字', () => {
    const html = renderToStaticMarkup(createElement(RestoreBar, {
      workspaceId: 'w',
      panels: [{ panelId: 'quiet', kind: 'file', title: '旧笔记' }],
    }));
    expect(html).not.toContain('data-testid="ws-restore"');
    expect(html).not.toContain('>unknown<');
  });
});

describe('停靠不复制、合并单栏保留两侧', () => {
  it('只有一个文档停靠到边缘不会复制实例', () => {
    const dock = makeDock();
    const pm = new PanelManager();
    managers.push(pm);
    pm.setHost(hostFor({ only: { title: '唯一.md', kind: 'file' } }));
    pm.attach(dock.api);
    const only = dock.seed('only', '唯一.md', 'floating', { left: 40, top: 30, width: 500, height: 320 });
    const before = dock.created.length;
    only.api.moveTo({ group: only.group, position: 'right' });
    pm.dock('only', { direction: 'right' });
    expect(dock.created.length).toBe(before);
    expect(dock.panel('only')).toBe(only);
    expect([...dock.api.panels].map((p) => p.id)).toEqual(['only']);
    expect(pm.get('only')?.id).toBe('only');
  });

  it('一个文档拖到已有分屏的边缘只移动，不复制', () => {
    const dock = makeDock();
    const pm = new PanelManager();
    managers.push(pm);
    pm.setHost(hostFor({}));
    pm.attach(dock.api);
    const stay = dock.seed('stay', '留下.md', 'grid');
    const moving = dock.seed('move', '移过去.md', 'floating', { left: 80, top: 60, width: 420, height: 300 });
    const before = dock.created.length;
    pm.dock('move', { ref: 'stay', direction: 'right' });
    expect(dock.created.length).toBe(before);
    expect(dock.panel('stay')).toBe(stay);
    expect(dock.panel('move')).toBe(moving);
    expect(moving.group).not.toBe(stay.group);
    expect(stay.group.panels.map((p) => p.id)).toEqual(['stay']);
    expect(moving.group.panels.map((p) => p.id)).toEqual(['move']);
    expect(pm.isCollapsed('stay')).toBe(false);
    expect(pm.isCollapsed('move')).toBe(false);
  });

  it('合并两个单栏时两侧文档都还在', () => {
    const dock = makeDock();
    const pm = new PanelManager();
    managers.push(pm);
    pm.setHost(hostFor({}));
    pm.attach(dock.api);
    const left = dock.seed('left', '左.md', 'grid');
    const right = dock.seed('right', '右.md', 'grid');
    const before = dock.created.length;
    right.api.moveTo({ group: left.group, position: 'center' });
    expect(dock.created.length).toBe(before);
    expect(dock.panel('left')).toBe(left);
    expect(dock.panel('right')).toBe(right);
    expect(left.group.panels.map((p) => p.id).sort()).toEqual(['left', 'right']);
    expect(pm.isCollapsed('left')).toBe(false);
    expect(pm.isCollapsed('right')).toBe(false);
    const stay = dock.seed('stay', '停.md', 'grid');
    const incoming = dock.seed('in', '并.md', 'floating', { left: 200, top: 40, width: 400, height: 300 });
    pm.dock('in', { ref: 'stay', direction: 'within' });
    expect(dock.panel('stay')).toBe(stay);
    expect(dock.panel('in')).toBe(incoming);
    expect(stay.group.panels.map((p) => p.id).sort()).toEqual(['in', 'stay']);
    expect([...dock.api.panels].map((p) => p.id).sort()).toEqual(['in', 'left', 'right', 'stay']);
  });
});

describe('停靠标签条', () => {
  it('隐藏只藏停靠组标签，不关面板、不改活动项，浮动标题还在', async () => {
    const dock = makeDock();
    const pm = new PanelManager();
    managers.push(pm);
    pm.setHost(hostFor({}));
    pm.attach(dock.api);
    const grid = dock.seed('doc', '笔记.md', 'grid');
    const floating = dock.seed('float', '浮窗.md', 'floating', { left: 30, top: 20, width: 400, height: 280 });
    dock.api.activePanel = grid as unknown as import('dockview-react').DockviewApi['activePanel'];
    const active = dock.api.activePanel;
    pm.hideDockedTabs();
    expect(pm.dockedTabsHidden()).toBe(true);
    expect(grid.group.header.hidden).toBe(true);
    expect(floating.group.header.hidden).toBe(false);
    expect(dock.panel('doc')).toBe(grid);
    expect(dock.panel('float')).toBe(floating);
    expect(dock.api.activePanel).toBe(active);
    expect([...dock.api.panels].map((p) => p.id).sort()).toEqual(['doc', 'float']);
    const added = dock.api.addPanel({ id: 'more', title: '另一份' });
    expect(added.group.header.hidden).toBe(true);
    expect(dock.api.getPanel('doc')).toBe(grid);
    expect(dock.api.activePanel).toBe(active);
    pm.showDocumentTabs();
    expect(pm.dockedTabsHidden()).toBe(false);
    expect(grid.group.header.hidden).toBe(false);
    expect(floating.group.header.hidden).toBe(false);
    expect(added.group.header.hidden).toBe(false);
    const exp = await import('../src/renderer/panel-manager/tabVisibility');
    expect(typeof exp.hideDockedTabs).toBe('function');
    expect(typeof exp.showDocumentTabs).toBe('function');
  });

  it('读回已收起的侧栏时仍不进气泡', () => {
    const dock = makeDock();
    const pm = new PanelManager();
    managers.push(pm);
    pm.setHost(hostFor({ note: { title: '版本计划.md', kind: 'file' } }));
    pm.attach(dock.api);
    dock.seed('note', '版本计划.md', 'floating', { left: 12, top: 12, width: 480, height: 320 });
    pm.restoreLayout({
      v: 1,
      viewport: { width: 1200, height: 800 },
      collapsed: { note: { from: 'floating', title: '版本计划.md', kind: 'file', seq: 2, bounds: { left: 12, top: 12, width: 480, height: 320 } } },
      sidebar: { mode: 'docked', collapsed: { from: 'sidebar-docked', seq: 1, title: '侧栏', kind: 'sidebar' } },
    });
    expect(pm.isCollapsed(SIDEBAR_ID)).toBe(true);
    expect(pm.bubbles().map((b) => b.id)).toEqual(['note']);
  });
});


describe('bubble tray position', () => {
  it('migrate keeps tray left/top', () => {
    const raw = {
      v: 1,
      viewport: { width: 800, height: 600 },
      order: [],
      collapsed: {
        'item.1': { from: 'floating', seq: 1, title: '笔记.md', kind: 'file', tray: { left: 24, top: 400 } },
      },
      floats: {},
      sidebar: { mode: 'docked' },
    };
    const { layout } = migratePanelLayout(raw);
    expect(layout.collapsed['item.1']?.tray).toEqual({ left: 24, top: 400 });
  });

  it('migrate drops invalid tray', () => {
    const raw = {
      v: 1,
      viewport: { width: 800, height: 600 },
      order: [],
      collapsed: {
        'item.1': { from: 'floating', seq: 1, title: '笔记.md', kind: 'file', tray: { left: 'x', top: 1 } },
      },
      floats: {},
      sidebar: { mode: 'docked' },
    };
    const { layout } = migratePanelLayout(raw);
    expect(layout.collapsed['item.1']?.tray).toBeUndefined();
  });
});
