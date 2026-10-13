/**
 * 三种阅读器的视图状态。字段只在 commit 时由阅读器写回。
 * 禁止用 contentOnly / editMode / hwnd / pid 这些名字。
 */
import { clampScale, IMAGE_SCALE_MAX, PDF_SCALE_MAX, PDF_SCALE_MIN, TEXT_SCALE_MAX, TEXT_SCALE_MIN } from './math';

export const MD_MODES = ['preview', 'edit', 'split'] as const;
export const TEXT_MODES = ['read', 'edit'] as const;
export const TEX_MODES = ['source', 'math', 'split'] as const;

export interface ScrollState {
  scroll: number;
  /** Markdown：preview | edit | split；文本：read | edit；TeX：source | math | split。旧状态没有此字段 = 阅读/预览 */
  mode?: string;
  /** 阅读比例。缺省 = 1。编辑框不使用这个字段。 */
  zoom?: number;
}

export interface PdfState {
  page: number;
  scale: number;
  /** 页内位置：视口顶部相对第 page 页顶部的偏移，以页高为单位 */
  off?: number;
  /** 横向：视口左缘相对页左缘的偏移，以页宽为单位。旧状态没有 = 0 */
  x?: number;
  dark?: boolean;
}

export interface ImageState {
  mode: 'fit' | 'free';
  scale: number;
  /** 视口中心对应的图像坐标比例，面板改尺寸后仍把这一点放在中心 */
  cx: number;
  cy: number;
}

const MODE_OK = new Set<string>([...MD_MODES, ...TEXT_MODES, ...TEX_MODES]);

export function effectiveZoom(state: { zoom?: number } | null | undefined): number {
  return typeof state?.zoom === 'number' && Number.isFinite(state.zoom) ? state.zoom : 1;
}

export function restoreScrollState(raw: unknown): ScrollState | undefined {
  if (!raw || typeof (raw as ScrollState).scroll !== 'number' || !Number.isFinite((raw as ScrollState).scroll)) return undefined;
  const src = raw as ScrollState;
  const mode = typeof src.mode === 'string' && MODE_OK.has(src.mode) ? src.mode : undefined;
  const zoom = typeof src.zoom === 'number' && Number.isFinite(src.zoom) ? clampScale(src.zoom, TEXT_SCALE_MIN, TEXT_SCALE_MAX) : undefined;
  const out: ScrollState = { scroll: Math.min(1, Math.max(0, src.scroll)) };
  if (mode) out.mode = mode;
  if (zoom !== undefined && Math.abs(zoom - 1) >= 1e-6) out.zoom = zoom;
  return out;
}

/** 滚动上报只改 scroll，zoom / mode 留在原状态里。 */
export function mergeScrollReport(prev: ScrollState, scroll: number): ScrollState {
  return { ...prev, scroll };
}

export function withMode(prev: ScrollState, mode: string, def: string): ScrollState {
  const { mode: _old, ...rest } = prev;
  if (mode === def) return rest;
  return { ...rest, mode };
}

export function withZoom(prev: ScrollState, zoom: number): ScrollState {
  const { zoom: _old, ...rest } = prev;
  if (!Number.isFinite(zoom) || Math.abs(zoom - 1) < 1e-6) return rest;
  return { ...rest, zoom: clampScale(zoom, TEXT_SCALE_MIN, TEXT_SCALE_MAX) };
}

const PDF_X_LIMIT = 20;

export function restorePdfState(raw: unknown): PdfState | undefined {
  const r = raw as PdfState;
  if (!r || typeof r.page !== 'number' || typeof r.scale !== 'number' || !Number.isFinite(r.page) || !Number.isFinite(r.scale)) return undefined;
  const off = typeof r.off === 'number' && Number.isFinite(r.off) ? Math.min(1, Math.max(-1, r.off)) : 0;
  const out: PdfState = { page: Math.max(1, Math.floor(r.page)), scale: clampScale(r.scale, PDF_SCALE_MIN, PDF_SCALE_MAX), off };
  if (typeof r.x === 'number' && Number.isFinite(r.x)) out.x = Math.min(PDF_X_LIMIT, Math.max(-PDF_X_LIMIT, r.x));
  if (r.dark === true) out.dark = true;
  return out;
}

export function restoreImageState(raw: unknown): ImageState | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Partial<ImageState>;
  if (r.mode !== 'fit' && r.mode !== 'free') return undefined;
  if (typeof r.scale !== 'number' || typeof r.cx !== 'number' || typeof r.cy !== 'number') return undefined;
  if (!Number.isFinite(r.scale) || !Number.isFinite(r.cx) || !Number.isFinite(r.cy) || r.scale <= 0) return undefined;
  // 适应值可能小于 0.1，恢复时先保留到上限 8；阅读器挂上后再按当前适应值收下限。
  return { mode: r.mode, scale: Math.min(IMAGE_SCALE_MAX, r.scale), cx: r.cx, cy: r.cy };
}

export type ZoomAnchorKind = 'exact' | 'page' | 'reflow' | 'approx';

/** 本拍真正做了的阅读器。控制台、沙箱、网页、托管不在这里。 */
export const READER_ZOOM: Record<string, { anchor: ZoomAnchorKind; min: number; max: number; note?: string }> = {
  'builtin.image': { anchor: 'exact', min: 0.1, max: 8, note: '适应比例更小时下限取适应值；重置为原始像素 100%' },
  'builtin.pdf': { anchor: 'page', min: PDF_SCALE_MIN, max: PDF_SCALE_MAX, note: 'viewScale 每帧改尺寸，renderScale 在 commit 时重画' },
  'builtin.markdown': { anchor: 'reflow', min: TEXT_SCALE_MIN, max: TEXT_SCALE_MAX, note: '根上 --content-zoom；textarea 不缩放' },
  'builtin.text': { anchor: 'reflow', min: TEXT_SCALE_MIN, max: TEXT_SCALE_MAX, note: '根上 --content-zoom；textarea 不缩放' },
  'builtin.tex': { anchor: 'reflow', min: TEXT_SCALE_MIN, max: TEXT_SCALE_MAX, note: '根上 --content-zoom；只读，不写回 .tex' },
};
