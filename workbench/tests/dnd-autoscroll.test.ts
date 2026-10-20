import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_SCROLL_EDGE_PX,
  AUTO_SCROLL_MAX_SPEED,
  AUTO_SCROLL_MIN_SPEED,
  calcEdgeScrollSpeed,
  findScrollableAncestor,
  installDragAutoScroll,
  stopDragAutoScroll,
  updateDragAutoScroll,
} from '../src/renderer/dnd/autoScroll';

describe('边缘自动滚动 (autoScroll)', () => {
  describe('速度梯度曲线 calcEdgeScrollSpeed', () => {
    it('距离超出 40px 时速度为 0', () => {
      expect(calcEdgeScrollSpeed(41)).toBe(0);
      expect(calcEdgeScrollSpeed(100)).toBe(0);
    });

    it('离边缘越近速度越快（40px 最小，0px 及以下最大）', () => {
      const atEdge = calcEdgeScrollSpeed(AUTO_SCROLL_EDGE_PX);
      const atHalf = calcEdgeScrollSpeed(20);
      const atZero = calcEdgeScrollSpeed(0);
      const beyond = calcEdgeScrollSpeed(-10);

      expect(atEdge).toBe(AUTO_SCROLL_MIN_SPEED);
      expect(atZero).toBe(AUTO_SCROLL_MAX_SPEED);
      expect(beyond).toBe(AUTO_SCROLL_MAX_SPEED);
      expect(atHalf).toBeGreaterThan(atEdge);
      expect(atHalf).toBeLessThan(atZero);
    });
  });

  describe('寻找最近可滚动祖先 findScrollableAncestor', () => {
    function createMockElement(opts: {
      top: number;
      bottom: number;
      left: number;
      right: number;
      scrollTop?: number;
      scrollLeft?: number;
      scrollHeight?: number;
      clientHeight?: number;
      scrollWidth?: number;
      clientWidth?: number;
      overflowY?: string;
      overflowX?: string;
      parent?: any;
    }) {
      const el: any = {
        scrollTop: opts.scrollTop ?? 50,
        scrollLeft: opts.scrollLeft ?? 50,
        scrollHeight: opts.scrollHeight ?? 500,
        clientHeight: opts.clientHeight ?? 200,
        scrollWidth: opts.scrollWidth ?? 500,
        clientWidth: opts.clientWidth ?? 200,
        parentElement: opts.parent ?? null,
        style: {
          overflowY: opts.overflowY ?? 'auto',
          overflowX: opts.overflowX ?? 'auto',
        },
        getBoundingClientRect: () => ({
          top: opts.top,
          bottom: opts.bottom,
          left: opts.left,
          right: opts.right,
          width: opts.right - opts.left,
          height: opts.bottom - opts.top,
        }),
      };
      Object.setPrototypeOf(el, globalThis.HTMLElement?.prototype ?? Object.prototype);
      return el;
    }

    it('指针靠近容器顶部且有向上空间：vy 为负且随距离变大', () => {
      const container = createMockElement({ top: 100, bottom: 300, left: 100, right: 300, scrollTop: 60 });
      // clientY = 110 -> 距 top 10px <= 40px
      const res = findScrollableAncestor(container, 200, 110);
      expect(res.vEl).toBe(container);
      expect(res.vy).toBeLessThan(0);
      expect(res.vy).toBe(-calcEdgeScrollSpeed(10));
    });

    it('指针靠近容器底部且有向下空间：vy 为正且随距离变大', () => {
      const container = createMockElement({ top: 100, bottom: 300, left: 100, right: 300, scrollTop: 60 });
      // clientY = 295 -> 距 bottom 5px <= 40px
      const res = findScrollableAncestor(container, 200, 295);
      expect(res.vEl).toBe(container);
      expect(res.vy).toBeGreaterThan(0);
      expect(res.vy).toBe(calcEdgeScrollSpeed(5));
    });

    it('已经在顶部 (scrollTop = 0) 时不再向上滚', () => {
      const container = createMockElement({ top: 100, bottom: 300, left: 100, right: 300, scrollTop: 0 });
      const res = findScrollableAncestor(container, 200, 110);
      expect(res.vy).toBe(0);
    });

    it('已经在底部 (scrollTop + clientHeight >= scrollHeight) 时不再向下滚', () => {
      const container = createMockElement({
        top: 100,
        bottom: 300,
        left: 100,
        right: 300,
        scrollTop: 300,
        clientHeight: 200,
        scrollHeight: 500,
      });
      const res = findScrollableAncestor(container, 200, 295);
      expect(res.vy).toBe(0);
    });

    it('横向：指针靠近左右边缘可触发 vx 滚动', () => {
      const container = createMockElement({ top: 100, bottom: 300, left: 100, right: 300, scrollLeft: 40 });
      // 距左边 8px
      const leftRes = findScrollableAncestor(container, 108, 200);
      expect(leftRes.hEl).toBe(container);
      expect(leftRes.vx).toBeLessThan(0);

      // 距右边 6px
      const rightRes = findScrollableAncestor(container, 294, 200);
      expect(rightRes.hEl).toBe(container);
      expect(rightRes.vx).toBeGreaterThan(0);
    });

    it('中间区域不触发任何滚动', () => {
      const container = createMockElement({ top: 100, bottom: 300, left: 100, right: 300 });
      const res = findScrollableAncestor(container, 200, 200);
      expect(res.vy).toBe(0);
      expect(res.vx).toBe(0);
    });
  });

  describe('生命周期与连续 rAF 滚动', () => {
    let mockCallbacks: FrameRequestCallback[] = [];
    let rafCounter = 1;

    beforeEach(() => {
      mockCallbacks = [];
      rafCounter = 1;
      vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
        mockCallbacks.push(cb);
        return rafCounter++;
      });
      vi.stubGlobal('cancelAnimationFrame', vi.fn());
    });

    afterEach(() => {
      stopDragAutoScroll();
      vi.unstubAllGlobals();
    });

    it('dragover 在边缘触发 rAF 连续滚动，直至停止', () => {
      const listeners: Record<string, Function[]> = {};
      const mockDoc: any = {
        addEventListener: (event: string, fn: Function) => {
          listeners[event] = listeners[event] || [];
          listeners[event].push(fn);
        },
        removeEventListener: (event: string, fn: Function) => {
          listeners[event] = (listeners[event] || []).filter((f) => f !== fn);
        },
        elementFromPoint: () => null,
      };

      const cleanup = installDragAutoScroll(mockDoc);

      const target: any = {
        scrollTop: 50,
        scrollLeft: 0,
        scrollHeight: 500,
        clientHeight: 200,
        scrollWidth: 200,
        clientWidth: 200,
        parentElement: null,
        style: { overflowY: 'auto' },
        getBoundingClientRect: () => ({ top: 100, bottom: 300, left: 100, right: 300, width: 200, height: 200 }),
      };
      Object.setPrototypeOf(target, globalThis.HTMLElement?.prototype ?? Object.prototype);

      // 模拟 dragover 在 top + 10px 位置（应向上滚动）
      const dragOverFns = listeners['dragover'] || [];
      expect(dragOverFns.length).toBeGreaterThan(0);
      dragOverFns[0]({ clientX: 200, clientY: 110, target });

      expect(mockCallbacks.length).toBe(1);

      // 执行一次 rAF tick
      const initialScrollTop = target.scrollTop;
      const cb = mockCallbacks.shift()!;
      cb(16);

      expect(target.scrollTop).toBeLessThan(initialScrollTop);

      // 模拟 drop 停止自动滚动
      const dropFns = listeners['drop'] || [];
      expect(dropFns.length).toBeGreaterThan(0);
      dropFns[0]();

      cleanup();
    });
  });
});
