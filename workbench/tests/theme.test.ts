import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMPONENTS, RENAMED_TOKENS, ROLES, STATES, THEME_CONTRACT_VERSION, TOKENS, fullTokens, scopeThemeCss, validateThemePack, validateTokens } from '../src/renderer/theme/contract';
import { HOST_API_VERSION } from '../src/renderer/plugin-host/types';

const ROOT = path.resolve(__dirname, '..');
function readPack(dir: string) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'theme.json'), 'utf8'));
  const files: Record<string, string> = {};
  const c = manifest.contributes ?? {};
  for (const t of [...(c.chromeThemes ?? []), ...(c.readingThemes ?? [])]) for (const v of [t.light, t.dark]) if (v?.css) files[v.css] = fs.readFileSync(path.join(dir, v.css), 'utf8');
  for (const p of c.layoutPresets ?? []) if (p.file) files[p.file] = fs.readFileSync(path.join(dir, p.file), 'utf8');
  return { manifest, files };
}

describe('主题接口（theme-contract.json）', () => {
  it('令牌名唯一、分为外框/阅读区两轴、都有浅色与深色默认值', () => {
    const names = TOKENS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(TOKENS.every((t) => (t.axis === 'reading') === t.name.startsWith('read-'))).toBe(true);
    expect(TOKENS.every((t) => t.default.light && t.default.dark)).toBe(true);
    expect(STATES).toEqual(['default', 'hover', 'active', 'focus-visible', 'disabled', 'selected', 'dragging', 'drag-over']);
    for (const id of ['button', 'tab', 'tree-row', 'splitter', 'input', 'search-result', 'plugin-row', 'statusbar', 'dialog']) expect(COMPONENTS.some((c) => c.id === id)).toBe(true);
  });
  it('v2：颜色角色、专注模式令牌、PDF 深色滤镜参数、统一状态集合、权威组件清单', () => {
    expect(THEME_CONTRACT_VERSION).toBe('2.0.0');
    for (const r of ['splitter.dragging', 'surface.sunken', 'text.disabled', 'splitter.hover', 'pdf.dark-filter', 'diff.add-bg', 'focus.surface']) expect(ROLES[r], r).toBeTruthy();
    expect(TOKENS.filter((t) => t.group === 'color' && t.axis === 'chrome').every((t) => t.role)).toBe(true);
    const roles = TOKENS.filter((t) => t.role).map((t) => t.role);
    expect(new Set(roles).size).toBe(roles.length);
    for (const n of ['read-focus-bg', 'read-focus-fg', 'read-focus-fs', 'read-focus-lh', 'read-focus-max-width', 'read-focus-chrome-opacity']) expect(TOKENS.some((t) => t.name === n), n).toBe(true);
    expect(TOKENS.some((t) => t.name === 'read-pdf-filter')).toBe(false);
    expect(RENAMED_TOKENS).toEqual({ 'color-disabled-fg': 'color-text-disabled', 'read-pdf-filter': 'read-pdf-dark-filter' });
    // 权威清单：每个组件都有 default，状态键与统一集合一致；id 唯一
    expect(new Set(COMPONENTS.map((c) => c.id)).size).toBe(COMPONENTS.length);
    for (const c of COMPONENTS) {
      expect(Object.keys(c.states)).toEqual(STATES);
      expect(c.states.default, c.id).toBeTruthy();
    }
    expect(COMPONENTS.find((c) => c.id === 'splitter')!.states.dragging).toBeTruthy();
    expect(COMPONENTS.find((c) => c.id === 'tab')!.states.dragging).toBeTruthy();
    for (const id of ['toggle', 'collection-row', 'toast', 'diff', 'editor', 'pdf-page', 'reading-focus']) expect(COMPONENTS.some((c) => c.id === id), id).toBe(true);
    expect(COMPONENTS.length).toBe(22);
  });
  it('组件状态表为权威清单中的每个组件提供渲染器', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/renderer/ui/StatesSheet.tsx'), 'utf8');
    const body = src.slice(src.indexOf('const RENDER'));
    for (const c of COMPONENTS) expect(body.includes(`'${c.id}':`) || body.includes(`  ${c.id}:`), c.id).toBe(true);
  });
  it('v1 兼容：改名令牌自动换算并警告；v1 主题包以警告方式加载；不兼容的大版本报错', () => {
    const r = validateTokens('chrome', { 'color-disabled-fg': '#999' }, 'x');
    expect(r.errors).toEqual([]);
    expect(r.tokens).toEqual({ 'color-text-disabled': '#999' });
    expect(r.warnings.join()).toMatch(/改名为 color-text-disabled/);
    const r2 = validateTokens('reading', { 'read-pdf-filter': 'invert(1)' }, 'x');
    expect(r2.tokens).toEqual({ 'read-pdf-dark-filter': 'invert(1)' });
    const mk = (range: string) => ({ id: 'x.v', name: 'v', version: '1.0.0', engines: { workbench: `^${HOST_API_VERSION}`, themeContract: range }, contributes: { readingThemes: [{ id: 'v', label: 'v', light: { tokens: {} }, dark: { tokens: {} } }] } });
    const v1 = validateThemePack(mk('^1.0.0'), {}, HOST_API_VERSION);
    expect(v1.errors).toEqual([]);
    expect(v1.warnings.join()).toMatch(/v1 兼容模式/);
    expect(validateThemePack(mk('^2.0.0'), {}, HOST_API_VERSION).warnings.join()).not.toMatch(/兼容模式/);
    expect(validateThemePack(mk('^3.0.0'), {}, HOST_API_VERSION).errors.join()).toMatch(/需要主题接口/);
  });
  it('核心样式只引用已声明的令牌，且每个令牌都被核心样式使用', () => {
    const css = fs.readFileSync(path.join(ROOT, 'src/renderer/styles.css'), 'utf8').replace(/^:root \{[^}]*\}/m, '');
    const used = new Set([...css.matchAll(/var\(--kb-([a-z0-9-]+)/g)].map((m) => m[1]));
    const declared = new Set(TOKENS.map((t) => t.name));
    expect([...used].filter((u) => !declared.has(u))).toEqual([]);
    expect([...declared].filter((d) => !used.has(d))).toEqual([]);
  });
  it('fullTokens 用默认值补齐', () => {
    const t = fullTokens('reading', 'dark', { 'read-fs': '18px' });
    expect(t['read-fs']).toBe('18px');
    expect(Object.keys(t)).toHaveLength(TOKENS.filter((x) => x.axis === 'reading').length);
  });
  it('令牌校验：未知令牌、跨轴、危险值', () => {
    const r = validateTokens('chrome', { 'color-bg': '#fff', 'read-fs': '1px', 'nope': '1', 'color-text': 'red; background:url(x)' }, 'x');
    expect(r.errors.join('\n')).toMatch(/阅读区/);
    expect(r.errors.join('\n')).toMatch(/未知令牌 nope/);
    expect(r.errors.join('\n')).toMatch(/color-text/);
    expect(r.tokens).toEqual({ 'color-bg': '#fff' });
  });
  it('主题 CSS：只允许组件钩子 + 外观属性；自动加作用域前缀', () => {
    const ok = scopeThemeCss('.kb-tree-row:hover { background: red; border-radius: 4px }\n@media (prefers-reduced-motion: reduce) { .kb-button { transition: none } }', 'chrome', ':root[data-kb-chrome="x"]');
    expect(ok.errors).toEqual([]);
    expect(ok.css).toContain(':root[data-kb-chrome="x"] .kb-tree-row:hover { background: red; border-radius: 4px; }');
    expect(ok.css).toContain('@media (prefers-reduced-motion: reduce)');
    const bad = scopeThemeCss(
      'body { color: red } .kb-sidebar { width: 10px; display: none; color: blue } .foo { color: red } @import "x.css"; .kb-button { background: url(http://x) } .kb-reading { color: red } .kb-button { --kb-x: 1 }',
      'chrome',
      'P',
    );
    const e = bad.errors.join('\n');
    expect(e).toMatch(/html\/body/);
    expect(e).toMatch(/width/);
    expect(e).toMatch(/display/);
    expect(e).toMatch(/\.foo/);
    expect(e).toMatch(/@import/);
    expect(e).toMatch(/url\(/);
    expect(e).toMatch(/\.kb-reading/); // 阅读区钩子不能出现在外框 CSS 中
    expect(e).toMatch(/变量/);
    expect(bad.css).toContain('P .kb-sidebar { color: blue; }');
  });
  it('内置 A/B/C 主题包全部通过校验，各自提供外框+阅读区（浅色+深色）与布局预设', () => {
    for (const id of ['study', 'pro', 'bright']) {
      const { manifest, files } = readPack(path.join(ROOT, 'themes', id));
      const v = validateThemePack(manifest, files, HOST_API_VERSION);
      expect(v.errors, id).toEqual([]);
      expect(v.chrome.length).toBe(1);
      expect(v.reading.length).toBe(1);
      expect(v.presets.length).toBeGreaterThan(0);
      for (const t of [...v.chrome, ...v.reading]) expect(t.light && t.dark).toBeTruthy();
    }
  });
  it('theme-kit/template 起步模板通过校验（无错误、无“未设置令牌”警告），且没有与内置主题重复的 id', () => {
    const { manifest, files } = readPack(path.join(ROOT, 'theme-kit', 'template'));
    const v = validateThemePack(manifest, files, HOST_API_VERSION);
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);
    expect(manifest.id.startsWith('kb.theme.')).toBe(false);
  });
  it('缺少深色变体、布局属性、引用不存在文件的主题包被拒绝', () => {
    const m = {
      id: 'x.bad',
      name: 'bad',
      version: '1.0.0',
      engines: { workbench: `^${HOST_API_VERSION}` },
      contributes: { chromeThemes: [{ id: 'bad', label: 'bad', light: { tokens: {}, css: 'a.css' } }], layoutPresets: [{ file: 'missing.json' }] },
    };
    const v = validateThemePack(m, { 'a.css': '.kb-sidebar { position: absolute }' }, HOST_API_VERSION);
    const e = v.errors.join('\n');
    expect(e).toMatch(/缺少 dark 变体/);
    expect(e).toMatch(/position/);
    expect(e).toMatch(/missing\.json/);
  });
});
