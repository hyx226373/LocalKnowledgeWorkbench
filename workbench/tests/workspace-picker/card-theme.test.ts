import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOKENS } from '../../src/renderer/theme/contract';
import { WORKSPACE_CARD_CLASS } from '../../src/shared/workspacePicker';
import {
  CARD_FACE_TOKENS,
  CARD_THEME_SETS,
  CardTokenError,
  acceptCardTokens,
  cardAccentVars,
  cardScopeDataset,
  cardThemeDeclarationBlock,
  cardThemeVars,
  isLayoutProportionToken,
} from '../../src/renderer/workspace-picker/cardThemes';

const css = readFileSync(path.join(process.cwd(), 'src/renderer/workspace-picker/cardTheme.css'), 'utf8');
const samples = JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/workspace-picker-samples.json'), 'utf8')) as {
  format: string;
  workspaces: { id: string; accent: string | null }[];
};

const FACE = [CARD_FACE_TOKENS.surface, CARD_FACE_TOKENS.text, CARD_FACE_TOKENS.border, CARD_FACE_TOKENS.accent];

describe('工作区卡片主题', () => {
  it('未知令牌拒绝', () => {
    expect(() => acceptCardTokens({
      'color-surface': '#fff',
      'color-text': '#111',
      'color-border': '#ccc',
      'color-accent': '#36c',
      'color-card': '#000',
    })).toThrow(CardTokenError);
    expect(() => acceptCardTokens({ nope: '1' })).toThrow(/未知令牌 nope/);
    expect(() => acceptCardTokens({ 'color-disabled-fg': '#999' })).toThrow(/未知令牌 color-disabled-fg/);
    expect(() => acceptCardTokens({
      'color-surface': '#fff',
      'color-text': 'red; background:url(x)',
      'color-border': '#ccc',
      'color-accent': '#36c',
    })).toThrow(/color-text/);
    const ok = acceptCardTokens({
      'color-surface': '#fff',
      'color-text': '#111',
      'color-border': '#ccc',
      'color-accent': '#36c',
    });
    expect(ok).toEqual({
      'color-surface': '#fff',
      'color-text': '#111',
      'color-border': '#ccc',
      'color-accent': '#36c',
    });
  });

  it('六套都含卡片表面、文字、边框、强调色', () => {
    expect(CARD_FACE_TOKENS).toEqual({
      surface: 'color-surface',
      text: 'color-text',
      border: 'color-border',
      accent: 'color-accent',
    });
    expect(CARD_THEME_SETS.map((set) => set.id)).toEqual(['A-light', 'A-dark', 'B-light', 'B-dark', 'C-light', 'C-dark']);
    expect(CARD_THEME_SETS.map((set) => set.label)).toEqual([
      '安静书房 · 浅色',
      '安静书房 · 深色',
      '专业工具 · 浅色',
      '专业工具 · 深色',
      '明亮卡片 · 浅色',
      '明亮卡片 · 深色',
    ]);
    const used = [...css.matchAll(/var\(--kb-([a-z0-9-]+)\)/g)].map((match) => match[1]);
    expect(used.length).toBeGreaterThan(0);
    const declared = new Set(TOKENS.map((token) => token.name));
    for (const name of used) expect(declared.has(name), name).toBe(true);
    for (const set of CARD_THEME_SETS) {
      expect(set.scheme === 'light' || set.scheme === 'dark').toBe(true);
      expect(cardScopeDataset(set)).toEqual({ 'data-kb-scheme': set.scheme });
      for (const name of FACE) {
        expect(set.tokens[name], `${set.id} ${name}`).toMatch(/\S/);
        expect(css).toContain(`var(--kb-${name})`);
      }
      for (const name of new Set(used)) expect(set.tokens[name], `${set.id} 缺少 ${name}`).toBeTruthy();
      expect(cardThemeDeclarationBlock(set)).toContain(`--kb-${CARD_FACE_TOKENS.surface}:`);
      expect(cardThemeDeclarationBlock(set)).toContain(`--kb-${CARD_FACE_TOKENS.accent}:`);
    }
    expect(CARD_THEME_SETS.filter((set) => set.scheme === 'light').map((set) => set.tokens['color-accent'])).toEqual([
      '#8a5a2b',
      '#005fb8',
      '#6c4cf5',
    ]);
    expect(CARD_THEME_SETS.filter((set) => set.scheme === 'dark').map((set) => set.tokens['color-accent'])).toEqual([
      '#c8925a',
      '#0078d4',
      '#8b72ff',
    ]);
    expect(css).toContain(`.${WORKSPACE_CARD_CLASS.root}.${WORKSPACE_CARD_CLASS.selected}`);
    expect(css).toContain(`.${WORKSPACE_CARD_CLASS.root}.${WORKSPACE_CARD_CLASS.favorite}`);
    expect(css).not.toMatch(/\.kb-ws-card\s+\.is-selected/);
    expect(css).not.toMatch(/\.kb-ws-card\s+\.is-favorite/);
    expect(css).toContain('[data-kb-scheme="light"]');
    expect(css).toContain('[data-kb-scheme="dark"]');
    expect(css).not.toMatch(/:root/);
    expect(css).toMatch(/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/);
    expect(css).toMatch(/transition:\s*none\s*!important/);
    expect(css).toMatch(/animation:\s*none\s*!important/);
    expect(css).toMatch(/transition:[\s\S]*var\(--kb-motion-fast\)/);
  });

  it('不改布局比例类令牌的语义', () => {
    const proportion = TOKENS.filter((token) => isLayoutProportionToken(token));
    expect(proportion.some((token) => token.name === 'dock-gap')).toBe(true);
    expect(proportion.some((token) => token.name === 'size-row')).toBe(true);
    expect(proportion.some((token) => token.name === 'read-max-width')).toBe(true);
    expect(proportion.some((token) => token.name === 'read-focus-max-width')).toBe(true);
    expect(isLayoutProportionToken(TOKENS.find((token) => token.name === 'color-surface')!)).toBe(false);
    expect(isLayoutProportionToken(TOKENS.find((token) => token.name === 'space-4')!)).toBe(false);
    expect(isLayoutProportionToken(TOKENS.find((token) => token.name === 'read-focus-bg')!)).toBe(false);
    expect(TOKENS.find((token) => token.name === 'dock-gap')!.description).toContain('不改变保存的分栏尺寸');
    expect(TOKENS.find((token) => token.name === 'shell-inset')!.description).toContain('外框四周留白');
    expect(TOKENS.find((token) => token.name === 'row-inset')!.description).toContain('左右内缩');
    expect(TOKENS.find((token) => token.name === 'read-max-width')!.description).toContain('正文最大宽度');
    expect(TOKENS.find((token) => token.name === 'read-pad-x')!.description).toContain('正文左右内边距');
    expect(TOKENS.find((token) => token.name === 'read-focus-max-width')!.description).toContain('正文最大宽度');
    for (const set of CARD_THEME_SETS) {
      for (const token of proportion) expect(set.tokens, set.id).not.toHaveProperty(token.name);
      expect(cardThemeDeclarationBlock(set)).not.toContain('--kb-dock-gap');
      expect(cardThemeDeclarationBlock(set)).not.toContain('--kb-read-max-width');
      expect(cardThemeDeclarationBlock(set)).not.toContain('--kb-size-row');
    }
    for (const token of proportion) expect(css).not.toContain(`--kb-${token.name}`);
    const face = {
      'color-surface': '#fff',
      'color-text': '#111',
      'color-border': '#ccc',
      'color-accent': '#36c',
    };
    expect(() => acceptCardTokens({ ...face, 'dock-gap': '10px' })).toThrow(/布局比例类令牌 dock-gap/);
    expect(() => acceptCardTokens({ ...face, 'read-max-width': '720px' })).toThrow(/布局比例类令牌 read-max-width/);
    expect(() => acceptCardTokens({ ...face, 'size-row': '20px' })).toThrow(/布局比例类令牌 size-row/);
    expect(() => acceptCardTokens({ ...face, 'read-focus-pad-x': '48px' })).toThrow(/布局比例类令牌 read-focus-pad-x/);
  });

  it('accent 只覆盖这一张卡片的强调色', () => {
    expect(samples.format).toBe('kb-workbench.workspace-picker-sample');
    const mixed = samples.workspaces.find((workspace) => workspace.id === 'ws-mixed');
    const empty = samples.workspaces.find((workspace) => workspace.id === 'ws-empty');
    expect(mixed?.accent).toBe('#3D6B4F');
    expect(empty?.accent).toBeNull();
    for (const set of CARD_THEME_SETS) {
      const scope = cardThemeVars(set);
      const before = scope['--kb-color-accent'];
      const onCard = cardAccentVars(mixed?.accent);
      expect(Object.keys(onCard)).toEqual(['--kb-color-accent']);
      expect(onCard['--kb-color-accent']).toBe('#3D6B4F');
      expect(scope['--kb-color-accent']).toBe(before);
      expect(before).not.toBe('#3D6B4F');
      const painted = { ...scope, ...onCard };
      expect(painted['--kb-color-surface']).toBe(scope['--kb-color-surface']);
      expect(painted['--kb-color-text']).toBe(scope['--kb-color-text']);
      expect(painted['--kb-color-border']).toBe(scope['--kb-color-border']);
      expect(painted['--kb-color-accent']).toBe('#3D6B4F');
      expect(cardAccentVars(empty?.accent)).toEqual({});
    }
    expect(cardAccentVars('red')).toEqual({});
    expect(cardAccentVars('#8A4B2F')).toEqual({ '--kb-color-accent': '#8A4B2F' });
  });
});
