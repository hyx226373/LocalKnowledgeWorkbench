import { useEffect } from 'react';

export const AUTO_SCROLL_EDGE_PX = 40;
export const AUTO_SCROLL_MAX_SPEED = 24;
export const AUTO_SCROLL_MIN_SPEED = 2;

/**
 * 越靠边越快：离边缘 <= 0 时最快（MAX_SPEED），40px 时为最小速度（MIN_SPEED），> 40px 时为 0。
 */
export function calcEdgeScrollSpeed(distanceToEdge: number, edgeThreshold = AUTO_SCROLL_EDGE_PX): number {
  if (distanceToEdge > edgeThreshold) return 0;
  const clampedDist = Math.max(0, distanceToEdge);
  const ratio = (edgeThreshold - clampedDist) / edgeThreshold;
  return Math.round(AUTO_SCROLL_MIN_SPEED + ratio * (AUTO_SCROLL_MAX_SPEED - AUTO_SCROLL_MIN_SPEED));
}

function isHtmlElement(node: unknown): node is HTMLElement {
  if (!node || typeof node !== 'object') return false;
  if (typeof HTMLElement !== 'undefined') return node instanceof HTMLElement;
  return 'scrollTop' in node && 'getBoundingClientRect' in node;
}

export function canScrollY(el: any): boolean {
  if (el.scrollHeight <= el.clientHeight) return false;
  const style = typeof window !== 'undefined' && window.getComputedStyle ? window.getComputedStyle(el) : el.style;
  const overflow = style?.overflowY || style?.overflow;
  return overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay';
}

export function canScrollX(el: any): boolean {
  if (el.scrollWidth <= el.clientWidth) return false;
  const style = typeof window !== 'undefined' && window.getComputedStyle ? window.getComputedStyle(el) : el.style;
  const overflow = style?.overflowX || style?.overflow;
  return overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay';
}

export interface ScrollTargets {
  vEl: HTMLElement | null;
  vy: number;
  hEl: HTMLElement | null;
  vx: number;
}

/**
 * 寻找指针下最近的可滚动祖先（竖向、横向都算）。
 */
export function findScrollableAncestor(
  startEl: Element | null,
  clientX: number,
  clientY: number,
  edgeThreshold = AUTO_SCROLL_EDGE_PX,
): ScrollTargets {
  let vEl: HTMLElement | null = null;
  let vy = 0;
  let hEl: HTMLElement | null = null;
  let vx = 0;

  let curr: Element | null = startEl;
  while (curr && isHtmlElement(curr)) {
    const rect = curr.getBoundingClientRect ? curr.getBoundingClientRect() : null;
    if (!rect) break;

    // 竖向检查
    if (!vEl && canScrollY(curr)) {
      const distTop = clientY - rect.top;
      const distBottom = rect.bottom - clientY;
      if (distTop >= -20 && distTop <= edgeThreshold && curr.scrollTop > 0) {
        vEl = curr;
        vy = -calcEdgeScrollSpeed(distTop, edgeThreshold);
      } else if (
        distBottom >= -20 &&
        distBottom <= edgeThreshold &&
        curr.scrollTop + curr.clientHeight < curr.scrollHeight - 1
      ) {
        vEl = curr;
        vy = calcEdgeScrollSpeed(distBottom, edgeThreshold);
      }
    }

    // 横向检查
    if (!hEl && canScrollX(curr)) {
      const distLeft = clientX - rect.left;
      const distRight = rect.right - clientX;
      if (distLeft >= -20 && distLeft <= edgeThreshold && curr.scrollLeft > 0) {
        hEl = curr;
        vx = -calcEdgeScrollSpeed(distLeft, edgeThreshold);
      } else if (
        distRight >= -20 &&
        distRight <= edgeThreshold &&
        curr.scrollLeft + curr.clientWidth < curr.scrollWidth - 1
      ) {
        hEl = curr;
        vx = calcEdgeScrollSpeed(distRight, edgeThreshold);
      }
    }

    if (vEl && hEl) break;
    curr = curr.parentElement;
  }

  return { vEl, vy, hEl, vx };
}

let activeRaf: number | null = null;
let currentPointer: { x: number; y: number; target: Element | null } | null = null;

export function stopDragAutoScroll() {
  if (activeRaf !== null) {
    if (typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(activeRaf);
    }
    activeRaf = null;
  }
  currentPointer = null;
}

function tick() {
  if (!currentPointer) {
    activeRaf = null;
    return;
  }

  const { target, x, y } = currentPointer;
  const { vEl, vy, hEl, vx } = findScrollableAncestor(target, x, y);

  let scrolled = false;
  if (vEl && vy !== 0) {
    vEl.scrollTop += vy;
    scrolled = true;
  }
  if (hEl && vx !== 0) {
    hEl.scrollLeft += vx;
    scrolled = true;
  }

  if (scrolled) {
    if (typeof requestAnimationFrame === 'function') {
      activeRaf = requestAnimationFrame(tick);
    } else {
      activeRaf = null;
    }
  } else {
    activeRaf = null;
  }
}

export function updateDragAutoScroll(x: number, y: number, target: Element | null) {
  currentPointer = { x, y, target };
  if (activeRaf === null) {
    if (typeof requestAnimationFrame === 'function') {
      activeRaf = requestAnimationFrame(tick);
    }
  }
}

/**
 * 在 document 上监听 dragover 等事件，驱动通用边缘自动滚动。
 */
export function installDragAutoScroll(doc: Document = document): () => void {
  const onDragOver = (e: DragEvent) => {
    // 指针停在边缘时保持滚动
    const target = (typeof doc.elementFromPoint === 'function' ? doc.elementFromPoint(e.clientX, e.clientY) : null) || (e.target as Element);
    updateDragAutoScroll(e.clientX, e.clientY, target);
  };

  const onStop = () => {
    stopDragAutoScroll();
  };

  const onDragLeave = (e: DragEvent) => {
    // 当指针离开整个窗口时停下
    if (
      !e.relatedTarget ||
      e.clientX <= 0 ||
      e.clientY <= 0 ||
      (typeof window !== 'undefined' && (e.clientX >= window.innerWidth || e.clientY >= window.innerHeight))
    ) {
      stopDragAutoScroll();
    }
  };

  doc.addEventListener('dragover', onDragOver, { capture: true, passive: true });
  doc.addEventListener('dragend', onStop, { capture: true });
  doc.addEventListener('drop', onStop, { capture: true });
  doc.addEventListener('dragleave', onDragLeave, { capture: true });
  doc.addEventListener('pointerup', onStop, { capture: true });
  doc.addEventListener('mouseup', onStop, { capture: true });

  const win = doc.defaultView;
  if (win) {
    win.addEventListener('blur', onStop);
  }

  return () => {
    stopDragAutoScroll();
    doc.removeEventListener('dragover', onDragOver, { capture: true });
    doc.removeEventListener('dragend', onStop, { capture: true });
    doc.removeEventListener('drop', onStop, { capture: true });
    doc.removeEventListener('dragleave', onDragLeave, { capture: true });
    doc.removeEventListener('pointerup', onStop, { capture: true });
    doc.removeEventListener('mouseup', onStop, { capture: true });
    if (win) {
      win.removeEventListener('blur', onStop);
    }
  };
}

export function useDragAutoScroll(enabled: boolean = true) {
  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return;
    return installDragAutoScroll(document);
  }, [enabled]);
}
