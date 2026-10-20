/**
 * L2：显示器列表 → scaleFactor → host.setBounds（无 UI / 无抢焦点）
 * 阈值：DIP→物理 |Δ| ≤ L2_BOUNDS_THRESHOLD.maxPhysicalPx（1 px）
 *        回算 DIP |Δ| ≤ maxCssPx（2 CSS px）
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  GET_DISPLAYS_HOOK,
  LAYOUT_DISPLAYS_CHANGED_EVENT,
  L2_BOUNDS_THRESHOLD,
} from '../src/shared/chromeLayout';
import {
  DisplayListStore,
  LayoutHost,
  MockLayoutNativeHostClient,
  applyPanelScaleFactorAttr,
  assertScale,
  clearHostCallerLog,
  computeContentBounds,
  contentBoundsToHostRect,
  createChromeController,
  createMemoryPersistStore,
  ensureNonEmptyDisplays,
  getDisplayListStore,
  maxAbsDelta,
  panelDipToPhysicalTrunc,
  panelToScreenDip,
  pickDisplayForRect,
  rectDipToPhysical,
  rectDipToPhysicalTrunc,
  resetDisplayListStoreForTests,
  scaleFactorForPanel,
  sanitizeDisplays,
  screenToPanelDip,
  synthesizePrimaryDisplay,
  type NativeHostPanelRef,
} from '../src/renderer/chrome-layout';

const PANEL: NativeHostPanelRef = {
  id: 'panel-npp-1',
  layout: { x: 0, y: 0, w: 1000, h: 700 },
  attached: true,
  shouldShow: true,
};

function makeController() {
  return createChromeController({ persist: createMemoryPersistStore() });
}

describe('L2 · display list + scaleFactor chain', () => {
  beforeEach(() => {
    resetDisplayListStoreForTests();
    clearHostCallerLog();
  });

  it('getDisplays 永不返回 []：空 provider 被替换为合成主屏', () => {
    const store = new DisplayListStore({
      provider: () => [],
      fallbackScaleFactor: 1.25,
    });
    const list = store.refresh();
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0]!.scaleFactor).toBe(1.25);
    expect(ensureNonEmptyDisplays([], synthesizePrimaryDisplay(1.25)).length).toBe(1);
  });

  it('layout.displaysChanged：detail.displays.length ≥ 1', () => {
    const target = new EventTarget();
    const seen: unknown[] = [];
    target.addEventListener(LAYOUT_DISPLAYS_CHANGED_EVENT, ((ev: Event) => {
      seen.push((ev as CustomEvent).detail);
    }) as EventListener);
    const store = new DisplayListStore({
      eventTarget: target,
      fallbackScaleFactor: 1.25,
      provider: () => [
        { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1.25 },
      ],
    });
    store.refresh();
    expect(seen.length).toBeGreaterThanOrEqual(1);
    const detail = seen[seen.length - 1] as { displays: { scaleFactor: number }[] };
    expect(detail.displays.length).toBeGreaterThanOrEqual(1);
    expect(detail.displays[0]!.scaleFactor).toBe(1.25);
    expect(LAYOUT_DISPLAYS_CHANGED_EVENT).toBe('layout.displaysChanged');
    expect(GET_DISPLAYS_HOOK).toBe('__kbGetDisplays');
  });

  it('多屏：按面板中心选 scaleFactor（1.25 vs 1.0）', () => {
    const displays = [
      { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1.25 },
      { id: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
    ];
    expect(scaleFactorForPanel({ x: 100, y: 100, w: 200, h: 200 }, displays)).toBe(1.25);
    expect(scaleFactorForPanel({ x: 2000, y: 100, w: 200, h: 200 }, displays)).toBe(1);
    expect(pickDisplayForRect({ x: 2000, y: 10, width: 100, height: 100 }, displays).id).toBe(2);
  });

  it('LayoutHost.setBounds 载荷携带 scaleFactor=1.25（mock host，无窗口）', async () => {
    const displayList = new DisplayListStore({
      provider: () => [
        { id: 1, bounds: { x: 0, y: 0, width: 2560, height: 1440 }, scaleFactor: 1.25 },
      ],
      fallbackScaleFactor: 1.25,
    });
    displayList.refresh();
    const controller = makeController();
    const mock = new MockLayoutNativeHostClient();
    const lh = new LayoutHost({
      controller,
      host: mock,
      displayList,
      getPanels: () => [PANEL],
      getViewport: () => ({ x: 0, y: 0, w: 1280, h: 800, scaleFactor: 1.25 }),
      listenRequestActivate: false,
      syncDebounceMs: 0,
      callerTag: 'layout-host',
    });
    await lh.sync('layout-adjust');
    const calls = mock.callsFor('setBounds', PANEL.id);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const args = calls[calls.length - 1]!.args as {
      panelId: string;
      bounds: { x: number; y: number; width: number; height: number; scaleFactor?: number };
    };
    expect(args.bounds.scaleFactor).toBe(1.25);
    // setBounds 仍传 DIP（usePhysical:false）；scaleFactor 供消费者 trunc
    const dip = {
      x: args.bounds.x,
      y: args.bounds.y,
      width: args.bounds.width,
      height: args.bounds.height,
    };
    const physical = rectDipToPhysicalTrunc(dip, 1.25);
    const floatMul = rectDipToPhysical(dip, 1.25);
    // trunc 与浮点 ×scale 偏差 < 1 物理像素
    expect(maxAbsDelta(physical, {
      x: Math.trunc(floatMul.x),
      y: Math.trunc(floatMul.y),
      width: Math.max(0, Math.trunc(floatMul.width)),
      height: Math.max(0, Math.trunc(floatMul.height)),
    })).toBe(0);
    // 回算 DIP：trunc 引入的误差 ≤ maxCssPx
    const back = {
      x: physical.x / 1.25,
      y: physical.y / 1.25,
      width: physical.width / 1.25,
      height: physical.height / 1.25,
    };
    expect(maxAbsDelta(dip, back)).toBeLessThanOrEqual(L2_BOUNDS_THRESHOLD.maxCssPx);
    lh.dispose();
  });

  it('contentBoundsChanged.bounds.scaleFactor 与 setBounds 同源', async () => {
    const displayList = new DisplayListStore({
      provider: () => [
        { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1.25 },
      ],
    });
    displayList.refresh();
    const events: unknown[] = [];
    const controller = makeController();
    const mock = new MockLayoutNativeHostClient();
    const lh = new LayoutHost({
      controller,
      host: mock,
      displayList,
      getPanels: () => [PANEL],
      getViewport: () => ({ x: 0, y: 0, w: 1280, h: 800 }),
      listenRequestActivate: false,
      syncDebounceMs: 0,
      onEvent: (name, payload) => {
        if (name === 'layout.contentBoundsChanged') events.push(payload);
      },
    });
    await lh.sync('chrome-toggle');
    expect(events.length).toBeGreaterThanOrEqual(1);
    const p = events[events.length - 1] as { bounds: { scaleFactor: number } };
    expect(p.bounds.scaleFactor).toBe(1.25);
    const hostBounds = (mock.callsFor('setBounds')[0]!.args as { bounds: { scaleFactor: number } }).bounds;
    expect(hostBounds.scaleFactor).toBe(p.bounds.scaleFactor);
    lh.dispose();
  });

  it('kb host.listDisplays 桥：refresh 采用 1.25', async () => {
    const kb = {
      'host.listDisplays': () => [
        { id: 9, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1.25 },
      ],
    };
    const store = new DisplayListStore({ kb, fallbackScaleFactor: 1 });
    const list = await store.refreshAsync();
    expect(list[0]!.scaleFactor).toBe(1.25);
    expect(store.scaleFactorForPoint(10, 10)).toBe(1.25);
  });

  it('sanitize 丢弃非法 scale；assertScale 拒绝 ≤0', () => {
    expect(sanitizeDisplays([{ bounds: { x: 0, y: 0, width: 1, height: 1 }, scaleFactor: 0 }])).toEqual([]);
    expect(() => assertScale(0)).toThrow(/scaleFactor/);
    expect(() => assertScale(-1)).toThrow(/96 DPI/);
  });

  it('computeContentBounds + contentBoundsToHostRect 带上 scaleFactor', () => {
    const b = computeContentBounds(
      { x: 0, y: 0, w: 1280, h: 800 },
      { top: 40, right: 0, bottom: 24, left: 280 },
      PANEL.layout,
    );
    const withScale = { ...b, scaleFactor: 1.25 };
    const host = contentBoundsToHostRect(withScale);
    expect(host.scaleFactor).toBe(1.25);
    expect(host.width).toBe(withScale.w);
  });

  it('applyPanelScaleFactorAttr：有 DOM 时写入 data-scale-factor', () => {
    if (typeof document === 'undefined') return;
    const el = document.createElement('div');
    el.setAttribute('data-panel-id', 'panel-npp-1');
    document.body.appendChild(el);
    applyPanelScaleFactorAttr('panel-npp-1', 1.25);
    expect(el.getAttribute('data-scale-factor')).toBe('1.25');
    el.remove();
  });

  it('单例 __kbGetDisplays hook 非空', () => {
    const store = getDisplayListStore();
    store.setDisplays([{ bounds: { x: 0, y: 0, width: 100, height: 100 }, scaleFactor: 1.25 }]);
    const g = globalThis as unknown as Record<string, unknown>;
    const fn = g[GET_DISPLAYS_HOOK] as () => unknown;
    expect(typeof fn).toBe('function');
    expect((fn() as unknown[]).length).toBeGreaterThanOrEqual(1);
  });
});

describe('L2 · 对照原生 6b09257（trunc / DIP 平移）', () => {
  it('rectDipToPhysicalTrunc：101×1.25→126；11×1.25→13', () => {
    expect(rectDipToPhysicalTrunc({ x: 101, y: 11, width: 101, height: 11 }, 1.25)).toEqual({
      x: 126,
      y: 13,
      width: 126,
      height: 13,
    });
    expect(panelDipToPhysicalTrunc({ x: 101, y: 11 }, 1.25)).toEqual({ x: 126, y: 13 });
    // 浮点助手仍保留精确乘积
    expect(rectDipToPhysical({ x: 101, y: 0, width: 0, height: 0 }, 1.25).x).toBeCloseTo(126.25, 10);
  });

  it('panelToScreenDip：只做 DIP 原点平移，不 ×scale（scale 1 与 1.25 同结果）', () => {
    const panel = { x: 200, y: 100 };
    const local = { x: 10, y: 20 };
    const a = panelToScreenDip(local, panel);
    expect(a).toEqual({ x: 210, y: 120 });
    // 契约：与 scale 无关——同一 DIP 加减
    expect(panelToScreenDip(local, panel)).toEqual(a);
    expect(screenToPanelDip(a, panel)).toEqual(local);
    // 证明未乘 scale：若误 ×1.25 会得到 262.5 / 150
    expect(a.x).not.toBe(210 * 1.25);
    expect(a.y).not.toBe(120 * 1.25);
  });

  it('native 样例 rect {12,48,900,600}×1.25 → trunc {15,60,1125,750}', () => {
    expect(rectDipToPhysicalTrunc({ x: 12, y: 48, width: 900, height: 600 }, 1.25)).toEqual({
      x: 15,
      y: 60,
      width: 1125,
      height: 750,
    });
  });
});
