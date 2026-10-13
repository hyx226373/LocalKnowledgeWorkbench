import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('KbToggle 预览胶囊对齐', () => {
  it('导出 SchemeSunToggle，并保留 kb-toggle 兼容类', () => {
    const src = readFileSync(join(__dirname, '../src/renderer/settings/KbToggle.tsx'), 'utf8');
    expect(src).toContain('export function SchemeSunToggle');
    expect(src).toContain("className={sun ? 'kb-toggle kb-toggle--sun' : 'kb-toggle'}");
    expect(src).toContain('role="switch"');
    const css = readFileSync(join(__dirname, '../src/renderer/settings/kb-toggle.css'), 'utf8');
    expect(css).toContain('--kb-toggle-travel: 22px');
    expect(css).toContain('kb-toggle-spin');
    expect(css).toContain('.kb-toggle--sun');
  });

  it('设置外观页用 set-row / seg，且不含假云同步', () => {
    const page = readFileSync(join(__dirname, '../src/renderer/settings/SettingsPage.tsx'), 'utf8');
    expect(page).toContain('showSchemeSun');
    expect(page).toContain('kb-set-page');
    expect(page).toContain('kb-set-row');
    expect(page).not.toMatch(/云同步|同步到云端/);
    const fields = readFileSync(join(__dirname, '../src/renderer/settings/AppearanceFields.tsx'), 'utf8');
    expect(fields).toContain('kb-seg');
    expect(fields).toContain('SchemeSunToggle');
    const frame = readFileSync(join(__dirname, '../src/renderer/settings/settings-frame.css'), 'utf8');
    expect(frame).toContain('.kb-set-row');
    expect(frame).toContain('.kb-seg');
  });
});
