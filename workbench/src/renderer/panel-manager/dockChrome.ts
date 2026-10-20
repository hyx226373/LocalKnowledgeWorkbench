/**
 * 预览 doc-stage 的分屏分隔条、停靠预览和气泡动效。
 * 只描述外观和触发；停靠、分屏比例、气泡几何仍走 PanelManager / dockview。
 */

export const DOCK_SEP = {
  /** 预览 grid 轨道是 10px；dockview 命中条是 4px，视觉条加宽后向左/上收 3px 才居中 */
  trackPx: 10,
  centerNudgePx: 3,
  radiusPx: 99,
  /** 预览 `.dock-sep`：rgba(62, 110, 140, 0.18) */
  restAlpha: 0.18,
  /** 预览没有悬停规则。悬停只把同一强调色加浓，不用旧的实心 sash 色。 */
  hoverAlpha: 0.32,
  /** 拖动时对齐停靠预览描边的 0.45 */
  dragAlpha: 0.45,
  transitionMs: 180,
  curve: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
} as const;

export const DOCK_PREVIEW = {
  insetPx: 10,
  radiusPx: 16,
  /** 预览 `.dock-preview` 填充 0.16、内描边 1.5px / 0.45 */
  fillAlpha: 0.16,
  ringAlpha: 0.45,
  ringPx: 1.5,
  /** 预览 emerge：320ms、下移 8px、同一条曲线。几何跟手仍用 dockview 的 70ms。 */
  emergeMs: 320,
  emergeY: 8,
  curve: 'cubic-bezier(0.2, 0.7, 0.2, 1)',
} as const;

export const BUBBLE_MOTION = {
  height: 36,
  radius: 999,
  gap: 8,
  inset: 16,
  maxWidth: 180,
  emergeMs: 320,
  emergeY: 8,
  curve: 'cubic-bezier(0.2, 0.7, 0.2, 1)',
} as const;

/** 预览 edgeLabel。center 是 dockview 组内停靠，预览样例没有这一格。 */
export const EDGE_LABEL = {
  left: '松手停靠到左侧',
  right: '松手停靠到右侧',
  top: '松手停靠到上方',
  bottom: '松手停靠到下方',
  center: '松手停靠到此组',
} as const;

/** 预览气泡标题去掉样例扩展名。不改 PanelManager 保存的标题。 */
export function bubbleCaption(title: string): string {
  return title.replace(/\.md$|\.pdf$/, '');
}

export interface MotionEnv {
  reduceAttr?: string | null;
  appMotion?: string | null;
  prefersReduce?: boolean;
}

export function motionReduced(env: MotionEnv): boolean {
  if (env.reduceAttr === 'true') return true;
  if (env.appMotion === 'reduce') return true;
  return env.prefersReduce === true;
}

export function readMotionEnv(): MotionEnv {
  if (typeof document === 'undefined') return {};
  const reduceAttr = document.documentElement?.getAttribute?.('data-reduce-motion');
  const app = typeof document.querySelector === 'function' ? document.querySelector('.app') : null;
  const appMotion = app && 'getAttribute' in app ? (app as Element).getAttribute('data-motion') : null;
  let prefersReduce = false;
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    prefersReduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  return { reduceAttr, appMotion, prefersReduce };
}

/**
 * 分隔条按下时标 data-pm-dragging，松手清掉。
 * 尺寸仍由 dockview 的 sash 指针处理，这里不记第二套分屏状态。
 */
export function bindDockSepDrag(root: ParentNode | null): () => void {
  if (!root || typeof (root as Element).addEventListener !== 'function') return () => {};
  const el = root as Element;
  let sash: HTMLElement | null = null;
  const down = (ev: Event) => {
    const t = ev.target;
    if (!t || typeof (t as Element).closest !== 'function') return;
    const hit = (t as Element).closest('.dv-sash');
    if (!hit || !el.contains(hit)) return;
    sash = hit as HTMLElement;
    sash.setAttribute('data-pm-dragging', 'true');
  };
  const up = () => {
    sash?.removeAttribute('data-pm-dragging');
    sash = null;
  };
  el.addEventListener('pointerdown', down, true);
  const win = typeof window !== 'undefined' ? window : null;
  win?.addEventListener('pointerup', up, true);
  win?.addEventListener('pointercancel', up, true);
  return () => {
    el.removeEventListener('pointerdown', down, true);
    win?.removeEventListener('pointerup', up, true);
    win?.removeEventListener('pointercancel', up, true);
    up();
  };
}
