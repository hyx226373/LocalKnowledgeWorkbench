import { describe, expect, it } from 'vitest';
import { builtinThemePacks } from '../src/renderer/theme/packs';

describe('内置主题包（builtinThemePacks）', () => {
  it('扫到球场指挥室，且 pro/study/bright 仍在', () => {
    const packs = builtinThemePacks();
    const ids = packs.map((p) => (p.manifest as { id?: string }).id);
    expect(packs).toHaveLength(5);
    expect(ids).toEqual(expect.arrayContaining(['kb.theme.bright', 'kb.theme.origin', 'kb.theme.pro', 'kb.theme.study', 'kb.theme.touchline']));

    const touch = packs.find((p) => (p.manifest as { id?: string }).id === 'kb.theme.touchline');
    expect(touch?.source).toBe('builtin');
    expect(touch?.location).toBe('touchline');
    const manifest = touch?.manifest as {
      id: string;
      name: string;
      engines: { workbench: string; themeContract: string };
      contributes: { chromeThemes: { id: string }[]; readingThemes: { id: string }[] };
    };
    expect(manifest.id).toBe('kb.theme.touchline');
    expect(manifest.name).toBe('球场指挥室');
    expect(manifest.engines.workbench).toBe('^0.2.0');
    expect(manifest.engines.themeContract).toBe('^2.0.0');
    expect(manifest.contributes.chromeThemes[0].id).toBe('touchline');
    expect(manifest.contributes.readingThemes[0].id).toBe('touchline');
    // vitest 默认把 .css（含 ?raw）的 default 导出换成空字符串，这里只断言文件名被扫进 files。
    expect(Object.keys(touch?.files ?? {}).sort()).toEqual(['chrome.css', 'reading.css']);
  });
});
