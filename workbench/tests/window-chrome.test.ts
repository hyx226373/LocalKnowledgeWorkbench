import { describe, expect, it, vi } from 'vitest';
import { applyWindowChromeColors, windowChromeOptions } from '../src/main/windowChrome';

describe('windowChromeOptions', () => {
  it('隐藏标题栏并给出 Windows 叠层，不关系统边框', () => {
    const options = windowChromeOptions();
    expect(options.titleBarStyle).toBe('hidden');
    expect(options.titleBarOverlay).toEqual({
      color: '#1e1e1e',
      symbolColor: '#e6e6e6',
      height: 40,
    });
    expect(options).not.toHaveProperty('frame');
    expect(options).not.toHaveProperty('backgroundColor');
    expect(options.titleBarOverlay.color).not.toBe('#ebe9e4');
  });

  it('颜色与符号色可单独覆盖，高度仍是 40', () => {
    expect(windowChromeOptions({ color: '#252526' }).titleBarOverlay).toEqual({
      color: '#252526',
      symbolColor: '#e6e6e6',
      height: 40,
    });
    expect(windowChromeOptions({ symbolColor: '#1a1a1a' }).titleBarOverlay).toEqual({
      color: '#1e1e1e',
      symbolColor: '#1a1a1a',
      height: 40,
    });
    expect(windowChromeOptions({ color: '#ebe9e4', symbolColor: '#1a1a1a' }).titleBarOverlay).toEqual({
      color: '#ebe9e4',
      symbolColor: '#1a1a1a',
      height: 40,
    });
  });

  it('展开进窗口选项时留下 title、菜单、图标和 webPreferences', () => {
    const options = {
      title: '本地知识工作台',
      icon: 'icon.png',
      autoHideMenuBar: true,
      backgroundColor: '#1e1e1e',
      ...windowChromeOptions(),
      webPreferences: { preload: 'preload.js', contextIsolation: true, sandbox: true, nodeIntegration: false },
    };
    expect(options.title).toBe('本地知识工作台');
    expect(options.icon).toBe('icon.png');
    expect(options.autoHideMenuBar).toBe(true);
    expect(options.backgroundColor).toBe('#1e1e1e');
    expect(options.webPreferences).toEqual({
      preload: 'preload.js',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    });
    expect(options.titleBarStyle).toBe('hidden');
    expect('frame' in options).toBe(false);
  });
});

describe('applyWindowChromeColors', () => {
  it('调用 setTitleBarOverlay，不关闭窗口', () => {
    const setTitleBarOverlay = vi.fn();
    const close = vi.fn();
    const win = { setTitleBarOverlay, close };
    applyWindowChromeColors(win, { color: '#222222', symbolColor: '#f0f0f0' });
    expect(setTitleBarOverlay).toHaveBeenCalledTimes(1);
    expect(setTitleBarOverlay).toHaveBeenCalledWith({ color: '#222222', symbolColor: '#f0f0f0', height: 40 });
    expect(close).not.toHaveBeenCalled();
  });

  it('没有 setTitleBarOverlay 时安全返回', () => {
    expect(() => applyWindowChromeColors({}, { color: '#111111', symbolColor: '#eeeeee' })).not.toThrow();
    expect(() => applyWindowChromeColors(null, { color: '#111111', symbolColor: '#eeeeee' })).not.toThrow();
    expect(() => applyWindowChromeColors(undefined, { color: '#111111', symbolColor: '#eeeeee' })).not.toThrow();
    const close = vi.fn();
    const bare = { close };
    applyWindowChromeColors(bare, { color: '#111111', symbolColor: '#eeeeee' });
    expect(close).not.toHaveBeenCalled();
  });
});
