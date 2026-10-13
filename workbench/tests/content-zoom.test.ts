import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCoalescer, type ZoomClock } from '../src/renderer/zoom/coalesce';
import {
  anchorOffset,
  clampOffset,
  factorOf,
  imageFitScale,
  imageScaleBounds,
  normalizeDelta,
  pdfFitScale,
  pdfHit,
  pdfLayout,
  pdfOpenScale,
  pdfPageOrigin,
  pdfScrollForAnchor,
  stepScale,
  stepWebZoom,
  webZoomScroll,
} from '../src/renderer/zoom/math';
import {
  CANVAS_ZOOM_ACTIONS,
  CONTENT_ZOOM_ACTIONS,
  bindContentZoom,
  pushContentZoomWheel,
  readActiveItemId,
  runContentZoom,
  setActiveItemResolver,
  type ZoomHandlers,
} from '../src/renderer/zoom/registry';
import {
  READER_ZOOM,
  effectiveZoom,
  mergeScrollReport,
  restoreImageState,
  restorePdfState,
  restoreScrollState,
  withMode,
  withZoom,
} from '../src/renderer/zoom/state';
import {
  decideWheel,
  installWheelTrigger,
  DEFAULT_WHEEL_BINDING,
  setContentZoomWheelBinding,
  wheelBindingFromAccel,
  isZoomDragBlocked,
  eventTargetElement,
  resolveZoomPanel,
} from '../src/renderer/zoom/wheelTrigger';
import { beginDrag, endDrag, peekDrag } from '../src/renderer/dnd/drag';
import { bindingFromWheel, isWheelBinding, normalizeKeybinding } from '../src/renderer/keybindings/normalize';
import { emptyStore, findConflict, listBoundAccelerators, setKeybinding } from '../src/renderer/keybindings/store';
import { registerContentZoomCommands } from '../src/renderer/zoom/actions';

const ROOT = path.resolve(__dirname, '..');

function clock() {
  let n = 1;
  const rafs = new Map<number, () => void>();
  const delays = new Map<number, () => void>();
  const c: ZoomClock = {
    raf(cb) {
      const id = n++;
      rafs.set(id, cb);
      return id;
    },
    cancelRaf(id) {
      rafs.delete(id);
    },
    delay(cb) {
      const id = n++;
      delays.set(id, cb);
      return id;
    },
    cancelDelay(id) {
      delays.delete(id);
    },
  };
  return {
    c,
    flushRaf() {
      const cbs = [...rafs.values()];
      rafs.clear();
      cbs.forEach((cb) => cb());
    },
    flushDelay() {
      const cbs = [...delays.values()];
      delays.clear();
      cbs.forEach((cb) => cb());
    },
    pendingDelay: () => delays.size,
  };
}

describe('内容缩放锚点与滚轮量', () => {
  it('中心和四角放大再缩小，漂移小于 0.5px', () => {
    const points = [
      { m: 200, off: -20, s: 1 },
      { m: 0, off: -40, s: 1.5 },
      { m: 10, off: 5, s: 0.8 },
      { m: 400, off: -180, s: 2 },
      { m: 399, off: -50, s: 1.25 },
    ];
    for (const c of points) {
      const s1 = c.s * 1.7;
      const off1 = anchorOffset(c.m, c.off, c.s, s1);
      const back = anchorOffset(c.m, off1, s1, c.s);
      expect(Math.abs(back - c.off), JSON.stringify(c)).toBeLessThan(0.5);
    }
  });

  it('边界只夹到边缘，不跳回中心', () => {
    expect(clampOffset(-30, 200, 80)).toBe(0);
    expect(clampOffset(40, 200, 80)).toBe(40);
    expect(clampOffset(500, 200, 80)).toBe(120);
    expect(clampOffset(10, 200, 500)).toBe(0);
    expect(clampOffset(-10, 200, 500)).toBe(-10);
    expect(clampOffset(-999, 200, 500)).toBe(-300);
    expect(clampOffset(10, 200, 500)).not.toBe((200 - 500) / 2);
    expect(clampOffset(40, 200, 80)).not.toBe((200 - 80) / 2);
  });

  it('deltaMode 0/1/2 归一、夹紧，触控板小 Δ 保留', () => {
    expect(normalizeDelta(100, 0, 800)).toBe(100);
    expect(normalizeDelta(3, 1, 800)).toBe(48);
    expect(normalizeDelta(1, 2, 800)).toBe(400);
    expect(normalizeDelta(-1, 2, 100)).toBe(-100);
    expect(normalizeDelta(4, 0, 800)).toBe(4);
    expect(normalizeDelta(9999, 0, 800)).toBe(400);
    expect(normalizeDelta(-9999, 0, 800)).toBe(-400);
    expect(factorOf(-100)).toBeCloseTo(2 ** 0.2, 10);
    expect(factorOf(100)).toBeCloseTo(2 ** -0.2, 10);
    const small = factorOf(4);
    expect(small).toBeGreaterThan(0.99);
    expect(small).toBeLessThan(1);
  });

  it('PDF 计入居中、border 和工具栏；放大再缩小不漂；越界不改去居中', () => {
    const layout = pdfLayout({ toolbarH: 24, viewportW: 200, viewportH: 300, baseW: 100, baseH: 100, scale: 1, pageCount: 2, borderTop: 10 });
    expect(pdfPageOrigin(layout, 0)).toEqual({ left: 50, top: 24 });
    expect(pdfHit(layout, 0, 0, 50, 34)).toEqual({ page: 1, fx: 0, fy: 0 });
    expect(pdfHit(layout, 0, 0, 100, 24)?.fy).toBeCloseTo(-0.1);
    const page2 = pdfHit(layout, 0, 0, 100, 144);
    expect(page2).toMatchObject({ page: 2, fx: 0.5, fy: 0 });

    const wide = pdfLayout({ toolbarH: 20, viewportW: 200, viewportH: 200, baseW: 400, baseH: 500, scale: 1, pageCount: 2, borderTop: 10 });
    const local = { x: 40, y: 60 };
    const scroll = { left: 50, top: 80 };
    const hit = pdfHit(wide, scroll.left, scroll.top, local.x, local.y)!;
    const grown = pdfLayout({ toolbarH: 20, viewportW: 200, viewportH: 200, baseW: 400, baseH: 500, scale: 1.5, pageCount: 2, borderTop: 10 });
    const next = pdfScrollForAnchor(grown, hit.page, hit.fx, hit.fy, local.x, local.y);
    const again = pdfHit(grown, next.scrollLeft, next.scrollTop, local.x, local.y)!;
    expect(again.page).toBe(hit.page);
    expect(Math.abs(again.fx - hit.fx) * grown.pageW).toBeLessThan(0.5);
    expect(Math.abs(again.fy - hit.fy) * grown.pageH).toBeLessThan(0.5);
    const back = pdfScrollForAnchor(wide, again.page, again.fx, again.fy, local.x, local.y);
    expect(Math.abs(back.scrollLeft - scroll.left)).toBeLessThan(0.5);
    expect(Math.abs(back.scrollTop - scroll.top)).toBeLessThan(0.5);

    const narrow = pdfLayout({ toolbarH: 0, viewportW: 100, viewportH: 100, baseW: 80, baseH: 80, scale: 1, pageCount: 1, borderTop: 0 });
    const clamped = pdfScrollForAnchor(narrow, 1, 0, 0, 100, 100);
    expect(clamped).toEqual({ scrollLeft: 0, scrollTop: 0 });
  });

  it('首开适合宽度封顶 150%，显式适应不封顶但仍在 0.4–4；图片不放大小图', () => {
    expect(pdfOpenScale(1000, 400)).toBe(1.5);
    expect(pdfFitScale(1000, 400)).toBe(2.4);
    expect(pdfFitScale(2000, 100)).toBe(4);
    expect(imageFitScale(100, 100, 50, 40)).toBe(1);
    expect(imageFitScale(100, 80, 200, 100)).toBeCloseTo(0.5);
    expect(imageScaleBounds(0.4).min).toBe(0.1);
    expect(imageScaleBounds(0.05)).toEqual({ min: 0.05, max: 8 });
    expect(stepScale(1.2, 1, 0.4, 4)).toBe(1.4);
    expect(stepScale(0.4, -1, 0.4, 4)).toBe(0.4);
    expect(stepWebZoom(1, 1)).toBeCloseTo(1.1);
    expect(stepWebZoom(1, -1)).toBeCloseTo(1 / 1.1);
    expect(stepWebZoom(3, 1)).toBe(3);
    expect(stepWebZoom(0.5, -1)).toBe(0.5);
    const back = webZoomScroll(webZoomScroll(40, 10, 1, 1.1), 10, 1.1, 1);
    expect(Math.abs(back - 40)).toBeLessThan(0.5);
  });
});

describe('滚轮按帧合并', () => {
  it('同帧对数相加，空闲后 commit 一次，之后静默', () => {
    const t = clock();
    const frames: { factor: number; x: number }[] = [];
    let commits = 0;
    const coal = createCoalescer(
      {
        onFrame: (factor, anchor) => frames.push({ factor, x: anchor.x }),
        onCommit: () => commits++,
      },
      t.c,
    );
    coal.push(100, { x: 1, y: 0 });
    coal.push(50, { x: 2, y: 0 });
    expect(frames).toHaveLength(0);
    t.flushRaf();
    expect(frames).toEqual([{ factor: factorOf(150), x: 2 }]);
    expect(commits).toBe(0);
    t.flushDelay();
    expect(commits).toBe(1);
    t.flushDelay();
    t.flushRaf();
    expect(commits).toBe(1);
    expect(frames).toHaveLength(1);
    coal.push(-20, { x: 3, y: 0 });
    t.flushRaf();
    t.flushDelay();
    expect(frames[1]?.factor).toBeCloseTo(factorOf(-20));
    expect(commits).toBe(2);
    coal.dispose();
  });

  it('空闲先到时先补本帧再 commit，不二次改比例', () => {
    const t = clock();
    const order: string[] = [];
    const coal = createCoalescer(
      {
        onFrame: () => order.push('frame'),
        onCommit: () => order.push('commit'),
      },
      t.c,
    );
    coal.push(10, { x: 0, y: 0 });
    t.flushDelay();
    expect(order).toEqual(['frame', 'commit']);
    t.flushRaf();
    expect(order).toEqual(['frame', 'commit']);
    coal.dispose();
  });
});

describe('阅读状态恢复', () => {
  it('三种状态夹紧，旧状态没有比例字段时按 1', () => {
    expect(restoreScrollState(null)).toBeUndefined();
    expect(restoreScrollState({ scroll: 0.25 })).toEqual({ scroll: 0.25 });
    expect(effectiveZoom(restoreScrollState({ scroll: 0.25 }))).toBe(1);
    expect(restoreScrollState({ scroll: 2, zoom: 9, mode: 'edit' })).toEqual({ scroll: 1, zoom: 3, mode: 'edit' });
    expect(restoreScrollState({ scroll: -1, zoom: 0.1 })).toEqual({ scroll: 0, zoom: 0.5 });
    expect(restoreScrollState({ scroll: 0, mode: 'nope', zoom: 1 })).toEqual({ scroll: 0 });

    const kept = restoreScrollState({ scroll: 0.2, mode: 'split', zoom: 2 })!;
    expect(mergeScrollReport(kept, 0.5)).toEqual({ scroll: 0.5, mode: 'split', zoom: 2 });
    expect(withMode(kept, 'preview', 'preview')).toEqual({ scroll: 0.2, zoom: 2 });
    expect(withZoom(kept, 1)).toEqual({ scroll: 0.2, mode: 'split' });

    expect(restorePdfState({ page: 4, scale: 1.1 })).toEqual({ page: 4, scale: 1.1, off: 0 });
    expect(restorePdfState({ page: 2.8, scale: 9, off: 0.25, x: 0.3, dark: true })).toEqual({ page: 2, scale: 4, off: 0.25, x: 0.3, dark: true });
    expect(restorePdfState({ page: 1, scale: 0.1 })).toEqual({ page: 1, scale: 0.4, off: 0 });
    expect(restorePdfState({ page: 1, scale: 1, x: 100 })?.x).toBe(20);
    expect(restorePdfState({})).toBeUndefined();

    expect(restoreImageState(undefined)).toBeUndefined();
    expect(restoreImageState({ mode: 'fit', scale: 1, cx: 0.5, cy: 0.5 })).toEqual({ mode: 'fit', scale: 1, cx: 0.5, cy: 0.5 });
    expect(restoreImageState({ mode: 'free', scale: 20, cx: 0.2, cy: 0.8 })!.scale).toBe(8);
    expect(restoreImageState({ mode: 'free', scale: 0.02, cx: 0, cy: 1 })!.scale).toBe(0.02);
    expect(restoreImageState({ mode: 'stretch', scale: 1, cx: 0, cy: 0 })).toBeUndefined();
  });

  it('恢复结果不含 contentOnly / editMode / hwnd / pid', () => {
    const samples = [
      restoreScrollState({ scroll: 0.1, zoom: 1.2, contentOnly: true, editMode: 1, hwnd: 2, pid: 3 }),
      restorePdfState({ page: 1, scale: 1, contentOnly: 1, editMode: 1, hwnd: 1, pid: 1 }),
      restoreImageState({ mode: 'free', scale: 2, cx: 0.5, cy: 0.5, contentOnly: 1, editMode: 1, hwnd: 1, pid: 1 }),
    ];
    for (const s of samples) {
      const keys = Object.keys(s ?? {});
      expect(keys).not.toEqual(expect.arrayContaining(['contentOnly', 'editMode', 'hwnd', 'pid']));
    }
  });
});

describe('面板登记与滚轮决定', () => {
  it('两个 itemId 互不影响；空 itemId 用活动面板；ActionId 不重复', () => {
    const mk = () => {
      const rec = { scale: 1, sets: [] as number[], commits: 0, factors: [] as number[] };
      const handlers: ZoomHandlers = {
        actions: () => ['in', 'out', 'reset', 'fit', 'set', 'wheel'],
        anchor: () => 'exact',
        getScale: () => rec.scale,
        getBounds: () => ({ min: 0.4, max: 4 }),
        applyFactor: (factor) => rec.factors.push(factor),
        setScale: (scale) => {
          rec.scale = scale;
          rec.sets.push(scale);
        },
        reset: () => {
          rec.scale = 1;
          rec.sets.push(1);
        },
        fit: () => rec.sets.push(-1),
        commit: () => rec.commits++,
      };
      return { rec, handlers };
    };
    const a = mk();
    const b = mk();
    const ta = clock();
    const tb = clock();
    const stopA = bindContentZoom('zoom-a', a.handlers, ta.c);
    const stopB = bindContentZoom('zoom-b', b.handlers, tb.c);
    pushContentZoomWheel('zoom-a', -100, { x: 4, y: 5 });
    ta.flushRaf();
    expect(a.rec.factors).toEqual([factorOf(-100)]);
    expect(b.rec.factors).toEqual([]);
    expect(runContentZoom('zoom-b', 'in')).toBe(true);
    expect(b.rec.sets).toEqual([1.2]);
    expect(b.rec.commits).toBe(1);
    expect(a.rec.sets).toEqual([]);
    const restore = setActiveItemResolver(() => 'zoom-a');
    expect(runContentZoom(null, 'reset')).toBe(true);
    expect(a.rec.scale).toBe(1);
    expect(b.rec.scale).toBe(1.2);
    expect(runContentZoom('zoom-b', 'set', { scale: 2.5 })).toBe(true);
    expect(b.rec.scale).toBe(2.5);
    expect(runContentZoom(null, 'set', { itemId: 'zoom-a', scale: 3 })).toBe(true);
    expect(a.rec.scale).toBe(3);
    expect(runContentZoom('zoom-a', 'wheel')).toBe(false);
    expect(runContentZoom('missing', 'in')).toBe(false);
    restore();
    stopA();
    stopB();
    expect(pushContentZoomWheel('zoom-a', 10, { x: 0, y: 0 })).toBe(false);

    const ids = CONTENT_ZOOM_ACTIONS.map((a0) => a0.actionId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      'view.contentZoomIn',
      'view.contentZoomOut',
      'view.contentZoomReset',
      'view.contentZoomFit',
      'view.contentZoomSet',
      'view.contentZoomWheel',
    ]);
    for (const id of CANVAS_ZOOM_ACTIONS) expect(ids).not.toContain(id);
    expect(CONTENT_ZOOM_ACTIONS.every((a0) => a0.approvalRequired === false && a0.access === 'pending')).toBe(true);
    expect(Object.keys(READER_ZOOM)).toEqual(['builtin.image', 'builtin.pdf', 'builtin.markdown', 'builtin.text', 'builtin.tex']);
  });

  it('活动组里读可见面板', () => {
    const hidden = { getAttribute: () => 'hidden', offsetParent: null, querySelector: () => null, querySelectorAll: () => [] };
    const shown = { getAttribute: () => 'shown', offsetParent: {}, querySelector: () => null, querySelectorAll: () => [] };
    const group = {
      getAttribute: () => null,
      querySelector: () => null,
      querySelectorAll: (sel: string) => (sel.includes('view-root') ? [hidden, shown] : []),
    };
    const root = {
      getAttribute: () => null,
      querySelector: (sel: string) => (sel.includes('dv-active-group') ? group : null),
      querySelectorAll: () => [],
    };
    expect(readActiveItemId(root)).toBe('shown');
  });

  it('Ctrl+滚轮缩放目标面板；Shift、按下按键、工具栏、拖放、没有面板只吞或不处理', () => {
    const binding = DEFAULT_WHEEL_BINDING;
    const base = { buttons: 0, dragging: false, onToolbar: false, itemId: 'p', binding, deltaY: -50, deltaMode: 0, pageH: 400, ctrlKey: true, altKey: false, shiftKey: false, metaKey: false };
    expect(decideWheel(base).kind).toBe('zoom');
    expect(decideWheel({ ...base, ctrlKey: false }).kind).toBe('ignore');
    expect(decideWheel({ ...base, shiftKey: true }).kind).toBe('ignore');
    expect(decideWheel({ ...base, buttons: 1 }).kind).toBe('swallow');
    expect(decideWheel({ ...base, dragging: true }).kind).toBe('swallow');
    expect(decideWheel({ ...base, onToolbar: true }).kind).toBe('swallow');
    expect(decideWheel({ ...base, itemId: null }).kind).toBe('swallow');
    const zoom = decideWheel({ ...base, deltaY: 2, deltaMode: 1 });
    expect(zoom).toEqual({ kind: 'zoom', itemId: 'p', deltaPx: 32 });

    const stopBind = setContentZoomWheelBinding(() => ({ ctrl: false, alt: true, shift: false, meta: false }));
    let prevented = 0;
    const panel = {
      clientHeight: 500,
      getAttribute: (name: string) => (name === 'data-item-id' ? 'wheel-panel' : null),
      closest(sel: string) {
        if (sel.includes('view-root')) return panel;
        return null;
      },
    };
    const listeners = new Map<string, { fn: (ev: Event) => void; opts?: unknown }>();
    const target = {
      addEventListener(type: string, fn: (ev: Event) => void, opts?: unknown) {
        listeners.set(type, { fn, opts });
      },
      removeEventListener() {},
    };
    const { rec, handlers } = (() => {
      const rec0 = { factors: [] as number[] };
      return {
        rec: rec0,
        handlers: {
          actions: () => ['in', 'out', 'reset', 'fit', 'set', 'wheel'] as const,
          anchor: () => 'page' as const,
          getScale: () => 1,
          getBounds: () => ({ min: 0.4, max: 4 }),
          applyFactor: (factor: number) => rec0.factors.push(factor),
          setScale: () => undefined,
          reset: () => undefined,
          fit: () => undefined,
          commit: () => undefined,
        },
      };
    })();
    const t = clock();
    const stopZoom = bindContentZoom('wheel-panel', handlers, t.c);
    const stopListen = installWheelTrigger(target);
    expect((listeners.get('wheel')?.opts as { passive?: boolean }).passive).toBe(false);
    listeners.get('wheel')?.fn({
      ctrlKey: false,
      altKey: true,
      shiftKey: false,
      metaKey: false,
      buttons: 0,
      deltaY: -16,
      deltaMode: 0,
      clientX: 8,
      clientY: 9,
      target: panel,
      preventDefault: () => prevented++,
      stopPropagation: () => undefined,
    } as unknown as Event);
    t.flushRaf();
    expect(prevented).toBe(1);
    expect(rec.factors).toEqual([factorOf(-16)]);
    stopListen();
    stopZoom();
    stopBind();
  });
});

describe('滚轮快捷键', () => {
  it('Wheel 必须带 Ctrl/Alt/Meta；只和滚轮冲突；listBoundAccelerators 不收', () => {
    expect(normalizeKeybinding('Ctrl+Wheel')).toBe('Ctrl+Wheel');
    expect(normalizeKeybinding('Wheel')).toBeNull();
    expect(normalizeKeybinding('Shift+Wheel')).toBeNull();
    expect(normalizeKeybinding('Alt+Shift+Wheel')).toBe('Alt+Shift+Wheel');
    expect(bindingFromWheel({ ctrlKey: true, altKey: false, shiftKey: true, metaKey: false })).toBe('Ctrl+Shift+Wheel');
    expect(bindingFromWheel({ ctrlKey: false, altKey: false, shiftKey: true, metaKey: false })).toBeNull();
    expect(isWheelBinding('Ctrl+Wheel')).toBe(true);
    expect(isWheelBinding('Ctrl+=')).toBe(false);

    const cmds = [
      { id: 'view.contentZoomIn', title: '放大', keybinding: 'Ctrl+=', when: 'global' as const },
      { id: 'view.contentZoomWheel', title: '滚轮', keybinding: 'Ctrl+Wheel', when: 'global' as const },
      { id: 'workbench.commandPalette', title: '命令面板', keybinding: 'Ctrl+Shift+P', when: 'global' as const },
    ];
    const s = emptyStore();
    expect(findConflict(s, cmds, 'other', 'Ctrl+Wheel')?.id).toBe('view.contentZoomWheel');
    expect(findConflict(s, cmds, 'view.contentZoomWheel', 'Ctrl+Shift+P')?.id).toBe('workbench.commandPalette');
    expect(findConflict(s, cmds, 'view.contentZoomIn', 'Ctrl+W')).toBeNull();
    const listed = listBoundAccelerators(cmds, s).map((x) => x.key);
    expect(listed).toContain('Ctrl+=');
    expect(listed).not.toContain('Ctrl+Wheel');
    expect(setKeybinding(s, cmds, 'view.contentZoomIn', 'Wheel').ok).toBe(false);
    expect(setKeybinding(s, cmds, 'view.contentZoomIn', 'Shift+Wheel').ok).toBe(false);
    expect(setKeybinding(s, cmds, 'view.contentZoomIn', 'Ctrl+Wheel').ok).toBe(false);
  });

  it('缩放命令 id 唯一，不和面板尺寸命令重复，when 为 global', () => {
    const zoom: { id: string; when?: string; trigger?: string }[] = [];
    registerContentZoomCommands((c) => {
      zoom.push(c);
      return { dispose() {} };
    });
    const ids = zoom.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['view.contentZoomIn', 'view.contentZoomOut', 'view.contentZoomReset', 'view.contentZoomFit', 'view.contentZoomSet', 'view.contentZoomWheel']);
    expect(zoom.every((c) => c.when === 'global')).toBe(true);
    expect(zoom.find((c) => c.id === 'view.contentZoomWheel')?.trigger).toBe('wheel');
    const keys = fs.readFileSync(path.join(ROOT, 'src/renderer/keybindings/registerCommands.ts'), 'utf8');
    expect(keys).not.toMatch(/id: 'view\.contentZoom/);
    expect(keys).toContain("id: 'panel.size.increase'");
    expect(keys).toContain("id: 'panel.size.decrease'");
    expect(CANVAS_ZOOM_ACTIONS.every((id) => !ids.includes(id) && !keys.includes(id))).toBe(true);
  });
});


describe('Ctrl+滚轮运行时根因修复', () => {
  it('空/空白快捷键回退 DEFAULT_WHEEL_BINDING', () => {
    expect(wheelBindingFromAccel('')).toEqual(DEFAULT_WHEEL_BINDING);
    expect(wheelBindingFromAccel('   ')).toEqual(DEFAULT_WHEEL_BINDING);
    expect(wheelBindingFromAccel(null)).toEqual(DEFAULT_WHEEL_BINDING);
    expect(wheelBindingFromAccel(undefined)).toEqual(DEFAULT_WHEEL_BINDING);
    expect(wheelBindingFromAccel('Ctrl+Wheel')).toEqual(DEFAULT_WHEEL_BINDING);
    expect(wheelBindingFromAccel('Alt+Wheel')).toEqual({ ctrl: false, alt: true, shift: false, meta: false });
  });

  it('仅 stale peekDrag 不阻断缩放；dragDepth>0 才阻断', () => {
    expect(isZoomDragBlocked()).toBe(false);
    const dt = { setData() {}, effectAllowed: 'all', types: [] } as unknown as DataTransfer;
    beginDrag({ v: 1, items: [] }, dt);
    expect(peekDrag()).not.toBeNull();
    expect(isZoomDragBlocked()).toBe(false);

    const listeners = new Map<string, (ev: Event) => void>();
    const target = {
      addEventListener(type: string, fn: (ev: Event) => void) {
        listeners.set(type, fn);
      },
      removeEventListener() {},
    };
    const stop = installWheelTrigger(target);
    listeners.get('dragstart')?.(new Event('dragstart'));
    expect(isZoomDragBlocked()).toBe(true);
    listeners.get('dragend')?.(new Event('dragend'));
    expect(isZoomDragBlocked()).toBe(false);
    listeners.get('dragstart')?.(new Event('dragstart'));
    expect(isZoomDragBlocked()).toBe(true);
    listeners.get('blur')?.(new Event('blur'));
    expect(isZoomDragBlocked()).toBe(false);
    stop();
    endDrag();
    expect(peekDrag()).toBeNull();
  });

  it('文本节点 target 经 parentElement 解析到阅读面板；elementFromPoint 优先', () => {
    const panel = {
      clientHeight: 500,
      getAttribute: (name: string) => (name === 'data-item-id' ? 'text-panel' : null),
      closest(sel: string) {
        if (sel.includes('view-root')) return panel;
        return null;
      },
    };
    const textNode = { parentElement: panel }; // no closest — like Text
    expect(eventTargetElement(textNode as unknown as EventTarget)).toBe(panel);
    expect(resolveZoomPanel({ target: textNode as unknown as EventTarget, clientX: 1, clientY: 2 })).toBe(panel);

    const other = {
      closest(sel: string) {
        if (sel.includes('view-root')) return panel;
        return null;
      },
      getAttribute: () => null,
    };
    const g = globalThis as { document?: { elementFromPoint: (x: number, y: number) => unknown } };
    const prev = g.document;
    g.document = {
      elementFromPoint: (x: number, y: number) => {
        expect(x).toBe(11);
        expect(y).toBe(22);
        return other;
      },
    };
    try {
      expect(resolveZoomPanel({ target: null, clientX: 11, clientY: 22 })).toBe(panel);
    } finally {
      if (prev === undefined) delete g.document;
      else g.document = prev;
    }

    let prevented = 0;
    const factors: number[] = [];
    const handlers = {
      actions: () => ['in', 'out', 'reset', 'fit', 'set', 'wheel'] as const,
      anchor: () => 'page' as const,
      getScale: () => 1,
      getBounds: () => ({ min: 0.4, max: 4 }),
      applyFactor: (factor: number) => factors.push(factor),
      setScale: () => undefined,
      reset: () => undefined,
      fit: () => undefined,
      commit: () => undefined,
    };
    let n = 1;
    const rafs = new Map<number, () => void>();
    const clock = {
      raf(cb: () => void) {
        const id = n++;
        rafs.set(id, cb);
        return id;
      },
      cancelRaf(id: number) {
        rafs.delete(id);
      },
      delay() {
        return n++;
      },
      cancelDelay() {},
    };
    const stopZoom = bindContentZoom('text-panel', handlers, clock);
    const listeners = new Map<string, (ev: Event) => void>();
    const target = {
      addEventListener(type: string, fn: (ev: Event) => void) {
        listeners.set(type, fn);
      },
      removeEventListener() {},
    };
    const stopListen = installWheelTrigger(target);
    listeners.get('wheel')?.({
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      buttons: 0,
      deltaY: -16,
      deltaMode: 0,
      clientX: 8,
      clientY: 9,
      target: textNode,
      preventDefault: () => prevented++,
      stopPropagation: () => undefined,
    } as unknown as Event);
    for (const cb of [...rafs.values()]) cb();
    expect(prevented).toBe(1);
    expect(factors).toEqual([factorOf(-16)]);
    stopListen();
    stopZoom();
  });
});

describe('样式变量', () => {
  it('字号乘 --content-zoom，不新增 --kb- 令牌；编辑框不乘', () => {
    const css = fs.readFileSync(path.join(ROOT, 'src/renderer/styles.css'), 'utf8');
    expect(css).toContain('calc(var(--kb-read-fs-code) * var(--content-zoom, 1))');
    expect(css).toContain('calc(var(--kb-read-fs) * var(--content-zoom, 1))');
    expect(css).toContain('calc(var(--kb-read-focus-fs) * var(--content-zoom, 1))');
    expect(css).toContain('calc(var(--kb-read-max-width) * var(--content-zoom, 1))');
    expect(css).not.toContain('--kb-content-zoom');
    expect(css).toMatch(/\.kb-editor-text \{[^}]*font-size: var\(--kb-read-fs-code\)/);
    const zoomCss = fs.readFileSync(path.join(ROOT, 'src/renderer/zoom/zoom.css'), 'utf8');
    expect(zoomCss).not.toContain('data-kb-overlay');
    expect(zoomCss).not.toMatch(/--kb-[a-z0-9-]+\s*:/);
  });
});
