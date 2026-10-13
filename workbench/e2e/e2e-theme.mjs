// 端到端：主题接口 v2（第 9 轮 A）
// - 「B 外框 + A 阅读区」组合（pro 外框 + study 阅读区）：两轴令牌各自来自所选主题，截图（浅色/深色）
// - 阅读专注模式（F9）：阅读区用 read-focus-* 令牌、外框淡出、分栏尺寸不变、重启后保持
// - PDF 深色滤镜：默认原色；每个 PDF 面板单独开关，存进面板阅读状态，重启恢复；主题只提供参数
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE = process.env.KB_SAMPLE || '/workspace/kb-sample';
const VERIFY = path.join(ROOT, 'verify');
const TMP = path.join(ROOT, 'e2e/.tmp/theme');
const USERDATA = path.join(TMP, 'userdata');
const R = path.join(TMP, '样例根');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
fs.cpSync(SAMPLE, R, { recursive: true });
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const pro = readJson(path.join(ROOT, 'themes/pro/theme.json'));
const study = readJson(path.join(ROOT, 'themes/study/theme.json'));

const results = [];
const check = (name, ok, detail = '') => (results.push({ name, ok: !!ok, detail }), console.log(`${ok ? '✔' : '✘'} ${name}${detail ? '  — ' + detail : ''}`));

async function launch() {
  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'], cwd: ROOT, env: { ...process.env, KB_USER_DATA: USERDATA } });
  const win = await app.firstWindow();
  win.on('console', (m) => m.type() === 'error' && console.log('[renderer]', m.text()));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800));
  await win.waitForFunction(() => window.__layoutRestored === true, null, { timeout: 30000 });
  return { app, win };
}
const cssVar = (win, n) => win.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(`--kb-${n}`).trim(), n);
const norm = (v) => String(v).replace(/\s+/g, '').replace(/\b0\./g, '.').toLowerCase();

let { app, win } = await launch();
const root = await win.evaluate((p) => window.kb.addRoot(p), R);
await win.waitForFunction(async () => (await window.kb.getIndexStatus()).every((s) => s.state === 'idle' && s.fileCount > 0), null, { timeout: 30000, polling: 200 });
await win.evaluate(([r]) => window.__kb.openByPath(r, '笔记/2026/读书笔记.md', 'tab'), [root.id]);
await win.evaluate(([r]) => window.__kb.openByPath(r, '资料/论文/讲义.pdf', 'right'), [root.id]);
await win.waitForSelector('[data-testid="reader-pdf"] .pdf-page[data-rendered="1"]', { timeout: 30000 });

// ---- 组合：B（pro）外框 + A（study）阅读区
for (const scheme of ['light', 'dark']) {
  await win.evaluate((a) => window.__kb.setAppearance(a), { chrome: 'pro', reading: 'study', scheme });
  await win.waitForTimeout(400);
  const ct = pro.contributes.chromeThemes[0][scheme].tokens;
  const rt = study.contributes.readingThemes[0][scheme].tokens;
  const got = {
    attrs: await win.evaluate(() => [document.documentElement.dataset.kbChrome, document.documentElement.dataset.kbReading, document.documentElement.dataset.kbScheme].join()),
    topbar: await cssVar(win, 'size-topbar'),
    colorBg: await cssVar(win, 'color-bg'),
    readBg: await cssVar(win, 'read-bg'),
    readFont: await cssVar(win, 'read-font'),
    topbarH: await win.evaluate(() => Math.round(document.querySelector('.kb-topbar').getBoundingClientRect().height)),
    pFont: await win.evaluate(() => getComputedStyle(document.querySelector('[data-testid="reader-markdown"] p')).fontSize),
    mdBg: await win.evaluate(() => getComputedStyle(document.querySelector('[data-testid="reader-markdown"]')).backgroundColor),
  };
  const ok =
    got.attrs === `pro,study,${scheme}` &&
    norm(got.topbar) === norm(ct['size-topbar']) &&
    got.topbarH === parseInt(ct['size-topbar']) &&
    norm(got.colorBg) === norm(ct['color-bg']) &&
    norm(got.readBg) === norm(rt['read-bg']) &&
    norm(got.readFont) === norm(rt['read-font']) &&
    got.pFont === rt['read-fs'];
  const shot = path.join(VERIFY, `theme-combo-B-chrome-pro+A-reader-study-${scheme}.png`);
  await win.screenshot({ path: shot });
  check(`「B 外框 + A 阅读区」组合（${scheme === 'light' ? '浅色' : '深色'}）：外框令牌来自 pro、阅读区令牌来自 study，互不覆盖`, ok, JSON.stringify(got) + ' → ' + path.relative(ROOT, shot));
}

// ---- 阅读专注模式
const dockSizes = () => win.evaluate(() => window.__dock.groups.map((g) => [Math.round(g.api.width), Math.round(g.api.height)]).join('|'));
const before = await dockSizes();
await win.locator('[data-testid="reader-markdown"]').click({ position: { x: 50, y: 50 } });
await win.keyboard.press('F9');
await win.waitForTimeout(400);
const f = await win.evaluate(() => ({
  root: document.documentElement.dataset.kbFocus,
  md: document.querySelector('[data-testid="reader-markdown"]').dataset.focus,
  pFont: getComputedStyle(document.querySelector('[data-testid="reader-markdown"] p')).fontSize,
  mdBg: getComputedStyle(document.querySelector('[data-testid="reader-markdown"]')).backgroundColor,
  sidebarOpacity: getComputedStyle(document.querySelector('.kb-sidebar')).opacity,
  focusFs: getComputedStyle(document.documentElement).getPropertyValue('--kb-read-focus-fs').trim(),
  chromeOp: getComputedStyle(document.documentElement).getPropertyValue('--kb-read-focus-chrome-opacity').trim(),
}));
await win.mouse.move(700, 400);
await win.screenshot({ path: path.join(VERIFY, 'theme-focus-mode.png') });
const after = await dockSizes();
check('阅读专注模式（F9）：阅读区使用 read-focus-* 令牌、外框淡出、分栏尺寸不变', f.root === 'on' && f.md === 'on' && f.pFont === f.focusFs && Number(f.sidebarOpacity) === Number(f.chromeOp) && before === after, JSON.stringify({ ...f, before, after }));

// ---- PDF 深色滤镜：默认原色；开启只影响这个面板
const pdfFilter = () => win.evaluate(() => [...document.querySelectorAll('[data-testid="reader-pdf"]')].map((el) => getComputedStyle(el.querySelector('.kb-pdf-page')).filter));
const f0 = await pdfFilter();
check('PDF 默认原色显示（未开启深色滤镜时没有任何滤镜，即使阅读区主题设置了 read-pdf-dark-filter）', f0.length === 1 && f0[0] === 'none', JSON.stringify(f0));
// 第二个 PDF 面板（另一个文件）
await win.evaluate(([r]) => window.__kb.openByPath(r, '资料/论文/paper.pdf', 'below'), [root.id]);
await win.waitForFunction(() => document.querySelectorAll('[data-testid="reader-pdf"] .pdf-page[data-rendered="1"]').length >= 2, null, { timeout: 30000 }).catch(() => {});
await win.waitForFunction(() => document.querySelectorAll('[data-testid="reader-pdf"]').length === 2, null, { timeout: 30000 });
const btn = await win.$('[data-testid="reader-pdf"] [data-testid="pdf-dark-filter"]');
await btn.click();
await win.waitForTimeout(300);
const f1 = await pdfFilter();
const pressed = await btn.getAttribute('aria-pressed');
const param = await cssVar(win, 'read-pdf-dark-filter');
await win.evaluate(() => window.__kb.flush());
const items = await win.evaluate(() => Object.values(window.__kb.items()).filter((i) => i.adapterId === 'builtin.pdf').map((i) => ({ ref: i.ref, dark: !!i.state?.data?.dark })));
check('PDF 深色滤镜按面板开关：只有点了按钮的面板应用主题提供的滤镜参数，另一个保持原色；开关存进该面板的阅读状态', pressed === 'true' && f1.filter((x) => x !== 'none').length === 1 && norm(f1.find((x) => x !== 'none')) === norm(param) && items.filter((i) => i.dark).length === 1, JSON.stringify({ f1, param, items }));
await win.screenshot({ path: path.join(VERIFY, 'theme-pdf-dark-filter.png') });

// ---- 重启：专注模式与 PDF 滤镜保持
await win.evaluate(() => window.__kb.flush());
await app.close();
({ app, win } = await launch());
await win.waitForFunction(() => document.querySelectorAll('[data-testid="reader-pdf"]').length >= 1, null, { timeout: 30000 });
// 后台标签可能延后加载：把所有 PDF 面板切到前台
await win.evaluate(() => window.__dock.panels.forEach((p) => p.api.setActive()));
await win.waitForFunction(() => document.querySelectorAll('[data-testid="reader-pdf"] .pdf-page[data-rendered="1"]').length >= 2, null, { timeout: 30000 }).catch(() => {});
const f2 = await pdfFilter();
const focus2 = await win.evaluate(() => document.documentElement.dataset.kbFocus);
check('重启后：专注模式保持开启，开了深色滤镜的那个 PDF 面板仍开启、另一个仍为原色', focus2 === 'on' && f2.length === 2 && f2.filter((x) => x !== 'none').length === 1, JSON.stringify({ focus2, f2 }));
await win.keyboard.press('F9');
await win.waitForTimeout(200);
check('再次 F9 关闭专注模式', (await win.evaluate(() => document.documentElement.dataset.kbFocus)) === 'off');
await app.close();

const pass = results.filter((r) => r.ok).length;
console.log(`E2E（主题 v2）: ${pass}/${results.length} 通过`);
fs.writeFileSync(path.join(VERIFY, 'e2e-theme.json'), JSON.stringify(results, null, 2));
process.exit(pass === results.length ? 0 : 1);
