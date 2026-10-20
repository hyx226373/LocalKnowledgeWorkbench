/**
 * 主窗口标题栏叠层。隐藏系统标题文字，在 Windows 上保留最小化 / 最大化 / 关闭。
 * 不设 frame:false：无边框窗口会丢掉系统贴靠。
 * 叠层默认色跟现有窗口 backgroundColor（#1e1e1e）。不要把浅色主题色写成唯一窗口色。
 */

/** 与预览顶栏 48px 对齐，系统最小化/最大化/关闭叠层盖住整条顶栏。 */
export const WINDOW_CHROME_OVERLAY_HEIGHT = 48;
export const WINDOW_CHROME_DEFAULT_COLOR = '#1e1e1e';
export const WINDOW_CHROME_DEFAULT_SYMBOL = '#e6e6e6';

export interface WindowChromeColors {
  color?: string;
  symbolColor?: string;
}

export interface WindowChromeOverlay {
  color: string;
  symbolColor: string;
  height: number;
}

/** 可展开进 BrowserWindow。不含 frame，边框保持 Electron 默认 true。 */
export interface WindowChromeOptions {
  titleBarStyle: 'hidden';
  titleBarOverlay: WindowChromeOverlay;
}

export interface WindowChromeTarget {
  setTitleBarOverlay?: (overlay: WindowChromeOverlay) => void;
}

export function windowChromeOptions(colors: WindowChromeColors = {}): WindowChromeOptions {
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: colors.color ?? WINDOW_CHROME_DEFAULT_COLOR,
      symbolColor: colors.symbolColor ?? WINDOW_CHROME_DEFAULT_SYMBOL,
      height: WINDOW_CHROME_OVERLAY_HEIGHT,
    },
  };
}

/** 只改叠层颜色。没有 setTitleBarOverlay 时返回，不关闭窗口。 */
export function applyWindowChromeColors(
  win: WindowChromeTarget | null | undefined,
  colors: { color: string; symbolColor: string },
): void {
  if (win == null || typeof win.setTitleBarOverlay !== 'function') return;
  win.setTitleBarOverlay({
    color: colors.color,
    symbolColor: colors.symbolColor,
    height: WINDOW_CHROME_OVERLAY_HEIGHT,
  });
}
