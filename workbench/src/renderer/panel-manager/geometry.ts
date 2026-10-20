/** 纯几何函数（可单测）：找回（夹回可见区域）、最大化矩形、吸附。 */
import type { Box, Size } from './types';

/**
 * 浮动窗口最小尺寸（插件视图可以声明更大的 minSize，见 docs/11 §6）。
 * 预览样例 beginResize 的下限是 300×200（PREVIEW_MIN_FLOAT）。这里保持 240×140：
 * rescue / keepGrabbable 会把更小的矩形抬到这个下限，restoreLayout 结束时就会跑 rescue。
 * 已保存的浮动窗和约 280 宽的浮动侧栏若被抬到 300，恢复后的矩形就变了。
 * migrate / finalize 本身不读这个值，但它们交出去的 bounds 会在 rescue 里被夹。
 */
export const MIN_FLOAT: Size = { width: 240, height: 140 };

/** 预览 doc-stage 的缩放下限。只作对照，不参与 rescue / resize。 */
export const PREVIEW_MIN_FLOAT: Size = { width: 300, height: 200 };

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** 规范化一个矩形（非数字 → 默认；取整） */
export function normBox(b: Partial<Box> | undefined, fallback: Box): Box {
  return {
    left: Math.round(num(b?.left, fallback.left)),
    top: Math.round(num(b?.top, fallback.top)),
    width: Math.round(Math.max(1, num(b?.width, fallback.width))),
    height: Math.round(Math.max(1, num(b?.height, fallback.height))),
  };
}

/**
 * 找回：窗口完全放进容器。
 *  1. 尺寸超过容器 → 缩到容器大小（不小于 min，除非容器本身更小）；
 *  2. 位置越界 → 平移回容器内（左上角优先可见：标题栏总能被抓到）。
 * 返回新矩形；与原矩形相同表示无需移动。
 */
export function rescueBox(b: Box, container: Size, min: Size = MIN_FLOAT): Box {
  const cw = Math.max(1, Math.floor(container.width));
  const ch = Math.max(1, Math.floor(container.height));
  const width = clamp(Math.round(b.width), Math.min(min.width, cw), cw);
  const height = clamp(Math.round(b.height), Math.min(min.height, ch), ch);
  const left = clamp(Math.round(b.left), 0, cw - width);
  const top = clamp(Math.round(b.top), 0, ch - height);
  return { left, top, width, height };
}

/** 用户移动窗口时：允许部分移出可见区域，但标题栏（窗口顶部）至少 GRAB_VISIBLE 像素留在可见区域内，保证能拖回来 */
export const GRAB_VISIBLE = 40;
export function keepGrabbable(b: Box, container: Size, min: Size = MIN_FLOAT): Box {
  const cw = Math.max(1, Math.floor(container.width));
  const ch = Math.max(1, Math.floor(container.height));
  const width = Math.max(Math.round(b.width), Math.min(min.width, cw));
  const height = Math.max(Math.round(b.height), Math.min(min.height, ch));
  const g = Math.min(GRAB_VISIBLE, cw, ch);
  const left = clamp(Math.round(b.left), g - width, cw - g);
  const top = clamp(Math.round(b.top), 0, ch - g);
  return { left, top, width, height };
}

export function sameBox(a: Box | null | undefined, b: Box | null | undefined, tol = 1): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.left - b.left) <= tol && Math.abs(a.top - b.top) <= tol && Math.abs(a.width - b.width) <= tol && Math.abs(a.height - b.height) <= tol;
}

/** 完全在容器内 */
export function isInside(b: Box, c: Size, tol = 1): boolean {
  return b.left >= -tol && b.top >= -tol && b.left + b.width <= c.width + tol && b.top + b.height <= c.height + tol;
}

export function maximizedBox(c: Size): Box {
  return { left: 0, top: 0, width: Math.floor(c.width), height: Math.floor(c.height) };
}

export function intersects(a: Box, b: Box): boolean {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}

/** 新浮动窗口的默认位置：在容器内错开排列（第 n 个窗口右下移 32px） */
/**
 * 右下角缩放：以起始矩形加指针增量，夹在 PanelManager 最小尺寸与容器内边（默认 12px，对齐预览）之间。
 * 不另记一套窗口状态；结果交给 PanelManager.resize。
 */
export function resizeDelta(start: Box, dx: number, dy: number, container: Size, min: Size = MIN_FLOAT, margin = 12): Size {
  const cw = Math.max(1, Math.floor(container.width));
  const ch = Math.max(1, Math.floor(container.height));
  const maxW = Math.max(min.width, cw - start.left - margin);
  const maxH = Math.max(min.height, ch - start.top - margin);
  return {
    width: Math.min(maxW, Math.max(min.width, Math.round(start.width + dx))),
    height: Math.min(maxH, Math.max(min.height, Math.round(start.height + dy))),
  };
}

export function cascadeBox(n: number, c: Size, size: Size = { width: 520, height: 380 }): Box {
  const w = Math.min(size.width, Math.max(MIN_FLOAT.width, c.width - 40));
  const h = Math.min(size.height, Math.max(MIN_FLOAT.height, c.height - 40));
  const step = 32;
  const maxSteps = Math.max(1, Math.floor(Math.min(c.width - w, c.height - h) / step));
  const k = n % (maxSteps + 1);
  return rescueBox({ left: 40 + k * step, top: 30 + k * step, width: w, height: h }, c);
}

/**
 * 吸附（API 调用 move 时使用；鼠标拖动由 dockview Smart Guides 负责，阈值相同）：
 * 窗口边缘距离容器边缘或其他窗口边缘 ≤ threshold 时贴齐。
 */
export function snapBox(b: Box, c: Size, others: Box[], threshold = 8): Box {
  let { left, top } = b;
  const xs = [0, c.width - b.width];
  const ys = [0, c.height - b.height];
  for (const o of others) {
    xs.push(o.left, o.left + o.width, o.left - b.width, o.left + o.width - b.width);
    ys.push(o.top, o.top + o.height, o.top - b.height, o.top + o.height - b.height);
  }
  const pick = (v: number, cands: number[]) => {
    let best = v;
    let d = threshold + 1;
    for (const x of cands) if (Math.abs(x - v) < d) (d = Math.abs(x - v)), (best = x);
    return d <= threshold ? best : v;
  };
  left = pick(left, xs);
  top = pick(top, ys);
  return { ...b, left: Math.round(left), top: Math.round(top) };
}
