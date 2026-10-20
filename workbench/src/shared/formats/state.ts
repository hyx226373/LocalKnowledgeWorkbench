/** 阅读位置。正文、图片字节、密码都不进面板状态。 */
export interface FormatViewState {
  page?: number;
  sheet?: number;
  slide?: number;
  scroll?: number;
  scale?: number;
}

const STATE_KEYS = ['page', 'sheet', 'slide', 'scroll', 'scale'] as const;

export function formatViewState(input: Record<string, unknown>): FormatViewState {
  const out: FormatViewState = {};
  for (const key of STATE_KEYS) {
    const value = input[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}
