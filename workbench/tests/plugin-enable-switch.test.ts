import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');

describe('r41-BC 插件胶囊开关与设置齿轮', () => {
  it('侧栏与插件管理页用 PluginEnableSwitch，无「已启用+禁用按钮」双占位', () => {
    const app = readFileSync(join(root, 'src/renderer/App.tsx'), 'utf8');
    expect(app).toContain("from './settings/PluginEnableSwitch'");
    expect(app).toContain('<PluginEnableSwitch');
    expect(app).not.toMatch(/已启用[\s\S]{0,120}禁用/);

    const pm = readFileSync(join(root, 'src/renderer/ui/PluginManager.tsx'), 'utf8');
    expect(pm).toContain('<PluginEnableSwitch');
    expect(pm).not.toMatch(/kb-badge[\s\S]{0,80}已启用[\s\S]{0,120}禁用/);
    expect(pm).not.toMatch(/>禁用</);
  });

  it('PluginEnableSwitch 异常态轻量展示，写入走 setEnabled', () => {
    const src = readFileSync(join(root, 'src/renderer/settings/PluginEnableSwitch.tsx'), 'utf8');
    expect(src).toContain("status === 'incompatible'");
    expect(src).toContain("status === 'error'");
    expect(src).toContain("status === 'denied'");
    expect(src).toContain('kb-plugin-status');
    expect(src).toContain('pluginHost.setEnabled');
    expect(src).toContain('busy');
    expect(src).toContain('内置核心插件，不可禁用');
  });

  it('设置齿轮为 lucide settings 路径，不是太阳射线', () => {
    const marks = readFileSync(join(root, 'src/renderer/ui/shellMarks.tsx'), 'utf8');
    expect(marks).toContain('M12.22 2h-.44a2 2 0 0 0-2 2v.18');
    expect(marks).toContain('width="16"');
    expect(marks).toContain('strokeWidth={sw}');
    // SettingsIcon 不得再用太阳射线短路径
    const settingsFn = marks.slice(marks.indexOf('export function SettingsIcon'), marks.indexOf('export function SunIcon'));
    expect(settingsFn).not.toContain('M12 2v2M12 20v2M4.9');
  });

  it('太阳胶囊 knob 对齐 switch-sun 切片；开关规格 52×30 / travel22 / opacity0.42', () => {
    const toggle = readFileSync(join(root, 'src/renderer/settings/KbToggle.tsx'), 'utf8');
    expect(toggle).toContain('m4.93 4.93 1.41 1.41');
    expect(toggle).toContain('width="13"');
    expect(toggle).toContain('strokeWidth="1.75"');
    const css = readFileSync(join(root, 'src/renderer/settings/kb-toggle.css'), 'utf8');
    expect(css).toContain('--kb-toggle-travel: 22px');
    expect(css).toContain('width: 52px');
    expect(css).toContain('height: 30px');
    expect(css).toContain('opacity: 0.42');
  });

  it('设置内容页无假云同步；分段与 set-row 保留', () => {
    const page = readFileSync(join(root, 'src/renderer/settings/SettingsPage.tsx'), 'utf8');
    expect(page).not.toMatch(/云同步|同步到云端/);
    expect(page).toContain('kb-set-page');
    expect(page).toContain('kb-set-row');
    const frame = readFileSync(join(root, 'src/renderer/settings/settings-frame.css'), 'utf8');
    expect(frame).toContain('border-radius: 12px');
    expect(frame).toContain('height: 34px');
    expect(frame).toContain('border-radius: 9px');
  });

  it('美术切片 SVG 已落盘', () => {
    const gear = readFileSync(join(root, 'src/renderer/ui/icons/settings-gear.svg'), 'utf8');
    const sun = readFileSync(join(root, 'src/renderer/ui/icons/switch-sun.svg'), 'utf8');
    expect(gear).toContain('M12.22 2h-.44');
    expect(sun).toContain('m4.93 4.93 1.41 1.41');
  });
});
