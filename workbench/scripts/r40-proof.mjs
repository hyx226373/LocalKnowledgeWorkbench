/**
 * 外贴 40 补证。真实 Electron 窗口，隔离 KB_USER_DATA。
 * 只用页面里的 element.click / select 事件和 capturePage，不发送系统鼠标或键盘。
 */
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.KB_R40_PROOF_DIR;
const USER = process.env.KB_USER_DATA;
if (!OUT || !USER) {
  console.error('需要 KB_R40_PROOF_DIR 与 KB_USER_DATA');
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
const notes = [];
function note(name, detail) {
  notes.push({ name, detail });
  console.log(name, detail ?? '');
}

async function launch() {
  const app = await electron.launch({
    args: ['.', '--no-sandbox'],
    cwd: ROOT,
    env: {
      ...process.env,
      KB_USER_DATA: USER,
      KB_THEME_DIRS: process.env.KB_THEME_DIRS || '',
    },
  });
  const win = await app.firstWindow();
  win.on('pageerror', (err) => note('pageerror', String(err)));
  await win.waitForFunction(() => window.__layoutRestored === true, null, { timeout: 90000 });
  await win.waitForTimeout(500);
  return { app, win };
}

async function bounds(app, size) {
  await app.evaluate(({ BrowserWindow }, s) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (!w) return;
    w.setBounds({ x: 60, y: 30, width: s.w, height: s.h });
    if (typeof w.showInactive === 'function') w.showInactive();
    else w.show();
  }, size);
  await new Promise((r) => setTimeout(r, 350));
}

async function shot(win, name) {
  const file = path.join(OUT, name);
  await win.screenshot({ path: file });
  note('shot', name);
}

async function domClick(win, selector) {
  const ok = await win.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.click();
    return true;
  }, selector);
  if (!ok) note('missing', selector);
  await win.waitForTimeout(250);
  return ok;
}

async function setSelect(win, testid, value) {
  return win.evaluate(({ testid, value }) => {
    const el = document.querySelector(`[data-testid="${testid}"]`);
    if (!el) return false;
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, { testid, value });
}

async function readState(win) {
  return win.evaluate(() => {
    const title = document.querySelector('.kb-topbar .title');
    const brand = document.querySelector('[data-testid="brand-mark"]');
    const side = document.querySelector('[data-testid="sidebar"]');
    const rect = side ? side.getBoundingClientRect() : null;
    const cards = [...document.querySelectorAll('[data-testid^="drawer-card-"]')].map((el) => ({
      id: el.getAttribute('data-module'),
      name: el.querySelector('.kb-drawer-card-name')?.textContent ?? '',
      pressed: el.getAttribute('aria-pressed'),
    }));
    const bubbles = [...document.querySelectorAll('[data-testid="pm-bubble"]')].map((el) => el.getAttribute('data-panel-id'));
    const more = document.querySelector('[data-testid="top-more-menu"]');
    const moreItems = more ? [...more.querySelectorAll('[role="menuitem"], .kb-menu-item')].map((el) => el.textContent?.trim() ?? '') : [];
    const chrome = document.querySelector('[data-testid="appearance-chrome"]');
    const options = chrome ? [...chrome.options].map((o) => o.value) : [];
    return {
      title: title?.textContent ?? '',
      titleAttr: title?.getAttribute('title') || title?.getAttribute('aria-label') || '',
      brand: !!brand,
      brandW: brand ? brand.getBoundingClientRect().width : 0,
      narrow: document.querySelector('.kb-topbar')?.getAttribute('data-narrow'),
      sidebarW: rect ? Math.round(rect.width) : null,
      cards,
      bubbles,
      moreOpen: !!more,
      moreItems,
      chromeOptions: options,
      settings: !!document.querySelector('[data-testid="settings-pane"]'),
      settingsCat: document.querySelector('[data-testid="settings-pane"]')?.getAttribute('data-category'),
      aboutBrand: !!document.querySelector('[data-testid="settings-about"] [data-testid="brand-mark"]'),
      dock: !!document.querySelector('[data-testid="dock"]'),
      overview: document.querySelector('[data-testid="ws-overview-mount"]')?.hasAttribute('hidden') === false,
      snapshot: window.__kbLastSnapshot ?? null,
      activePanel: document.querySelector('.dv-tab.dv-active, .dv-tab.active')?.textContent ?? '',
    };
  });
}

const themes = [
  ['origin', 'origin', 'light', '10-theme-origin-light'],
  ['origin', 'origin', 'dark', '11-theme-origin-dark'],
  ['study', 'study', 'light', '12-theme-study-light'],
  ['study', 'study', 'dark', '13-theme-study-dark'],
  ['pro', 'pro', 'light', '14-theme-pro-light'],
  ['pro', 'pro', 'dark', '15-theme-pro-dark'],
  ['bright', 'bright', 'light', '16-theme-bright-light'],
  ['bright', 'bright', 'dark', '17-theme-bright-dark'],
  ['touchline', 'touchline', 'light', '18-theme-touchline-light'],
  ['touchline', 'touchline', 'dark', '19-theme-touchline-dark'],
  ['origin', 'study', 'light', '20-mix-origin-study'],
  ['study', 'origin', 'dark', '21-mix-study-origin'],
  ['pro', 'study', 'light', '22-mix-pro-study'],
  ['touchline', 'bright', 'dark', '23-mix-touchline-bright'],
];

async function applyTheme(win, chrome, reading, scheme) {
  await domClick(win, '[data-testid="top-more"]');
  await domClick(win, '[data-testid="appearance-button"]');
  await setSelect(win, 'appearance-chrome', chrome);
  await setSelect(win, 'appearance-reading', reading);
  await setSelect(win, 'appearance-scheme', scheme);
  await win.waitForTimeout(300);
  await domClick(win, '[data-testid="top-more"]');
}

let app;
let win;
try {
  ({ app, win } = await launch());
  await bounds(app, { w: 1280, h: 800 });
  let state = await readState(win);
  note('boot', JSON.stringify({ title: state.title, brand: state.brand, cards: state.cards, sidebarW: state.sidebarW }));
  await shot(win, '01-topbar-wide.png');

  if (state.overview) {
    await win.evaluate(() => {
      const input = document.querySelector('[data-field="create-name"]');
      if (!input) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '补证工作区');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await domClick(win, '[data-action="create"]');
    await win.waitForTimeout(800);
    state = await readState(win);
    note('after-create', JSON.stringify({ overview: state.overview, title: state.title }));
  }

  for (const id of ['root', 'bench', 'fav']) await domClick(win, `[data-testid="drawer-card-${id}"]`);
  await win.waitForTimeout(200);
  state = await readState(win);
  note('selected', JSON.stringify(state.cards));
  await shot(win, '02-drawer-selected.png');

  await domClick(win, '[data-testid="drawer-card-bench"]');
  await domClick(win, '[data-testid="drawer-card-fav"]');
  await domClick(win, '[data-testid="drawer-card-root"]');
  state = await readState(win);
  note('cleared', JSON.stringify(state.cards));
  await shot(win, '03-drawer-cleared.png');

  await domClick(win, '[data-testid="drawer-card-web"]');
  await domClick(win, '[data-testid="drawer-toggle"]');
  await win.waitForTimeout(300);
  state = await readState(win);
  note('collapsed', JSON.stringify({ sidebarW: state.sidebarW, bubbles: state.bubbles, cards: state.cards }));
  await shot(win, '04-drawer-closed.png');
  await domClick(win, '[data-testid="drawer-toggle"]');

  await app.close();
  ({ app, win } = await launch());
  await bounds(app, { w: 1280, h: 800 });
  state = await readState(win);
  note('restored', JSON.stringify(state.cards));
  await shot(win, '05-drawer-restored.png');

  const panelBefore = await win.evaluate(() => document.querySelector('[data-testid="dock"]')?.innerText?.slice(0, 80) ?? '');
  await domClick(win, '[data-testid="settings-open"]');
  await domClick(win, '[data-testid="settings-cat-about"]');
  await win.waitForTimeout(300);
  state = await readState(win);
  note('settings', JSON.stringify({ cat: state.settingsCat, aboutBrand: state.aboutBrand, dock: state.dock }));
  await shot(win, '06-settings-about.png');
  await domClick(win, '[data-testid="settings-back"]');
  const panelAfter = await win.evaluate(() => document.querySelector('[data-testid="dock"]')?.innerText?.slice(0, 80) ?? '');
  note('panel-kept', JSON.stringify({ before: panelBefore, after: panelAfter, same: panelBefore === panelAfter }));
  await shot(win, '07-back-to-work.png');

  await bounds(app, { w: 860, h: 700 });
  await domClick(win, '[data-testid="top-more"]');
  state = await readState(win);
  note('narrow', JSON.stringify({ title: state.title, titleAttr: state.titleAttr, narrow: state.narrow, more: state.moreItems }));
  await shot(win, '08-narrow-more.png');
  await domClick(win, '[data-testid="top-more"]');
  await bounds(app, { w: 1280, h: 800 });

  state = await readState(win);
  if (!state.chromeOptions.length) {
    await domClick(win, '[data-testid="top-more"]');
    await domClick(win, '[data-testid="appearance-button"]');
    state = await readState(win);
    await domClick(win, '[data-testid="top-more"]');
  }
  note('chrome-options', state.chromeOptions.join(','));
  for (const [chrome, reading, scheme, file] of themes) {
    if (state.chromeOptions.length && !state.chromeOptions.includes(chrome)) {
      note('skip-theme', chrome);
      continue;
    }
    await applyTheme(win, chrome, reading, scheme);
    await shot(win, `${file}.png`);
  }
  for (const id of ['a', 'b', 'c']) {
    if (!state.chromeOptions.includes(id)) {
      note('contractor-absent', id);
      continue;
    }
    await applyTheme(win, id, id, 'light');
    await shot(win, `24-contractor-${id}-light.png`);
  }

  await applyTheme(win, 'origin', 'origin', 'light');
  await domClick(win, '[data-testid="ws-overview-toggle"]');
  await win.waitForTimeout(1200);
  state = await readState(win);
  note('snapshot', JSON.stringify(state.snapshot));
  await shot(win, '09-overview.png');
  const snapDir = path.join(USER, 'workspace-snapshots');
  const files = fs.existsSync(snapDir) ? fs.readdirSync(snapDir) : [];
  note('snapshot-files', files.join(','));
  await domClick(win, '[data-action="enter"]');
  await win.waitForTimeout(500);
  await shot(win, '09b-entered-workspace.png');

  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w?.close();
  });
  await win.waitForTimeout(1500);
  await app.close().catch(() => undefined);
  ({ app, win } = await launch());
  await bounds(app, { w: 1280, h: 800 });
  state = await readState(win);
  note('after-close', JSON.stringify({ cards: state.cards, title: state.title }));
  await shot(win, '25-after-close.png');
  await app.close();
} catch (err) {
  note('fatal', String(err?.stack || err));
  if (app) await app.close().catch(() => undefined);
  fs.writeFileSync(path.join(OUT, 'notes.json'), JSON.stringify(notes, null, 2));
  process.exit(1);
}
fs.writeFileSync(path.join(OUT, 'notes.json'), JSON.stringify(notes, null, 2));
console.log('proof done', notes.length);
