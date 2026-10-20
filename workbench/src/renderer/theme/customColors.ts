/**
 * 自定义配色。只新增设置键 settings.customColors，不改已有外观字段。
 * 值是 CSS 变量名（--kb-*）到颜色。非法颜色丢掉，未知顶层字段保留。
 */

export const CUSTOM_COLORS_KEY = 'settings.customColors';
export const CUSTOM_COLORS_EVENT = 'kb:custom-colors';

export interface CustomColorField {
  key: string;
  label: string;
}

/** 外观页可编辑的变量。都是主题契约里的 --kb-* 颜色。 */
export const CUSTOM_COLOR_FIELDS: readonly CustomColorField[] = [
  { key: '--kb-color-accent', label: '主色' },
  { key: '--kb-color-bg', label: '背景色' },
  { key: '--kb-color-chrome', label: '侧栏背景' },
  { key: '--kb-color-surface', label: '卡片背景' },
  { key: '--kb-color-text', label: '正文文字' },
  { key: '--kb-color-text-muted', label: '次要文字' },
  { key: '--kb-color-border', label: '边框线' },
  { key: '--kb-color-selected', label: '选中高亮' },
  { key: '--kb-color-success', label: '成功' },
  { key: '--kb-color-warning', label: '警告' },
  { key: '--kb-color-danger', label: '危险' },
];

const FIELD_KEYS = new Set(CUSTOM_COLOR_FIELDS.map((field) => field.key));

export interface CustomColorPreset {
  id: string;
  label: string;
  vars: Record<string, string>;
}

/** 预设只改强调色和选中底，浅色/深色的表面色仍由方案决定。不用紫色。 */
export const CUSTOM_COLOR_PRESETS: readonly CustomColorPreset[] = [
  { id: 'blue', label: '默认蓝', vars: { '--kb-color-accent': '#2563EB', '--kb-color-selected': '#EFF4FF' } },
  { id: 'green', label: '墨绿', vars: { '--kb-color-accent': '#0F766E', '--kb-color-selected': '#ECFDF5' } },
  { id: 'orange', label: '暖橙', vars: { '--kb-color-accent': '#C2410C', '--kb-color-selected': '#FFF7ED' } },
  { id: 'rose', label: '玫瑰', vars: { '--kb-color-accent': '#BE123C', '--kb-color-selected': '#FFF1F2' } },
  { id: 'slate', label: '石墨', vars: { '--kb-color-accent': '#374151', '--kb-color-selected': '#F3F4F6' } },
];

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FUNC = /^(?:rgb|rgba|hsl|hsla)\(\s*[0-9.%\s,/+-]+\s*\)$/;

/** 只接受十六进制和 rgb/hsl 函数。url、表达式、分号一律拒绝。 */
export function isCustomColorValue(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text || text.length > 80) return false;
  if (/[;{}<>]|url\s*\(|expression\s*\(|var\s*\(|!important/i.test(text)) return false;
  return HEX.test(text) || FUNC.test(text);
}

export function isCustomColorKey(key: string): boolean {
  return FIELD_KEYS.has(key);
}

/** 丢掉非法键和非法值。不修改入参。 */
export function sanitizeColorVars(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isCustomColorKey(key) || !isCustomColorValue(value)) continue;
    out[key] = value.trim();
  }
  return out;
}

export interface CustomColorsFile {
  v: 1;
  enabled: boolean;
  vars: Record<string, string>;
  [extra: string]: unknown;
}

/** 缺键（null/undefined）表示还没存过，调用方应保留快照里的覆盖。已存对象则解析。 */
export function parseCustomColors(raw: unknown): CustomColorsFile | null {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return { v: 1, enabled: false, vars: {} };
  const rec = raw as Record<string, unknown>;
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rec)) {
    if (key === 'v' || key === 'enabled' || key === 'vars') continue;
    extra[key] = value;
  }
  const vars = sanitizeColorVars(rec.vars);
  return {
    ...extra,
    v: 1,
    enabled: rec.enabled === true,
    vars,
  };
}

/** 清空颜色并关掉覆盖。其它已存字段留着。 */
export function resetCustomColors(current: CustomColorsFile | null | undefined): CustomColorsFile {
  const base = current ?? { v: 1 as const, enabled: false, vars: {} };
  return { ...base, v: 1, enabled: false, vars: {} };
}

/** 实际盖到界面上的变量。关闭或没有颜色时是空对象。 */
export function effectiveCustomColors(file: CustomColorsFile | null | undefined): Record<string, string> {
  if (!file || file.enabled !== true) return {};
  return sanitizeColorVars(file.vars);
}

export function matchingPresetId(vars: Record<string, string>): string | null {
  const keys = Object.keys(vars).sort();
  for (const preset of CUSTOM_COLOR_PRESETS) {
    const theirs = Object.keys(preset.vars).sort();
    if (keys.length !== theirs.length) continue;
    if (keys.every((key, index) => key === theirs[index] && vars[key] === preset.vars[key])) return preset.id;
  }
  return keys.length ? 'custom' : null;
}

type StyleTarget = {
  setProperty(name: string, value: string, priority?: string): void;
  removeProperty(name: string): string;
};

let overlay: Record<string, string> = {};
let painted: string[] = [];

export function getCustomColorOverlay(): Record<string, string> {
  return { ...overlay };
}

function styleTarget(target?: StyleTarget | null): StyleTarget | null {
  if (target) return target;
  return typeof document === 'undefined' ? null : document.documentElement.style;
}

/**
 * 去掉已经不在覆盖里的变量。
 * 必须在 applyAppearance 写主题令牌之前调用。之后再 removeProperty 会把刚写上的令牌一起删掉。
 */
export function dropStaleCustomColors(target?: StyleTarget | null): void {
  const el = styleTarget(target);
  if (!el) return;
  const next = new Set(Object.keys(overlay));
  const keep: string[] = [];
  for (const key of painted) {
    if (next.has(key)) keep.push(key);
    else el.removeProperty(key);
  }
  painted = keep;
}

/** 只把当前覆盖写成 important，不删除。 */
export function applyCustomColorOverlay(target?: StyleTarget | null): void {
  const el = styleTarget(target);
  if (!el) return;
  for (const [key, value] of Object.entries(overlay)) el.setProperty(key, value, 'important');
  painted = Object.keys(overlay);
}

export function paintCustomColorOverlay(target?: StyleTarget | null): void {
  dropStaleCustomColors(target);
  applyCustomColorOverlay(target);
}

/** paint 默认立刻写到文档。notify 通知壳层把当前外观再铺一遍并写入快照。 */
export function setCustomColorOverlay(vars: Record<string, string>, opts?: { paint?: boolean; notify?: boolean }): void {
  overlay = sanitizeColorVars(vars);
  if (opts?.paint !== false) paintCustomColorOverlay();
  if (opts?.notify && typeof window !== 'undefined') window.dispatchEvent(new Event(CUSTOM_COLORS_EVENT));
}
