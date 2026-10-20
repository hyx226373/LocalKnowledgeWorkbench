import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { UI_SNAPSHOT_KEY, readUiSnapshot, writeUiSnapshot } from '../src/renderer/layoutSnapshot';
import { DEFAULT_SHELL, migrateLayout } from '../src/renderer/plugin-host/layoutModel';
import { FormatHint } from '../src/renderer/rebirth/FormatHint';
import {
  CUSTOM_COLOR_PRESETS,
  applyCustomColorOverlay,
  dropStaleCustomColors,
  effectiveCustomColors,
  isCustomColorValue,
  matchingPresetId,
  paintCustomColorOverlay,
  parseCustomColors,
  resetCustomColors,
  sanitizeColorVars,
  setCustomColorOverlay,
} from '../src/renderer/theme/customColors';
import { normalizeAppearance, readStoredAppearance } from '../src/renderer/theme/appearance';
import { NEW_LAYOUT_SIDEBAR_WIDTH, newLayoutSidebarWidth } from '../src/shared/items';
import {
  EMPTY_OVERVIEW_BOARDS,
  addOverviewCategory,
  deleteOverviewCategory,
  renameOverviewCategory,
} from '../src/shared/workspacePicker/overviewBoards';

vi.mock('../src/renderer/kb', () => ({ kb: {} }));
import { Transfer, backupVersionLabel } from '../src/renderer/rebirth/Transfer';

function memory() {
  const bag = new Map<string, string>();
  return {
    getItem: (key: string) => bag.get(key) ?? null,
    setItem: (key: string, value: string) => {
      bag.set(key, value);
    },
  };
}

describe('r23-E 外观滑块兼容', () => {
  it('合法 scheme 优先，旧滑块字段原样留着', () => {
    const system = normalizeAppearance({ chrome: 'origin', reading: 'origin', scheme: 'system', schemeSlider: true });
    expect(system?.scheme).toBe('system');
    expect((system as { schemeSlider?: boolean }).schemeSlider).toBe(true);
    const dark = normalizeAppearance({ chrome: 'origin', reading: 'origin', schemeSlider: true });
    expect(dark?.scheme).toBe('dark');
    expect((dark as { schemeSlider?: boolean }).schemeSlider).toBe(true);
    const light = normalizeAppearance({ chrome: 'origin', reading: 'origin', darkAppearance: false });
    expect(light?.scheme).toBe('light');
    expect((light as { darkAppearance?: boolean }).darkAppearance).toBe(false);
    expect(normalizeAppearance({ chrome: 'origin', reading: 'origin', scheme: 'nope', schemeSlider: 'maybe' })).toBeNull();
    expect(normalizeAppearance({ chrome: 'origin', reading: 'origin' })).toBeNull();
  });

  it('ui 根上的滑块映射到卡片，三项快照仍按原样读回', () => {
    const stored = readStoredAppearance({ chrome: 'touchline', reading: 'study', schemeSlider: 1 });
    expect(stored.scheme).toBe('dark');
    expect(stored.chrome).toBe('origin');
    expect((stored as { schemeSlider?: number }).schemeSlider).toBe(1);
    const nested = readStoredAppearance({
      appearance: { chrome: 'touchline', reading: 'study' },
      darkAppearance: 'light',
    });
    expect(nested).toMatchObject({ chrome: 'touchline', reading: 'study', scheme: 'light', darkAppearance: 'light' });

    const saved = { chrome: 'touchline', reading: 'study', scheme: 'dark' as const };
    const plain = memory();
    writeUiSnapshot({ appearance: saved, focus: false, expanded: [], sidebarWidth: 280 }, plain);
    expect(readUiSnapshot(plain)?.appearance).toEqual(saved);

    const legacy = memory();
    legacy.setItem(UI_SNAPSHOT_KEY, JSON.stringify({
      v: 1,
      appearance: { chrome: 'origin', reading: 'origin', schemeSlider: true },
      focus: false,
      expanded: [],
      sidebarWidth: 300,
    }));
    const read = readUiSnapshot(legacy);
    expect(read?.appearance.scheme).toBe('dark');
    expect((read?.appearance as { schemeSlider?: boolean }).schemeSlider).toBe(true);
    expect(read?.sidebarWidth).toBe(300);

    const broken = memory();
    broken.setItem(UI_SNAPSHOT_KEY, JSON.stringify({
      v: 1,
      appearance: { chrome: 'origin', reading: 'origin', scheme: 'nope' },
      sidebarWidth: 240,
    }));
    expect(readUiSnapshot(broken)).toBeNull();

    const keep = memory();
    keep.setItem(UI_SNAPSHOT_KEY, JSON.stringify({
      v: 1,
      appearance: { chrome: 'origin', reading: 'origin', scheme: 'light' },
      schemeSlider: false,
      focus: false,
      expanded: [],
      sidebarWidth: 280,
    }));
    writeUiSnapshot({ appearance: { chrome: 'origin', reading: 'origin', scheme: 'dark' }, focus: true, expanded: [], sidebarWidth: 280 }, keep);
    const raw = JSON.parse(keep.getItem(UI_SNAPSHOT_KEY) ?? '{}') as { schemeSlider?: boolean; appearance: { scheme: string } };
    expect(raw.schemeSlider).toBe(false);
    expect(raw.appearance.scheme).toBe('dark');
  });
});

describe('r23-E 自定义配色', () => {
  it('非法颜色丢掉，重置清空并保留其它字段', () => {
    expect(sanitizeColorVars({
      '--kb-color-accent': '#2563EB',
      '--kb-color-bg': '  #fff ',
      '--kb-color-text': 'url(http://x)',
      '--kb-nope': '#fff',
      '--kb-color-border': 'red',
      '--kb-color-danger': 'rgb(1, 2, 3)',
      '--kb-color-warning': 'expression(alert(1))',
    })).toEqual({
      '--kb-color-accent': '#2563EB',
      '--kb-color-bg': '#fff',
      '--kb-color-danger': 'rgb(1, 2, 3)',
    });
    expect(isCustomColorValue('var(--kb-color-accent)')).toBe(false);
    const file = { v: 1 as const, enabled: true, vars: { '--kb-color-accent': '#2563EB' }, note: 'keep' };
    const reset = resetCustomColors(file);
    expect(reset.enabled).toBe(false);
    expect(reset.vars).toEqual({});
    expect(reset.note).toBe('keep');
    expect(effectiveCustomColors(reset)).toEqual({});
    expect(effectiveCustomColors({ ...file, enabled: false })).toEqual({});
    expect(effectiveCustomColors(file)['--kb-color-accent']).toBe('#2563EB');
    expect(parseCustomColors(null)).toBeNull();
    expect(parseCustomColors(undefined)).toBeNull();
    expect(parseCustomColors('nope')).toEqual({ v: 1, enabled: false, vars: {} });
  });

  it('预设不含紫色，关闭时不进入快照', () => {
    const blob = JSON.stringify(CUSTOM_COLOR_PRESETS);
    expect(blob.toLowerCase()).not.toContain('#5b5bd6');
    expect(blob.toLowerCase()).not.toContain('#7c3aed');
    expect(blob).toContain('#2563EB');
    expect(matchingPresetId({ ...CUSTOM_COLOR_PRESETS[0].vars })).toBe('blue');
    expect(matchingPresetId({ '--kb-color-accent': '#111111' })).toBe('custom');
    expect(matchingPresetId({})).toBeNull();
    const calls: string[] = [];
    setCustomColorOverlay({ '--kb-color-accent': '#2563EB', '--kb-evil': 'x' }, { paint: false });
    paintCustomColorOverlay({
      setProperty(name, value, priority) { calls.push(`${name}=${value}/${priority ?? ''}`); },
      removeProperty(name) { calls.push(`remove:${name}`); return ''; },
    });
    expect(calls).toContain('--kb-color-accent=#2563EB/important');
    expect(calls.some((line) => line.includes('--kb-evil'))).toBe(false);
    setCustomColorOverlay({}, { paint: false });
    paintCustomColorOverlay({
      setProperty(name, value, priority) { calls.push(`${name}=${value}/${priority ?? ''}`); },
      removeProperty(name) { calls.push(`remove:${name}`); return ''; },
    });
    expect(calls).toContain('remove:--kb-color-accent');
    const props = new Map<string, string>();
    const target = {
      setProperty(name: string, value: string, priority?: string) { props.set(name, `${value}/${priority ?? ''}`); },
      removeProperty(name: string) { props.delete(name); return ''; },
    };
    setCustomColorOverlay({ '--kb-color-accent': '#2563EB' }, { paint: false });
    paintCustomColorOverlay(target);
    setCustomColorOverlay({}, { paint: false });
    dropStaleCustomColors(target);
    target.setProperty('--kb-color-accent', '#3e6e8c');
    applyCustomColorOverlay(target);
    expect(props.get('--kb-color-accent')).toBe('#3e6e8c/');
    const store = memory();
    writeUiSnapshot({
      appearance: { chrome: 'origin', reading: 'origin', scheme: 'light' },
      focus: false,
      expanded: [],
      sidebarWidth: 280,
      customColors: { '--kb-color-accent': '#0F766E', '--kb-color-text': 'url(x)' },
    }, store);
    expect(readUiSnapshot(store)?.customColors).toEqual({ '--kb-color-accent': '#0F766E' });
    writeUiSnapshot({
      appearance: { chrome: 'origin', reading: 'origin', scheme: 'light' },
      focus: false,
      expanded: [],
      sidebarWidth: 280,
    }, store);
    expect(readUiSnapshot(store)?.customColors).toBeUndefined();
    expect(JSON.parse(store.getItem(UI_SNAPSHOT_KEY) ?? '{}').customColors).toBeUndefined();
  });
});

describe('r23-E 侧栏默认宽', () => {
  it('已保存宽度原样读回，缺宽仍是 280，没有保存过才是 240', () => {
    const saved = migrateLayout({ schema: 4, dock: null, shell: { sidebarWidth: 280 } });
    expect(saved.ok && saved.layout.shell.sidebarWidth).toBe(280);
    const missing = migrateLayout({ schema: 4, dock: null, shell: {} });
    expect(missing.ok && missing.layout.shell.sidebarWidth).toBe(280);
    expect(DEFAULT_SHELL.sidebarWidth).toBe(280);
    expect(newLayoutSidebarWidth(321)).toBe(321);
    expect(newLayoutSidebarWidth(280)).toBe(280);
    expect(newLayoutSidebarWidth(undefined)).toBe(NEW_LAYOUT_SIDEBAR_WIDTH);
    expect(newLayoutSidebarWidth(Number.NaN)).toBe(240);
    const src = readFileSync(join(__dirname, '../src/main/service/WorkbenchService.ts'), 'utf8');
    expect(src).toContain('sidebarWidth: NEW_LAYOUT_SIDEBAR_WIDTH');
    expect(src).toContain('sidebarWidth: newLayoutSidebarWidth(ui.sidebarWidth)');
    expect(src).toContain('sidebarWidth: ui.sidebarWidth ?? 280');
  });
});

describe('r23-E 默认分类', () => {
  it('最近和收藏不能改名或删除，用户分类可以改名', () => {
    const boards = addOverviewCategory(EMPTY_OVERVIEW_BOARDS, '项目甲');
    for (const id of ['recent', 'favorites', 'all']) {
      expect(renameOverviewCategory(boards, id, '改名')).toBe(boards);
      expect(deleteOverviewCategory(boards, id)).toBe(boards);
    }
    const custom = boards.categories?.[0];
    expect(custom?.name).toBe('项目甲');
    const renamed = renameOverviewCategory(boards, custom!.id, '项目乙');
    expect(renamed).not.toBe(boards);
    expect(renamed.categories?.[0]?.name).toBe('项目乙');
    expect(deleteOverviewCategory(renamed, custom!.id).categories).toEqual([]);
  });
});

describe('r23-E 编辑器收纳', () => {
  it('版本菜单默认折叠，仍带原来的回退入口', () => {
    const html = renderToStaticMarkup(React.createElement(Transfer, { id: 'R1' }));
    for (const text of ['导入', '导出', '导入合并…', '回退到版本…', '版本']) expect(html).toContain(text);
    expect(html).not.toMatch(/<details[^>]*\sopen[\s=>]/);
    expect(backupVersionLabel('2026-10-17T02-24-08')).toMatch(/2026/);
    expect(backupVersionLabel('2026-10-17T02-24-08')).not.toBe('2026-10-17T02-24-08');
    expect(backupVersionLabel('not-a-stamp')).toBe('not-a-stamp');
  });

  it('格式说明默认折叠，六块标题和全文都在', () => {
    const hint = '格式名：默认。概述到待办。';
    const html = renderToStaticMarkup(React.createElement(FormatHint, { text: hint }));
    expect(html).toContain('格式：默认六块');
    expect(html).toContain('展开说明');
    for (const title of ['概述', '角色', '用户要求', '技能与做法', '已定结论', '待办与下一步']) expect(html).toContain(title);
    expect(html).toContain(hint);
    expect(html).toContain('class="rb-format"');
    expect(html).not.toMatch(/<details[^>]*\sopen[\s=>]/);
  });
});
