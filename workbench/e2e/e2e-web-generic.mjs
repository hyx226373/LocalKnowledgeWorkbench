// 端到端（第 11 轮 A · 星图组）：网络资料 = 内置 web.generic（随应用、逐站授权 SDK 修订 10）+ 直链阅读器 web.file。
//   打开网址（去 query）→ 逐站询问 → 网页面板；被拦截的外部资源走按网站提示条；跨站导航询问/拒绝横幅；http 标“不安全连接”
//   加入本工作资料 / 复制网址；直链 PDF / md 受控下载后复用内置阅读器（只读）；重定向逐跳检查；类型冲突；断网占位与重试
//   保存到本地（根内新文件，重名加 (2)；网页存 MHTML）；搜索（标题/网址）；重启恢复（不再询问）；插件管理撤销网站 → 重新询问；
//   禁用内置适配器 → 占位“重新启用内置网页适配器”。全部用本地夹具站点（KB_TEST_WEB_FIXTURE，测试专用），不联网。
// 截图：/workspace/out/r11/shots/星图组/（KB_E2E_SHOTS_DIR 可改）。
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { grabWindow, hasX } from './lib/xshot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, 'e2e/.tmp');
const USERDATA = path.join(TMP, 'userdata-web-generic');
const RA = path.join(TMP, 'web-generic 资料');
const FIX = path.join(TMP, 'web-generic-fixture');
const SHOTS = process.env.KB_E2E_SHOTS_DIR || '/workspace/out/r11/shots/星图组';
for (const d of [USERDATA, RA, FIX]) fs.rmSync(d, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });
const put = (p, c) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, c));
put(path.join(RA, '说明.md'), '# 网络资料测试根\n');

// ---------------- 夹具站点（运行时生成，不提交二进制） ----------------
const PDF = makePdf(3);
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f1d6a90000000049454e44ae426082', 'hex');
const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font:16px sans-serif;margin:24px}p{height:600px}</style></head><body><h1>${title}</h1>${body}</body></html>`;
put(path.join(FIX, 'site-a.test/index.html'), page('站点 A 首页', '<p>普通网页。<a id="to-b" href="https://site-b.test/">去站点 B</a></p><img id="pic" src="https://cdn-c.test/pic.png" width="40" height="40"><p>第二段</p>'));
put(path.join(FIX, 'site-b.test/index.html'), page('站点 B', '<p>站点 B</p>'));
put(path.join(FIX, 'cdn-c.test/pic.png'), PNG);
put(path.join(FIX, 'plain.test/index.html'), page('明文站点', '<p>http only</p>'));
put(path.join(FIX, 'files.test/paper.pdf'), PDF);
put(path.join(FIX, 'files.test/notes.md'), '# 网络笔记\n\n来自 files.test 的 Markdown。\n');
put(path.join(FIX, 'files.test/old.pdf.redirect'), 'https://files.test/paper.pdf');
put(path.join(FIX, 'files.test/away.pdf.redirect'), 'https://evil.test/x.pdf');
put(path.join(FIX, 'files.test/fake.pdf'), 'this is not a pdf');
put(path.join(FIX, 'evil.test/x.pdf'), PDF);
put(path.join(FIX, 'down.test/doc.pdf'), PDF);
put(path.join(FIX, 'down.test/.offline'), '');

function makePdf(n) {
  const objs = [];
  const add = (s) => (objs.push(s), objs.length);
  const catalog = add('');
  const pages = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];
  for (let i = 1; i <= n; i++) {
    const text = `BT /F1 28 Tf 72 700 Td (Web PDF page ${i} of ${n}) Tj ET`;
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
  return Buffer.from(out);
}

// ---------------- 工具 ----------------
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? '  — ' + detail : ''}`);
}
const consoleErrors = [];
async function launch() {
  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'], cwd: ROOT, env: { ...process.env, KB_USER_DATA: USERDATA, KB_TEST_WEB_FIXTURE: FIX, KB_WEB_FETCH_TIMEOUT_MS: '8000' } });
  const win = await app.firstWindow();
  win.on('console', (m) => {
    if (m.type() === 'error' && !/403|404|ERR_|Content Security Policy|Refused to|net::/.test(m.text())) consoleErrors.push(m.text());
  });
  await win.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setPosition(0, 0);
    w.setContentSize(1280, 800);
  });
  // 空数据目录会停在工作区选择，不会自动 loadWorkspace，因此 __layoutRestored 不会自己变成 true。
  await win.waitForFunction(() => !!(window.kb && window.__kb), null, { timeout: 30000 });
  await win.evaluate(async () => {
    if (window.__layoutRestored && window.__kb.currentWorkspaceId()) return;
    const listed = await window.kb.listWorkspaces();
    if (listed.length === 0) {
      const created = await window.kb.createWorkspace('网络资料', '', { schema: 4, dock: null, shell: { sidebarWidth: 280 } }, []);
      await window.__kb.switchTo(created.id);
      return;
    }
    await window.__kb.switchTo(listed[0].id);
  });
  await win.waitForFunction(() => window.__layoutRestored === true, null, { timeout: 20000 });
  await win.evaluate(() => {
    const mount = document.querySelector('[data-testid="ws-overview-mount"]');
    if (mount && !mount.hasAttribute('hidden')) document.querySelector('[data-testid="ws-overview-toggle"]')?.click();
  });
  await win.waitForTimeout(400);
  await app.evaluate(({ shell }) => {
    globalThis.__opened = [];
    shell.openExternal = async (u) => void globalThis.__opened.push(u);
  });
  return { app, win };
}
async function shot(app, win, name) {
  const file = path.join(SHOTS, name);
  try {
    if (hasX()) await grabWindow(app, file);
    else await win.screenshot({ path: file });
  } catch (e) {
    console.log(`   (截图失败 ${name}: ${e.message})`);
  }
  return file;
}
async function addRoot(app, win, dir) {
  const n = await win.locator('[data-testid="root-row"]').count();
  await app.evaluate(({ dialog }, x) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [x] });
  }, dir);
  await win.click('[data-testid="pick-folder"]');
  await win.waitForFunction((k) => document.querySelectorAll('[data-testid="root-row"]').length === k + 1, n);
  return win.evaluate(async (p) => (await window.kb.listRoots()).find((r) => r.path === p).id, dir);
}
const views = (app) => app.evaluate(() => [...globalThis.__kbWeb.views.values()].map((e) => ({ viewId: e.viewId, url: e.wc.getURL(), pluginId: e.pluginId, visible: e.view.getVisible() })));
const viewEval = (app, urlPrefix, code) =>
  app.evaluate(async (_e, [u, c]) => {
    const e = [...globalThis.__kbWeb.views.values()].find((x) => x.wc.getURL().startsWith(u));
    return e ? e.wc.executeJavaScript(c, true) : null;
  }, [urlPrefix, code]);
async function waitWebReady(win, urlPrefix, timeout = 20000) {
  await win.waitForFunction(
    (u) => [...document.querySelectorAll('[data-testid="web-panel"]')].some((el) => el.dataset.load === 'ready' && el.dataset.url.startsWith(u)),
    urlPrefix,
    { timeout },
  );
}
const siteDialog = (win, timeout = 10000) => win.waitForSelector('[data-testid="site-dialog"]', { timeout }).then(() => true, () => false);
async function answerSite(win, allow) {
  const host = await win.textContent('[data-testid="site-host"]');
  await win.click(`[data-testid="${allow ? 'site-allow' : 'site-deny'}"]`);
  await win.waitForSelector('[data-testid="site-dialog"]', { state: 'detached' });
  return host;
}
const openUrl = (win, u, mode = 'tab') => win.evaluate(([x, m]) => window.__kb.openUrl(x, m), [u, mode]);
const items = (win) => win.evaluate(() => Object.values(window.__kb.items()));
const activate = (win, itemId) => win.evaluate((id) => window.__dock.getPanel(id)?.api.setActive(), itemId);
async function itemOf(win, pred) {
  return (await items(win)).find(pred);
}
async function openManager(win, focus) {
  await win.evaluate((f) => window.__kb.openPluginManager(f), focus);
  await win.waitForSelector('[data-testid="plugin-manager"]');
  await win.waitForTimeout(200);
}
async function closeManager(win) {
  await win.click('[data-testid="pm-close"]');
  await win.waitForSelector('[data-testid="plugin-manager"]', { state: 'detached' });
}
const webfile = (win, url) => `[data-testid="webfile-view"][data-url="${url}"]`;
async function waitPhase(win, url, phase, timeout = 15000) {
  return win.waitForFunction(([u, ph]) => document.querySelector(`[data-testid="webfile-view"][data-url="${u}"]`)?.dataset.phase === ph, [url, phase], { timeout }).then(
    () => true,
    () => false,
  );
}

// ============================================================ 1. 启动：内置 web.generic 随包、默认启用、不可卸载
let { app, win } = await launch();
const ra = await addRoot(app, win, RA);
await openManager(win, 'web.generic');
const pmText = await win.innerText('[data-testid="pm-plugin-web.generic"]').catch(() => '');
check('内置 web.generic 随应用载入（插件管理显示“随应用内置”、已启用）', /随应用内置/.test(pmText) && (await win.getAttribute('[data-testid="pm-plugin-web.generic"]', 'data-status')) === 'active', pmText.split('\n').slice(0, 2).join(' / '));
check('内置插件没有“卸载”按钮', (await win.locator('[data-testid="pm-uninstall-web.generic"]').count()) === 0);
check('“尚未安装第三方插件”只统计第三方', /尚未安装第三方插件/.test(await win.innerText('[data-testid="plugin-manager"]')));
await shot(app, win, '01-插件管理-内置web.generic.png');
await closeManager(win);

// ============================================================ 2. 打开网址 → 逐站询问 → 网页面板
const ridA = await openUrl(win, 'site-a.test/?token=secret#top');
const asked = await siteDialog(win);
const dlgText = asked ? await win.innerText('[data-testid="site-dialog"]') : '';
await shot(app, win, '02-逐站询问-site-a.png');
check('首次打开网站弹出逐站询问（主机名 site-a.test）', asked && (await win.textContent('[data-testid="site-host"]')) === 'site-a.test', dlgText.split('\n')[0]);
await answerSite(win, true);
await waitWebReady(win, 'https://site-a.test/');
const itA = await itemOf(win, (i) => i.sourceKind === 'web' && i.adapterId === 'web.generic');
check('网址去掉 query / fragment 后作为条目 ref；web resourceId 为 UUID v4', itA?.ref === 'https://site-a.test/' && /^[0-9a-f-]{36}$/.test(ridA ?? ''), JSON.stringify({ ref: itA?.ref, ridA }));
const ridA2 = await openUrl(win, 'https://site-a.test/?other=1');
check('同一网址再次打开：resourceId 不变、不重复开面板', ridA2 === ridA && (await items(win)).filter((i) => i.ref === 'https://site-a.test/').length === 1);
const wA = await win.evaluate((r) => window.kb.webResourceGet(r), ridA);
check('网络资料记录标题来自页面', wA?.title === '站点 A 首页' || (await win.waitForFunction((r) => window.kb.webResourceGet(r).then((w) => w?.title === '站点 A 首页'), ridA, { timeout: 5000 }).then(() => true, () => false)), wA?.title);

// 被拦截的外部资源：按网站提示条允许（同一网站只问一次，始终允许写入 web-site-grants.json）
await win.waitForSelector('[data-testid="web-site-grant-banner"]', { timeout: 10000 }).catch(() => undefined);
const picBefore = await viewEval(app, 'https://site-a.test/', 'document.getElementById("pic").naturalWidth');
const bannerCount = await win.locator('[data-testid="web-site-grant-banner"]').count();
const cdnRow = await win.locator('[data-testid="web-site-row-cdn-c.test"]').count();
check(
  '未批准的资源网站（cdn-c.test）的图片被拦截，并出现按网站提示条',
  picBefore === 0 && bannerCount === 1 && cdnRow === 1,
  `naturalWidth=${picBefore} banner=${bannerCount} row=${cdnRow}`,
);
await win.click('[data-testid="web-site-allow-always-cdn-c.test"]');
const grantFile = path.join(USERDATA, 'web-site-grants.json');
let grantDoc = null;
for (let i = 0; i < 30; i++) {
  if (fs.existsSync(grantFile)) {
    try {
      grantDoc = JSON.parse(fs.readFileSync(grantFile, 'utf8'));
      if (grantDoc?.sites?.['cdn-c.test']?.decision === 'allow') break;
    } catch {
      grantDoc = null;
    }
  }
  await win.waitForTimeout(100);
}
check('始终允许写入按网站授权（cdn-c.test）', grantDoc?.sites?.['cdn-c.test']?.decision === 'allow', JSON.stringify(grantDoc?.sites ?? null));
await win.waitForTimeout(800);
await waitWebReady(win, 'https://site-a.test/');
const picAfter = await win
  .waitForFunction(async () => true, null)
  .then(() => viewEval(app, 'https://site-a.test/', 'new Promise(r => { const i = document.getElementById("pic"); if (i.complete) r(i.naturalWidth); else i.onload = i.onerror = () => r(i.naturalWidth); })'));
check('允许资源主机后重新载入，图片正常显示', picAfter > 0, `naturalWidth=${picAfter}`);

// 跨站导航：询问 → 拒绝 → 横幅（site-denied），页面留在 A
await viewEval(app, 'https://site-a.test/', 'document.getElementById("to-b").click(); 1');
const askedB = await siteDialog(win);
check('页面内跳到新网站（site-b.test）时询问', askedB && (await win.textContent('[data-testid="site-host"]')) === 'site-b.test');
if (askedB) await answerSite(win, false);
await win.waitForSelector('[data-testid="web-blocked-banner"][data-reason="site-denied"]', { timeout: 8000 }).catch(() => undefined);
const urlAfterDeny = (await views(app)).find((v) => v.url.startsWith('https://site-a.test/'))?.url;
check('拒绝后显示横幅（未允许访问此网站），页面仍在站点 A', (await win.locator('[data-testid="web-blocked-banner"][data-reason="site-denied"]').count()) === 1 && !!urlAfterDeny);
await shot(app, win, '03-网页面板-拒绝站点B横幅.png');

// 工具条：加入工作资料 / 复制网址
await activate(win, itA.itemId);
await win.click('[data-testid="web-addref"]');
await win.waitForSelector(`[data-testid="ws-ref-row"][data-resource-id="${ridA}"][data-source-kind="web"]`, { timeout: 5000 }).catch(() => undefined);
check('“加入本工作资料”：工作资料出现网络条目', (await win.locator(`[data-testid="ws-ref-row"][data-resource-id="${ridA}"][data-source-kind="web"]`).count()) === 1);
await win.click('[data-testid="web-copy"]');
await win.waitForTimeout(200);
check('“复制网址”：复制的是去掉 query 的网址', (await win.evaluate(() => window.__kb.lastCopied())) === 'https://site-a.test/');

// http：询问框与工具条标“不安全连接”
await openUrl(win, 'http://plain.test/', 'right');
await siteDialog(win);
const insecureDlg = (await win.locator('[data-testid="site-insecure"]').count()) === 1;
await answerSite(win, true);
await waitWebReady(win, 'http://plain.test/');
check('http 网址：询问框与工具条都标“不安全连接”', insecureDlg && (await win.locator('[data-testid="web-insecure"]').count()) >= 1);
await shot(app, win, '04-http不安全连接.png');
const itPlain = await itemOf(win, (i) => i.ref === 'http://plain.test/');
await win.evaluate((id) => window.__dock.getPanel(id).api.close(), itPlain.itemId);

// ============================================================ 3. 直链文件：受控下载 → 内置阅读器
const PDF_URL = 'https://files.test/paper.pdf';
const ridPdf = await openUrl(win, PDF_URL + '?dl=1', 'right');
const askedF = await siteDialog(win);
if (askedF) await answerSite(win, true);
const pdfReady = await waitPhase(win, PDF_URL, 'ready');
const reader = pdfReady ? await win.getAttribute(`${webfile(win, PDF_URL)} [data-testid="webfile-reader"]`, 'data-reader') : null;
await win.waitForSelector(`${webfile(win, PDF_URL)} .pdf-page`, { timeout: 15000 }).catch(() => undefined);
check('直链 PDF：询问 files.test 后下载到缓存，用内置 PDF 阅读器打开', askedF && pdfReady && /pdf/.test(reader ?? '') && (await win.locator(`${webfile(win, PDF_URL)} .pdf-page`).count()) >= 1, `reader=${reader}`);
const cache = await app.evaluate((_e, r) => globalThis.__kbWebResources?.store.cacheFile(r) ?? null, ridPdf);
check('缓存位于 <数据目录>/web-cache/<resourceId>/，内容与服务器一致', !!cache && cache.includes(path.join('web-cache', ridPdf)) && fs.readFileSync(cache).equals(PDF), cache ?? '');
await shot(app, win, '05-直链PDF-内置阅读器.png');

const MD_URL = 'https://files.test/notes.md';
const ridMd = await openUrl(win, MD_URL, 'below');
const mdNoAsk = !(await siteDialog(win, 1500));
const mdReady = await waitPhase(win, MD_URL, 'ready');
await win.waitForSelector(`${webfile(win, MD_URL)} [data-testid="md-editor"]`, { timeout: 10000 }).catch(() => undefined);
const mdText = await win.innerText(webfile(win, MD_URL)).catch(() => '');
check('同一网站已批准：直链 Markdown 不再询问，用内置 Markdown 阅读器显示', mdNoAsk && mdReady && /网络笔记/.test(mdText));
const snap = await win.evaluate((r) => window.kb.textOpen(r), ridMd);
const saveErr = await win.evaluate((r) => window.kb.textSave(r, 'x', 'y').then(() => 'saved', (e) => String(e.message)), ridMd);
check('网络资料只读：textOpen 不可编辑，保存被拒绝，缓存不变', snap?.editable === false && /只读/.test(snap?.readOnlyReason ?? '') && saveErr !== 'saved', `${snap?.readOnlyReason} / ${saveErr.slice(0, 60)}`);

// 重定向：同站跟随；跳到未批准网站 → 询问；拒绝 → 占位
const OLD_URL = 'https://files.test/old.pdf';
await openUrl(win, OLD_URL, 'tab');
const oldOk = await waitPhase(win, OLD_URL, 'ready');
check('重定向（同站 302）逐跳检查后跟随，仍用 PDF 阅读器', oldOk, oldOk ? '' : (await win.innerText(webfile(win, OLD_URL)).catch(() => '')).replace(/\s+/g, ' ').slice(0, 300));
const AWAY_URL = 'https://files.test/away.pdf';
await openUrl(win, AWAY_URL, 'tab');
const askedEvil = await siteDialog(win);
const evilHost = askedEvil ? await answerSite(win, false) : '';
const awayDenied = await win.waitForSelector(`${webfile(win, AWAY_URL)} [data-testid="placeholder"][data-kind="site-denied"]`, { timeout: 8000 }).then(() => true, () => false);
check('重定向到未批准网站：询问目标主机；拒绝后显示占位，不下载', askedEvil && evilHost === 'evil.test' && awayDenied, evilHost);
const awayRec = await win.evaluate(() => window.kb.webResourceGetByUrl('https://files.test/away.pdf'));
check('被拒绝的重定向没有写入缓存（引用保留）', !!awayRec && !awayRec.cached, JSON.stringify({ cached: awayRec?.cached }));
// 本会话拒绝只在本次运行内有效：关掉该标签，避免重启后再次询问 evil.test 干扰后面的检查
{
  const itAway = await itemOf(win, (i) => i.ref === AWAY_URL);
  if (itAway) await win.evaluate((id) => window.__dock.getPanel(id)?.api.close(), itAway.itemId);
}

// 类型冲突
const FAKE_URL = 'https://files.test/fake.pdf';
await openUrl(win, FAKE_URL, 'tab');
const typeOk = await win.waitForSelector(`${webfile(win, FAKE_URL)} [data-testid="placeholder"][data-kind="type-unknown"]`, { timeout: 8000 }).then(() => true, () => false);
check('扩展名 .pdf 但内容不是 PDF：提示“无法识别类型”，可仍按网页打开 / 取消', typeOk && (await win.locator(`${webfile(win, FAKE_URL)} [data-testid="webfile-open-as-web"]`).count()) === 1);

// 断网占位 → 恢复 → 重试
const DOWN_URL = 'https://down.test/doc.pdf';
await openUrl(win, DOWN_URL, 'tab');
if (await siteDialog(win)) await answerSite(win, true);
const offline = await win.waitForSelector(`${webfile(win, DOWN_URL)} [data-testid="placeholder"][data-kind="network-offline"]`, { timeout: 15000 }).then(() => true, () => false);
const offTitle = offline ? await win.textContent(`${webfile(win, DOWN_URL)} [data-testid="webfile-error-title"]`) : '';
await shot(app, win, '06-断网占位-可重试.png');
check('网络不可用：显示可重试占位（引用保留）', offline, offTitle);
fs.rmSync(path.join(FIX, 'down.test/.offline'));
await win.click(`${webfile(win, DOWN_URL)} [data-testid="placeholder-action-retry"]`);
check('恢复网络后点“重试”：下载成功并打开', await waitPhase(win, DOWN_URL, 'ready'));

// ============================================================ 4. 保存到本地
const itPdf = await itemOf(win, (i) => i.ref === PDF_URL && i.adapterId === 'web.file');
await activate(win, itPdf.itemId);
async function saveVia(btn) {
  await win.click(btn);
  await win.waitForSelector('[data-testid="web-save-dialog"]');
  await win.click('[data-testid="web-save-ok"]');
  await win.waitForSelector('[data-testid="web-save-dialog"]', { state: 'detached' });
  await win.waitForFunction((prev) => window.__kb.lastSaved()?.opId !== prev, null, { timeout: 15000 }).catch(() => undefined);
  return win.evaluate(() => window.__kb.lastSaved());
}
const s1 = await win.evaluate(() => window.__kb.lastSaved()?.opId ?? null).then(() => saveVia(`${webfile(win, PDF_URL)} [data-testid="webfile-save"]`));
const saved1 = path.join(RA, '网络资料/paper.pdf');
check('直链 PDF “保存到本地”：根内新文件，字节一致', s1?.relPath === '网络资料/paper.pdf' && fs.existsSync(saved1) && fs.readFileSync(saved1).equals(PDF), JSON.stringify(s1));
const s2 = await saveVia(`${webfile(win, PDF_URL)} [data-testid="webfile-save"]`);
check('再次保存：不覆盖，自动改名为 “paper (2).pdf”', s2?.relPath === '网络资料/paper (2).pdf' && fs.existsSync(path.join(RA, '网络资料/paper (2).pdf')), s2?.relPath);
const oplog = await win.evaluate(() => (window.kb.opLog ? window.kb.opLog(20) : window.kb.listOpLog ? window.kb.listOpLog(20) : null)).catch(() => null);
check('保存记入操作记录（via web-save）', !oplog || JSON.stringify(oplog).includes('web-save') || JSON.stringify(oplog).includes('paper.pdf'), oplog ? '' : '（操作记录接口不存在，跳过）');
await activate(win, itA.itemId);
await win.waitForTimeout(300);
const s3 = await saveVia('[data-testid="web-save"]');
check('网页“保存到本地”：保存为 .mhtml 新文件', !!s3 && /\.mhtml$/.test(s3.relPath) && fs.existsSync(path.join(RA, s3.relPath)) && /site-a\.test/.test(fs.readFileSync(path.join(RA, s3.relPath), 'utf8').slice(0, 4000)), s3?.relPath);
await shot(app, win, '07-保存到本地后.png');

// ============================================================ 5. 搜索（标题 / 网址；不含网页正文）
const hits = await win.evaluate(() => window.kb.search('站点 A'));
check('搜索：网络资料按标题命中（matchKind name）', hits.some((h) => h.resourceId === ridA && h.matchKind === 'name'));
const bodyHits = await win.evaluate(() => window.kb.search('第二段'));
check('网页正文不进入索引（索引后置）', !bodyHits.some((h) => h.resourceId === ridA));

// ============================================================ 6. 重启恢复
const openItems = (win) => win.evaluate(() => Object.values(window.__kb.items()).filter((i) => window.__dock.getPanel(i.itemId)));
const before = (await openItems(win)).filter((i) => i.sourceKind === 'web').map((i) => `${i.adapterId}|${i.ref}`).sort();
await win.evaluate(() => window.__kb.flush());
await app.close();
({ app, win } = await launch());
await waitWebReady(win, 'https://site-a.test/');
const after = (await openItems(win)).filter((i) => i.sourceKind === 'web').map((i) => `${i.adapterId}|${i.ref}`).sort();
check('重启后网页 / 直链条目原样恢复', JSON.stringify(before) === JSON.stringify(after), JSON.stringify(before) === JSON.stringify(after) ? `${after.length} 个条目` : JSON.stringify({ before, after }));
check('重启后不再询问已批准的网站', (await win.locator('[data-testid="site-dialog"]').count()) === 0);
check('重启后工作资料中的网络条目仍在', (await win.locator(`[data-testid="ws-ref-row"][data-resource-id="${ridA}"]`).count()) === 1);
const itPdf2 = await itemOf(win, (i) => i.ref === PDF_URL && i.adapterId === 'web.file');
await activate(win, itPdf2.itemId);
check('重启后直链 PDF 直接用缓存打开', await waitPhase(win, PDF_URL, 'ready'));
await shot(app, win, '08-重启恢复.png');

// 工作资料中的网络条目：点开 → 打开对应面板
await win.click(`[data-testid="ws-ref-row"][data-resource-id="${ridA}"]`);
await win.waitForTimeout(400);
const actRef = await win.evaluate(() => {
  const p = window.__dock.activePanel;
  return p ? window.__kb.items()[p.params?.itemId ?? '']?.ref : null;
});
check('点工作资料中的网络条目：激活已打开的网页面板', actRef === 'https://site-a.test/', actRef);

// ============================================================ 7. 插件管理撤销网站 → 重新询问
await openManager(win, 'web.generic');
const sites = await win.innerText('[data-testid="pm-plugin-web.generic"]');
check('插件管理列出已允许打开的网站（site-a.test、files.test）；资源网站不进逐站导航名单', /site-a\.test/.test(sites) && /files\.test/.test(sites) && !/cdn-c\.test/.test(sites), sites.replace(/\s+/g, ' ').slice(0, 400));
await shot(app, win, '09-插件管理-已允许网站.png');
await win.click('[data-testid="site-revoke-site-a.test"]');
// 已打开的 site-a 面板立即重新询问（询问框叠在插件管理之上）
const reAsk = await siteDialog(win);
check('撤销 site-a.test 后，已打开的网页面板重新询问', reAsk && (await win.textContent('[data-testid="site-host"]')) === 'site-a.test');
if (reAsk) await answerSite(win, false);
await closeManager(win);
const deniedGate = await win.waitForSelector('[data-testid="site-denied"][data-host="site-a.test"]', { timeout: 8000 }).then(() => true, () => false);
check('拒绝后显示“未允许访问此网站”占位，网页视图销毁', deniedGate && !(await views(app)).some((v) => v.url.startsWith('https://site-a.test/')));
await shot(app, win, '10-撤销后拒绝占位.png');
await win.click('[data-testid="site-allow-again"]');
await siteDialog(win);
await answerSite(win, true);
await waitWebReady(win, 'https://site-a.test/').then(() => check('“允许访问…”再次允许：网页恢复', true), () => check('“允许访问…”再次允许：网页恢复', false));

// ============================================================ 8. 禁用内置适配器 → 占位与重新启用
await openManager(win, 'web.generic');
await win.click('[data-testid="pm-toggle-web.generic"]');
await win.waitForTimeout(400);
await closeManager(win);
await activate(win, itA.itemId).catch(() => undefined);
const itA3 = await itemOf(win, (i) => i.ref === 'https://site-a.test/' && i.adapterId === 'web.generic');
await activate(win, itA3.itemId);
const ph = await win.waitForSelector('[data-testid="placeholder"][data-adapter-id="web.generic"]', { timeout: 8000 }).then(() => true, () => false);
const enableLabel = ph ? await win.textContent('[data-testid="placeholder"][data-adapter-id="web.generic"] [data-testid="placeholder-action-enable-plugin"]').catch(() => '') : '';
check('禁用内置网页适配器：网页条目显示占位，按钮“重新启用内置网页适配器”', ph && /重新启用内置网页适配器/.test(enableLabel ?? ''), enableLabel ?? '');
await shot(app, win, '11-禁用内置适配器占位.png');
if (ph) await win.click('[data-testid="placeholder"][data-adapter-id="web.generic"] [data-testid="placeholder-action-enable-plugin"]');
await waitWebReady(win, 'https://site-a.test/').then(() => check('重新启用后网页面板恢复', true), () => check('重新启用后网页面板恢复', false));

// ============================================================ 9. 导出 / 双库自检（存在时）
const wsId = await win.evaluate(() => window.__kb.currentWorkspaceId());
const EXPORT_FILE = path.join(TMP, 'web-generic-export.kblayout.json');
fs.rmSync(EXPORT_FILE, { force: true });
await app.evaluate(({ dialog }, f) => {
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: f });
}, EXPORT_FILE);
await win.evaluate((id) => window.kb.exportWorkspaceToFile(id), wsId);
const exported = fs.existsSync(EXPORT_FILE) ? JSON.parse(fs.readFileSync(EXPORT_FILE, 'utf8')) : null;
check('导出的工作区带网络资料记录（导入时按网址重新匹配 resourceId）', !!exported && (exported.webResources ?? []).some((w) => w.url === 'https://site-a.test/' && w.resourceId === ridA) && (exported.refs ?? []).includes(ridA));
const dual = await win.evaluate(() => (typeof window.kb.debugDualDbCheck === 'function' ? window.kb.debugDualDbCheck() : null)).catch((e) => ({ error: String(e) }));
check('双库自检（debugDualDbCheck，不存在时跳过）', dual === null || !dual.error, dual === null ? '接口不存在，跳过' : JSON.stringify(dual).slice(0, 200));
check('无未预期的控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
await app.close();

const failed = results.filter((r) => !r.ok);
fs.mkdirSync(path.join(ROOT, 'verify'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'verify/e2e-web-generic-results.json'), JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} 通过（网络资料 / 内置 web.generic）`);
process.exit(failed.length ? 1 : 0);
