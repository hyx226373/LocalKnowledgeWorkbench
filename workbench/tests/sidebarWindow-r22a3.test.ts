import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { planSidebarAutoWidth, type Rect } from '../src/shared/sidebarLayout';
import { nearlySameRect } from '../src/shared/sidebarWindow';

const fake = vi.hoisted(() => ({ handler: null as any, reduced: true }));
vi.mock('electron', () => ({
  ipcMain: { handle: (_channel: string, callback: unknown) => { fake.handler = callback; } },
  systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: fake.reduced }) },
  screen: {
    getDisplayMatching: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getAllDisplays: () => [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
    getPrimaryDisplay: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
  },
}));
import { registerSidebarWindow } from '../src/main/sidebarWindow';

type Quantize = (rect: Rect) => Rect;

/** Constant per-call bias. scale 1.25: width/height +1, y -1. scale 1.5: width/height +2, y -1. */
function biasQuantize(scale: 1.25 | 1.5): Quantize {
  const grow = scale === 1.25 ? 1 : 2;
  return (rect) => ({ x: rect.x, y: rect.y - 1, width: rect.width + grow, height: rect.height + grow });
}

/**
 * DIP → physical pixels → DIP.
 * Physical pixels use `round` or `ceil`. The DIP read-back is physical/scale, not a second
 * rounding: rounding both ways is an identity on integer DIP, so the old code would not drift.
 * At 1.5×, round and ceil agree on integer DIP (halves round away from zero). At 1.25× they
 * differ when the fractional part is below 1/2. The sample rect below hits that case.
 */
function dipQuantize(scale: number, mode: 'round' | 'ceil'): Quantize {
  const axis = (dip: number) => {
    const physical = dip * scale;
    const pixels = mode === 'ceil' ? Math.ceil(physical - 1e-9) : Math.round(physical);
    return pixels / scale;
  };
  return (rect) => ({ x: axis(rect.x), y: axis(rect.y), width: axis(rect.width), height: axis(rect.height) });
}

/** 201/1201/801 are 1 mod 4, so 1.25× round and ceil land on different pixels. */
const initialRect: Rect = { x: 100, y: 201, width: 1201, height: 801 };

beforeEach(() => { vi.useFakeTimers(); fake.reduced = true; });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

function setup(quantize: Quantize, initial: Rect = { x: 100, y: 50, width: 1200, height: 800 }) {
  const values = new Map<string, unknown>([['settings.uiChrome', { reduceMotion: true }]]);
  let reported = { ...initial };
  const sets: Rect[] = [];
  const listeners: Record<string, Array<() => void>> = {};
  const win: any = {
    webContents: {},
    getBounds: () => ({ ...reported }),
    getNormalBounds: () => ({ ...reported }),
    isMinimized: () => false,
    isFullScreen: () => false,
    restore: vi.fn(),
    setBounds: vi.fn((next: Rect) => { sets.push({ ...next }); reported = quantize(next); }),
    getMinimumSize: () => [600, 400],
    setMinimumSize: vi.fn(),
    isMaximized: () => false,
    unmaximize: vi.fn(),
    maximize: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    isDestroyed: () => false,
    on: vi.fn((event: string, cb: () => void) => { (listeners[event] ??= []).push(cb); }),
    once: vi.fn(),
    minimize: vi.fn(),
    close: vi.fn(),
  };
  const hide = vi.fn();
  const resume = vi.fn();
  registerSidebarWindow(() => win, {
    get: async (key) => values.get(key),
    set: async (key, value) => { values.set(key, value); },
  }, hide, resume);
  const call = (request: any) => fake.handler({ sender: win.webContents }, request);
  return {
    call,
    values,
    sets,
    reported: () => reported,
    place(next: Rect) { reported = { ...next }; },
    drag(next: Rect, event: 'move' | 'resize' = 'move') {
      reported = { ...next };
      for (const cb of listeners[event] ?? []) cb();
    },
  };
}

async function roundTrip(s: ReturnType<typeof setup>, rounds = 20) {
  const exitTargets: Rect[] = [];
  for (let n = 0; n < rounds; n++) {
    const before = s.sets.length;
    await s.call({ action: 'enter', width: 360 });
    await s.call({ action: 'exit' });
    const added = s.sets.slice(before);
    exitTargets.push(added[added.length - 1]);
  }
  return {
    restore: s.values.get('sidebarMode.restore') as Rect,
    bounds: s.values.get('sidebarMode.bounds') as Rect,
    exitTargets,
  };
}

function sameRect(a: Rect, b: Rect) {
  expect({ x: a.x, y: a.y, width: a.width, height: a.height }).toEqual({ x: b.x, y: b.y, width: b.width, height: b.height });
}

it.each([
  ['bias', 1.25, biasQuantize(1.25)],
  ['bias', 1.5, biasQuantize(1.5)],
  ['dip-round', 1.25, dipQuantize(1.25, 'round')],
  ['dip-round', 1.5, dipQuantize(1.5, 'round')],
  ['dip-ceil', 1.25, dipQuantize(1.25, 'ceil')],
  ['dip-ceil', 1.5, dipQuantize(1.5, 'ceil')],
] as const)('%s scale %s keeps restore, sidebar bounds and exit target identical for 20 round-trips', async (_kind, scale, quantize) => {
  const moved = quantize(initialRect);
  expect(moved).not.toEqual(initialRect);
  if (_kind === 'dip-round' && scale === 1.25) expect(moved.y).toBeCloseTo(200.8);
  if (_kind === 'dip-ceil' && scale === 1.25) expect(moved.y).toBeCloseTo(201.6);
  const s = setup(quantize, initialRect);
  const once = await roundTrip(s, 1);
  const many = await roundTrip(setup(quantize, initialRect), 20);
  sameRect(many.restore, once.restore);
  sameRect(many.bounds, once.bounds);
  for (const target of many.exitTargets) sameRect(target, once.exitTargets[0]);
  sameRect(once.restore, initialRect);
  sameRect(once.bounds, { ...initialRect, width: 360 });
});

it('remembers a real drag and ignores a read-back within 3px', async () => {
  const s = setup(biasQuantize(1.25));
  await vi.advanceTimersByTimeAsync(50);
  await s.call({ action: 'enter', width: 360 });
  const saved = { ...(s.values.get('sidebarMode.bounds') as Rect) };
  s.drag({ ...saved, width: saved.width + 3, height: saved.height + 3, y: saved.y - 3 });
  await vi.advanceTimersByTimeAsync(150);
  sameRect(s.values.get('sidebarMode.bounds') as Rect, saved);
  const dragged = { ...saved, x: saved.x + 40, width: saved.width + 80 };
  s.drag(dragged, 'resize');
  await vi.advanceTimersByTimeAsync(150);
  sameRect(s.values.get('sidebarMode.bounds') as Rect, dragged);
  await s.call({ action: 'exit' });
  await s.call({ action: 'enter', width: 360 });
  sameRect(s.values.get('sidebarMode.bounds') as Rect, dragged);
  sameRect(s.values.get('sidebarMode.restore') as Rect, { x: 100, y: 50, width: 1200, height: 800 });
});

it('replaces restore only when the full window actually moved', async () => {
  const s = setup((rect) => ({ ...rect }));
  await s.call({ action: 'enter', width: 360 });
  await s.call({ action: 'exit' });
  s.place({ x: 102, y: 51, width: 1201, height: 801 });
  await s.call({ action: 'enter', width: 360 });
  sameRect(s.values.get('sidebarMode.restore') as Rect, { x: 100, y: 50, width: 1200, height: 800 });
  await s.call({ action: 'exit' });
  s.place({ x: 180, y: 90, width: 1100, height: 700 });
  await s.call({ action: 'enter', width: 360 });
  sameRect(s.values.get('sidebarMode.restore') as Rect, { x: 180, y: 90, width: 1100, height: 700 });
});

it('treats a 3px gap as the same rectangle and a 4px gap as a move', () => {
  const base = { x: 10, y: 20, width: 30, height: 40 };
  expect(nearlySameRect(base, { x: 13, y: 17, width: 33, height: 37 })).toBe(true);
  expect(nearlySameRect(base, { x: 14, y: 20, width: 30, height: 40 })).toBe(false);
  expect(nearlySameRect(base, base, 0)).toBe(true);
});

it('does not ask the sidebar window to grow when the read-back is only 2px', () => {
  const columns = [360, 420];
  const sum = 780;
  expect(planSidebarAutoWidth(columns, sum + 2)).toEqual({ widths: columns });
  expect(planSidebarAutoWidth(columns, sum - 2)).toEqual({ widths: columns });
  expect(planSidebarAutoWidth(columns, sum + 2, { maximized: true })).toEqual({ widths: columns });
  expect(planSidebarAutoWidth(columns, 400, { availWidth: 1920 })).toEqual({ resizeTo: sum, widths: columns });
  expect(planSidebarAutoWidth(columns, 500, { availWidth: 502 })).toEqual({ widths: columns });
  const grown = planSidebarAutoWidth(columns, sum + 40);
  expect(grown.resizeTo).toBeUndefined();
  expect(grown.widths).toEqual([360, 460]);
  expect(planSidebarAutoWidth(columns, sum + 40, { maximized: true }).widths).toEqual(columns);
});
