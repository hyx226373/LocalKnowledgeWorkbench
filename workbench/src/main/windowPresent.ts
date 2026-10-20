type Bounds = { x: number; y: number; width: number; height: number };

export function presentPlan(s: Bounds & { minimized: boolean }, wa: Bounds): { restore: boolean; bounds: Bounds; nudge: boolean } {
  let bounds = { x: s.x, y: s.y, width: s.width, height: s.height };
  const outside = s.x + s.width <= wa.x || s.y + s.height <= wa.y || s.x >= wa.x + wa.width || s.y >= wa.y + wa.height;
  // 最小化坐标或已断开的显示器位置不能沿用，重新放回工作区。
  if (s.x <= -16000 || s.y <= -16000 || outside) {
    const width = Math.min(s.width, wa.width);
    const height = Math.min(s.height, wa.height);
    bounds = { x: wa.x + Math.floor((wa.width - width) / 2), y: wa.y + Math.floor((wa.height - height) / 2), width, height };
  }
  return { restore: s.minimized, bounds, nudge: true };
}

export function presentSwitches(platform: string, env: Record<string, string | undefined>, argv: readonly string[] = []): { appendSwitch: [string, string?][]; disableHardwareAcceleration: boolean } {
  void argv;
  const appendSwitch: [string, string?][] = platform === 'win32' ? [
    ['disable-backgrounding-occluded-windows'],
    ['disable-features', 'CalculateNativeWinOcclusion'],
  ] : [];
  // 呈现计划从不追加进程内 GPU 开关，也不因启动参数关闭硬件加速。Windows 上该模式画不出合成帧。
  return {
    appendSwitch,
    disableHardwareAcceleration: env.KB_DISABLE_GPU === '1',
  };
}
