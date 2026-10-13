// X 屏幕截图（含主进程的原生 WebContentsView）：Playwright 的 page.screenshot 只截主窗口的网页内容，
// 看不到盖在上面的原生网页视图；这里用 ffmpeg x11grab 截取窗口在屏幕上的真实像素（用户实际看到的画面）。
import { execFileSync } from 'node:child_process';

export function hasX() {
  return !!process.env.DISPLAY;
}

/** 截取窗口内容区域（屏幕坐标），输出 PNG */
export async function grabWindow(app, file) {
  const b = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentBounds());
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'x11grab', '-video_size', `${b.width}x${b.height}`, '-i', `${process.env.DISPLAY}+${b.x},${b.y}`, '-frames:v', '1', file]);
  return b;
}

/** PNG 中某个矩形的原始 RGB 像素（ffmpeg 裁剪） */
export function rawRegion(png, r) {
  const w = Math.max(2, Math.floor(r.width / 2) * 2);
  const h = Math.max(2, Math.floor(r.height / 2) * 2);
  return {
    w,
    h,
    buf: execFileSync('ffmpeg', ['-loglevel', 'error', '-i', png, '-vf', `crop=${w}:${h}:${Math.round(r.x)}:${Math.round(r.y)}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 * 1024 * 1024 }),
  };
}

/** 两张 PNG 同一矩形的平均每通道差（0–255） */
export function regionDiff(pngA, pngB, r) {
  const a = rawRegion(pngA, r).buf;
  const b = rawRegion(pngB, r).buf;
  const n = Math.min(a.length, b.length);
  let d = 0;
  for (let i = 0; i < n; i++) d += Math.abs(a[i] - b[i]);
  return n ? d / n : 255;
}
