/**
 * 内容缩放的纯计算。内容坐标 =（鼠标 − 偏移）÷ 比例；新偏移 = 鼠标 − 内容坐标 × 新比例。
 * 比例、面板尺寸、画布缩放是三个动作；这里只算内容。
 */

export interface Point {
  x: number;
  y: number;
}

export const PDF_SCALE_MIN = 0.4;
export const PDF_SCALE_MAX = 4;
/** 首开「适合宽度」仍封顶 150%；显式适应不使用这个上限。 */
export const PDF_OPEN_CAP = 1.5;
export const TEXT_SCALE_MIN = 0.5;
export const TEXT_SCALE_MAX = 3;
export const IMAGE_SCALE_MIN = 0.1;
export const IMAGE_SCALE_MAX = 8;
export const WEB_SCALE_MIN = 0.5;
export const WEB_SCALE_MAX = 3;

/** 网页按格 ±10%（1.1）。只在主进程用。 */
export function stepWebZoom(current: number, direction: 1 | -1): number {
  const base = Number.isFinite(current) && current > 0 ? current : 1;
  return clampScale(base * (direction > 0 ? 1.1 : 1 / 1.1), WEB_SCALE_MIN, WEB_SCALE_MAX);
}

/** 缩放后让鼠标下的内容留在原处。scroll 与 mouse 同一套视口像素。 */
export function webZoomScroll(scroll: number, mouse: number, prev: number, next: number): number {
  if (!(prev > 0) || !Number.isFinite(scroll) || !Number.isFinite(mouse) || !Number.isFinite(next)) return Number.isFinite(scroll) ? scroll : 0;
  return (scroll + mouse) * (next / prev) - mouse;
}

/** 与 styles.css `.kb-pdf-page` 的 border-top 一致。 */
export const PDF_PAGE_BORDER_TOP = 10;

/** 工具栏按钮一步。PDF 原按钮是 ±0.2，e2e 按这个差值断言。 */
export const ZOOM_STEP = 0.2;

const WHEEL_LIMIT = 400;
const LINE_PX = 16;

export function clampScale(scale: number, min: number, max: number): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  if (!Number.isFinite(scale)) return lo;
  return Math.min(hi, Math.max(lo, scale));
}

export function stepScale(current: number, direction: 1 | -1, min: number, max: number): number {
  return clampScale(+(current + direction * ZOOM_STEP).toFixed(2), min, max);
}

/**
 * 鼠标所在的内容坐标不变时，比例从 s 变成 s1 后的新偏移。
 * m、off 与调用方使用同一套坐标（视口内像素，原点在内容区左上）。
 */
export function anchorOffset(mouse: number, offset: number, scale: number, nextScale: number): number {
  if (!Number.isFinite(scale) || scale === 0 || !Number.isFinite(mouse) || !Number.isFinite(offset) || !Number.isFinite(nextScale)) return offset;
  const content = (mouse - offset) / scale;
  return mouse - content * nextScale;
}

/**
 * 内容比视口小：偏移夹在 [0, V − 内容]；内容比视口大：夹在 [V − 内容, 0]。
 * 只收到边缘，不改成居中。
 */
export function clampOffset(offset: number, viewport: number, contentPx: number): number {
  if (!Number.isFinite(offset)) return 0;
  const v = Number.isFinite(viewport) ? viewport : 0;
  const c = Number.isFinite(contentPx) ? contentPx : 0;
  const slack = v - c;
  const lo = Math.min(0, slack);
  const hi = Math.max(0, slack);
  return Math.min(hi, Math.max(lo, offset));
}

/** deltaMode：0 像素，1 行（×16），2 页（×pageH）。单次夹紧 ±400。 */
export function normalizeDelta(dy: number, deltaMode: number, pageH: number): number {
  if (!Number.isFinite(dy)) return 0;
  let px = dy;
  if (deltaMode === 1) px = dy * LINE_PX;
  else if (deltaMode === 2) px = dy * (Number.isFinite(pageH) && pageH > 0 ? pageH : 0);
  if (!Number.isFinite(px)) return 0;
  return Math.min(WHEEL_LIMIT, Math.max(-WHEEL_LIMIT, px));
}

/** 向下（正 Δ）缩小。一格约 100px → 2^0.2 ≈ 1.15 倍。 */
export function factorOf(px: number): number {
  if (!Number.isFinite(px) || px === 0) return 1;
  return 2 ** (-px / 500);
}

/** 不放大小图：适应比例 ≤ 1。尺寸未知时按 1。 */
export function imageFitScale(viewportW: number, viewportH: number, naturalW: number, naturalH: number): number {
  if (viewportW <= 0 || viewportH <= 0 || naturalW <= 0 || naturalH <= 0) return 1;
  return Math.min(viewportW / naturalW, viewportH / naturalH, 1);
}

/** 下限 0.1；适应值更小则下限取适应值。上限 8。 */
export function imageScaleBounds(fitScale: number): { min: number; max: number } {
  const fit = Number.isFinite(fitScale) && fitScale > 0 ? fitScale : 1;
  return { min: Math.min(IMAGE_SCALE_MIN, fit), max: IMAGE_SCALE_MAX };
}

export function pdfOpenScale(viewportW: number, pageW: number): number {
  if (!(viewportW > 0) || !(pageW > 0)) return 1.2;
  return clampScale(+((viewportW - 40) / pageW).toFixed(2), PDF_SCALE_MIN, PDF_OPEN_CAP);
}

/** 适合宽度，不使用首开的 150% 上限；仍夹在 0.4–4。 */
export function pdfFitScale(viewportW: number, pageW: number): number {
  if (!(viewportW > 0) || !(pageW > 0)) return 1;
  return clampScale(+((viewportW - 40) / pageW).toFixed(2), PDF_SCALE_MIN, PDF_SCALE_MAX);
}

export interface PdfLayout {
  toolbarH: number;
  viewportW: number;
  viewportH: number;
  borderTop: number;
  pageW: number;
  pageH: number;
  pageCount: number;
}

export function pdfLayout(input: {
  toolbarH: number;
  viewportW: number;
  viewportH: number;
  baseW: number;
  baseH: number;
  scale: number;
  pageCount: number;
  borderTop?: number;
}): PdfLayout {
  return {
    toolbarH: input.toolbarH,
    viewportW: input.viewportW,
    viewportH: input.viewportH,
    borderTop: input.borderTop ?? PDF_PAGE_BORDER_TOP,
    pageW: Math.round(input.baseW * input.scale),
    pageH: Math.round(input.baseH * input.scale),
    pageCount: Math.max(0, input.pageCount),
  };
}

/** 页框左上角（含 border-top 之外的文档坐标）。窄页水平居中，宽页贴左。 */
export function pdfPageOrigin(layout: PdfLayout, pageIndex: number): { left: number; top: number } {
  const left = Math.max(0, (layout.viewportW - layout.pageW) / 2);
  const top = layout.toolbarH + pageIndex * (layout.borderTop + layout.pageH);
  return { left, top };
}

export interface PdfHit {
  page: number;
  /** 相对内容盒（border 之下），可以略超出 0..1（点在边框上）。 */
  fx: number;
  fy: number;
}

export function pdfHit(layout: PdfLayout, scrollLeft: number, scrollTop: number, localX: number, localY: number): PdfHit | null {
  if (layout.pageW <= 0 || layout.pageH <= 0 || layout.pageCount <= 0) return null;
  const cx = scrollLeft + localX;
  const cy = scrollTop + localY;
  for (let i = 0; i < layout.pageCount; i++) {
    const origin = pdfPageOrigin(layout, i);
    const bottom = origin.top + layout.borderTop + layout.pageH;
    const right = origin.left + layout.pageW;
    if (cx >= origin.left && cx < right && cy >= origin.top && cy < bottom) {
      return {
        page: i + 1,
        fx: (cx - origin.left) / layout.pageW,
        fy: (cy - (origin.top + layout.borderTop)) / layout.pageH,
      };
    }
  }
  return null;
}

/** 让命中点留在视口内的同一位置。滚动只夹到合法范围，不改去居中。 */
export function pdfScrollForAnchor(layout: PdfLayout, page: number, fx: number, fy: number, localX: number, localY: number): { scrollLeft: number; scrollTop: number } {
  const index = Math.min(layout.pageCount, Math.max(1, page)) - 1;
  const origin = pdfPageOrigin(layout, index);
  const contentX = origin.left + fx * layout.pageW;
  const contentY = origin.top + layout.borderTop + fy * layout.pageH;
  let scrollLeft = contentX - localX;
  let scrollTop = contentY - localY;
  const scrollW = Math.max(layout.viewportW, layout.pageW);
  const scrollH = layout.toolbarH + layout.pageCount * (layout.borderTop + layout.pageH);
  const maxL = Math.max(0, scrollW - layout.viewportW);
  const maxT = Math.max(0, scrollH - layout.viewportH);
  scrollLeft = Math.min(maxL, Math.max(0, scrollLeft));
  scrollTop = Math.min(maxT, Math.max(0, scrollTop));
  return { scrollLeft, scrollTop };
}
