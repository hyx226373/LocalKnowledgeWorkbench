import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { presentPlan, presentSwitches } from '../src/main/windowPresent';

describe('presentPlan', () => {
  const wa = { x: 100, y: 50, width: 1200, height: 800 };

  it('最小化的异常坐标还原并居中到工作区内', () => {
    const plan = presentPlan({ minimized: true, x: -25600, y: -25600, width: 1000, height: 600 }, wa);
    expect(plan).toEqual({ restore: true, bounds: { x: 200, y: 150, width: 1000, height: 600 }, nudge: true });
  });

  it('完全离开工作区时居中并限制尺寸', () => {
    expect(presentPlan({ minimized: false, x: 1300, y: 50, width: 1600, height: 900 }, wa)).toEqual({
      restore: false, bounds: wa, nudge: true,
    });
  });

  it('正常和部分可见的窗口保留位置与尺寸，仍触发重绘', () => {
    for (const bounds of [{ x: 200, y: 150, width: 900, height: 600 }, { x: 50, y: 0, width: 900, height: 600 }]) {
      expect(presentPlan({ ...bounds, minimized: false }, wa)).toEqual({ restore: false, bounds, nudge: true });
    }
  });
});

describe('presentSwitches', () => {
  it('Windows 关闭遮挡节流', () => {
    expect(presentSwitches('win32', {})).toEqual({
      appendSwitch: [['disable-backgrounding-occluded-windows'], ['disable-features', 'CalculateNativeWinOcclusion']],
      disableHardwareAcceleration: false,
    });
  });

  it('Linux 不添加开关', () => {
    expect(presentSwitches('linux', {})).toEqual({ appendSwitch: [], disableHardwareAcceleration: false });
  });

  it('任何平台仅在 KB_DISABLE_GPU=1 时禁用硬件加速', () => {
    for (const platform of ['win32', 'linux', 'darwin']) {
      expect(presentSwitches(platform, { KB_DISABLE_GPU: '1' }).disableHardwareAcceleration).toBe(true);
      expect(presentSwitches(platform, { KB_DISABLE_GPU: '0' }).disableHardwareAcceleration).toBe(false);
    }
  });

  it('命令行或环境请求 in-process-gpu 时不追加该开关，也不因此关闭 GPU', () => {
    const baseline = presentSwitches('win32', {});
    const fromArgv = presentSwitches('win32', {}, ['--in-process-gpu']);
    const fromArgvValue = presentSwitches('win32', {}, ['--in-process-gpu=1']);
    const fromEnv = presentSwitches('win32', { ELECTRON_EXTRA_LAUNCH_ARGS: '--in-process-gpu' });
    const fromLinux = presentSwitches('linux', { ELECTRON_EXTRA_LAUNCH_ARGS: '--foo --in-process-gpu' });
    const gpuOff = presentSwitches('win32', { KB_DISABLE_GPU: '1' }, ['--in-process-gpu']);
    for (const plan of [fromArgv, fromArgvValue, fromEnv, fromLinux, gpuOff]) {
      expect(plan.appendSwitch.some(([name]) => name === 'in-process-gpu')).toBe(false);
    }
    expect(fromArgv).toEqual(baseline);
    expect(fromArgvValue).toEqual(baseline);
    expect(fromEnv).toEqual(baseline);
    expect(fromLinux).toEqual({ appendSwitch: [], disableHardwareAcceleration: false });
    expect(gpuOff.disableHardwareAcceleration).toBe(true);
    expect(gpuOff.appendSwitch).toEqual(baseline.appendSwitch);
  });
});

it('主窗口隐藏创建并导入呈现计划', () => {
  const source = fs.readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  expect(source).toMatch(/show:\s*false/);
  expect(source).toMatch(/import\s*\{[^}]*\bpresentPlan\b[^}]*\}\s*from\s*['"]\.\/windowPresent['"]/);
});

it('主进程源码不追加 in-process-gpu', () => {
  const source = fs.readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  expect(source).not.toContain("appendSwitch('in-process-gpu')");
  expect(source).not.toContain('appendSwitch("in-process-gpu")');
});
