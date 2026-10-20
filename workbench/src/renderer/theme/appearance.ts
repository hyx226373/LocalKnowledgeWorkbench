/** 外观 = 外框样式 × 阅读区样式 × 明暗。只设置 CSS 变量与作用域 CSS，从不改变布局。 */
import { chromeThemes, readingThemes } from '../plugin-host/registry';
import { applyCustomColorOverlay, dropStaleCustomColors } from './customColors';
import { APPEARANCE_CHANGED_EVENT, fullTokens, type Scheme } from './contract';

export type SchemePref = 'light' | 'dark' | 'system';
export interface Appearance {
  chrome: string;
  reading: string;
  scheme: SchemePref;
}

/**
 * 旧「深色外观」滑块可能单独存布尔或 light/dark。
 * 这些字段只读、保留，不改名、不删除。合法的 scheme 优先于滑块。
 */
export const LEGACY_SCHEME_SLIDER_FIELDS = ['schemeSlider', 'darkAppearance'] as const;
/** 仅在没有已存外观时使用。不迁移、不覆盖 layout 里已经保存的选择。 */
export const DEFAULT_APPEARANCE: Appearance = { chrome: 'origin', reading: 'origin', scheme: 'light' };

export function resolveScheme(pref: SchemePref): Scheme {
  if (pref === 'system') return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  return pref;
}

function isScheme(value: unknown): value is SchemePref {
  return value === 'light' || value === 'dark' || value === 'system';
}

/** 滑块开（true / dark）对应深色卡，关对应浅色卡。认不出则返回 null。 */
export function schemeFromSlider(record: Record<string, unknown>): SchemePref | null {
  for (const key of LEGACY_SCHEME_SLIDER_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const value = record[key];
    if (value === true || value === 1 || value === 'dark' || value === 'true') return 'dark';
    if (value === false || value === 0 || value === 'light' || value === 'false') return 'light';
  }
  return null;
}

/**
 * 读出外观。scheme 已是三张卡之一就用它。
 * 否则若旧滑块字段存在，映射到浅色或深色卡。滑块字段原样留在返回对象上。
 * chrome / reading 不是字符串时返回 null。
 */
export function normalizeAppearance(raw: unknown): Appearance | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.chrome !== 'string' || !rec.chrome || typeof rec.reading !== 'string' || !rec.reading) return null;
  const scheme = isScheme(rec.scheme) ? rec.scheme : schemeFromSlider(rec);
  if (!scheme) return null;
  const next: Appearance = { chrome: rec.chrome, reading: rec.reading, scheme };
  for (const [key, value] of Object.entries(rec)) {
    if (key === 'chrome' || key === 'reading' || key === 'scheme') continue;
    (next as Appearance & Record<string, unknown>)[key] = value;
  }
  return next;
}

/** 写入时保留旧字段，只更新三张卡和外框、阅读区。 */
export function mergeAppearance(prev: Appearance | null | undefined, patch: Partial<Appearance>): Appearance {
  const base = prev ?? DEFAULT_APPEARANCE;
  return { ...base, ...patch, chrome: patch.chrome ?? base.chrome, reading: patch.reading ?? base.reading, scheme: patch.scheme ?? base.scheme };
}

/**
 * 从已存的 ui 对象读外观。
 * 合法 scheme 优先。没有合法 scheme 时，把旧滑块映射到浅色或深色卡。
 * 滑块字段若在外观对象或 ui 根上，都抄进返回值，方便下次整份写回时仍能读到。
 */
export function readStoredAppearance(ui: unknown, legacy?: Appearance | null): Appearance {
  const rec = ui && typeof ui === 'object' && !Array.isArray(ui) ? (ui as Record<string, unknown>) : {};
  const appearanceRec = rec.appearance && typeof rec.appearance === 'object' && !Array.isArray(rec.appearance) ? (rec.appearance as Record<string, unknown>) : {};
  const normalized = normalizeAppearance(rec.appearance);
  const fallback = legacy ?? DEFAULT_APPEARANCE;
  const next = (normalized
    ? { ...normalized }
    : {
        ...appearanceRec,
        chrome: typeof appearanceRec.chrome === 'string' && appearanceRec.chrome ? appearanceRec.chrome : fallback.chrome,
        reading: typeof appearanceRec.reading === 'string' && appearanceRec.reading ? appearanceRec.reading : fallback.reading,
        scheme: schemeFromSlider(appearanceRec) ?? schemeFromSlider(rec) ?? fallback.scheme,
      }) as Appearance & Record<string, unknown>;
  for (const key of LEGACY_SCHEME_SLIDER_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(next, key)) continue;
    if (Object.prototype.hasOwnProperty.call(appearanceRec, key)) next[key] = appearanceRec[key];
    else if (Object.prototype.hasOwnProperty.call(rec, key)) next[key] = rec[key];
  }
  return next;
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
  dropStaleCustomColors(root.style);
  for (const [k, v] of Object.entries(fullTokens('chrome', scheme, cv?.tokens))) root.style.setProperty(`--kb-${k}`, v);
  for (const [k, v] of Object.entries(fullTokens('reading', scheme, rv?.tokens))) root.style.setProperty(`--kb-${k}`, v);
  root.dataset.kbChrome = chrome?.id ?? '';
  root.dataset.kbReading = reading?.id ?? '';
  root.dataset.kbScheme = scheme;
  root.style.colorScheme = scheme;
  styleEl('kb-theme-chrome-css').textContent = cv?.css ?? '';
  styleEl('kb-theme-reading-css').textContent = rv?.css ?? '';
  // 自定义配色用 important 盖在主题令牌上。主题写入不带 important，盖不住已有覆盖。
  applyCustomColorOverlay(root.style);
  // 通知阅读器：排版令牌可能变了（即便正文高度不变，例如只改了内边距），按阅读锚点校正位置
  window.dispatchEvent(new Event(APPEARANCE_CHANGED_EVENT));
  return { chrome: chrome?.id ?? a.chrome, reading: reading?.id ?? a.reading, scheme: a.scheme, resolvedScheme: scheme };
}
