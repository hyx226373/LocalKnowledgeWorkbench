/**
 * desk-r1 坐标链 + DPI（01 §3）。
 * 空间标签强制：PanelCss → VideoContent → SourcePixel → WinDesktop。
 * scaleFactor 仅在 source↔win 边界使用；面板内部统一 CSS。
 * 缩面板 ≠ 改 Win 分辨率；只改 contentCss 与映射。
 */
import type {
  PanelCssPoint,
  SourcePixelPoint,
  VideoContentPoint,
  VideoMetrics,
  WinDesktopPoint,
} from './types';

/** Windows WHEEL_DELTA：一次刻度通常为 120 */
export const WHEEL_DELTA = 120;

/**
 * panel CSS → 视频内容区；点在 letterbox 外返回 null。
 * contentCss 相对 videoElementCss（object-fit: contain 的实际绘制矩形）。
 */
export function panelCssToVideoContent(p: PanelCssPoint, m: VideoMetrics): VideoContentPoint | null {
  if (p.space !== 'panel-css') throw new Error('panelCssToVideoContent: expected space panel-css');
  const absX = m.videoElementCss.x + m.contentCss.x;
  const absY = m.videoElementCss.y + m.contentCss.y;
  const w = m.contentCss.width;
  const h = m.contentCss.height;
  if (w <= 0 || h <= 0) return null;
  const lx = p.x - absX;
  const ly = p.y - absY;
  if (lx < 0 || ly < 0 || lx > w || ly > h) return null;
  return { x: lx, y: ly, space: 'video-content' };
}

/** 视频内容区 → 源画面像素（按 contentCss 尺寸线性映射到 sourceWidth/Height） */
export function videoContentToSourcePixel(p: VideoContentPoint, m: VideoMetrics): SourcePixelPoint {
  if (p.space !== 'video-content') throw new Error('videoContentToSourcePixel: expected space video-content');
  const w = m.contentCss.width;
  const h = m.contentCss.height;
  if (w <= 0 || h <= 0) {
    return { x: 0, y: 0, space: 'source-pixel' };
  }
  // 夹到内容区边缘内侧，避免边界 1px 越界
  const nx = Math.min(Math.max(p.x, 0), w);
  const ny = Math.min(Math.max(p.y, 0), h);
  const sx = (nx / w) * m.sourceWidth;
  const sy = (ny / h) * m.sourceHeight;
  return { x: sx, y: sy, space: 'source-pixel' };
}

/**
 * 源画面像素 → Win 桌面物理坐标。
 * 约定：sourceWidth/Height 与捕获帧一致（物理像素）；
 * sourceOrigin 为源屏在虚拟桌面的原点（物理像素）。
 * scaleFactor 供 DPI 审计；当源帧为 DIP 时由调用方先把 metrics 归一化为物理像素。
 * 本函数：WinDesktop = sourceOrigin + sourcePixel（物理像素直加）。
 */
export function sourcePixelToWinDesktop(p: SourcePixelPoint, m: VideoMetrics): WinDesktopPoint {
  if (p.space !== 'source-pixel') throw new Error('sourcePixelToWinDesktop: expected space source-pixel');
  void m.scaleFactor; // 边界标记：DPI 已体现在 source 物理像素与 origin 中
  return {
    x: m.sourceOrigin.x + p.x,
    y: m.sourceOrigin.y + p.y,
    space: 'win-desktop',
  };
}

/** 组合：面板点击 → Win 桌面；letterbox 外 null */
export function panelCssToWinDesktop(p: PanelCssPoint, m: VideoMetrics): WinDesktopPoint | null {
  const vc = panelCssToVideoContent(p, m);
  if (!vc) return null;
  const sp = videoContentToSourcePixel(vc, m);
  return sourcePixelToWinDesktop(sp, m);
}

/**
 * 滚轮：CSS/DOM delta → 传给 helper 的整数 delta。
 * 策略（与 Windows WHEEL_DELTA=120 对齐）：
 * - deltaMode 0 (PIXEL): 累加像素，约 100px ≈ 一次刻度 → round(delta / 100 * 120)
 * - deltaMode 1 (LINE):  每行 × 120
 * - deltaMode 2 (PAGE):  每页 × 120×3
 * 结果四舍五入为整数；符号保留（正=向下/向右，与 DOM WheelEvent 一致）。
 */
export function normalizeWheelDelta(
  deltaX: number,
  deltaY: number,
  deltaMode: number,
): { dx: number; dy: number } {
  const scale =
    deltaMode === 1 ? WHEEL_DELTA : deltaMode === 2 ? WHEEL_DELTA * 3 : WHEEL_DELTA / 100;
  return {
    dx: Math.round(deltaX * scale),
    dy: Math.round(deltaY * scale),
  };
}

/**
 * 根据 object-fit: contain 计算 contentCss（相对 videoElementCss）。
 * 供面板在视频元素布局变化时更新 VideoMetrics。
 */
export function containContentRect(
  elementWidth: number,
  elementHeight: number,
  sourceWidth: number,
  sourceHeight: number,
): { x: number; y: number; width: number; height: number } {
  if (elementWidth <= 0 || elementHeight <= 0 || sourceWidth <= 0 || sourceHeight <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const srcAspect = sourceWidth / sourceHeight;
  const elAspect = elementWidth / elementHeight;
  let width: number;
  let height: number;
  if (srcAspect > elAspect) {
    width = elementWidth;
    height = elementWidth / srcAspect;
  } else {
    height = elementHeight;
    width = elementHeight * srcAspect;
  }
  return {
    x: (elementWidth - width) / 2,
    y: (elementHeight - height) / 2,
    width,
    height,
  };
}
