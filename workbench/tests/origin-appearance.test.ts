import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readUiSnapshot, writeUiSnapshot } from '../src/renderer/layoutSnapshot';
import { DEFAULT_APPEARANCE } from '../src/renderer/theme/appearance';
import { TOKENS, validateThemePack } from '../src/renderer/theme/contract';
import { builtinThemePacks } from '../src/renderer/theme/packs';
import { HOST_API_VERSION } from '../src/renderer/plugin-host/types';

const ROOT = path.resolve(__dirname, '..');

function memory() {
  const bag = new Map<string, string>();
  return {
    getItem: (k: string) => bag.get(k) ?? null,
    setItem: (k: string, v: string) => {
      bag.set(k, v);
    },
  };
}

describe('原始风格', () => {
  it('内置包校验通过，贡献 id 都是 origin', () => {
    const dir = path.join(ROOT, 'themes', 'origin');
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'theme.json'), 'utf8'));
    const files: Record<string, string> = {
      'chrome.css': fs.readFileSync(path.join(dir, 'chrome.css'), 'utf8'),
      'reading.css': fs.readFileSync(path.join(dir, 'reading.css'), 'utf8'),
    };
    const v = validateThemePack(manifest, files, HOST_API_VERSION);
    expect(v.errors).toEqual([]);
    expect(v.warnings.join()).not.toMatch(/未设置/);
    expect(manifest.id).toBe('kb.theme.origin');
    expect(manifest.name).toBe('原始风格');
    expect(manifest.engines.themeContract).toBe('^2.0.0');
    expect(v.chrome.map((t) => t.id)).toEqual(['origin']);
    expect(v.reading.map((t) => t.id)).toEqual(['origin']);
    const chromeNames = new Set(TOKENS.filter((t) => t.axis === 'chrome').map((t) => t.name));
    const readingNames = new Set(TOKENS.filter((t) => t.axis === 'reading').map((t) => t.name));
    for (const scheme of ['light', 'dark'] as const) {
      expect(new Set(Object.keys(v.chrome[0][scheme].tokens))).toEqual(chromeNames);
      expect(new Set(Object.keys(v.reading[0][scheme].tokens))).toEqual(readingNames);
    }
    const light = v.chrome[0].light.tokens;
    const dark = v.chrome[0].dark.tokens;
    expect(light['color-bg']).toBe('#f3f2ee');
    expect(light['color-chrome']).toBe('#ebe9e4');
    expect(light['color-surface']).toBe('#fcfbf8');
    expect(light['color-text']).toBe('#1c1b17');
    expect(light['color-text-muted']).toBe('#6f6c64');
    expect(light['color-border']).toBe('#e3e0d8');
    expect(light['color-accent']).toBe('#3e6e8c');
    expect(light['color-selected-fg']).toBe('#1d445c');
    expect(light['color-selected']).toBe('#c5d8e6');
    expect(light['color-accent-soft']).toBe('#e7f0f5');
    expect(light['size-topbar']).toBe('48px');
    expect(dark['size-topbar']).toBe('48px');
    expect(dark['color-bg']).not.toBe(light['color-bg']);
    expect(dark['color-text']).not.toBe(light['color-text']);
    expect(dark['color-surface']).not.toBe(light['color-surface']);
    const read = v.reading[0].light.tokens;
    const readDark = v.reading[0].dark.tokens;
    expect(read['read-fs']).toBe('16px');
    expect(read['read-lh']).toBe('1.7');
    expect(read['read-max-width']).toBe('700px');
    expect(read['read-heading']).toBe('#1d445c');
    expect(read['read-font']).toContain('SimSun');
    expect(read['read-font']).toContain('Noto Serif CJK');
    expect(read['read-font']).toContain('PMingLiU');
    expect(read['read-font']).toContain('serif');
    expect(readDark['read-bg']).not.toBe(read['read-bg']);
    expect(readDark['read-fg']).not.toBe(read['read-fg']);
    const packs = builtinThemePacks();
    expect(packs.map((p) => (p.manifest as { id?: string }).id)).toContain('kb.theme.origin');
  });

  it('没有已存快照时默认是原始风格浅色；已保存的三项原样读回', () => {
    const empty = memory();
    expect(readUiSnapshot(empty)).toBeNull();
    expect(DEFAULT_APPEARANCE).toEqual({ chrome: 'origin', reading: 'origin', scheme: 'light' });
    const saved = { chrome: 'touchline', reading: 'study', scheme: 'dark' as const };
    const store = memory();
    writeUiSnapshot({ appearance: saved, focus: false, expanded: [], sidebarWidth: 280 }, store);
    expect(readUiSnapshot(store)?.appearance).toEqual(saved);
  });
});
