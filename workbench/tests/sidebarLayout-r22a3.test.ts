import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { clampMainDragWidth, mainColumnViewport, planMainColumns, visibleColumnWidths, type MainColumnPlan } from '../src/shared/sidebarLayout';

function loadModule(spec: string): Promise<Record<string, any>> {
  return import(spec);
}

const read = (path: string) => readFileSync(new URL('../src/' + path, import.meta.url), 'utf8');

function expectSafe(plan: MainColumnPlan, viewport: number, ribbon = false) {
  plan.widths.forEach((width, index) => {
    expect(Number.isInteger(width)).toBe(true);
    if (ribbon && index === 0) {
      expect(width).toBe(44);
      return;
    }
    expect(width).toBeGreaterThanOrEqual(240);
    expect(width).not.toBe(44);
  });
  expect(plan.readerWidth).toBeGreaterThanOrEqual(360);
  if (plan.scroll) {
    expect(plan.readerWidth).toBe(360);
    return;
  }
  const used = plan.widths.reduce((total, width) => total + width, 0);
  expect(used + plan.readerWidth).toBeLessThanOrEqual(viewport + 1e-6);
  expect(used).toBeLessThanOrEqual(Math.max(0, viewport - 360) + 1e-6);
}

it('keeps saved widths when the reader still has 360px', () => {
  const roomy = planMainColumns([360, 280], 1400);
  expect(roomy).toEqual({ widths: [360, 280], readerWidth: 760, scroll: false });
  const readerAtFloor = planMainColumns([400, 400], 1160);
  expect(readerAtFloor).toEqual({ widths: [400, 400], readerWidth: 360, scroll: false });
  expect(planMainColumns([360], 1200)).toEqual({ widths: [360], readerWidth: 840, scroll: false });
  expect(planMainColumns([], 1000)).toEqual({ widths: [], readerWidth: 1000, scroll: false });
  const fractional = planMainColumns([360.9, 360.9], 2000);
  expect(fractional.widths).toEqual([360, 360]);
  expect(fractional.readerWidth).toBe(1280);
  expect(fractional.scroll).toBe(false);
  expectSafe(roomy, 1400);
  expectSafe(readerAtFloor, 1160);
  expectSafe(fractional, 2000);
});

it('compresses columns above 240 in proportion and gives the leftover pixel to the last column', () => {
  const two = planMainColumns([480, 360], 1000);
  expect(two).toEqual({ widths: [346, 294], readerWidth: 360, scroll: false });
  const three = planMainColumns([501, 400, 300], 1200);
  expect(three.widths.reduce((total, width) => total + width, 0)).toBe(840);
  expect(three.readerWidth).toBe(360);
  expect(three.scroll).toBe(false);
  expect(three.widths.every(width => width >= 240)).toBe(true);
  const one = planMainColumns([900], 700);
  expect(one).toEqual({ widths: [340], readerWidth: 360, scroll: false });
  const subpixel = planMainColumns([480, 360], 1000.4);
  expect(subpixel.widths).toEqual([346, 294]);
  expect(subpixel.readerWidth).toBeCloseTo(360.4);
  expect(subpixel.scroll).toBe(false);
  expectSafe(two, 1000);
  expectSafe(three, 1200);
  expectSafe(one, 700);
  expectSafe(subpixel, 1000.4);
});

it('scrolls the column strip once every flexible column is at 240 and keeps the reader at 360', () => {
  expect(planMainColumns([360, 360, 360], 1000)).toEqual({ widths: [240, 240, 240], readerWidth: 360, scroll: true });
  expect(planMainColumns([360, 360], 800)).toEqual({ widths: [240, 240], readerWidth: 360, scroll: true });
  expect(planMainColumns([900], 500)).toEqual({ widths: [240], readerWidth: 360, scroll: true });
  expect(planMainColumns([], 100)).toEqual({ widths: [], readerWidth: 360, scroll: true });
  for (const plan of [
    planMainColumns([360, 360, 360], 1000),
    planMainColumns([360, 360], 800),
    planMainColumns([900], 500),
  ]) expectSafe(plan, 0);
});

it('keeps a user-collapsed ribbon at 44 and still refuses to rail the other columns', () => {
  const fitted = planMainColumns([360, 400], 1400, { ribbonCollapsed: true });
  expect(fitted).toEqual({ widths: [44, 400], readerWidth: 956, scroll: false });
  const squeezed = planMainColumns([360, 360, 360], 900, { ribbonCollapsed: true });
  expect(squeezed).toEqual({ widths: [44, 248, 248], readerWidth: 360, scroll: false });
  const scrolled = planMainColumns([360, 400, 300], 700, { ribbonCollapsed: true });
  expect(scrolled).toEqual({ widths: [44, 240, 240], readerWidth: 360, scroll: true });
  const onlyRibbon = planMainColumns([360], 1000, { ribbonCollapsed: true });
  expect(onlyRibbon).toEqual({ widths: [44], readerWidth: 956, scroll: false });
  expectSafe(fitted, 1400, true);
  expectSafe(squeezed, 900, true);
  expectSafe(scrolled, 700, true);
  expectSafe(onlyRibbon, 1000, true);
  expect(planMainColumns([44, 360], 2000).widths).toEqual([240, 360]);
});

it('treats non-finite input as an empty viewport or the default column width', () => {
  expect(planMainColumns([360, 360], Number.NaN)).toEqual({ widths: [240, 240], readerWidth: 360, scroll: true });
  expect(planMainColumns([360], Number.POSITIVE_INFINITY).scroll).toBe(true);
  const replaced = planMainColumns([Number.NaN, Number.POSITIVE_INFINITY, -20], 2000);
  expect(replaced).toEqual({ widths: [360, 360, 240], readerWidth: 1040, scroll: false });
  expectSafe(replaced, 2000);
});

it('never paints a 44px column from space pressure across one, two and three columns', () => {
  const samples = [[240], [360], [900], [360, 360], [480, 360], [500, 400, 300], [900, 800, 700]];
  const views = [0, 100, 500, 640, 800, 1000, 1100, 1400, 2000, 1000.4, Number.NaN, Number.POSITIVE_INFINITY];
  for (const widths of samples) {
    for (const viewport of views) {
      for (const ribbon of [false, true]) {
        const plan = planMainColumns(widths, viewport, { ribbonCollapsed: ribbon });
        const view = Number.isFinite(viewport) ? viewport : 0;
        expectSafe(plan, view, ribbon && widths.length > 0);
      }
    }
  }
});

it('stops a main-mode drag at 240 and at the reader floor, and only shrinks once already over the cap', () => {
  expect(clampMainDragWidth(100, 360, 0, 2000)).toBe(240);
  expect(clampMainDragWidth(500, 360, 400, 1400)).toBe(500);
  expect(clampMainDragWidth(900, 360, 400, 1400)).toBe(640);
  expect(clampMainDragWidth(900, 360, 400, 1400.9)).toBe(640);
  expect(clampMainDragWidth(900, 800, 400, 1400)).toBe(800);
  expect(clampMainDragWidth(700, 800, 400, 1400)).toBe(700);
  expect(clampMainDragWidth(400, 800, 400, 1400)).toBe(400);
  expect(clampMainDragWidth(100, 800, 400, 1400)).toBe(240);
  expect(clampMainDragWidth(500, 400, 400, 800)).toBe(400);
  expect(clampMainDragWidth(300, 400, 400, 800)).toBe(300);
  expect(clampMainDragWidth(100, 400, 400, 800)).toBe(240);
  expect(clampMainDragWidth(Number.NaN, 300, 0, 2000)).toBe(300);
  expect(clampMainDragWidth(Number.POSITIVE_INFINITY, 300, 0, 1200)).toBe(300);
  expect(clampMainDragWidth(800, 300, 0, Number.POSITIVE_INFINITY)).toBe(800);
  expect(clampMainDragWidth(500, 300, 0, Number.NaN)).toBe(300);
  expect(clampMainDragWidth(200, 300, 0, Number.NaN)).toBe(240);
});

it('budgets main columns against the shell content box', () => {
  expect(mainColumnViewport({ windowWidth: 1428 })).toBe(1428);
  expect(mainColumnViewport({ windowWidth: 1428, mainClientWidth: 1428, paddingLeft: 0, paddingRight: 0 })).toBe(1428);
  expect(mainColumnViewport({ windowWidth: 1428, mainClientWidth: 1428, paddingLeft: 10, paddingRight: 10 })).toBe(1408);
  expect(mainColumnViewport({ windowWidth: Number.NaN })).toBe(0);
  expect(mainColumnViewport({ windowWidth: 1428, mainClientWidth: Number.NaN, paddingLeft: 10, paddingRight: 10 })).toBe(1428);
});

it('still exposes the old rail helper for callers that have not moved', () => {
  expect(visibleColumnWidths([{ modules: [], width: 360 }, { modules: [], width: 360 }], 1000)).toEqual([360, 44]);
});

it('lets the reader keep 360px in CSS without touching the sidebar shell', () => {
  const css = read('renderer/drawer/columns.css');
  expect(css).toContain('.main > .kb-sidebar:has(.kb-columns[data-mode=main]) { flex:0 1 auto; min-width:0!important; max-width:calc(100% - 360px)!important; overflow:hidden; }');
  expect(css).toContain('.main:has(.kb-columns[data-mode=main]) > .center { flex:1 0 360px; min-width:360px; }');
  expect(css).toContain('.kb-columns[data-mode=main] > .kb-column { overflow:hidden; min-width:0; }');
  expect(css).toContain('.kb-column > .kb-drawer { flex:1; width:100%!important; min-width:0!important;');
  expect(css).toContain('.app.kb-sidebar-shell { height:100vh;');
  expect(css).toContain('.kb-columns[data-mode=sidebar] { width:100%; max-width:100%; overflow-x:auto; }');
  const shell = read('renderer/MainShell.tsx');
  expect(shell).toContain('style={{ minWidth: 360 }}');
});

const memory = new Map<string, string>();
const g = globalThis as Record<string, any>;
const previous = {
  window: Object.getOwnPropertyDescriptor(g, 'window'),
  localStorage: Object.getOwnPropertyDescriptor(g, 'localStorage'),
};

afterEach(() => {
  memory.clear();
  if (previous.window) Object.defineProperty(g, 'window', previous.window);
  else delete g.window;
  if (previous.localStorage) Object.defineProperty(g, 'localStorage', previous.localStorage);
  else delete g.localStorage;
});

async function renderColumns(innerWidth: number, ribbon: boolean) {
  g.localStorage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => { memory.set(key, value); },
    removeItem: (key: string) => { memory.delete(key); },
  };
  g.window = {
    innerWidth,
    kb: { getLayout: async () => null, setLayout: async () => undefined, sidebarWindow: async () => undefined },
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };
  const { updateSidebarPrefs } = await import('../src/renderer/drawer/sidebarPrefs');
  updateSidebarPrefs({ categoriesLayout: ribbon ? 'list' : 'grid', ribbonCollapsed: ribbon, categoriesCollapsed: false });
  const { ColumnsDrawer } = await import('../src/renderer/drawer/ColumnsDrawer');
  const react = await loadModule('react');
  const server = await loadModule('react-dom/server');
  return server.renderToStaticMarkup(react.createElement(ColumnsDrawer, {
    open: true,
    mode: 'main',
    layoutSeed: {
      v: 1,
      cols: [
        { modules: ['root'], width: 360 },
        { modules: ['fav'], width: 360 },
        { modules: ['web'], width: 360 },
      ],
    },
    width: 360,
    onWidth: () => undefined,
    onSelectionChange: () => undefined,
    selection: ['root', 'fav', 'web'],
    slots: { root: '根', fav: '藏', web: '网' },
  })) as string;
}

it('renders three main columns in a narrow window without a rail', async () => {
  const html = await renderColumns(700, false);
  expect(html).not.toContain('kb-column-rail');
  expect(html).not.toContain('data-collapsed="true"');
  expect(html.match(/width:240px/g)?.length).toBe(3);
  expect(html).toContain('width:360px');
});

it('keeps only the first column as a rail when the user collapsed the ribbon', async () => {
  const html = await renderColumns(900, true);
  expect(html.match(/class="kb-column-rail"/g)?.length).toBe(1);
  expect(html.match(/data-collapsed="true"/g)?.length).toBe(1);
  expect(html).toContain('width:44px');
  expect(html.match(/width:248px/g)?.length).toBe(2);
});
