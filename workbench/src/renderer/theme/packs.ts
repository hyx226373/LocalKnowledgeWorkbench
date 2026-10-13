/** 主题包 → 插件模块。内置 A/B/C 与用户安装/开发中的主题包走同一条路径。 */
import { HOST_API_VERSION, type PluginModule } from '../plugin-host/types';
import type { PluginEntry } from '../plugin-host/host';
import type { ThemePackDto } from '../../shared/types';
import { validateThemePack, type ValidatedPack } from './contract';

export interface LoadedPack {
  dto: ThemePackDto;
  validated: ValidatedPack;
  entry: PluginEntry;
}

export function themePackEntry(dto: ThemePackDto, index = 0): LoadedPack {
  const v = dto.error
    ? { manifest: null, chrome: [], reading: [], presets: [], errors: [dto.error], warnings: [] }
    : validateThemePack(dto.manifest, dto.files, HOST_API_VERSION);
  const raw = (dto.manifest ?? {}) as { id?: string; name?: string; version?: string; description?: string; engines?: { workbench?: string } };
  const id = typeof raw.id === 'string' && /^[a-z0-9][a-z0-9.-]{1,63}$/.test(raw.id) ? raw.id : `theme.invalid-${index}`;
  const module: PluginModule = {
    manifest: {
      id,
      name: raw.name ?? id,
      version: typeof raw.version === 'string' ? raw.version : '0.0.0',
      engines: { workbench: raw.engines?.workbench ?? `^${HOST_API_VERSION}` },
      description: raw.description,
      activationEvents: ['onStartup'],
      contributes: {
        chromeThemes: v.chrome.map((t) => ({ id: t.id, label: t.label })),
        readingThemes: v.reading.map((t) => ({ id: t.id, label: t.label })),
        layoutPresets: v.presets.map((p) => ({ id: p.id, label: p.label })),
      },
    },
    activate(api) {
      for (const t of v.chrome) api.themes.registerChrome(t);
      for (const t of v.reading) api.themes.registerReading(t);
      for (const p of v.presets) api.themes.registerLayoutPreset(p);
    },
  };
  return {
    dto,
    validated: v,
    entry: { module, source: dto.source === 'builtin' ? 'builtin' : 'user', kind: 'theme', preflightError: v.errors.length ? v.errors.slice(0, 3).join('；') + (v.errors.length > 3 ? ` 等 ${v.errors.length} 处` : '') : undefined },
  };
}

/** 安装提示照实说。没启用时不能说「已安装」。 */
export function themeInstallFeedback(name: string, status: string | undefined, message?: string): { title: string; body: string } {
  const label = name.trim() || '主题包';
  if (status === 'active') return { title: '主题包已安装', body: `${label}：可在“外观”中选择。` };
  const why = (message || '没有进入启用状态').replace(/\s+/g, ' ').trim();
  return { title: '主题包已复制，但未能启用', body: `${label}已复制，但未能启用：${why}` };
}

/** 随应用打包的主题包（themes/<id>/），以与外部主题包相同的 DTO 形式提供 */
export function builtinThemePacks(): ThemePackDto[] {
  const manifests = import.meta.glob('../../../themes/*/theme.json', { eager: true, import: 'default' }) as Record<string, unknown>;
  const raws = import.meta.glob('../../../themes/*/**/*.{css,json}', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
  const out: ThemePackDto[] = [];
  for (const [p, manifest] of Object.entries(manifests)) {
    const dir = p.slice(0, -'theme.json'.length);
    const files: Record<string, string> = {};
    for (const [fp, text] of Object.entries(raws)) if (fp.startsWith(dir) && fp !== p) files[fp.slice(dir.length)] = text;
    out.push({ source: 'builtin', location: dir.split('/').slice(-2, -1)[0], manifest, files });
  }
  return out.sort((a, b) => a.location.localeCompare(b.location));
}
