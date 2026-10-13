/**
 * 滚轮按帧合并：同一帧里的 Δ 在对数域相加（factorOf 相乘），每帧只回调一次。
 * 最后一次输入空闲 150ms 后回调 commit。commit 不再改比例。
 */
import { factorOf, type Point } from './math';

export const ZOOM_COMMIT_IDLE_MS = 150;

export interface ZoomClock {
  raf(cb: () => void): number;
  cancelRaf(id: number): void;
  delay(cb: () => void, ms: number): number;
  cancelDelay(id: number): void;
}

export function defaultZoomClock(): ZoomClock {
  const raf = typeof requestAnimationFrame === 'function' ? (cb: () => void) => requestAnimationFrame(() => cb()) : (cb: () => void) => setTimeout(cb, 0) as unknown as number;
  const cancelRaf = typeof cancelAnimationFrame === 'function' ? (id: number) => cancelAnimationFrame(id) : (id: number) => clearTimeout(id);
  return {
    raf,
    cancelRaf,
    delay: (cb, ms) => setTimeout(cb, ms) as unknown as number,
    cancelDelay: (id) => clearTimeout(id),
  };
}

export interface ZoomCoalescer {
  push(deltaPx: number, anchor: Point): void;
  dispose(): void;
}

export function createCoalescer(
  handlers: { onFrame(factor: number, anchor: Point): void; onCommit(): void },
  clock?: ZoomClock,
  idleMs = ZOOM_COMMIT_IDLE_MS,
): ZoomCoalescer {
  const c = clock ?? defaultZoomClock();
  let acc = 0;
  let anchor: Point = { x: 0, y: 0 };
  let rafId = 0;
  let idleId = 0;
  let disposed = false;

  const flushFrame = () => {
    rafId = 0;
    if (acc === 0) return;
    const factor = factorOf(acc);
    const point = anchor;
    acc = 0;
    handlers.onFrame(factor, point);
  };

  const fireCommit = () => {
    idleId = 0;
    if (disposed) return;
    if (rafId) {
      c.cancelRaf(rafId);
      rafId = 0;
    }
    if (acc !== 0) flushFrame();
    handlers.onCommit();
  };

  return {
    push(deltaPx, point) {
      if (disposed || !Number.isFinite(deltaPx) || deltaPx === 0) return;
      acc += deltaPx;
      anchor = point;
      if (!rafId) rafId = c.raf(flushFrame);
      if (idleId) c.cancelDelay(idleId);
      idleId = c.delay(fireCommit, idleMs);
    },
    dispose() {
      disposed = true;
      if (rafId) c.cancelRaf(rafId);
      if (idleId) c.cancelDelay(idleId);
      rafId = 0;
      idleId = 0;
      acc = 0;
    },
  };
}
