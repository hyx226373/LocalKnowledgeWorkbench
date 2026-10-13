import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UI_CHROME_PREFS,
  UI_CHROME_PREFS_KEY,
  loadUiChromePrefs,
  parseUiChromePrefs,
  saveUiChromePrefs,
  serializeUiChromePrefs,
  withUiChromePrefs,
  type UiChromePrefs,
} from '../src/renderer/settings/uiChromePrefs';

function memoryPort(bag: Map<string, unknown>, failSet = false) {
  const writes: string[] = [];
  return {
    writes,
    async getLayout(key: string) {
      return bag.has(key) ? bag.get(key) : null;
    },
    async setLayout(key: string, value: unknown) {
      writes.push(key);
      if (failSet) throw new Error('disk full');
      bag.set(key, value);
    },
  };
}

describe('壳层偏好', () => {
  it('键名和缺省', () => {
    expect(UI_CHROME_PREFS_KEY).toBe('settings.uiChrome');
    expect(DEFAULT_UI_CHROME_PREFS).toEqual({
      v: 1,
      reduceMotion: false,
      documentTabs: true,
      drawerOpenByDefault: true,
      topBarVisible: true,
    });
  });

  it('缺键、空值和认不出的 v 回到默认，不改入参', () => {
    expect(parseUiChromePrefs(null)).toEqual(DEFAULT_UI_CHROME_PREFS);
    expect(parseUiChromePrefs(undefined)).toEqual(DEFAULT_UI_CHROME_PREFS);
    expect(parseUiChromePrefs('settings.uiChrome')).toEqual(DEFAULT_UI_CHROME_PREFS);
    expect(parseUiChromePrefs([])).toEqual(DEFAULT_UI_CHROME_PREFS);
    const foreign = { ui: { sidebarWidth: 280 }, 'settings.workspacePicker': { v: 1, startup: 'last' }, v: 2, reduceMotion: true };
    const before = JSON.parse(JSON.stringify(foreign)) as typeof foreign;
    expect(parseUiChromePrefs(foreign)).toEqual(DEFAULT_UI_CHROME_PREFS);
    expect(foreign).toEqual(before);
  });

  it('缺布尔用默认，非布尔丢掉，未知字段不进结果', () => {
    expect(parseUiChromePrefs({ documentTabs: false })).toEqual({
      v: 1,
      reduceMotion: false,
      documentTabs: false,
      drawerOpenByDefault: true,
      topBarVisible: true,
    });
    expect(parseUiChromePrefs({ v: 1, reduceMotion: 'yes', documentTabs: 0, drawerOpenByDefault: false, extra: 1 })).toEqual({
      v: 1,
      reduceMotion: false,
      documentTabs: true,
      drawerOpenByDefault: false,
      topBarVisible: true,
    });
    const raw = { v: 1, reduceMotion: true, documentTabs: true, drawerOpenByDefault: true, noise: 'keep' };
    expect(parseUiChromePrefs(raw)).toEqual({
      v: 1,
      reduceMotion: true,
      documentTabs: true,
      drawerOpenByDefault: true,
      topBarVisible: true,
    });
    expect(raw.noise).toBe('keep');
  });

  it('序列化往返只留四个字段', () => {
    const next: UiChromePrefs = { v: 1, reduceMotion: true, documentTabs: false, drawerOpenByDefault: true, topBarVisible: true };
    expect(serializeUiChromePrefs(next)).toEqual(next);
    expect(parseUiChromePrefs(serializeUiChromePrefs(next))).toEqual(next);
    expect(Object.keys(serializeUiChromePrefs(next)).sort()).toEqual(['documentTabs', 'drawerOpenByDefault', 'reduceMotion', 'topBarVisible', 'v']);
    expect(withUiChromePrefs(next, { documentTabs: true })).toEqual({ ...next, documentTabs: true });
    expect(withUiChromePrefs(next, { reduceMotion: false }).reduceMotion).toBe(false);
  });

  it('读取不写库，别的 layout 键保持原样', async () => {
    const bag = new Map<string, unknown>([
      ['ui', { sidebarWidth: 280 }],
      ['settings.workspacePicker', { v: 1, startup: 'overview' }],
      [UI_CHROME_PREFS_KEY, { v: 1, reduceMotion: true, documentTabs: false, drawerOpenByDefault: false, extra: 9 }],
    ]);
    const port = memoryPort(bag);
    expect(await loadUiChromePrefs(port)).toEqual({
      v: 1,
      reduceMotion: true,
      documentTabs: false,
      drawerOpenByDefault: false,
      topBarVisible: true,
    });
    expect(port.writes).toEqual([]);
    expect(bag.get('ui')).toEqual({ sidebarWidth: 280 });
    expect(bag.get('settings.workspacePicker')).toEqual({ v: 1, startup: 'overview' });
    expect(bag.get(UI_CHROME_PREFS_KEY)).toEqual({
      v: 1,
      reduceMotion: true,
      documentTabs: false,
      drawerOpenByDefault: false,
      extra: 9,
    });
  });

  it('缺键读取是默认；保存后能读回，且不写别的键', async () => {
    const bag = new Map<string, unknown>([
      ['ui', { sidebarWidth: 280 }],
      ['settings.workspacePicker', { v: 1, startup: 'last' }],
    ]);
    const port = memoryPort(bag);
    expect(await loadUiChromePrefs(port)).toEqual(DEFAULT_UI_CHROME_PREFS);
    const stored = await saveUiChromePrefs(port, {
      v: 1,
      reduceMotion: true,
      documentTabs: false,
      drawerOpenByDefault: true,
      topBarVisible: false,
    });
    expect(stored).toEqual({ v: 1, reduceMotion: true, documentTabs: false, drawerOpenByDefault: true, topBarVisible: false });
    expect(port.writes).toEqual([UI_CHROME_PREFS_KEY]);
    expect(await loadUiChromePrefs(port)).toEqual(stored);
    expect(bag.get('ui')).toEqual({ sidebarWidth: 280 });
    expect(bag.get('settings.workspacePicker')).toEqual({ v: 1, startup: 'last' });
    expect(bag.get(UI_CHROME_PREFS_KEY)).toEqual(stored);
  });

  it('写入失败就抛出，不把失败当成已保存，也不改别的键', async () => {
    const bag = new Map<string, unknown>([['ui', { sidebarWidth: 1 }]]);
    const port = memoryPort(bag, true);
    await expect(
      saveUiChromePrefs(port, { v: 1, reduceMotion: true, documentTabs: false, drawerOpenByDefault: true, topBarVisible: true }),
    ).rejects.toThrow('disk full');
    expect(port.writes).toEqual([UI_CHROME_PREFS_KEY]);
    expect(bag.has(UI_CHROME_PREFS_KEY)).toBe(false);
    expect(bag.get('ui')).toEqual({ sidebarWidth: 1 });
  });

  it('topBarVisible defaults true; toggle and legacy missing field', () => {
    expect(parseUiChromePrefs({ v: 1, reduceMotion: false, documentTabs: true, drawerOpenByDefault: true })).toEqual({
      v: 1,
      reduceMotion: false,
      documentTabs: true,
      drawerOpenByDefault: true,
      topBarVisible: true,
    });
    expect(parseUiChromePrefs({ v: 1, reduceMotion: false, documentTabs: true, drawerOpenByDefault: true, topBarVisible: false }).topBarVisible).toBe(false);
    const base = { v: 1 as const, reduceMotion: false, documentTabs: true, drawerOpenByDefault: true, topBarVisible: true };
    expect(withUiChromePrefs(base, { topBarVisible: false }).topBarVisible).toBe(false);
    expect(withUiChromePrefs(base, { topBarVisible: base.topBarVisible === false }).topBarVisible).toBe(false);
  });


});
