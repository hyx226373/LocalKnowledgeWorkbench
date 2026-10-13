/** 外观 = 外框样式 × 阅读区样式 × 明暗。只设置 CSS 变量与作用域 CSS，从不改变布局。 */
import { chromeThemes, readingThemes } from '../plugin-host/registry';
import { APPEARANCE_CHANGED_EVENT, fullTokens, type Scheme } from './contract';

export type SchemePref = 'light' | 'dark' | 'system';
export interface Appearance {
  chrome: string;
  reading: string;
  scheme: SchemePref;
}
/** 仅在没有已存外观时使用。不迁移、不覆盖 layout 里已经保存的选择。 */
export const DEFAULT_APPEARANCE: Appearance = { chrome: 'origin', reading: 'origin', scheme: 'light' };

export function resolveScheme(pref: SchemePref): Scheme {
  if (pref === 'system') return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  return pref;
}

function styleEl(id: string) {
  let el = document.getElementById(id) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = id;
    document.head.appendChild(el);
  }
  return el;
}

/** 应用外观；不存在的样式回退到第一个已注册的。返回实际生效的选择。 */
export function applyAppearance(a: Appearance): Appearance & { resolvedScheme: Scheme } {
  const scheme = resolveScheme(a.scheme);
  const chrome = chromeThemes.get(a.chrome) ?? chromeThemes.all()[0];
  const reading = readingThemes.get(a.reading) ?? readingThemes.all()[0];
  const root = document.documentElement;
  const cv = chrome?.[scheme];
  const rv = reading?.[scheme];
  for (const [k, v] of Object.entries(fullTokens('chrome', scheme, cv?.tokens))) root.style.setProperty(`--kb-${k}`, v);
  for (const [k, v] of Object.entries(fullTokens('reading', scheme, rv?.tokens))) root.style.setProperty(`--kb-${k}`, v);
  root.dataset.kbChrome = chrome?.id ?? '';
  root.dataset.kbReading = reading?.id ?? '';
  root.dataset.kbScheme = scheme;
  root.style.colorScheme = scheme;
  styleEl('kb-theme-chrome-css').textContent = cv?.css ?? '';
  styleEl('kb-theme-reading-css').textContent = rv?.css ?? '';
  // 通知阅读器：排版令牌可能变了（即便正文高度不变，例如只改了内边距），按阅读锚点校正位置
  window.dispatchEvent(new Event(APPEARANCE_CHANGED_EVENT));
  return { chrome: chrome?.id ?? a.chrome, reading: reading?.id ?? a.reading, scheme: a.scheme, resolvedScheme: scheme };
}
