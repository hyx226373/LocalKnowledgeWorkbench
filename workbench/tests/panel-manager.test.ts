/** 第九轮 · 布局组：统一面板管理层的纯函数（找回、吸附、windows 序列化/迁移、浮动组裁剪、视图窗口声明）与保存链路 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cascadeBox, GRAB_VISIBLE, isInside, keepGrabbable, maximizedBox, rescueBox, snapBox } from '../src/renderer/panel-manager/geometry';
import { defaultPanelLayout, finalizePanelLayout, migratePanelLayout } from '../src/renderer/panel-manager/serialize';
import { resolveViewWindow } from '../src/renderer/panel-manager/viewContract';
import { MAX_WINDOWS_BYTES, PANEL_LAYOUT_VERSION, SIDEBAR_ID } from '../src/renderer/panel-manager/types';
import { coveringWindows, dragShieldActive, ownLayer, windowCoverProbe } from '../src/renderer/panel-manager/webOcclusion';
import { pruneDock, type SerializedDock } from '../src/shared/items';
import { migrateLayout, toStoredLayout } from '../src/renderer/plugin-host/layoutModel';
import { makeService } from './helpers';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe('找回（屏幕变小后浮动窗口夹回可见区域）', () => {
  const c = { width: 1000, height: 600 };
  it('越界的窗口平移回容器内，尺寸不变', () => {
    expect(rescueBox({ left: 1500, top: 900, width: 400, height: 300 }, c)).toEqual({ left: 600, top: 300, width: 400, height: 300 });
    expect(rescueBox({ left: -200, top: -50, width: 400, height: 300 }, c)).toEqual({ left: 0, top: 0, width: 400, height: 300 });
  });
  it('比容器大的窗口缩到容器大小', () => {
    const b = rescueBox({ left: 100, top: 100, width: 1800, height: 1200 }, c);
    expect(b).toEqual({ left: 0, top: 0, width: 1000, height: 600 });
    expect(isInside(b, c)).toBe(true);
  });
  it('1920×1080 上保存的一组窗口在 1024×700 窗口（dock 区域约 744×600）里全部可见', () => {
    const small = { width: 744, height: 600 };
    const saved = [
      { left: 1300, top: 500, width: 600, height: 500 },
      { left: 40, top: 30, width: 1200, height: 900 },
      { left: 900, top: -20, width: 300, height: 200 },
    ];
    for (const b of saved) expect(isInside(rescueBox(b, small), small)).toBe(true);
  });
  it('容器比最小尺寸还小时也不越界', () => {
    const tiny = { width: 150, height: 100 };
    expect(isInside(rescueBox({ left: 50, top: 50, width: 400, height: 300 }, tiny), tiny)).toBe(true);
  });
  it('最大化矩形 = 容器；新窗口错开排列且在容器内', () => {
    expect(maximizedBox(c)).toEqual({ left: 0, top: 0, width: 1000, height: 600 });
    for (let i = 0; i < 20; i++) expect(isInside(cascadeBox(i, c), c)).toBe(true);
  });
});

describe('吸附（阈值 8px）', () => {
  const c = { width: 1000, height: 600 };
  it('贴近容器边缘与其他窗口边缘时对齐，远离时不动', () => {
    expect(snapBox({ left: 5, top: 7, width: 300, height: 200 }, c, [])).toMatchObject({ left: 0, top: 0 });
    expect(snapBox({ left: 695, top: 395, width: 300, height: 200 }, c, [])).toMatchObject({ left: 700, top: 400 });
    expect(snapBox({ left: 406, top: 100, width: 300, height: 200 }, c, [{ left: 100, top: 100, width: 300, height: 200 }])).toMatchObject({ left: 400 });
    expect(snapBox({ left: 420, top: 100, width: 300, height: 200 }, c, [{ left: 100, top: 100, width: 300, height: 200 }])).toMatchObject({ left: 420 });
  });
});

describe('部分移出（标题栏至少 40px 可见）', () => {
  const c = { width: 1000, height: 600 };
  it('左右与下方可以部分移出，但标题栏左上 40×40 留在可见区域；顶部不能移出', () => {
    expect(GRAB_VISIBLE).toBe(40);
    expect(keepGrabbable({ left: 3000, top: 3000, width: 400, height: 300 }, c)).toEqual({ left: 960, top: 560, width: 400, height: 300 });
    expect(keepGrabbable({ left: -200, top: -50, width: 400, height: 300 }, c)).toEqual({ left: -200, top: 0, width: 400, height: 300 });
    expect(keepGrabbable({ left: -1000, top: 100, width: 400, height: 300 }, c)).toEqual({ left: -360, top: 100, width: 400, height: 300 });
    expect(keepGrabbable({ left: 100, top: 100, width: 400, height: 300 }, c)).toEqual({ left: 100, top: 100, width: 400, height: 300 });
  });
  it('尺寸不小于 240×140', () => {
    expect(keepGrabbable({ left: 10, top: 10, width: 100, height: 50 }, c)).toMatchObject({ width: 240, height: 140 });
  });
});

describe('layout.windows 序列化与迁移', () => {
  it('缺失（第八轮及更早的工作区）→ 默认：侧栏停靠、无气泡、无层级', () => {
    const r = migratePanelLayout(undefined);
    expect(r.from).toBe(0);
    expect(r.layout).toEqual(defaultPanelLayout());
    expect(r.layout.v).toBe(PANEL_LAYOUT_VERSION);
  });
  it('v1 往返；非法字段被丢弃（路径/URL/超长 id/非数字）', () => {
    const raw = {
      v: 1,
      viewport: { width: 1200, height: 700 },
      order: ['it-a', SIDEBAR_ID, 'C:\\Users\\x\\secret.pdf', 'it-a'],
      collapsed: { 'it-b': { from: 'grid', dockRef: 'it-a', dockDir: 'right', seq: 3 }, 'it-c': { from: 'floating', bounds: { left: 10, top: 20, width: 300, height: 200 }, seq: 4 }, bad: { from: 'nowhere' } },
      floats: { 'it-a': { maximized: { restore: { left: 1, top: 2, width: 300, height: 200 } } }, 'it-x': { maximized: { restore: { left: 'a' } } } },
      gridMaximized: 'it-d',
      sidebar: { mode: 'floating', bounds: { left: 5, top: 6, width: 280, height: 500 }, token: 'abc', content: 'x'.repeat(10) },
    };
    const { layout, from } = migratePanelLayout(raw);
    expect(from).toBe(1);
    expect(layout.order).toEqual(['it-a', SIDEBAR_ID]);
    expect(Object.keys(layout.collapsed)).toEqual(['it-b', 'it-c']);
    expect(layout.collapsed['it-b']).toEqual({ from: 'grid', dockRef: 'it-a', dockDir: 'right', seq: 3 });
    expect(Object.keys(layout.floats)).toEqual(['it-a']);
    expect(layout.sidebar).toEqual({ mode: 'floating', bounds: { left: 5, top: 6, width: 280, height: 500 } });
    expect(JSON.stringify(layout)).not.toMatch(/token|content|Users/);
    expect(migratePanelLayout(JSON.parse(JSON.stringify(layout))).layout).toEqual(layout);
  });
  it('更新版本（v2）：读取已知字段（只加字段的约定），不报错', () => {
    const { layout, from } = migratePanelLayout({ v: 2, order: ['it-a'], sidebar: { mode: 'docked' }, futureField: { a: 1 } });
    expect(from).toBe(2);
    expect(layout.order).toEqual(['it-a']);
    expect((layout as unknown as Record<string, unknown>).futureField).toBeUndefined();
  });
  it('非对象 / 无版本号 → 默认', () => {
    expect(migratePanelLayout('x').layout).toEqual(defaultPanelLayout());
    expect(migratePanelLayout({ order: ['a'] }).layout.order).toEqual([]);
  });
  it('保存前只保留仍存在的面板；超过上限只保留侧栏', () => {
    const l = { ...defaultPanelLayout({ width: 1, height: 1 }), order: ['a', 'gone', SIDEBAR_ID], collapsed: { gone: { from: 'grid' as const, seq: 1 } }, gridMaximized: 'gone' };
    const f = finalizePanelLayout(l, new Set(['a']));
    expect(f.order).toEqual(['a', SIDEBAR_ID]);
    expect(f.collapsed).toEqual({});
    expect(f.gridMaximized).toBeUndefined();
    const ids = Array.from({ length: 3000 }, (_, i) => `it-${'x'.repeat(30)}-${i}`);
    const big = finalizePanelLayout({ ...l, order: ids, sidebar: { mode: 'floating' } }, new Set(ids));
    expect(JSON.stringify(big).length).toBeLessThan(MAX_WINDOWS_BYTES);
    expect(big.sidebar.mode).toBe('floating');
  });
});

const leaf = (id: string, views: string[]) => ({ type: 'leaf' as const, size: 400, data: { id, views, activeView: views[0] } });
const dockWithFloats = (): SerializedDock => ({
  grid: { root: { type: 'branch', size: 600, data: [leaf('1', ['a']), leaf('2', ['b'])] }, width: 800, height: 600, orientation: 'HORIZONTAL' },
  panels: Object.fromEntries(['a', 'b', 'c', 'd', SIDEBAR_ID].map((id) => [id, { id, contentComponent: id === SIDEBAR_ID ? SIDEBAR_ID : 'view', params: id === SIDEBAR_ID ? {} : { itemId: id } }])),
  activeGroup: '9',
  floatingGroups: [
    { data: { id: '3', views: ['c'], activeView: 'c' }, position: { left: 10, top: 10, width: 300, height: 200 } },
    { data: { id: '9', views: [SIDEBAR_ID], activeView: SIDEBAR_ID }, position: { left: 0, top: 0, width: 280, height: 500 } },
    { grid: { root: { type: 'branch', size: 300, data: [leaf('4', ['d'])] }, width: 300, height: 300, orientation: 'HORIZONTAL' }, position: { left: 40, top: 40, width: 300, height: 300 } },
  ],
});

describe('pruneDock 处理浮动窗口（dockview floatingGroups）', () => {
  it('去掉侧栏面板时其浮动窗口整个删除，activeGroup 改指存在的分组', () => {
    const d = pruneDock(dockWithFloats(), (id) => id !== SIDEBAR_ID)!;
    expect(Object.keys(d.panels).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect((d.floatingGroups as unknown[]).length).toBe(2);
    expect(['1', '2', '3', '4']).toContain(d.activeGroup);
  });
  it('只剩浮动面板时分屏为空分支，浮动窗口保留', () => {
    const d = pruneDock(dockWithFloats(), (id) => id === 'c')!;
    expect(d.grid.root).toMatchObject({ type: 'branch', data: [] });
    expect((d.floatingGroups as { data: { views: string[] } }[])[0].data.views).toEqual(['c']);
  });
  it('嵌套 grid 形式的浮动窗口同样裁剪；全部去掉 → null', () => {
    const d = pruneDock(dockWithFloats(), (id) => id !== 'd' && id !== SIDEBAR_ID)!;
    expect((d.floatingGroups as unknown[]).length).toBe(1);
    expect(pruneDock(dockWithFloats(), () => false)).toBeNull();
  });
  it('迁移（打开工作区）时引用不存在条目的浮动面板被裁掉，不会让 dockview fromJSON 失败', () => {
    const dock = pruneDock(dockWithFloats(), (id) => id !== SIDEBAR_ID)!;
    const items = ['a', 'b', 'd'].map((id) => ({ itemId: id, sourceKind: 'file', adapterId: 'auto', ref: 'r' + id, displayMode: 'in-app-reader' }));
    const m = migrateLayout({ schema: 4, dock, shell: { sidebarWidth: 300 } }, {}, items as never);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(Object.keys(m.layout.dock!.panels).sort()).toEqual(['a', 'b', 'd']);
    expect((m.layout.dock!.floatingGroups as unknown[]).length).toBe(1);
    const st = toStoredLayout(m.layout.dock, m.layout.items, m.layout.shell);
    expect(st.items.map((i) => i.itemId).sort()).toEqual(['a', 'b', 'd']);
  });
});

describe('保存链路：layout.windows 原样进出数据库（schema 仍为 4）', () => {
  it('saveWorkspaceLayout 接受 windows 字段；导出文件中保留', async () => {
    const { svc } = await makeService();
    cleanups.push(() => svc.close());
    const id = svc.getCurrentWorkspaceId();
    const dock = pruneDock(dockWithFloats(), (x) => x !== SIDEBAR_ID)!;
    const items = ['a', 'b', 'c', 'd'].map((x) => ({ itemId: x, sourceKind: 'file', adapterId: 'auto', ref: 'res' + x, displayMode: 'in-app-reader' }));
    const windows = { ...defaultPanelLayout({ width: 800, height: 600 }), order: ['c', 'd', SIDEBAR_ID], collapsed: { b: { from: 'grid', dockRef: 'a', dockDir: 'right', seq: 1 } }, sidebar: { mode: 'floating', bounds: { left: 1, top: 2, width: 280, height: 400 } } };
    svc.saveWorkspaceLayout(id, { schema: 4, dock, shell: { sidebarWidth: 300 }, windows }, items);
    const ws = svc.getWorkspace(id);
    expect(ws.layoutSchema).toBe(4);
    expect((ws.layout as { windows: unknown }).windows).toEqual(windows);
    expect((svc.exportWorkspace(id).layout as { windows: unknown }).windows).toEqual(windows);
  });
});

describe('网页遮挡（拖动中的浮动层与浮层仍要求遮挡）', () => {
  type Box = { left: number; top: number; width: number; height: number };
  type FakeNode = {
    classList: { contains(name: string): boolean };
    attrs: Map<string, string>;
    hasAttribute(name: string): boolean;
    parentElement: FakeNode | null;
    z: string;
    rect: { left: number; top: number; right: number; bottom: number; width: number; height: number; x: number; y: number; toJSON(): object };
    getBoundingClientRect(): FakeNode['rect'];
    contains(node: FakeNode): boolean;
  };
  const nodes: FakeNode[] = [];
  const prevDoc = globalThis.document;
  const prevStyle = globalThis.getComputedStyle;

  function box(b: Box): FakeNode['rect'] {
    return { left: b.left, top: b.top, width: b.width, height: b.height, right: b.left + b.width, bottom: b.top + b.height, x: b.left, y: b.top, toJSON() { return {}; } };
  }
  function el(className: string, b: Box, z = 'auto'): FakeNode {
    const classes = new Set(className.split(/\s+/).filter(Boolean));
    const node: FakeNode = {
      classList: { contains: (name) => classes.has(name) },
      attrs: new Map(),
      hasAttribute(name) { return node.attrs.has(name); },
      parentElement: null,
      z,
      rect: box(b),
      getBoundingClientRect() { return node.rect; },
      contains(other) {
        let p: FakeNode | null = other;
        while (p) {
          if (p === node) return true;
          p = p.parentElement;
        }
        return false;
      },
    };
    nodes.push(node);
    return node;
  }
  function child(parent: FakeNode, node: FakeNode) {
    node.parentElement = parent;
    return node;
  }

  beforeAll(() => {
    globalThis.document = {
      querySelectorAll(sel: string) {
        const cls = sel.startsWith('.') ? sel.slice(1) : sel;
        return nodes.filter((n) => n.classList.contains(cls));
      },
    } as unknown as Document;
    globalThis.getComputedStyle = ((node: FakeNode) => ({ zIndex: node.z })) as unknown as typeof getComputedStyle;
  });
  afterAll(() => {
    globalThis.document = prevDoc;
    globalThis.getComputedStyle = prevStyle;
    nodes.length = 0;
  });

  it('更高的浮动窗口盖住网页时要求遮挡；拖动中的同一层窗口也要求遮挡', () => {
    nodes.length = 0;
    const dock = el('dv-dockview', { left: 0, top: 0, width: 800, height: 600 });
    const slot = child(dock, el('kb-web-slot', { left: 20, top: 40, width: 300, height: 200 }));
    const r = slot.getBoundingClientRect();
    expect(ownLayer(slot as unknown as Element)).toBe(0);
    expect(windowCoverProbe(slot as unknown as Element, r as unknown as DOMRect)).toBe(false);
    const float = el('dv-resize-container', { left: 40, top: 50, width: 280, height: 180 }, '8');
    expect(coveringWindows(slot as unknown as Element, r as unknown as DOMRect)).toEqual([float]);
    expect(windowCoverProbe(slot as unknown as Element, r as unknown as DOMRect)).toBe(true);
    float.rect = box({ left: 200, top: 80, width: 280, height: 180 });
    expect(windowCoverProbe(slot as unknown as Element, r as unknown as DOMRect)).toBe(true);
  });

  it('收起、隐藏、更低、不相交或窗口自己都不算遮挡', () => {
    nodes.length = 0;
    const host = el('dv-resize-container', { left: 0, top: 0, width: 400, height: 300 }, '2');
    const slot = child(host, el('kb-web-slot', { left: 10, top: 10, width: 200, height: 120 }));
    const r = slot.getBoundingClientRect();
    expect(ownLayer(slot as unknown as Element)).toBe(2);
    const collapsed = el('dv-resize-container', { left: 0, top: 0, width: 400, height: 300 }, '9');
    collapsed.attrs.set('data-pm-collapsed', '1');
    const hidden = el('dv-resize-container dv-hidden', { left: 0, top: 0, width: 400, height: 300 }, '9');
    el('dv-resize-container', { left: 0, top: 0, width: 400, height: 300 }, '1');
    el('dv-resize-container', { left: 500, top: 500, width: 100, height: 80 }, '9');
    expect(coveringWindows(slot as unknown as Element, r as unknown as DOMRect)).toEqual([]);
    expect(windowCoverProbe(slot as unknown as Element, r as unknown as DOMRect)).toBe(false);
    expect(hidden.classList.contains('dv-hidden')).toBe(true);
  });
});


describe('dragShieldActive：不因自身 pm-drag-shield 自锁', () => {
  const prevDoc = globalThis.document;
  const nodes: { classList: { contains(c: string): boolean }; attrs: Map<string, string>; matches?(s: string): boolean }[] = [];
  function el(cls: string, attrs: Record<string, string> = {}) {
    const attrMap = new Map(Object.entries(attrs));
    const node = {
      classList: { contains: (c: string) => cls.split(/\s+/).includes(c) },
      attrs: attrMap,
      matches(sel: string) {
        if (sel === '.pm-drag-shield[data-active="true"]') return cls.split(/\s+/).includes('pm-drag-shield') && attrMap.get('data-active') === 'true';
        if (sel.startsWith('.') && !sel.includes('[')) return cls.split(/\s+/).includes(sel.slice(1));
        return false;
      },
      getAttribute(name: string) { return attrMap.get(name) ?? null; },
    };
    nodes.push(node);
    return node;
  }
  beforeAll(() => {
    globalThis.document = {
      querySelector(sel: string) {
        return nodes.find((n) => n.matches?.(sel)) ?? null;
      },
      querySelectorAll(sel: string) {
        const cls = sel.startsWith('.') && !sel.includes('[') ? sel.slice(1) : '';
        return nodes.filter((n) => (cls ? n.classList.contains(cls) : n.matches?.(sel)));
      },
    } as unknown as Document;
  });
  afterAll(() => {
    globalThis.document = prevDoc;
    nodes.length = 0;
  });
  it('仅有 pm-drag-shield 时不算拖动期（避免 DragShield 永久自锁）', () => {
    nodes.length = 0;
    el('pm-drag-shield', { 'data-active': 'true' });
    expect(dragShieldActive()).toBe(false);
  });
  it('真正拖动 / 停靠预览时仍为 true', () => {
    nodes.length = 0;
    el('dv-resize-container-dragging');
    expect(dragShieldActive()).toBe(true);
    nodes.length = 0;
    el('dv-drop-target-selection');
    expect(dragShieldActive()).toBe(true);
  });
});

describe('插件视图窗口声明（接口草案）', () => {
  it('默认值：可浮动/停靠/收起/最大化，最小 240×140；网页显示方式推断为原生表面', () => {
    const r = resolveViewWindow(undefined, 'in-app-web');
    expect(r.errors).toEqual([]);
    expect(r.value).toMatchObject({ canFloat: true, canDock: true, canCollapse: true, canMaximize: true, minSize: { width: 240, height: 140 }, nativeSurface: true, canPopout: false });
    expect(resolveViewWindow({}, 'in-app-reader').value.nativeSurface).toBe(false);
  });
  it('非法声明给出错误', () => {
    expect(resolveViewWindow({ canFloat: false, canDock: false }).errors.length).toBe(1);
    expect(resolveViewWindow({ minSize: { width: 10 } }).errors[0]).toMatch(/minSize/);
    expect(resolveViewWindow({ minSize: { width: 400, height: 300 }, defaultFloatSize: { width: 300, height: 300 } }).errors[0]).toMatch(/defaultFloatSize/);
    expect(resolveViewWindow({ canFloat: 'yes' }).errors[0]).toMatch(/布尔/);
    expect(resolveViewWindow({ initialPlacement: 'float', canFloat: false }).errors.length).toBeGreaterThan(0);
  });
});
