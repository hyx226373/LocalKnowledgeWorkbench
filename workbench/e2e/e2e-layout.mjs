// 端到端：自由窗口 + 吸附分屏（第九轮 · 布局组，docs/11-自由窗口布局.md）
//   一个工作区：PDF、Markdown、CSV 三份文档 + 侧栏 + 网页面板（SDK web-adapter 模板，本地夹具站点）。
//   演示并核对：分屏保留 → 浮动并用鼠标拖动/缩放 → 互相覆盖与层级 → 网页面板与浮动窗口叠放（截图替身）→
//   收起成气泡再恢复 → 最大化/还原 → 重启后完整恢复（位置、尺寸、层级、收起、阅读位置）→ 窗口缩到 1024×700 后全部找回 →
//   在大窗口保存、以小窗口启动也全部找回。每一步 X 屏幕截图（含原生网页视图）写到 /workspace/layout-review/。
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { grabWindow, hasX } from './lib/xshot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SDK = process.env.KB_ADAPTER_SDK_DIR || path.resolve(ROOT, '../kb-adapter-sdk');
const OUT = process.env.KB_LAYOUT_REVIEW_DIR || '/workspace/layout-review';
const TMP = path.join(ROOT, 'e2e/.tmp');
const USERDATA = path.join(TMP, 'userdata-layout');
const RA = path.join(TMP, 'layout 资料');
const PLUG = path.join(TMP, 'plugins-layout');
for (const d of [USERDATA, RA, PLUG]) fs.rmSync(d, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const put = (p, c) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, c));
put(path.join(RA, '论文.pdf'), makePdf(30));
put(path.join(RA, '笔记.md'), '# 阅读笔记\n\n' + Array.from({ length: 120 }, (_, i) => `## 第 ${i + 1} 节\n\n这是第 ${i + 1} 节的笔记内容，用来测试自由窗口里的阅读位置恢复。`).join('\n\n') + '\n');
put(path.join(RA, '数据.csv'), 'id,名称,数值\n' + Array.from({ length: 400 }, (_, i) => `${i + 1},项目${i + 1},${(i * 37) % 101}`).join('\n') + '\n');
const P_WEB = path.join(PLUG, 'mdn');
execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-adapter-plugin.mjs'), path.join(SDK, 'templates/web-adapter'), '--out', P_WEB], { stdio: 'inherit' });
const PID = 'example.mdn-docs';
const AID = 'example.mdn-docs.web';
const PAGE = 'https://developer.mozilla.org/zh-CN/docs/Web/JavaScript';
const extraEnv = { KB_TEST_WEB_FIXTURE: path.join(ROOT, 'e2e/fixtures/web') };

function makePdf(n) {
  const objs = [];
  const add = (s) => (objs.push(s), objs.length);
  const catalog = add('');
  const pages = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];
  for (let i = 1; i <= n; i++) {
    const text = `BT /F1 36 Tf 72 700 Td (Page ${i} of ${n}) Tj ET BT /F1 12 Tf 72 660 Td (Free window layout test, page ${i}.) Tj ET`;
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

const results = [];
const notes = {};
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? '  — ' + detail : ''}`);
}
const consoleErrors = [];
async function launch(size = { width: 1400, height: 900 }) {
  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'], cwd: ROOT, env: { ...process.env, KB_USER_DATA: USERDATA, ...extraEnv } });
  const win = await app.firstWindow();
  win.on('console', (m) => {
    if (m.type() === 'error' && !/403|ERR_|Content Security Policy|Refused to/.test(m.text())) consoleErrors.push(m.text());
  });
  win.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  await win.waitForLoadState('domcontentloaded');
  if (size)
    await app.evaluate(({ BrowserWindow }, s) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.setPosition(0, 0);
      w.setContentSize(s.width, s.height);
    }, size);
  await win.waitForFunction(() => window.__layoutRestored === true, null, { timeout: 20000 });
  await win.waitForTimeout(600);
  return { app, win };
}
const stubOpen = (app, p) =>
  app.evaluate(({ dialog }, x) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [x] });
  }, p);
async function addRoot(app, win, dir) {
  const n = await win.locator('[data-testid="root-row"]').count();
  await stubOpen(app, dir);
  await win.click('[data-testid="pick-folder"]');
  await win.waitForFunction((k) => document.querySelectorAll('[data-testid="root-row"]').length === k + 1, n);
  return win.evaluate(async (p) => (await window.kb.listRoots()).find((r) => r.path === p).id, dir);
}
async function waitIndexed(win, rootId, rel) {
  for (let i = 0; i < 80; i++) {
    if (await win.evaluate(async ([r, p]) => (await window.kb.listDir(r, '')).some((x) => x.relPath === p), [rootId, rel])) return true;
    await win.waitForTimeout(250);
  }
  return false;
}
const frames = (win, n = 2) => win.evaluate((k) => new Promise((res) => { let i = 0; const f = () => (++i >= k ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
const views = (app) => app.evaluate(() => [...globalThis.__kbWeb.views.values()].map((e) => ({ viewId: e.viewId, wcId: e.wc.id, bounds: e.bounds, viewBounds: e.view.getBounds(), visible: e.view.getVisible() })));
const pageEval = (app, code) => app.evaluate(async (_e, c) => [...globalThis.__kbWeb.views.values()][0].wc.executeJavaScript(c, true), code);
const pm = (win, method, ...args) => win.evaluate(([m, a]) => window.__kb.pm[m](...a), [method, args]);
const list = (win) => win.evaluate(() => window.__kb.pm.list());
const info = async (win, id) => (await list(win)).find((w) => w.id === id);
const csize = (win) => win.evaluate(() => window.__kb.pm.containerSize());
const items = (win) => win.evaluate(() => window.__kb.items());
/** 截图前的界面自检：没有残留的空白标题栏/孤立图标/空面板组；每个可见浮动窗口都露出标题（标签）和内容 */
async function visualAudit(win) {
  return win.evaluate(() => {
    const bad = [];
    if (document.querySelector('.dv-floating-titlebar')) bad.push('存在单独的空白标题栏 .dv-floating-titlebar');
    for (const o of document.querySelectorAll('.dv-resize-container[data-pm-collapsed], .dv-render-overlay[data-pm-hidden]')) {
      const leak = [o, ...o.querySelectorAll('*')].find((e) => getComputedStyle(e).visibility === 'visible' && e.getBoundingClientRect().width > 0);
      if (leak) bad.push(`收起的窗口里有元素仍可见：${leak.className}`);
    }
    for (const g of document.querySelectorAll('.dv-groupview')) {
      const r = g.getBoundingClientRect();
      const hidden = g.closest('[data-pm-collapsed]') || getComputedStyle(g).visibility !== 'visible';
      if (!hidden && r.width > 0 && !g.querySelector('.dv-tab')) bad.push(`空面板组 ${Math.round(r.x)},${Math.round(r.y)}`);
    }
    // 窗口部分移出 / 收起的隐藏窗口不能把页面或 dock 区域撑出滚动条
    for (const e of document.querySelectorAll('*')) {
      const r = e.getBoundingClientRect();
      if ((r.width < innerWidth * 0.6 && !e.closest('[data-testid="sidebar"]')) || r.width === 0 || e.offsetHeight - e.clientHeight < 4) continue;
      const cs = getComputedStyle(e);
      if (cs.visibility === 'hidden' || !/auto|scroll/.test(cs.overflowX) || e.scrollWidth <= e.clientWidth + 1) continue;
      bad.push(`横向滚动条：${e.nodeName}.${e.className} ${e.scrollWidth} > ${e.clientWidth} at y=${Math.round(r.bottom)}`);
    }
    for (const e of [document.scrollingElement, ...document.querySelectorAll('body, #root, .app, .main, .center, .kb-dock, .dv-shell, .dv-floating-overlay-host, .dv-dockview')]) {
      if (!e) continue;
      const cs = getComputedStyle(e);
      const sx = e.scrollWidth > e.clientWidth && (e === document.scrollingElement || /auto|scroll/.test(cs.overflowX));
      const sy = e.scrollHeight > e.clientHeight && (e === document.scrollingElement || /auto|scroll/.test(cs.overflowY));
      if (sx || sy) bad.push(`出现滚动条：${e.className || e.nodeName} ${e.scrollWidth}x${e.scrollHeight} > ${e.clientWidth}x${e.clientHeight}`);
    }
    if (document.querySelector('[data-testid="sidebar"][data-floating="true"] .pm-sidebar-bar')) bad.push('浮动侧栏里重复的“侧栏”标题行');
    const wins = [...document.querySelectorAll('.dv-resize-container')].filter((o) => !o.hasAttribute('data-pm-collapsed') && getComputedStyle(o).visibility === 'visible');
    const dock = document.querySelector('.dv-floating-overlay-host')?.getBoundingClientRect();
    const isMax = (o) => dock && Math.abs(o.getBoundingClientRect().width - dock.width) < 2 && Math.abs(o.getBoundingClientRect().height - dock.height) < 2;
    const checkWins = wins.some(isMax) ? wins.filter(isMax) : wins;
    const own = (o, e) => {
      if (!e) return false;
      if (o.contains(e)) return true;
      const ro = e.closest('.dv-render-overlay'); // 常驻渲染（网页）面板的内容在窗口 DOM 之外，按矩形归属
      if (!ro) return false;
      const a = ro.getBoundingClientRect(), r = o.getBoundingClientRect();
      return a.left >= r.left - 1 && a.right <= r.right + 1 && a.top >= r.top - 1 && a.bottom <= r.bottom + 1;
    };
    for (const o of checkWins) {
      const label = o.getAttribute('aria-label');
      const tab = o.querySelector('.dv-tab.dv-active-tab') ?? o.querySelector('.dv-tab');
      const tr = tab?.getBoundingClientRect();
      const tabHit = tr && document.elementFromPoint(tr.left + tr.width / 2, tr.top + tr.height / 2); // 标签中心（标题文字）露在外面
      if (!tr || !tabHit || !o.contains(tabHit)) bad.push(`${label}：标题（标签）被遮住`);
      const c = o.querySelector('.dv-content-container')?.getBoundingClientRect() ?? o.getBoundingClientRect();
      let seen = false;
      for (let i = 1; i < 6 && !seen; i++) for (let j = 1; j < 6 && !seen; j++) {
        const x = c.left + (c.width * i) / 6, y = c.top + (c.height * j) / 6;
        if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
        if (own(o, document.elementFromPoint(x, y))) seen = true;
      }
      if (!seen) bad.push(`${label}：内容完全被遮住`);
    }
    return bad;
  });
}
async function shot(app, win, name) {
  await frames(win, 3);
  await win.waitForTimeout(150);
  const audit = await visualAudit(win);
  check(`截图自检 ${name}：无残留图标/空白标题栏/空面板组，浮动窗口都露出标题和内容`, audit.length === 0, audit.join(' | '));
  const file = path.join(OUT, name);
  if (hasX()) await grabWindow(app, file);
  else await win.screenshot({ path: file });
  return file;
}
const slotRect = (win) =>
  win.evaluate(() => {
    const el = document.querySelector('[data-testid="web-slot"]');
    const r = el?.getBoundingClientRect();
    return r ? { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.right) - Math.round(r.left), height: Math.round(r.bottom) - Math.round(r.top) } : null;
  });
async function webState(app, win) {
  await frames(win, 4);
  const [r, v, covered, snap] = [await slotRect(win), (await views(app))[0], await win.evaluate(() => document.querySelector('[data-testid="web-panel"]')?.dataset.covered), await win.locator('[data-testid="web-snapshot"]').count()];
  const dev = r && v?.visible ? Math.max(Math.abs(v.viewBounds.x - r.x), Math.abs(v.viewBounds.y - r.y), Math.abs(v.viewBounds.width - r.width), Math.abs(v.viewBounds.height - r.height)) : Infinity;
  return { covered: covered === 'true', snapshot: snap > 0, nativeVisible: !!v?.visible, dev, slot: r, view: v?.viewBounds };
}
/** 阅读位置 */
async function reading(win, ids) {
  return win.evaluate((ids) => {
    const ratio = (el) => (el ? +(el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight)).toFixed(3) : null);
    const q = (id, sel) => document.querySelector(`[data-item-id="${id}"] ${sel}`) ?? document.querySelector(`[data-item-id="${id}"]${sel}`);
    return {
      pdfPage: Number(q(ids.pdf, '[data-testid="reader-pdf"]')?.dataset.page ?? 0),
      md: ratio(q(ids.md, '[data-testid="reader-markdown"]')),
      csv: ratio(q(ids.csv, '[data-testid="view-csv-table"]')),
    };
  }, ids);
}
const near = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= tol;
const boxNear = (a, b, tol = 2) => a && b && ['left', 'top', 'width', 'height'].every((k) => Math.abs(a[k] - b[k]) <= tol);
const inside = (b, c) => b && b.left >= -1 && b.top >= -1 && b.left + b.width <= c.width + 1 && b.top + b.height <= c.height + 1;
const groupHeader = (win, id) => win.locator(`.dv-groupview:has([data-item-id="${id}"]) .dv-tabs-and-actions-container, .dv-groupview:has([data-item-id="${id}"]) .dv-tabs-container`).first();
async function clickAct(win, id, act) {
  // 分组标题栏右侧的窗口按钮（对分组当前面板操作）
  // 先把窗口带到最上层（用户点按钮前总会先看到它），再激活面板
  await win.evaluate((pid) => (window.__kb.pm.get(pid)?.mode === 'floating' && window.__kb.pm.bringToFront(pid), window.__dock.getPanel(pid).api.setActive()), id);
  await frames(win, 2);
  const g = await win.evaluate((pid) => window.__dock.getPanel(pid).group.id, id);
  const sel = `[data-testid="pm-act-${act}"]`;
  const loc = win.locator(`.dv-groupview`).filter({ has: win.locator(`[data-item-id="${id}"]`) }).locator(sel);
  if ((await loc.count()) > 0) {
    try {
      return await loc.first().click({ timeout: 4000 });
    } catch (e) {
      await win.screenshot({ path: '/tmp/clickact-fail.png' }).catch(() => {});
      console.log('clickAct dbg', JSON.stringify(await win.evaluate(([pid, s]) => {
        const b = [...document.querySelectorAll(s)].find((x) => x.closest('.dv-groupview')?.querySelector(`[data-item-id="${pid}"]`));
        const r = b?.getBoundingClientRect();
        const hit = r && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { r: r && [r.left, r.top, r.width, r.height], hit: hit?.className, ov: [...document.querySelectorAll('.dv-resize-container')].map((o) => [o.getAttribute('aria-label'), o.style.cssText, JSON.stringify(o.getBoundingClientRect())]) };
      }, [id, sel])));
      throw new Error(`clickAct ${act} 失败（按钮被遮挡？）：${e.message.split('\n').slice(0, 6).join(' | ')}`);
    }
  }
  // 常驻渲染（网页）面板的内容不在分组 DOM 里：按分组 id 找标题栏
  await win.evaluate(([gid, s]) => {
    const el = [...document.querySelectorAll(s)].find((b) => b.closest('.dv-groupview') === window.__dock.getGroup(gid).element);
    el.click();
  }, [g, sel]);
}

// ============================================================ 1. 启动：资料、网页适配器、分屏
let { app, win } = await launch();
const ra = await addRoot(app, win, RA);
for (const f of ['论文.pdf', '笔记.md', '数据.csv']) await waitIndexed(win, ra, f);
await win.evaluate(() => window.__kb.openPluginManager());
await win.waitForSelector('[data-testid="plugin-manager"]');
await win.check('[data-testid="dev-mode-toggle"]');
await win.waitForFunction(() => !document.querySelector('[data-testid="dev-install"]').disabled);
await stubOpen(app, P_WEB);
await win.click('[data-testid="dev-install"]');
await win.waitForSelector(`[data-testid="pm-plugin-${PID}"]`);
await win.click('[data-testid="pm-close"]');
const openP = (rel, mode) => win.evaluate(([r, p, m]) => window.__kb.openByPath(r, p, m), [ra, rel, mode]);
const itemOf = async (rid) => Object.values(await items(win)).find((i) => i.ref === rid)?.itemId;
const ids = {};
ids.pdf = await itemOf(await openP('论文.pdf', 'tab'));
await win.waitForSelector('[data-testid="reader-pdf"] canvas, [data-testid="reader-pdf"] .pdf-page', { timeout: 20000 });
ids.md = await itemOf(await openP('笔记.md', 'right'));
await win.waitForSelector('[data-testid="reader-markdown"] h1');
ids.csv = await itemOf(await openP('数据.csv', 'below'));
await win.waitForSelector('[data-testid="view-csv-table"] td');
await win.evaluate((id) => window.__dock.getPanel(id).api.setActive(), ids.pdf);
const webP = win.evaluate(([a, u]) => window.__kb.openWeb(a, u, 'below'), [AID, PAGE]);
await win.waitForSelector('[data-testid="perm-dialog"]', { timeout: 15000 });
await win.click('[data-testid="perm-allow"]');
ids.web = await webP;
await win.waitForFunction((u) => document.querySelector('[data-testid="web-panel"]')?.dataset.load === 'ready' && document.querySelector('[data-testid="web-panel"]').dataset.url.startsWith(u), PAGE, { timeout: 45000 });
await win.waitForTimeout(800);
notes.ids = ids;
let L = await list(win);
check('分屏成果保留：PDF/MD/CSV/网页四个面板都在分屏里，侧栏停靠', ['pdf', 'md', 'csv', 'web'].every((k) => L.find((w) => w.id === ids[k])?.mode === 'docked') && L.find((w) => w.id === 'kb.sidebar').mode === 'docked', JSON.stringify(L.map((w) => [w.title, w.mode])));
check('每个分组标题栏都有窗口按钮（浮动 / 收起 / 最大化）', (await win.locator('[data-testid="pm-act-float"]').count()) >= 4 && (await win.locator('[data-testid="pm-act-collapse"]').count()) >= 4 && (await win.locator('[data-testid="pm-sidebar-float"]').count()) === 1);
let ws = await webState(app, win);
check('网页面板在分屏中：原生视图可见并与占位重合', ws.nativeVisible && ws.dev <= 1 && !ws.covered, JSON.stringify(ws));
await shot(app, win, '01-split-preserved.png');

// 阅读位置
await win.evaluate((id) => {
  const el = document.querySelector(`[data-item-id="${id}"] [data-testid="reader-pdf"]`);
  const pages = el.querySelectorAll('.pdf-page, [data-page-no], canvas');
  const target = pages[6] ?? pages[pages.length - 1];
  el.scrollTop = target ? target.offsetTop - 40 : el.scrollHeight * 0.25;
}, ids.pdf);
await win.evaluate((id) => {
  const el = document.querySelector(`[data-item-id="${id}"] [data-testid="reader-markdown"]`);
  el.scrollTop = 0.42 * (el.scrollHeight - el.clientHeight);
}, ids.md);
await win.evaluate((id) => {
  const el = document.querySelector(`[data-item-id="${id}"] [data-testid="view-csv-table"]`);
  el.scrollTop = 0.6 * (el.scrollHeight - el.clientHeight);
}, ids.csv);
await pageEval(app, 'window.scrollTo(0, 900); window.scrollY');
await win.waitForTimeout(1500);
const read0 = await reading(win, ids);
check('设置阅读位置：PDF 翻到后面的页、MD 42%、CSV 60%', read0.pdfPage >= 5 && near(read0.md, 0.42, 0.02) && near(read0.csv, 0.6, 0.02), JSON.stringify(read0));

// ============================================================ 2. 浮动 + 鼠标拖动 + 鼠标缩放
await clickAct(win, ids.md, 'float');
await win.waitForTimeout(400);
let md = await info(win, ids.md);
const r1 = await reading(win, ids);
check('点“浮动”：MD 变成自由窗口，阅读位置不变', md.mode === 'floating' && near(r1.md, read0.md, 0.02), JSON.stringify({ md, r1 }));
// 鼠标拖右下角缩放
// 抓在窗口外框右下角（dockview 以按下点推算原尺寸：抓在把手中心会让窗口偏移几像素）
const ovb = await win.locator('.dv-resize-container').filter({ has: win.locator(`[data-item-id="${ids.md}"]`) }).boundingBox();
const brx = ovb.x + ovb.width - 1;
const bry = ovb.y + ovb.height - 1;
await win.mouse.move(brx, bry);
await win.mouse.down();
// dockview 8.4 以第一次 pointermove 作为起点：先挪 1px，避免第一步的位移被当成窗口平移
await win.mouse.move(brx - 1, bry - 1);
await win.mouse.move(brx - 90, bry - 70, { steps: 12 });
await win.waitForTimeout(120);
await win.mouse.up();
await win.waitForTimeout(300);
const mdResized = (await info(win, ids.md)).bounds;
check('鼠标拖右下角：独立调整宽和高（左上角不动）', near(mdResized.width, md.bounds.width - 90, 4) && near(mdResized.height, md.bounds.height - 70, 4) && near(mdResized.left, md.bounds.left, 3) && near(mdResized.top, md.bounds.top, 3), JSON.stringify({ before: md.bounds, after: mdResized }));
md = await info(win, ids.md);
// 鼠标拖动标题栏：移到网页面板上方
const webBox = (await info(win, ids.web)).bounds;
const c0 = await csize(win);
const tb = await win.locator('.dv-resize-container').filter({ has: win.locator(`[data-item-id="${ids.md}"]`) }).locator('.dv-void-container').boundingBox();
const target = { left: Math.min(c0.width - md.bounds.width - 20, webBox.left + 60), top: Math.min(c0.height - md.bounds.height - 20, Math.max(20, webBox.top - 40)) };
const dx = target.left - md.bounds.left;
const dy = target.top - md.bounds.top;
await win.mouse.move(tb.x + 20, tb.y + tb.height / 2);
await win.mouse.down();
await win.mouse.move(tb.x + 21, tb.y + tb.height / 2);
for (let i = 1; i <= 8; i++) await win.mouse.move(tb.x + 20 + (dx * i) / 8, tb.y + tb.height / 2 + (dy * i) / 8, { steps: 2 });
await win.waitForTimeout(120); // dockview 按帧处理拖动：等最后一帧落地再松开
await win.mouse.move(tb.x + 20 + dx, tb.y + tb.height / 2 + dy);
await win.waitForTimeout(80);
await win.mouse.up();
await win.waitForTimeout(300);
const mdMoved = (await info(win, ids.md)).bounds;
check('鼠标拖动浮动窗口标题栏：窗口跟随移动（吸附阈值 8px 内）', near(mdMoved.left, target.left, 10) && near(mdMoved.top, target.top, 10), JSON.stringify({ from: md.bounds, to: mdMoved, target }));
ws = await webState(app, win);
check('浮动 MD 盖在分屏里的网页面板上：网页改显示截图（原生视图隐藏），MD 完整可见', ws.covered && !ws.nativeVisible && ws.snapshot, JSON.stringify(ws));
await shot(app, win, '02-float-dragged-over-docked-web.png');
// 鼠标拖动吸附：右边缘拖到离容器右边 5px 处 → 松手后贴边（本层实现，阈值 8px）
{
  const cur = (await info(win, ids.md)).bounds;
  const tb2 = await win.locator('.dv-resize-container').filter({ has: win.locator(`[data-item-id="${ids.md}"]`) }).locator('.dv-void-container').boundingBox();
  const dx2 = c0.width - cur.width - 5 - cur.left;
  const sx = tb2.x + 20, sy = tb2.y + tb2.height / 2;
  await win.mouse.move(sx, sy);
  await win.mouse.down();
  await win.mouse.move(sx + 1, sy);
  for (let i = 1; i <= 6; i++) await win.mouse.move(sx + (dx2 * i) / 6, sy, { steps: 2 });
  await win.waitForTimeout(120);
  await win.mouse.move(sx + dx2, sy);
  await win.waitForTimeout(80);
  await win.mouse.up();
  await win.waitForTimeout(300);
  const after = (await info(win, ids.md)).bounds;
  check('鼠标拖动吸附：右边缘距容器 5px 松手 → 贴到右边缘（阈值 8px）', after.left + after.width === c0.width && near(after.top, cur.top, 2), JSON.stringify({ cur, after, container: c0 }));
  await pm(win, 'move', ids.md, { left: cur.left, top: cur.top });
}
// API：移动 / 调整尺寸 / 吸附
await pm(win, 'move', ids.md, { left: 5, top: 6 });
const snapped = (await info(win, ids.md)).bounds;
check('API move 到 (5,6)：吸附到容器左上角 (0,0)', snapped.left === 0 && snapped.top === 0, JSON.stringify(snapped));
// 容器尺寸以移动时为准（气泡栏出现/消失会让 dock 区域高度变化 10px）
await frames(win, 4);
const cc = await csize(win);
await pm(win, 'move', ids.md, { left: 3000, top: 3000 });
const clamped = (await info(win, ids.md)).bounds;
const rootScroll = await win.evaluate(() => [document.documentElement.scrollWidth - document.documentElement.clientWidth, document.documentElement.scrollHeight - document.documentElement.clientHeight]);
check('窗口部分移出 dock 区域：超出部分被裁掉，页面不出现滚动条', rootScroll[0] <= 0 && rootScroll[1] <= 0, JSON.stringify(rootScroll));
check('API move 到屏幕外 (3000,3000)：允许部分移出，但标签栏左上 40×40 仍在可见区域', clamped.left === cc.width - 40 && clamped.top === cc.height - 40, JSON.stringify({ clamped, cc }));
await pm(win, 'move', ids.md, { left: -200, top: -50 });
const partial = (await info(win, ids.md)).bounds;
check('API move 到 (-200,-50)：左边移出 200px 保留，顶部不能移出（标签栏必须可见）', partial.left === -200 && partial.top === 0, JSON.stringify(partial));
// 鼠标把窗口往上拖出屏幕：标签栏停在顶边
{
  const h = await win.locator('.dv-resize-container').filter({ has: win.locator(`[data-item-id="${ids.md}"]`) }).locator('.dv-void-container').boundingBox();
  await pm(win, 'move', ids.md, { left: 200, top: 200 });
  const h2 = await win.locator('.dv-resize-container').filter({ has: win.locator(`[data-item-id="${ids.md}"]`) }).locator('.dv-void-container').boundingBox();
  const sx = h2.x + 20, sy = h2.y + h2.height / 2;
  await win.mouse.move(sx, sy);
  await win.mouse.down();
  await win.mouse.move(sx, sy - 1);
  for (let i = 1; i <= 8; i++) await win.mouse.move(sx - i * 40, sy - i * 60, { steps: 2 });
  await win.waitForTimeout(120);
  await win.mouse.move(sx - 320, sy - 480);
  await win.waitForTimeout(80);
  await win.mouse.up();
  await win.waitForTimeout(300);
  const up = (await info(win, ids.md)).bounds;
  check('鼠标往左上拖出屏幕：顶部停在 0（标签栏可见），左侧可部分移出但至少留 40px', up.top === 0 && up.left + up.width >= 40 && up.left < 0, JSON.stringify({ up, h: !!h }));
}

// ============================================================ 3. 互相覆盖排列 + 层级
const c1 = await csize(win);
// 层叠排列：每个窗口的标签（标题）和一部分内容都露在外面（MD 在最下，CSV 压在 MD 上，网页在最上）
const csvTop = () => win.evaluate((id) => { const el = document.querySelector(`[data-item-id="${id}"] [data-testid="view-csv-table"]`); return +(el.scrollTop / el.scrollHeight).toFixed(3); }, ids.csv);
const readCsv0 = await csvTop();
await pm(win, 'float', ids.csv, { left: 420, top: 150, width: 480, height: 330 });
await win.waitForTimeout(700);
const readCsv1 = await csvTop();
check('CSV 从分屏浮动后阅读位置不变（视口顶部在全文中的位置 ±0.01，窗口变矮后顶部仍是同一行）', near(readCsv1, readCsv0, 0.01), JSON.stringify({ before: readCsv0, after: readCsv1 }));
await pm(win, 'move', ids.md, { left: 330, top: 20 });
await pm(win, 'resize', ids.md, { width: 520, height: 360 });
await win.click('[data-testid="pm-sidebar-float"]');
await win.waitForSelector('[data-testid="sidebar"][data-floating="true"] [data-testid="root-row"]');
await pm(win, 'move', 'kb.sidebar', { left: 20, top: 30 });
await pm(win, 'resize', 'kb.sidebar', { width: 280, height: Math.min(560, c1.height - 60) });
await pm(win, 'float', ids.web, { left: Math.min(600, c1.width - 520), top: 260, width: 500, height: 400 });
await win.waitForTimeout(500);
L = await list(win);
const z = (id) => L.find((w) => w.id === id).z;
check('侧栏、MD、CSV、网页都成为自由窗口，PDF 留在分屏', ['md', 'csv', 'web'].every((k) => L.find((w) => w.id === ids[k]).mode === 'floating') && L.find((w) => w.id === 'kb.sidebar').mode === 'floating' && L.find((w) => w.id === ids.pdf).mode === 'docked', JSON.stringify(L.map((w) => [w.title, w.mode, w.z])));
check('浮动侧栏仍可用（目录树、收藏在浮动窗口里）', (await win.locator('[data-testid="sidebar"][data-floating="true"] [data-testid="root-row"]').count()) === 1 && (await win.locator('aside[data-testid="sidebar"]').count()) === 0);
check('层级：后浮动的在上（网页 > 侧栏 > CSV）', z(ids.web) > z('kb.sidebar') && z('kb.sidebar') > z(ids.csv), JSON.stringify({ web: z(ids.web), sb: z('kb.sidebar'), csv: z(ids.csv), md: z(ids.md) }));
await shot(app, win, '03-free-windows-overlapping.png');
// 点击 MD 的标签（用户手势）→ MD 到最上层
{
  // 点 MD 窗口露在外面的部分（标题栏右端；左侧被 CSV 盖住）
  const t = await win.locator('.dv-resize-container').filter({ has: win.locator(`[data-item-id="${ids.md}"]`) }).locator('.dv-void-container').boundingBox();
  await win.mouse.click(t.x + t.width - 12, t.y + t.height / 2);
  await frames(win, 2);
}
L = await list(win);
check('点击 MD 标签：MD 到最上层', z(ids.md) === Math.max(...L.filter((w) => w.z >= 0).map((w) => w.z)), JSON.stringify(L.map((w) => [w.title, w.z])));
await pm(win, 'bringToFront', ids.csv);
L = await list(win);
check('API bringToFront(CSV)：CSV 到最上层', z(ids.csv) === Math.max(...L.filter((w) => w.z >= 0).map((w) => w.z)));

// ============================================================ 4. 网页面板与浮动层级
// MD 盖住网页窗口一部分，且层级在网页之上
const wb = (await info(win, ids.web)).bounds;
await pm(win, 'move', ids.md, { left: wb.left - 290, top: wb.top + 60 }); // 标签留在 CSV 窗口左侧，任何层级下都露出标题
await pm(win, 'bringToFront', ids.web);
await pm(win, 'bringToFront', ids.md);
ws = await webState(app, win);
check('网页窗口在下、MD 窗口在上且相交：网页显示截图（不是盖住 MD 的真网页）', ws.covered && !ws.nativeVisible && ws.snapshot, JSON.stringify(ws));
notes.webUnder = ws;
await shot(app, win, '04-web-under-floating-md-snapshot.png');
// 点击网页面板的标签 → 网页窗口到最上层 → 恢复真网页
await win.locator('.dv-resize-container').filter({ has: win.locator('[data-testid="web-panel"]') }).locator('.dv-tab').first().click().catch(async () => pm(win, 'bringToFront', ids.web));
await frames(win, 4);
let wz = await info(win, ids.web);
if (wz.z !== Math.max(...(await list(win)).filter((w) => w.z >= 0).map((w) => w.z))) await pm(win, 'bringToFront', ids.web);
ws = await webState(app, win);
check('网页窗口带到最上层：原生视图恢复显示，并与占位重合（偏差 ≤ 1px），盖住下面的 MD', !ws.covered && ws.nativeVisible && ws.dev <= 1, JSON.stringify(ws));
await shot(app, win, '05-web-on-top-live.png');
// 拖动网页窗口：原生视图跟随
const wtb = await win.locator(`.dv-resize-container[aria-label="${(await info(win, ids.web)).title}"] .dv-void-container`).boundingBox().catch(() => null);
let dragDev = 0;
if (wtb) {
  await win.mouse.move(wtb.x + 20, wtb.y + wtb.height / 2);
  await win.mouse.down();
  await win.mouse.move(wtb.x + 19, wtb.y + wtb.height / 2);
  for (let i = 1; i <= 6; i++) {
    await win.mouse.move(wtb.x + 20 - i * 15, wtb.y + wtb.height / 2 - i * 8, { steps: 2 });
    const s = await webState(app, win);
    dragDev = Math.max(dragDev, s.covered ? 0 : s.dev);
  }
  await win.mouse.up();
}
ws = await webState(app, win);
check('鼠标拖动浮动网页窗口：每一步原生视图都跟随（偏差 ≤ 1px）', !!wtb && dragDev <= 1 && ws.dev <= 1, `最大偏差 ${dragDev}px；${JSON.stringify(ws)}`);
// 工作台菜单盖在网页上（原有机制）
await win.click('[data-testid="ws-switcher"]');
await win.waitForSelector('[data-testid="ws-menu"]');
const menuBox = await win.locator('[data-testid="ws-menu"]').boundingBox();
const slotNow = await slotRect(win);
const menuHits = menuBox && slotNow && menuBox.x < slotNow.x + slotNow.width && slotNow.x < menuBox.x + menuBox.width && menuBox.y < slotNow.y + slotNow.height && slotNow.y < menuBox.y + menuBox.height;
ws = await webState(app, win);
check('菜单与网页相交时网页改显示截图；菜单在所有浮动窗口之上（dock 区域独立层叠上下文）', !menuHits || (ws.covered && !ws.nativeVisible), JSON.stringify({ menuHits, ws }));
const menuOnTop = await win.evaluate(() => {
  const m = document.querySelector('[data-testid="ws-menu"]').getBoundingClientRect();
  const el = document.elementFromPoint(m.left + 20, m.top + 20);
  return !!el?.closest('[data-testid="ws-menu"]');
});
check('菜单不被浮动窗口遮住（elementFromPoint 命中菜单）', menuOnTop);
await shot(app, win, '06-menu-over-floating-web.png');
await win.keyboard.press('Escape');
await win.waitForTimeout(150);
if (await win.locator('[data-testid="ws-menu"]').count()) await win.click('[data-testid="ws-switcher"]');
await win.waitForSelector('[data-testid="ws-menu"]', { state: 'detached' });

// ============================================================ 5. 收起成气泡 / 恢复
const before5 = { md: (await info(win, ids.md)).bounds, sb: (await info(win, 'kb.sidebar')).bounds, web: (await info(win, ids.web)).bounds };
const read5 = await reading(win, ids);
await clickAct(win, ids.md, 'collapse');
await pm(win, 'collapseToBubble', ids.pdf);
await clickAct(win, 'kb.sidebar', 'collapse'); // 浮动侧栏的窗口按钮在它的标签栏上
await pm(win, 'collapseToBubble', ids.web);
await win.waitForTimeout(400);
const bubbles = await win.locator('[data-testid="pm-bubble"]').evaluateAll((els) => els.map((e) => e.dataset.panelId));
L = await list(win);
const sidebarCollapsed = L.find((w) => w.id === 'kb.sidebar');
check('收起 MD（浮动）、PDF（分屏）、网页进气泡；侧栏隐藏且不进气泡', bubbles.length === 3 && [ids.md, ids.pdf, ids.web].every((i) => bubbles.includes(i)) && !bubbles.includes('kb.sidebar') && sidebarCollapsed?.mode === 'collapsed', JSON.stringify({ bubbles, sidebar: sidebarCollapsed }));
const visibleMd = await win.evaluate((id) => {
  const el = document.querySelector(`[data-item-id="${id}"]`);
  return el ? el.checkVisibility({ visibilityProperty: true }) : false;
}, ids.md);
ws = await webState(app, win);
check('收起后：面板不可见、不可点击；网页原生视图隐藏', !visibleMd && !ws.nativeVisible && L.filter((w) => w.mode === 'collapsed').length === 4, JSON.stringify({ visibleMd, ws: ws.nativeVisible }));
await shot(app, win, '07-collapsed-to-bubbles.png');
for (const id of [ids.md, ids.pdf, ids.web]) {
  await win.click(`[data-testid="pm-bubble"][data-panel-id="${id}"]`);
  await win.waitForTimeout(250);
}
await pm(win, 'restoreFromBubble', 'kb.sidebar');
await win.waitForTimeout(250);
await win.waitForTimeout(500);
L = await list(win);
const read5b = await reading(win, ids);
check('点气泡恢复：MD 回到原位置与尺寸', boxNear(L.find((w) => w.id === ids.md).bounds, before5.md), JSON.stringify({ before: before5.md, after: L.find((w) => w.id === ids.md).bounds }));
check('PDF 恢复后回到分屏（停靠）', L.find((w) => w.id === ids.pdf).mode === 'docked');
check('侧栏恢复为浮动窗口、原位置', L.find((w) => w.id === 'kb.sidebar').mode === 'floating' && boxNear(L.find((w) => w.id === 'kb.sidebar').bounds, before5.sb), JSON.stringify(L.find((w) => w.id === 'kb.sidebar').bounds));
check('恢复后阅读位置不变（PDF 页、MD/CSV 比例）', read5b.pdfPage === read5.pdfPage && near(read5b.md, read5.md, 0.02) && near(read5b.csv, read5.csv, 0.02), JSON.stringify({ read5, read5b }));
await pm(win, 'bringToFront', ids.web);
ws = await webState(app, win);
check('网页恢复：原生视图重新显示、位置正确（同一网页，没有重建）', ws.nativeVisible && ws.dev <= 1, JSON.stringify(ws));
await shot(app, win, '08-restored-from-bubbles.png');

// ============================================================ 6. 最大化 / 还原
const csvB = (await info(win, ids.csv)).bounds;
await clickAct(win, ids.csv, 'max');
await win.waitForTimeout(300);
let cs = await info(win, ids.csv);
const c6 = await csize(win);
check('浮动窗口最大化：占满 dock 区域并在最上层', cs.maximized && boxNear(cs.bounds, { left: 0, top: 0, width: c6.width, height: c6.height }) && cs.z === Math.max(...(await list(win)).filter((w) => w.z >= 0).map((w) => w.z)), JSON.stringify(cs));
ws = await webState(app, win);
check('最大化的 CSV 盖住网页窗口：网页显示截图', ws.covered && !ws.nativeVisible, JSON.stringify(ws));
await shot(app, win, '09-floating-maximized.png');
await clickAct(win, ids.csv, 'restore');
await win.waitForTimeout(300);
cs = await info(win, ids.csv);
check('还原：回到最大化前的位置与尺寸', !cs.maximized && boxNear(cs.bounds, csvB), JSON.stringify({ before: csvB, after: cs.bounds }));
await pm(win, 'maximize', ids.pdf);
await win.waitForTimeout(300);
const pdfMax = await info(win, ids.pdf);
check('分屏面板最大化（dockview 原生）', pdfMax.maximized === true, JSON.stringify(pdfMax));
await pm(win, 'bringToFront', ids.web); // 还原后的 CSV 压住了网页窗口的标签：把网页带到上层再截图
await shot(app, win, '10-docked-maximized.png');
await pm(win, 'restore', ids.pdf);
await win.waitForTimeout(300);
check('分屏面板还原', (await info(win, ids.pdf)).maximized === false);

// ============================================================ 7. 重启后完整恢复
await pm(win, 'collapseToBubble', ids.csv);
await pm(win, 'bringToFront', ids.md);
await win.waitForTimeout(400);
const readR = await reading(win, ids);
const webY = await pageEval(app, 'window.scrollY');
await win.evaluate(() => window.__kb.flush());
const before7 = (await list(win)).map((w) => ({ id: w.id, mode: w.mode, bounds: w.bounds, z: w.z }));
const order7 = before7.filter((w) => w.z >= 0).sort((a, b) => a.z - b.z).map((w) => w.id);
const stored = await win.evaluate(async () => (await window.kb.getWorkspace(window.__kb.currentWorkspaceId())).layout);
check('保存格式：layout.schema 仍为 4，layout.windows.v = 1；不含路径/URL/文件内容', stored.schema === 4 && stored.windows?.v === 1 && !/developer\.mozilla|layout 资料|\.pdf|阅读笔记/.test(JSON.stringify(stored.windows)) && !JSON.stringify(stored.dock).includes('kb.sidebar'), JSON.stringify(stored.windows).slice(0, 300));
notes.storedWindows = stored.windows;
notes.csvStateBeforeRestart = await win.evaluate(async (id) => JSON.stringify((await window.kb.getWorkspace(window.__kb.currentWorkspaceId())).items?.find((i) => i.itemId === id)?.state), ids.csv);
console.log('csv state before restart', notes.csvStateBeforeRestart);
await shot(app, win, '11-before-restart.png');
await app.close();
({ app, win } = await launch());
await win.waitForFunction(() => document.querySelector('[data-testid="web-panel"]')?.dataset.load === 'ready', null, { timeout: 45000 });
await win.waitForTimeout(1500);
const after7 = (await list(win)).map((w) => ({ id: w.id, mode: w.mode, bounds: w.bounds, z: w.z }));
const order7b = after7.filter((w) => w.z >= 0).sort((a, b) => a.z - b.z).map((w) => w.id);
const diffs = before7.filter((b) => {
  const a = after7.find((x) => x.id === b.id);
  return !a || a.mode !== b.mode || (b.bounds && b.mode === 'floating' && !boxNear(a.bounds, b.bounds, 2));
});
check('重启后：每个窗口的停靠/浮动/收起状态与位置、尺寸一致（±2px）', diffs.length === 0, JSON.stringify({ diffs, after7 }));
check('重启后：层级顺序一致', JSON.stringify(order7) === JSON.stringify(order7b), `${order7.join(' < ')} | ${order7b.join(' < ')}`);
check('重启后：CSV 仍是气泡', (await win.locator(`[data-testid="pm-bubble"][data-panel-id="${ids.csv}"]`).count()) === 1);
const readR2 = await reading(win, ids);
check('重启后：PDF 页、MD 阅读位置恢复', readR2.pdfPage === readR.pdfPage && near(readR2.md, readR.md, 0.02), JSON.stringify({ readR, readR2 }));
const csvDom = () => win.evaluate((id) => { const el = document.querySelector(`[data-item-id="${id}"] [data-testid="view-csv-table"]`); const ov = el?.closest('.dv-resize-container'); const tagged = !!el?.__pmTag; if (el) el.__pmTag = 1; return el ? [tagged, el.scrollTop, el.scrollHeight, el.clientHeight, ov ? ov.getAttribute('data-pm-collapsed') + '|' + ov.className + '|' + getComputedStyle(ov).visibility + getComputedStyle(ov).display : 'grid'] : 'none'; }, ids.csv);
notes.csvDom = [await csvDom()];
await win.click(`[data-testid="pm-bubble"][data-panel-id="${ids.csv}"]`);
notes.csvDom.push(await csvDom());
await win.waitForTimeout(600);
notes.csvDom.push(await csvDom());

const readR3 = await reading(win, ids);
const csvStored = await win.evaluate(async (id) => JSON.stringify((await window.kb.getWorkspace(window.__kb.currentWorkspaceId())).items?.find((i) => i.itemId === id)?.state), ids.csv);
check('重启后从气泡恢复 CSV：阅读位置（滚动 60%）恢复', near(readR3.csv, readR.csv, 0.02), JSON.stringify({ before: readR.csv, after: readR3.csv, csvStored }));
const webY2 = await pageEval(app, 'window.scrollY');
check('重启后：网页面板地址与滚动位置恢复', Math.abs(webY2 - webY) <= 40, `${webY} → ${webY2}`);
await pm(win, 'bringToFront', ids.web);
ws = await webState(app, win);
check('重启后：网页窗口在最上层时原生视图与占位重合', ws.nativeVisible && ws.dev <= 1, JSON.stringify(ws));
await shot(app, win, '12-after-restart.png');

// ============================================================ 8. 窗口缩到 1024×700：全部找回
await pm(win, 'move', ids.web, { left: 5000, top: 5000 }); // 贴到右下角
await pm(win, 'resize', ids.md, { width: 900, height: 640 });
const rescued0 = await win.evaluate(() => window.__kb.pm.stats.rescued);
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1024, 700));
await win.waitForTimeout(1200);
const c8 = await csize(win);
L = await list(win);
const outside8 = L.filter((w) => w.mode === 'floating' && !inside(w.bounds, c8));
const rescued1 = await win.evaluate(() => window.__kb.pm.stats.rescued);
check('窗口缩到 1024×700：所有浮动窗口（含侧栏）都在 dock 区域内', outside8.length === 0 && rescued1 > rescued0, JSON.stringify({ c8, outside8, rescued: rescued1 - rescued0 }));
check('1024×700：气泡栏与分屏面板仍可达', (await win.locator('[data-testid="pm-bubble-tray"]').count()) === 0 || (await win.locator('[data-testid="pm-bubble-tray"]').isVisible()));
ws = await webState(app, win);
check('1024×700：网页窗口原生视图仍跟随占位', !ws.nativeVisible || ws.dev <= 1, JSON.stringify(ws));
await shot(app, win, '13-window-1024x700-rescued.png');
await win.evaluate(() => window.__kb.flush());
await app.close(); // 主进程记下 1024×700

// ============================================================ 9. 大窗口保存、小窗口启动
({ app, win } = await launch(null));
const startSize = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize());
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1500, 950));
await win.waitForTimeout(800);
const cBig = await csize(win);
await pm(win, 'move', ids.web, { left: cBig.width, top: cBig.height });
await pm(win, 'move', 'kb.sidebar', { left: cBig.width, top: 0 });
await pm(win, 'resize', ids.md, { width: cBig.width - 40, height: cBig.height - 40 });
await win.waitForTimeout(300);
await win.evaluate(() => window.__kb.flush());
const bigSaved = await win.evaluate(async () => (await window.kb.getWorkspace(window.__kb.currentWorkspaceId())).layout.windows.viewport);
// 强制结束：主进程不会记下 1500×950，下次仍以 1024×700 启动
app.process().kill('SIGKILL');
await new Promise((r) => setTimeout(r, 800));
({ app, win } = await launch(null));
await win.waitForTimeout(1200);
const cS = await csize(win);
const size9 = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize());
L = await list(win);
const outside9 = L.filter((w) => w.mode === 'floating' && !inside(w.bounds, cS));
check('在 1500×950 保存、以 1024×700 启动：所有浮动窗口都被找回到可见区域', size9[0] <= 1030 && bigSaved.width > cS.width && outside9.length === 0, JSON.stringify({ start: startSize, size9, bigSaved, cS, outside9, floats: L.filter((w) => w.mode === 'floating').map((w) => [w.title, w.bounds]) }));
await pm(win, 'bringToFront', 'kb.sidebar'); // 找回后侧栏放到最上层，便于在截图里看到每个窗口
await shot(app, win, '14-saved-large-opened-small.png');

// ============================================================ 10. 两个网页窗口互相重叠：上层真网页，下层截图
const PAGE2 = 'https://developer.mozilla.org/zh-CN/docs/Web/CSS';
const web2P = win.evaluate(([a, u]) => window.__kb.openWeb(a, u, 'right'), [AID, PAGE2]);
const dlg = await win.waitForSelector('[data-testid="perm-dialog"]', { timeout: 4000 }).catch(() => null);
if (dlg) await win.click('[data-testid="perm-allow"]');
ids.web2 = await web2P;
await win.waitForFunction((u) => [...document.querySelectorAll('[data-testid="web-panel"]')].some((e) => e.dataset.load === 'ready' && e.dataset.url.startsWith(u)), PAGE2, { timeout: 45000 });
await win.waitForTimeout(600);
for (const k of ['md', 'csv', 'kb.sidebar']) await pm(win, 'collapseToBubble', ids[k] ?? k);
// 错开排列：无论谁在上，两个窗口的标签都露在外面
await pm(win, 'float', ids.web, { left: 20, top: 130, width: 480, height: 360 });
await pm(win, 'float', ids.web2, { left: 300, top: 20, width: 480, height: 360 });
await win.waitForTimeout(1500);
/** 每个网页面板：占位矩形、是否显示截图、主进程原生视图是否可见并与占位重合 */
async function webStateOf(id) {
  await frames(win, 4);
  // 被遮挡的网页：截图由主进程在页面稳定后缓存，最多等 5 秒出现
  await win.waitForFunction((pid) => { const el = document.querySelector(`[data-item-id="${pid}"] [data-testid="web-panel"]`); return !el || el.dataset.covered !== 'true' || !!el.querySelector('[data-testid="web-snapshot"]'); }, id, { timeout: 5000 }).catch(() => {});
  const dom = await win.evaluate((pid) => {
    const el = document.querySelector(`[data-item-id="${pid}"] [data-testid="web-panel"]`);
    const slot = el?.querySelector('[data-testid="web-slot"]')?.getBoundingClientRect();
    return el && { viewId: el.dataset.viewId, covered: el.dataset.covered === 'true', snapshot: !!el.querySelector('[data-testid="web-snapshot"]'), slot: slot && { x: Math.round(slot.left), y: Math.round(slot.top), width: Math.round(slot.right) - Math.round(slot.left), height: Math.round(slot.bottom) - Math.round(slot.top) } };
  }, id);
  const v = dom && (await views(app)).find((x) => x.viewId === dom.viewId);
  const dev = v?.visible && dom.slot ? Math.max(Math.abs(v.viewBounds.x - dom.slot.x), Math.abs(v.viewBounds.y - dom.slot.y), Math.abs(v.viewBounds.width - dom.slot.width), Math.abs(v.viewBounds.height - dom.slot.height)) : null;
  const main = dom && (await app.evaluate((_, vid) => { const e = globalThis.__kbWeb?.views?.get(vid); return e && { loading: e.loading, dirty: e.shotDirty, shot: e.shot ? (e.shot.isEmpty() ? 'empty' : e.shot.getSize()) : null, poll: !!e.poll }; }, dom.viewId).catch((er) => String(er)));
  return { ...dom, nativeVisible: !!v?.visible, dev, main };
}
await pm(win, 'bringToFront', ids.web2);
let w1 = await webStateOf(ids.web), w2 = await webStateOf(ids.web2);
check('两个网页窗口重叠，CSS 页在上：上层显示真网页（原生视图与占位重合），下层显示截图', w2.nativeVisible && !w2.covered && w2.dev <= 1 && w1.covered && w1.snapshot && !w1.nativeVisible, JSON.stringify({ lower: w1, upper: w2 }));
await shot(app, win, '15-two-web-windows-css-on-top.png');
await pm(win, 'bringToFront', ids.web);
w1 = await webStateOf(ids.web);
w2 = await webStateOf(ids.web2);
check('点下层网页窗口带到最上层：两者互换（JavaScript 页真网页，CSS 页截图）', w1.nativeVisible && !w1.covered && w1.dev <= 1 && w2.covered && w2.snapshot && !w2.nativeVisible, JSON.stringify({ upper: w1, lower: w2 }));
await shot(app, win, '16-two-web-windows-js-on-top.png');
await pm(win, 'move', ids.web2, { left: 520, top: 20 });
w1 = await webStateOf(ids.web);
w2 = await webStateOf(ids.web2);
check('两个网页窗口不再重叠：都显示真网页', w1.nativeVisible && w2.nativeVisible && !w1.covered && !w2.covered && w1.dev <= 1 && w2.dev <= 1, JSON.stringify({ w1, w2 }));
await app.close();

const okAll = results.every((r) => r.ok);
check('渲染进程没有未处理的错误', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '));
const summary = { passed: results.filter((r) => r.ok).length, total: results.length, results, notes, at: new Date().toISOString() };
fs.writeFileSync(path.join(OUT, 'e2e-layout-result.json'), JSON.stringify(summary, null, 2));
console.log(`\n自由窗口 e2e：${summary.passed}/${summary.total} 通过；截图与结果在 ${OUT}`);
process.exit(okAll && consoleErrors.length === 0 ? 0 : 1);
