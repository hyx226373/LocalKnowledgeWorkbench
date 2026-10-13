/**
 * 工作区卡片六套外观：A/B/C × 浅色/深色。结构在 cardTheme.css，这里只换令牌。
 * 工作区 accent 经 cardAccentVars 写到那一张卡片，不改整页变量。
 * 尺寸组、阅读区 layout 组、专注模式的宽与内边距不覆盖：语义仍是分栏外观或正文尺度，不是卡片皮肤。
 */
import { checkTokenValue, TOKENS, type TokenDef } from '../theme/contract';
import { normalizeAccent } from '../../shared/workspacePicker';

export const CARD_DIRECTIONS = ['A', 'B', 'C'] as const;
export type CardDirection = (typeof CARD_DIRECTIONS)[number];
export const CARD_SCHEMES = ['light', 'dark'] as const;
export type CardScheme = (typeof CARD_SCHEMES)[number];

export const CARD_FACE_TOKENS = {
  surface: 'color-surface',
  text: 'color-text',
  border: 'color-border',
  accent: 'color-accent',
} as const;

const FOCUS_MEASURE = new Set(['read-focus-max-width', 'read-focus-pad-x', 'read-focus-pad-y']);

const TOKEN_BY_NAME = new Map(TOKENS.map((token) => [token.name, token]));

/** 这些令牌不表示工作区里保存的分栏比例，卡片主题不得改写它们。 */
export function isLayoutProportionToken(token: Pick<TokenDef, 'name' | 'group'>): boolean {
  return token.group === 'size' || token.group === 'layout' || FOCUS_MEASURE.has(token.name);
}

export class CardTokenError extends Error {
  readonly errors: readonly string[];
  constructor(errors: string[]) {
    super(errors.join('；'));
    this.name = 'CardTokenError';
    this.errors = errors;
  }
}

/** 未知令牌、危险值、布局比例类令牌都拒绝。六套主题都要有表面、文字、边框、强调色。 */
export function acceptCardTokens(tokens: Record<string, unknown>): Record<string, string> {
  const errors: string[] = [];
  const out: Record<string, string> = {};
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) {
    throw new CardTokenError(['令牌必须是对象']);
  }
  for (const [name, value] of Object.entries(tokens)) {
    const def = TOKEN_BY_NAME.get(name);
    if (!def) {
      errors.push(`未知令牌 ${name}`);
      continue;
    }
    if (isLayoutProportionToken(def)) {
      errors.push(`布局比例类令牌 ${name} 不能写入卡片主题`);
      continue;
    }
    const valueError = checkTokenValue(value);
    if (valueError) {
      errors.push(`${name} ${valueError}`);
      continue;
    }
    out[name] = value as string;
  }
  for (const name of Object.values(CARD_FACE_TOKENS)) {
    if (!(name in out)) errors.push(`缺少 ${name}`);
  }
  if (errors.length) throw new CardTokenError(errors);
  return out;
}

export interface CardThemeSet {
  id: 'A-light' | 'A-dark' | 'B-light' | 'B-dark' | 'C-light' | 'C-dark';
  direction: CardDirection;
  scheme: CardScheme;
  label: string;
  tokens: Readonly<Record<string, string>>;
}

function defineCardTheme(spec: {
  id: CardThemeSet['id'];
  direction: CardDirection;
  scheme: CardScheme;
  label: string;
  tokens: Record<string, string>;
}): CardThemeSet {
  return Object.freeze({
    id: spec.id,
    direction: spec.direction,
    scheme: spec.scheme,
    label: spec.label,
    tokens: Object.freeze(acceptCardTokens(spec.tokens)),
  });
}

const SANS = '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';
const SERIF = '"Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", "SimSun", serif';
const MONO = '"Cascadia Mono", Consolas, "JetBrains Mono", "Noto Sans Mono CJK SC", monospace';
const EASE = 'cubic-bezier(.2,0,0,1)';

function shape(input: Record<string, string>): Record<string, string> {
  return input;
}

const shapeA = shape({
  'font-ui': SANS,
  'font-ui-accent': SERIF,
  'fs-xs': '11px',
  'fs-sm': '12px',
  'fs-md': '13px',
  'fw-strong': '600',
  'ls-caps': '.12em',
  'space-1': '2px',
  'space-2': '4px',
  'space-3': '8px',
  'space-4': '12px',
  'space-5': '16px',
  'radius-sm': '2px',
  'radius-lg': '4px',
  'radius-pill': '999px',
  'shadow-1': 'none',
  'motion-fast': '80ms',
  'motion-ease': EASE,
});

const shapeB = shape({
  'font-ui': SANS,
  'font-ui-accent': MONO,
  'fs-xs': '10px',
  'fs-sm': '11px',
  'fs-md': '12px',
  'fw-strong': '600',
  'ls-caps': '.02em',
  'space-1': '2px',
  'space-2': '4px',
  'space-3': '6px',
  'space-4': '8px',
  'space-5': '12px',
  'radius-sm': '2px',
  'radius-lg': '2px',
  'radius-pill': '999px',
  'shadow-1': 'none',
  'motion-fast': '40ms',
  'motion-ease': EASE,
});

const shapeC = shape({
  'font-ui': SANS,
  'font-ui-accent': SANS,
  'fs-xs': '11px',
  'fs-sm': '12px',
  'fs-md': '13.5px',
  'fw-strong': '600',
  'ls-caps': '.08em',
  'space-1': '2px',
  'space-2': '6px',
  'space-3': '10px',
  'space-4': '14px',
  'space-5': '20px',
  'radius-sm': '6px',
  'radius-lg': '14px',
  'radius-pill': '999px',
  'motion-fast': '120ms',
  'motion-ease': EASE,
});

export const CARD_THEME_SETS: readonly CardThemeSet[] = Object.freeze([
  defineCardTheme({
    id: 'A-light',
    direction: 'A',
    scheme: 'light',
    label: '安静书房 · 浅色',
    tokens: {
      ...shapeA,
      'color-bg': '#ece5d8',
      'color-surface': '#f6f1e7',
      'color-surface-raised': '#fbf8f1',
      'color-surface-sunken': '#ebe3d3',
      'color-border': '#d9cfbc',
      'color-border-strong': '#c4b79f',
      'color-text': '#3b342b',
      'color-text-muted': '#7d7263',
      'color-text-faint': '#a59a88',
      'color-accent': '#8a5a2b',
      'color-accent-fg': '#fffaf2',
      'color-accent-soft': '#efe2cf',
      'color-hover': 'rgba(120,90,50,.08)',
      'color-selected': 'rgba(138,90,43,.16)',
      'color-selected-fg': '#3b342b',
      'color-focus-ring': '#8a5a2b',
      'color-fav': '#b07a2a',
    },
  }),
  defineCardTheme({
    id: 'A-dark',
    direction: 'A',
    scheme: 'dark',
    label: '安静书房 · 深色',
    tokens: {
      ...shapeA,
      'color-bg': '#1c1814',
      'color-surface': '#25201a',
      'color-surface-raised': '#2d261f',
      'color-surface-sunken': '#1c1814',
      'color-border': '#3a3128',
      'color-border-strong': '#4d4236',
      'color-text': '#e6dccb',
      'color-text-muted': '#a89a85',
      'color-text-faint': '#75695a',
      'color-accent': '#c8925a',
      'color-accent-fg': '#1c1814',
      'color-accent-soft': '#3a2c1d',
      'color-hover': 'rgba(230,200,160,.06)',
      'color-selected': 'rgba(200,146,90,.22)',
      'color-selected-fg': '#f3e9d8',
      'color-focus-ring': '#c8925a',
      'color-fav': '#d9a55a',
    },
  }),
  defineCardTheme({
    id: 'B-light',
    direction: 'B',
    scheme: 'light',
    label: '专业工具 · 浅色',
    tokens: {
      ...shapeB,
      'color-bg': '#f3f3f3',
      'color-surface': '#ffffff',
      'color-surface-raised': '#ffffff',
      'color-surface-sunken': '#f0f0f0',
      'color-border': '#e5e5e5',
      'color-border-strong': '#c8c8c8',
      'color-text': '#1f1f1f',
      'color-text-muted': '#616161',
      'color-text-faint': '#9e9e9e',
      'color-accent': '#005fb8',
      'color-accent-fg': '#ffffff',
      'color-accent-soft': '#e6f0fa',
      'color-hover': 'rgba(0,0,0,.05)',
      'color-selected': '#e4e6f1',
      'color-selected-fg': '#1f1f1f',
      'color-focus-ring': '#005fb8',
      'color-fav': '#c48a1a',
    },
  }),
  defineCardTheme({
    id: 'B-dark',
    direction: 'B',
    scheme: 'dark',
    label: '专业工具 · 深色',
    tokens: {
      ...shapeB,
      'color-bg': '#181818',
      'color-surface': '#1e1e1e',
      'color-surface-raised': '#252526',
      'color-surface-sunken': '#161616',
      'color-border': '#2b2b2b',
      'color-border-strong': '#454545',
      'color-text': '#cccccc',
      'color-text-muted': '#8b8b8b',
      'color-text-faint': '#5f5f5f',
      'color-accent': '#0078d4',
      'color-accent-fg': '#ffffff',
      'color-accent-soft': '#0f2e4a',
      'color-hover': 'rgba(255,255,255,.06)',
      'color-selected': '#04395e',
      'color-selected-fg': '#ffffff',
      'color-focus-ring': '#2f8fe0',
      'color-fav': '#e2c08d',
    },
  }),
  defineCardTheme({
    id: 'C-light',
    direction: 'C',
    scheme: 'light',
    label: '明亮卡片 · 浅色',
    tokens: {
      ...shapeC,
      'shadow-1': '0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.08)',
      'color-bg': '#eef1f7',
      'color-surface': '#ffffff',
      'color-surface-raised': '#ffffff',
      'color-surface-sunken': '#eef1f7',
      'color-border': '#e3e7ef',
      'color-border-strong': '#cfd5e2',
      'color-text': '#1d2433',
      'color-text-muted': '#667085',
      'color-text-faint': '#98a2b3',
      'color-accent': '#6c4cf5',
      'color-accent-fg': '#ffffff',
      'color-accent-soft': '#f2f0fe',
      'color-hover': '#f2f0fe',
      'color-selected': '#e9e4ff',
      'color-selected-fg': '#3b1fd1',
      'color-focus-ring': '#6c4cf5',
      'color-fav': '#f5a524',
    },
  }),
  defineCardTheme({
    id: 'C-dark',
    direction: 'C',
    scheme: 'dark',
    label: '明亮卡片 · 深色',
    tokens: {
      ...shapeC,
      'shadow-1': '0 1px 2px rgba(0,0,0,.4)',
      'color-bg': '#0f1220',
      'color-surface': '#171a2c',
      'color-surface-raised': '#1f2338',
      'color-surface-sunken': '#0f1220',
      'color-border': '#262a42',
      'color-border-strong': '#363b5c',
      'color-text': '#e6e8f2',
      'color-text-muted': '#98a0bd',
      'color-text-faint': '#646b8a',
      'color-accent': '#8b72ff',
      'color-accent-fg': '#ffffff',
      'color-accent-soft': '#262150',
      'color-hover': '#22264a',
      'color-selected': '#2e2a5c',
      'color-selected-fg': '#ffffff',
      'color-focus-ring': '#8b72ff',
      'color-fav': '#f5b54a',
    },
  }),
]);

/** 写到卡片列表的作用域上，不写到 :root。 */
export function cardThemeVars(set: CardThemeSet): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(set.tokens)) out[`--kb-${name}`] = value;
  return out;
}

export function cardThemeDeclarationBlock(set: CardThemeSet): string {
  return Object.entries(cardThemeVars(set))
    .map(([name, value]) => `${name}: ${value};`)
    .join('\n');
}

/** 只覆盖这一张卡片的强调色。无合法 accent 时不写变量。 */
export function cardAccentVars(accent: unknown): Record<string, string> {
  const norm = normalizeAccent(accent);
  if (!norm) return {};
  return { '--kb-color-accent': norm };
}

export function cardScopeDataset(set: CardThemeSet): { 'data-kb-scheme': CardScheme } {
  return { 'data-kb-scheme': set.scheme };
}
