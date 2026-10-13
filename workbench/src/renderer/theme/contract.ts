/**
 * 主题接口（纯函数，可在 Node 测试与 theme:shots 校验中使用）。
 * 主题包 = theme.json + 可选 CSS + 可选布局预设 JSON；只含数据，不含可执行代码。
 * 三个独立的轴：外框样式（chromeThemes）、阅读区样式（readingThemes）、工作区布局预设（layoutPresets）。
 * 每个外框/阅读区样式都必须同时提供 light 与 dark 变体。
 */
import contract from '../../shared/theme-contract.json';
import { satisfies } from '../plugin-host/semver';
import { validatePreset, type LayoutPresetTemplate } from '../plugin-host/layoutModel';
import type { ChromeThemeContribution, ReadingThemeContribution, ThemeVariant } from '../plugin-host/types';

export type Axis = 'chrome' | 'reading';
export type Scheme = 'light' | 'dark';
export interface TokenDef {
  name: string;
  axis: Axis;
  group: string;
  description: string;
  default: Record<Scheme, string>;
  /** 颜色角色（v2）：点分语义名，例如 surface.sunken、text.disabled、splitter.dragging */
  role?: string;
  /** 首次出现的主题接口版本 */
  since?: string;
}
export interface ComponentDef {
  id: string;
  name: string;
  axis: Axis;
  hook: string;
  states: Record<string, string | null>;
  note?: string;
  since?: string;
}
export const THEME_CONTRACT_VERSION: string = contract.version;
export const TOKENS = contract.tokens as TokenDef[];
export const COMPONENTS = contract.components as ComponentDef[];
export const STATES = contract.states as string[];
export const STATE_DESCRIPTIONS = contract.stateDescriptions as Record<string, string>;
/** v1 → v2 改名的令牌（旧名 → 新名）；旧名在任何主题包中都会被换算并给出警告 */
export const RENAMED_TOKENS = contract.compat.renamedTokens as Record<string, string>;
/** 颜色角色 → 令牌名 */
export const ROLES: Record<string, string> = Object.fromEntries(TOKENS.filter((t) => t.role).map((t) => [t.role!, t.name]));
const TOKEN_BY_NAME = new Map(TOKENS.map((t) => [t.name, t]));
const DISALLOWED_PROPS = new Set(contract.css.disallowedProperties);
const ALLOWED_AT = contract.css.allowedAtRules;
const FORBIDDEN_VALUES = contract.css.forbiddenValues;

export function tokensOf(axis: Axis) {
  return TOKENS.filter((t) => t.axis === axis);
}

/** 完整令牌表：主题给出的值覆盖默认值；未知令牌被忽略（由校验报告） */
export function fullTokens(axis: Axis, scheme: Scheme, partial: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tokensOf(axis)) out[t.name] = partial[t.name] ?? t.default[scheme];
  return out;
}

export function checkTokenValue(v: unknown): string | null {
  if (typeof v !== 'string') return '值必须是字符串';
  if (v.length > 300) return '值过长';
  if (/[;{}<>]/.test(v)) return '值中不能包含 ; { } < >';
  const low = v.toLowerCase();
  for (const f of FORBIDDEN_VALUES) if (low.includes(f)) return `值中不能包含 ${f}`;
  return null;
}

export function validateTokens(axis: Axis, tokens: unknown, where: string): { errors: string[]; warnings: string[]; tokens: Record<string, string> } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const out: Record<string, string> = {};
  if (!tokens || typeof tokens !== 'object') return { errors: [`${where}: tokens 必须是对象`], warnings, tokens: out };
  for (const [k0, v] of Object.entries(tokens as Record<string, unknown>)) {
    let k = k0;
    if (RENAMED_TOKENS[k0]) {
      k = RENAMED_TOKENS[k0];
      warnings.push(`${where}: 令牌 ${k0} 在主题接口 2.0 中改名为 ${k}，已自动换算（请在 theme.json 中改名）`);
      if (k0 in (tokens as Record<string, unknown>) && k in (tokens as Record<string, unknown>)) continue; // 新旧名同时出现时以新名为准
    }
    const def = TOKEN_BY_NAME.get(k);
    if (!def) {
      errors.push(`${where}: 未知令牌 ${k}`);
      continue;
    }
    if (def.axis !== axis) {
      errors.push(`${where}: 令牌 ${k} 属于${def.axis === 'chrome' ? '外框' : '阅读区'}，不能写在${axis === 'chrome' ? '外框' : '阅读区'}样式中`);
      continue;
    }
    const e = checkTokenValue(v);
    if (e) errors.push(`${where}: ${k} ${e}`);
    else out[k] = v as string;
  }
  const missing = tokensOf(axis).filter((t) => !(t.name in out)).map((t) => t.name);
  if (missing.length) warnings.push(`${where}: ${missing.length} 个令牌未设置，使用默认值（${missing.slice(0, 6).join(', ')}${missing.length > 6 ? '…' : ''}）`);
  return { errors, warnings, tokens: out };
}

/** 允许出现在主题 CSS 选择器中的组件钩子（类名） */
export const HOOK_CLASSES: Record<Axis, Set<string>> = { chrome: new Set(), reading: new Set() };
for (const c of COMPONENTS) for (const m of c.hook.matchAll(/\.([a-z][\w-]*)/gi)) HOOK_CLASSES[c.axis].add(m[1]);

function stripComments(css: string) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * 校验主题 CSS 并给每条规则加上作用域前缀（只在该主题生效时命中）。
 * 规则：只允许平铺的规则和少数 @media；每个选择器都必须使用至少一个本轴的组件钩子类，
 * 且不能用 html/body/#id/* 开头；禁止布局属性（position/display/width/margin…）与 url()/@import。
 */
export function scopeThemeCss(css: string, axis: Axis, prefix: string): { css: string; errors: string[] } {
  const errors: string[] = [];
  const src = stripComments(css);
  if (src.length > 200_000) return { css: '', errors: ['CSS 过大（上限 200 KB）'] };
  const out: string[] = [];
  let i = 0;
  const readBlock = (from: number): [string, number] => {
    let depth = 0;
    for (let k = from; k < src.length; k++) {
      if (src[k] === '{') depth++;
      else if (src[k] === '}') {
        depth--;
        if (depth === 0) return [src.slice(from + 1, k), k + 1];
      }
    }
    return ['', -1];
  };
  const doRules = (body: string, wrap?: string) => {
    const res: string[] = [];
    let j = 0;
    while (j < body.length) {
      const open = body.indexOf('{', j);
      if (open < 0) {
        if (body.slice(j).trim()) errors.push(`无法解析的 CSS 片段: ${body.slice(j, j + 40).trim()}`);
        break;
      }
      const close = body.indexOf('}', open);
      if (close < 0) {
        errors.push('CSS 花括号不匹配');
        break;
      }
      const selector = body.slice(j, open).trim();
      const decls = body.slice(open + 1, close);
      j = close + 1;
      if (selector.startsWith('@')) {
        errors.push(`不允许嵌套的 @ 规则: ${selector}`);
        continue;
      }
      const sels = selector.split(',').map((s) => s.trim()).filter(Boolean);
      const okSels: string[] = [];
      for (const s of sels) {
        if (/^(html|body|:root|\*|#)/i.test(s) || /#[a-z]/i.test(s)) {
          errors.push(`选择器不能针对 html/body/:root/*/#id: ${s}`);
          continue;
        }
        const classes = [...s.matchAll(/\.([a-z][\w-]*)/gi)].map((m) => m[1]);
        if (!classes.some((c) => HOOK_CLASSES[axis].has(c))) {
          errors.push(`选择器必须使用${axis === 'chrome' ? '外框' : '阅读区'}组件钩子类（见 COMPONENTS.md）: ${s}`);
          continue;
        }
        okSels.push(`${prefix} ${s}`);
      }
      const okDecls: string[] = [];
      for (const d of decls.split(';').map((x) => x.trim()).filter(Boolean)) {
        const c = d.indexOf(':');
        if (c < 0) {
          errors.push(`无法解析的声明: ${d}`);
          continue;
        }
        const prop = d.slice(0, c).trim().toLowerCase();
        const val = d.slice(c + 1).trim();
        if (prop.startsWith('--')) {
          errors.push(`主题 CSS 中不能定义变量（请写在 tokens 里）: ${prop}`);
          continue;
        }
        if (DISALLOWED_PROPS.has(prop) || /^(margin|inset|grid|flex|overflow|min-|max-)/.test(prop)) {
          errors.push(`不允许的布局属性 ${prop}（主题只能改外观；改变排列请用布局预设）`);
          continue;
        }
        const low = val.toLowerCase();
        const bad = FORBIDDEN_VALUES.find((f) => low.includes(f));
        if (bad) {
          errors.push(`不允许的值 ${bad} 于 ${prop}`);
          continue;
        }
        okDecls.push(`${prop}: ${val}`);
      }
      if (okSels.length && okDecls.length) res.push(`${okSels.join(',\n')} { ${okDecls.join('; ')}; }`);
    }
    return wrap ? `${wrap} {\n${res.join('\n')}\n}` : res.join('\n');
  };
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (src.startsWith('@', i)) {
      const open = src.indexOf('{', i);
      const semi = src.indexOf(';', i);
      if (semi >= 0 && (open < 0 || semi < open)) {
        errors.push(`不允许的 @ 规则: ${src.slice(i, semi).trim()}`);
        i = semi + 1;
        continue;
      }
      const head = src.slice(i, open).trim().replace(/\s+/g, ' ');
      const [body, next] = readBlock(open);
      if (next < 0) {
        errors.push('CSS 花括号不匹配');
        break;
      }
      if (!ALLOWED_AT.includes(head)) errors.push(`不允许的 @ 规则: ${head}（仅允许 ${ALLOWED_AT.join(' / ')}）`);
      else out.push(doRules(body, head));
      i = next;
      continue;
    }
    // 普通规则：找到匹配的 }
    const open = src.indexOf('{', i);
    if (open < 0) {
      errors.push(`无法解析的 CSS 片段: ${src.slice(i, i + 40).trim()}`);
      break;
    }
    const close = src.indexOf('}', open);
    if (close < 0) {
      errors.push('CSS 花括号不匹配');
      break;
    }
    out.push(doRules(src.slice(i, close + 1)));
    i = close + 1;
  }
  return { css: out.filter(Boolean).join('\n'), errors };
}

// ---------------------------------------------------------------- 主题包

/** 声明的范围是否落在 1.x（v1 主题包按兼容模式加载） */
export function isV1Range(range: string): boolean {
  return ['1.0.0', '1.1.0', '1.2.0', '1.5.0', '1.9.0'].some((v) => satisfies(v, range));
}

export interface ThemePackManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  engines: { workbench: string; themeContract?: string };
  contributes: {
    chromeThemes?: { id: string; label: string; light: { tokens: Record<string, string>; css?: string }; dark: { tokens: Record<string, string>; css?: string } }[];
    readingThemes?: { id: string; label: string; light: { tokens: Record<string, string>; css?: string }; dark: { tokens: Record<string, string>; css?: string } }[];
    layoutPresets?: ({ file: string } | LayoutPresetTemplate)[];
  };
}

export interface ValidatedPack {
  manifest: ThemePackManifest | null;
  chrome: ChromeThemeContribution[];
  reading: ReadingThemeContribution[];
  presets: LayoutPresetTemplate[];
  errors: string[];
  warnings: string[];
}

export const chromeCssPrefix = (id: string, scheme: Scheme) => `:root[data-kb-chrome="${id}"][data-kb-scheme="${scheme}"]`;
export const readingCssPrefix = (id: string, scheme: Scheme) => `:root[data-kb-reading="${id}"][data-kb-scheme="${scheme}"]`;

/** 校验一个主题包（theme.json + 文件内容），产出可注册的贡献；有 error 时不应启用 */
export function validateThemePack(rawManifest: unknown, files: Record<string, string>, hostVersion: string): ValidatedPack {
  const errors: string[] = [];
  const warnings: string[] = [];
  const res: ValidatedPack = { manifest: null, chrome: [], reading: [], presets: [], errors, warnings };
  const m = rawManifest as ThemePackManifest;
  if (!m || typeof m !== 'object') return (errors.push('theme.json 不是对象'), res);
  if (!/^[a-z0-9][a-z0-9.-]{1,63}$/.test(m.id ?? '')) errors.push(`非法 id: ${m.id}`);
  if (typeof m.name !== 'string' || !m.name) errors.push('缺少 name');
  if (!/^\d+\.\d+\.\d+/.test(m.version ?? '')) errors.push(`非法版本号: ${m.version}`);
  if (!m.engines?.workbench) errors.push('缺少 engines.workbench');
  else if (!satisfies(hostVersion, m.engines.workbench)) errors.push(`需要宿主 API ${m.engines.workbench}，当前为 ${hostVersion}`);
  if (m.engines?.themeContract && !satisfies(THEME_CONTRACT_VERSION, m.engines.themeContract)) {
    if (isV1Range(m.engines.themeContract))
      warnings.push(
        `主题包声明主题接口 ${m.engines.themeContract}：按 v1 兼容模式加载（改名的令牌自动换算；read-pdf-filter 不再强制应用，改为 PDF 面板“深色滤镜”开启时的参数）。请按 theme-kit/MIGRATION-v1-to-v2.md 升级到 ^${THEME_CONTRACT_VERSION}`,
      );
    else errors.push(`需要主题接口 ${m.engines.themeContract}，当前为 ${THEME_CONTRACT_VERSION}（兼容 ${contract.compat.acceptsContract}）`);
  }
  const c = m.contributes ?? {};
  if (!c.chromeThemes?.length && !c.readingThemes?.length && !c.layoutPresets?.length) errors.push('contributes 中没有任何外框样式、阅读区样式或布局预设');
  const variant = (axis: Axis, id: string, scheme: Scheme, v: { tokens: Record<string, string>; css?: string } | undefined): ThemeVariant | null => {
    const where = `${axis === 'chrome' ? 'chromeThemes' : 'readingThemes'}[${id}].${scheme}`;
    if (!v || typeof v !== 'object') {
      errors.push(`${where}: 缺少 ${scheme} 变体（每个样式都必须同时提供 light 与 dark）`);
      return null;
    }
    const t = validateTokens(axis, v.tokens ?? {}, where);
    errors.push(...t.errors);
    warnings.push(...t.warnings);
    let css: string | undefined;
    if (v.css !== undefined) {
      const text = files[v.css];
      if (typeof text !== 'string') errors.push(`${where}: 找不到 CSS 文件 ${v.css}`);
      else {
        const prefix = axis === 'chrome' ? chromeCssPrefix(id, scheme) : readingCssPrefix(id, scheme);
        const sc = scopeThemeCss(text, axis, prefix);
        errors.push(...sc.errors.map((e) => `${v.css}: ${e}`));
        css = sc.css;
      }
    }
    return { tokens: t.tokens, css };
  };
  const ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;
  for (const t of c.chromeThemes ?? []) {
    if (!ID.test(t?.id ?? '') || !t.label) {
      errors.push(`外框样式缺少合法的 id/label: ${t?.id}`);
      continue;
    }
    const light = variant('chrome', t.id, 'light', t.light);
    const dark = variant('chrome', t.id, 'dark', t.dark);
    if (light && dark) res.chrome.push({ id: t.id, label: t.label, light, dark });
  }
  for (const t of c.readingThemes ?? []) {
    if (!ID.test(t?.id ?? '') || !t.label) {
      errors.push(`阅读区样式缺少合法的 id/label: ${t?.id}`);
      continue;
    }
    const light = variant('reading', t.id, 'light', t.light);
    const dark = variant('reading', t.id, 'dark', t.dark);
    if (light && dark) res.reading.push({ id: t.id, label: t.label, light, dark });
  }
  for (const p of c.layoutPresets ?? []) {
    let tpl: unknown = p;
    if (p && typeof (p as { file?: unknown }).file === 'string') {
      const text = files[(p as { file: string }).file];
      if (typeof text !== 'string') {
        errors.push(`找不到布局预设文件 ${(p as { file: string }).file}`);
        continue;
      }
      try {
        tpl = JSON.parse(text);
      } catch {
        errors.push(`布局预设文件不是合法 JSON: ${(p as { file: string }).file}`);
        continue;
      }
    }
    const e = validatePreset(tpl);
    if (e) errors.push(`布局预设 ${(tpl as { id?: string })?.id ?? '?'}: ${e}`);
    else res.presets.push(tpl as LayoutPresetTemplate);
  }
  res.manifest = m;
  return res;
}

/** applyAppearance 之后在 window 上派发；阅读器据此按锚点（视口顶部的块）而不是像素恢复位置 */
export const APPEARANCE_CHANGED_EVENT = 'kb:appearance-changed';
