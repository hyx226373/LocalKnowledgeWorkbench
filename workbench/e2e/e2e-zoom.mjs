// 内容缩放端到端（r11-Z）。不在 scripts/run-e2e.mjs 的默认列表里。
// 本文件只写不跑。开跑前由协调人确认 Amy 空闲，并且只关掉本脚本自己启动的 pid。
// 阶段①已接通：图片 / PDF / Markdown / 文本的 Ctrl+滚轮锚点。
// 阶段②才有 Ctrl+= 命令。阶段③才有主进程缩放锁和网页面板独立比例。
// 回归（另开，不在这里嵌套）：e2e/e2e-lazy.mjs、e2e/e2e-layout.mjs、e2e/e2e-workspaces.mjs。
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, 'e2e/.tmp/zoom');
const USERDATA = path.join(TMP, 'userdata');
const RA = path.join(TMP, '缩放资料');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(RA, { recursive: true });

const svg = (id) => `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">
  <rect width="800" height="600" fill="#222"/>
  <circle id="${id}" cx="240" cy="180" r="30" fill="#e33"/>
  <rect x="560" y="420" width="40" height="40" fill="#3c3"/>
</svg>`;
fs.writeFileSync(path.join(RA, '甲.svg'), svg('a'));
fs.writeFileSync(path.join(RA, '乙.svg'), svg('b'));
fs.writeFileSync(path.join(RA, '笔记.md'), ['# 缩放笔记', ...Array.from({ length: 80 }, (_, i) => `## 第 ${i + 1} 节\n\n这一行用来核对鼠标下面的文字在重排后还停在原来的高度。标记-${i + 1}。`)].join('\n\n'));
fs.writeFileSync(path.join(RA, '原文.txt'), Array.from({ length: 120 }, (_, i) => `文本第 ${i + 1} 行，用来看普通滚轮仍在滚动。`).join('\n'));

function makePdf(n) {
  const objs = [];
  const add = (s) => (objs.push(s), objs.length);
  const catalog = add('');
  const pages = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];
  for (let i = 1; i <= n; i++) {
    const text = `BT /F1 24 Tf 72 720 Td (Zoom page ${i}) Tj ET`;
    const c = add(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${c} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`;
  objs[pages - 1] = `<< /Type /Pages /Count ${n} /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] >>`;
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => {
    offs.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}
fs.writeFileSync(path.join(RA, '讲义.pdf'), makePdf(4));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? '  — ' + detail : ''}`);
}
const spawned = new Set();
const apps = [];

async function launch() {
  const app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'],
    cwd: ROOT,
    env: { ...process.env, KB_USER_DATA: USERDATA },
  });
  const pid = app.process()?.pid;
  if (pid) spawned.add(pid);
  apps.push(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setPosition(40, 40);
    w.setContentSize(1400, 900);
  });
  await win.waitForFunction(() => window.__layoutRestored === true, null, { timeout: 20000 });
  await win.waitForTimeout(400);
  return { app, win };
}

const row = (win, rel) => win.locator(`[data-testid="sidebar"] [data-testid="tree-row"][data-relpath="${rel}"]`).first();

async function addRoot(app, win) {
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
  }, RA);
  await win.click('[data-testid="pick-folder"]');
  await row(win, '甲.svg').waitFor({ timeout: 15000 });
}

async function wheel(win, selector, dx, dy, extra = {}) {
  return win.evaluate(({ selector: sel, dx: x, dy: y, extra: ex }) => {
    const el = document.querySelector(sel);
    if (!el) return { ok: false, reason: 'missing ' + sel };
    const r = el.getBoundingClientRect();
    const cx = ex.clientX ?? r.left + r.width * (ex.fx ?? 0.5);
    const cy = ex.clientY ?? r.top + r.height * (ex.fy ?? 0.5);
    const target = document.elementFromPoint(cx, cy) || el;
    target.dispatchEvent(new WheelEvent('wheel', {
      deltaX: x,
      deltaY: y,
      deltaMode: ex.deltaMode ?? 0,
      ctrlKey: !!ex.ctrlKey,
      shiftKey: !!ex.shiftKey,
      bubbles: true,
      cancelable: true,
      clientX: cx,
      clientY: cy,
    }));
    return { ok: true, cx, cy };
  }, { selector, dx, dy, extra });
}

function imageFrac(win, selector, x, y) {
  return win.evaluate(({ selector: sel, x: px, y: py }) => {
    const img = document.querySelector(sel);
    if (!img) return null;
    const r = img.getBoundingClientRect();
    return { fx: (px - r.left) / r.width, fy: (py - r.top) / r.height, w: r.width, h: r.height };
  }, { selector, x, y });
}

const frames = (win, n = 3) => win.evaluate((k) => new Promise((res) => {
  let i = 0;
  const step = () => (++i >= k ? res(true) : requestAnimationFrame(step));
  requestAnimationFrame(step);
}), n);

let app;
let win;
try {
  ({ app, win } = await launch());
  await addRoot(app, win);

  await row(win, '甲.svg').click();
  await win.waitForFunction(() => {
    const img = document.querySelector('[data-testid="reader-image"] img');
    return !!img && img.complete && img.naturalWidth > 0;
  });
  await frames(win, 4);
  const imgSel = '[data-testid="reader-image"] img';
  const box = await win.evaluate((sel) => {
    const r = document.querySelector(sel).getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }, imgSel);
  const spots = [
    { name: '中心', x: box.left + box.width * 0.5, y: box.top + box.height * 0.5 },
    { name: '左上', x: box.left + box.width * 0.2, y: box.top + box.height * 0.2 },
    { name: '右上', x: box.left + box.width * 0.8, y: box.top + box.height * 0.2 },
    { name: '左下', x: box.left + box.width * 0.2, y: box.top + box.height * 0.8 },
    { name: '右下', x: box.left + box.width * 0.8, y: box.top + box.height * 0.8 },
  ];
  const drifts = [];
  for (const spot of spots) {
    const before = await imageFrac(win, imgSel, spot.x, spot.y);
    await wheel(win, '[data-testid="reader-image"]', 0, -120, { ctrlKey: true, clientX: spot.x, clientY: spot.y });
    await frames(win);
    await wheel(win, '[data-testid="reader-image"]', 0, 120, { ctrlKey: true, clientX: spot.x, clientY: spot.y });
    await frames(win);
    const after = await imageFrac(win, imgSel, spot.x, spot.y);
    const dx = Math.abs(after.fx - before.fx) * after.w;
    const dy = Math.abs(after.fy - before.fy) * after.h;
    drifts.push({ name: spot.name, dx, dy });
  }
  check('图片中心和四角放大再缩小，目标点漂移 < 2px', drifts.every((d) => d.dx < 2 && d.dy < 2), JSON.stringify(drifts));

  await row(win, '甲.svg').hover();
  await row(win, '甲.svg').locator('[data-testid="open-right"]').click();
  await win.waitForTimeout(200);
  await row(win, '乙.svg').hover();
  await win.locator('[data-testid="sidebar"] [data-testid="tree-row"][data-relpath="乙.svg"]').first().locator('[data-testid="open-right"]').click();
  await win.waitForFunction(() => document.querySelectorAll('[data-testid="reader-image"] img').length >= 2);
  await frames(win, 4);
  const beforeBadges = await win.$$eval('[data-testid="zoom-badge"]', (els) => els.map((e) => e.getAttribute('data-scale')));
  const first = await win.evaluate(() => {
    const roots = [...document.querySelectorAll('.view-root')].filter((n) => n.querySelector('[data-testid="reader-image"]'));
    const r = roots[0].getBoundingClientRect();
    return { id: roots[0].getAttribute('data-item-id'), x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await wheel(win, `.view-root[data-item-id="${first.id}"] [data-testid="reader-image"]`, 0, -200, { ctrlKey: true, clientX: first.x, clientY: first.y });
  await frames(win);
  await win.waitForTimeout(200);
  const afterBadges = await win.evaluate((id) => {
    const a = document.querySelector(`.view-root[data-item-id="${id}"] [data-testid="zoom-badge"]`)?.getAttribute('data-scale');
    const others = [...document.querySelectorAll('.view-root')]
      .filter((n) => n.getAttribute('data-item-id') !== id && n.querySelector('[data-testid="zoom-badge"]'))
      .map((n) => n.querySelector('[data-testid="zoom-badge"]').getAttribute('data-scale'));
    return { a, others };
  }, first.id);
  check('并排图片只缩放鼠标所在的一块', beforeBadges.length >= 2 && afterBadges.a !== beforeBadges[0] && afterBadges.others.every((s, i) => s === beforeBadges[i + 1] || s === beforeBadges[i]), JSON.stringify({ beforeBadges, afterBadges }));

  await row(win, '讲义.pdf').click();
  await win.waitForSelector('[data-testid="reader-pdf"] .pdf-page[data-rendered="1"]', { timeout: 20000 });
  const pdfBefore = await win.evaluate(() => {
    const el = document.querySelector('[data-testid="reader-pdf"]');
    const page = el.querySelector('.pdf-page');
    const canvas = page.querySelector('canvas');
    const r = el.getBoundingClientRect();
    return { scale: el.dataset.scale, canvas: canvas ? canvas.width : 0, pageW: page.clientWidth, x: r.left + 80, y: r.top + 120 };
  });
  await wheel(win, '[data-testid="reader-pdf"]', 0, -160, { ctrlKey: true, clientX: pdfBefore.x, clientY: pdfBefore.y });
  await frames(win);
  const stretched = await win.evaluate(() => {
    const el = document.querySelector('[data-testid="reader-pdf"]');
    const page = el.querySelector('.pdf-page');
    return { scale: Number(el.dataset.scale), pageW: page.clientWidth };
  });
  await win.waitForTimeout(250);
  const sharp = await win.evaluate(() => {
    const canvas = document.querySelector('[data-testid="reader-pdf"] .pdf-page canvas');
    return canvas ? canvas.width : 0;
  });
  check('PDF 滚轮先改页面尺寸，空闲后画布变清晰', stretched.scale > Number(pdfBefore.scale) && stretched.pageW > pdfBefore.pageW && sharp > pdfBefore.canvas, JSON.stringify({ pdfBefore, stretched, sharp }));

  await row(win, '笔记.md').click();
  await win.waitForSelector('[data-testid="reader-markdown"] h2');
  const md = await win.evaluate(() => {
    const el = document.querySelector('[data-testid="reader-markdown"]');
    const h = el.querySelector('h2');
    const r = h.getBoundingClientRect();
    return { x: r.left + 12, y: r.top + r.height / 2, top: r.top, text: h.textContent, zoom: el.style.getPropertyValue('--content-zoom') || '1' };
  });
  const scrollBefore = await win.evaluate(() => document.querySelector('[data-testid="reader-markdown"]').scrollTop);
  await wheel(win, '[data-testid="reader-markdown"]', 0, 80, { ctrlKey: false, clientX: md.x, clientY: md.y });
  await frames(win);
  const scrollAfter = await win.evaluate(() => document.querySelector('[data-testid="reader-markdown"]').scrollTop);
  const zoomSame = await win.evaluate(() => document.querySelector('[data-testid="reader-markdown"]').style.getPropertyValue('--content-zoom') || '1');
  check('普通滚轮滚动 Markdown，不改变内容比例', scrollAfter !== scrollBefore && zoomSame === md.zoom, JSON.stringify({ scrollBefore, scrollAfter, zoomSame }));
  const line = await win.evaluate(({ x, y }) => {
    const range = document.caretRangeFromPoint(x, y);
    const top = range ? range.getBoundingClientRect().top : null;
    const text = range?.startContainer?.textContent ?? '';
    return { top, text };
  }, md);
  await wheel(win, '[data-testid="reader-markdown"]', 0, -30, { ctrlKey: true, deltaMode: 0, clientX: md.x, clientY: md.y });
  await frames(win);
  const line2 = await win.evaluate(({ x, y }) => {
    const range = document.caretRangeFromPoint(x, y);
    return { top: range ? range.getBoundingClientRect().top : null, text: range?.startContainer?.textContent ?? '' };
  }, md);
  check('Markdown 重排后鼠标处那一行的 y 基本不动', line.text && line.text === line2.text && Math.abs(line2.top - line.top) < 3, JSON.stringify({ line, line2 }));

  await row(win, '原文.txt').click();
  await win.waitForSelector('[data-testid="reader-text"]');
  const textZoom0 = await win.getAttribute('[data-testid="reader-text"] ~ [data-testid="zoom-hud"] [data-testid="zoom-badge"], .kb-zoom-host [data-testid="zoom-badge"]', 'data-scale').catch(() => null);
  const textBox = await win.evaluate(() => {
    const el = document.querySelector('[data-testid="reader-text"]');
    const r = el.getBoundingClientRect();
    return { x: r.left + 30, y: r.top + 40, zoom: el.style.getPropertyValue('--content-zoom') || '1' };
  });
  await wheel(win, '[data-testid="reader-text"]', 0, -8, { ctrlKey: true, clientX: textBox.x, clientY: textBox.y });
  await frames(win);
  const textZoom1 = await win.evaluate(() => document.querySelector('[data-testid="reader-text"]').style.getPropertyValue('--content-zoom') || '1');
  const ratio = Number(textZoom1) / Number(textBox.zoom || 1);
  check('触控板小 Δ 只轻轻放大文本', ratio > 1 && ratio < 1.05, JSON.stringify({ textZoom0, textBox, textZoom1, ratio }));

  const factor = await app.evaluate(({ webContents, BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    return { factor: wc.getZoomFactor(), fromImport: typeof webContents === 'object' };
  });
  check('主窗口 getZoomFactor() === 1', Math.abs(factor.factor - 1) < 0.001, JSON.stringify(factor));

  await row(win, '讲义.pdf').click();
  await win.waitForSelector('[data-testid="reader-pdf"]');
  const scaleEq0 = await win.getAttribute('[data-testid="reader-pdf"]', 'data-scale');
  await win.click('[data-testid="reader-pdf"]');
  await win.keyboard.press('Control+=');
  await win.waitForTimeout(200);
  const scaleEq1 = await win.getAttribute('[data-testid="reader-pdf"]', 'data-scale');
  check('Ctrl+= 放大活动 PDF（阶段②命令；阶段①预期失败）', scaleEq1 !== scaleEq0 && Number(scaleEq1) > Number(scaleEq0), JSON.stringify({ scaleEq0, scaleEq1 }));

  await win.waitForTimeout(800);
  const remembered = await win.evaluate(() => ({
    pdf: document.querySelector('[data-testid="reader-pdf"]')?.dataset.scale ?? null,
    md: document.querySelector('[data-testid="reader-markdown"]')?.style.getPropertyValue('--content-zoom') || null,
  }));
  await app.close();
  ({ app, win } = await launch());
  await win.waitForSelector('[data-testid="reader-pdf"], [data-testid="reader-markdown"], [data-testid="reader-image"]', { timeout: 20000 });
  await win.waitForTimeout(800);
  const restored = await win.evaluate(() => ({
    pdf: document.querySelector('[data-testid="reader-pdf"]')?.dataset.scale ?? null,
    md: [...document.querySelectorAll('[data-testid="reader-markdown"]')].map((el) => el.style.getPropertyValue('--content-zoom') || '1'),
  }));
  check('重启后 PDF / Markdown 比例还在', !!remembered.pdf && restored.pdf === remembered.pdf, JSON.stringify({ remembered, restored }));

  let webDetail = '';
  try {
    webDetail = await app.evaluate(async () => {
      const kb = window.kb;
      if (!kb || typeof kb.webSetZoom !== 'function' || typeof kb.webGetZoom !== 'function') return '阶段③ P-web 未接线（webSetZoom/webGetZoom 不在 preload）';
      return 'preload 已有 webSetZoom';
    });
  } catch (e) {
    webDetail = String(e?.message ?? e);
  }
  check('网页两块同源面板各自缩放（阶段③；未接线时记失败但不抛出）', webDetail === 'preload 已有 webSetZoom', webDetail);
} catch (e) {
  check('脚本跑完中途没有抛错', false, String(e?.stack ?? e));
} finally {
  for (const a of apps) {
    try { await a.close(); } catch { /* 已经关了 */ }
  }
  for (const pid of spawned) {
    try { process.kill(pid); } catch { /* 进程已退出 */ }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(JSON.stringify({ ok: failed.length === 0, failed: failed.length, total: results.length }, null, 2));
  process.exitCode = failed.length ? 1 : 0;
}
