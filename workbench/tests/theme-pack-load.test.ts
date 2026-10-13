import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/renderer/kb', () => ({
  kb: {
    registerPlugin: async (id: string, version: string, source: 'builtin' | 'user') => ({
      id,
      version,
      source,
      enabled: true,
      granted: {},
      installedAt: 1,
    }),
  },
}));

import { chromeThemes, readingThemes } from '../src/renderer/plugin-host/registry';
import { pluginHost } from '../src/renderer/plugin-host/host';
import type { PluginEntry } from '../src/renderer/plugin-host/host';
import { themeInstallFeedback, themePackEntry } from '../src/renderer/theme/packs';
import type { ThemePackDto } from '../src/shared/types';

function touchline(): ThemePackDto {
  return {
    source: 'installed',
    location: 'amy.touchline',
    files: {},
    manifest: {
      id: 'amy.touchline',
      name: '球场指挥室',
      version: '1.0.0',
      engines: { workbench: '^0.2.0', themeContract: '^2.0.0' },
      contributes: {
        chromeThemes: [{ id: 'touchline', label: '球场指挥室', light: { tokens: {} }, dark: { tokens: {} } }],
        readingThemes: [{ id: 'touchline', label: '球场指挥室阅读', light: { tokens: {} }, dark: { tokens: {} } }],
      },
    },
  };
}

describe('用户主题包加载', () => {
  beforeEach(() => {
    chromeThemes.unregisterOwner('amy.touchline');
    readingThemes.unregisterOwner('amy.touchline');
  });

  it('安装后是 active，外框和阅读区都能拿到，重复安装仍是 active', async () => {
    const first = themePackEntry(touchline());
    expect(first.entry.source).toBe('user');
    expect(first.entry.kind).toBe('theme');
    expect(first.validated.errors).toEqual([]);
    await pluginHost.load([first.entry]);
    expect(pluginHost.get('amy.touchline')?.status).toBe('active');
    expect(chromeThemes.get('touchline')?.label).toBe('球场指挥室');
    expect(readingThemes.get('touchline')?.label).toBe('球场指挥室阅读');

    const again = themePackEntry({
      ...touchline(),
      manifest: {
        ...(touchline().manifest as object),
        name: '球场指挥室',
        contributes: {
          chromeThemes: [{ id: 'touchline', label: '球场指挥室二', light: { tokens: {} }, dark: { tokens: {} } }],
          readingThemes: [{ id: 'touchline', label: '球场指挥室阅读二', light: { tokens: {} }, dark: { tokens: {} } }],
        },
      },
    });
    await pluginHost.load([again.entry]);
    expect(pluginHost.get('amy.touchline')?.status).toBe('active');
    expect(pluginHost.get('amy.touchline#dup')).toBeUndefined();
    expect(pluginHost.list().some((r) => r.message?.includes('插件 id 重复'))).toBe(false);
    expect(chromeThemes.get('touchline')?.label).toBe('球场指挥室二');
    expect(readingThemes.get('touchline')?.label).toBe('球场指挥室阅读二');
  });

  it('user 来源的代码插件仍然被拒', async () => {
    const entry: PluginEntry = {
      source: 'user',
      kind: 'code',
      module: {
        manifest: { id: 'user.codepack', name: '代码', version: '1.0.0', engines: { workbench: '^0.2.0' } },
        activate() {
          throw new Error('不该激活');
        },
      },
    };
    await pluginHost.load([entry]);
    const rec = pluginHost.get('user.codepack');
    expect(rec?.status).toBe('incompatible');
    expect(rec?.message).toMatch(/沙箱适配器插件/);
  });

  it('加载失败时安装提示不说已安装', async () => {
    const broken = themePackEntry({ ...touchline(), error: 'theme.json 读不了' });
    expect(broken.entry.preflightError).toBeTruthy();
    await pluginHost.load([broken.entry]);
    const rec = pluginHost.get('amy.touchline');
    expect(rec?.status).toBe('incompatible');
    const notice = themeInstallFeedback('球场指挥室', rec?.status, rec?.message ?? broken.entry.preflightError);
    expect(notice.title + notice.body).not.toContain('已安装');
    expect(notice.body).toMatch(/已复制，但未能启用：/);
    expect(notice.body).toContain('theme.json 读不了');
  });
});
