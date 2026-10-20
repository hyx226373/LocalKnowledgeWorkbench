import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { isSuppressedDrawerSlot } from '../src/renderer/drawer/Drawer';

it('slot 显式为 null 时整块不画（插件关掉），未提供时仍显示「尚未挂接」', async () => {
  const { SingleDrawer: Drawer } = await import('../src/renderer/drawer/Drawer');
  const base = { open: true, onWidth: () => {}, onSelectionChange: () => {}, selection: ['root', 'web'] as const };
  const hidden = renderToStaticMarkup(createElement(Drawer, { ...base, slots: { root: '根内容', web: null } } as never));
  expect(hidden).toContain('data-testid="drawer-slot-root"');
  expect(hidden).not.toContain('data-testid="drawer-slot-web"');
  expect(hidden).not.toContain('drawer-pending-web');
  const shown = renderToStaticMarkup(createElement(Drawer, { ...base, slots: { root: '根内容', web: '网络内容' } } as never));
  expect(shown).toContain('data-testid="drawer-slot-web"');
  const missing = renderToStaticMarkup(createElement(Drawer, { ...base, slots: { root: '根内容' } } as never));
  expect(missing).toContain('drawer-pending-web');
});

it('大图标模式在插件关掉或未授权时整张卡片不画，重新打开后恢复', async () => {
  const { SingleDrawer: Drawer } = await import('../src/renderer/drawer/Drawer');
  const { updateSidebarPrefs } = await import('../src/renderer/drawer/sidebarPrefs');
  const filled = { root: '根内容', fav: '藏', bench: '台', agent: '智', plugin: '插' };
  const base = { open: true, onWidth: () => {}, onSelectionChange: () => {}, selection: ['root', 'web'] as const };
  const cards = (html: string) => html.match(/data-testid="drawer-card-/g)?.length ?? 0;
  try {
    updateSidebarPrefs({ categoriesLayout: 'grid', ribbonCollapsed: false, categoriesCollapsed: false });
    expect(isSuppressedDrawerSlot(null)).toBe(true);
    expect(isSuppressedDrawerSlot(false)).toBe(true);
    expect(isSuppressedDrawerSlot(undefined)).toBe(false);

    const off = renderToStaticMarkup(createElement(Drawer, { ...base, slots: { ...filled, web: null } } as never));
    expect(off).not.toContain('data-testid="drawer-card-web"');
    expect(off).not.toContain('data-testid="drawer-slot-web"');
    expect(off).not.toContain('drawer-pending-web');
    expect(off).not.toContain('网络资料');
    expect(off).toContain('data-testid="drawer-card-root"');
    expect(off).toContain('data-testid="drawer-slot-root"');
    expect(cards(off)).toBe(5);

    const onlyWeb = renderToStaticMarkup(createElement(Drawer, { ...base, selection: ['web'] as const, slots: { ...filled, web: null } } as never));
    expect(onlyWeb).not.toContain('data-testid="drawer-card-web"');
    expect(onlyWeb).not.toContain('data-testid="drawer-modules"');
    expect(onlyWeb).not.toContain('drawer-slot-web');

    const denied = renderToStaticMarkup(createElement(Drawer, { ...base, slots: { ...filled, web: false } } as never));
    expect(denied).not.toContain('data-testid="drawer-card-web"');
    expect(denied).not.toContain('data-testid="drawer-slot-web"');
    expect(denied).not.toContain('drawer-pending-web');
    expect(denied).not.toContain('>网络资料<');
    expect(cards(denied)).toBe(5);

    const on = renderToStaticMarkup(createElement(Drawer, { ...base, slots: { ...filled, web: '网络内容' } } as never));
    const webAt = on.indexOf('data-testid="drawer-card-web"');
    const webButton = on.slice(on.lastIndexOf('<button', webAt), on.indexOf('</button>', webAt));
    expect(webButton.startsWith('<button')).toBe(true);
    expect(webButton).not.toContain('disabled');
    expect(on).toContain('data-testid="drawer-slot-web"');
    expect(on).toContain('网络内容');
    expect(on).toContain('网络资料');
    expect(cards(on)).toBe(6);

    updateSidebarPrefs({ categoriesLayout: 'list', ribbonCollapsed: false });
    const narrowOff = renderToStaticMarkup(createElement(Drawer, { ...base, slots: { ...filled, web: null } } as never));
    expect(narrowOff).not.toContain('data-testid="drawer-card-web"');
    expect(narrowOff).not.toContain('data-testid="drawer-slot-web"');
    const narrowOn = renderToStaticMarkup(createElement(Drawer, { ...base, slots: { ...filled, web: '网络内容' } } as never));
    expect(narrowOn).toContain('data-testid="drawer-card-web"');
    expect(narrowOn).toContain('data-testid="drawer-slot-web"');
  } finally {
    updateSidebarPrefs({ categoriesLayout: 'grid', ribbonCollapsed: false, categoriesCollapsed: false });
  }
});
