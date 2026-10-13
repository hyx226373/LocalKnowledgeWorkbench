// 端到端：冷启动分级加载（第 9 轮 D）
// - 工作区完整恢复（标签、分栏、尺寸、阅读状态都在），但只立即加载可见面板；后台标签不加载（不挂载视图、不读文件）
// - startup-trace.json 三个指标：窗口出现、可交互、可见内容加载完成
// - 切到后台标签时加载并恢复阅读位置（Markdown 滚动、PDF 页码/缩放）
// - 空闲时后台标签自动加载（延迟可设置）
// - 只在面板内容加载层实现：布局数据（dock JSON、条目）启动前后不变
// - 收起成气泡的面板按后台标签处理：启动时不加载、不计入可见内容，点气泡立即加载
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE = process.env.KB_SAMPLE || '/workspace/kb-sample';
const VERIFY = path.join(ROOT, 'verify');
const TMP = path.join(ROOT, 'e2e/.tmp/lazy');
const USERDATA = path.join(TMP, 'userdata');
const R = path.join(TMP, '样例根');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
fs.cpSync(SAMPLE, R, { recursive: true });

function makePdf(n) {
  const objs = [];
  const add = (s) => (objs.push(s), objs.length);
  const catalog = add('');
  const pages = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];
  for (let i = 1; i <= n; i++) {
    const t = `BT /F1 36 Tf 72 700 Td (Page ${i}) Tj ET`;
    const c = add(`<< /Length ${t.length} >>\nstream\n${t}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Contents ${c} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`;
  objs[pages - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${n} >>`;
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => (offs.push(out.length), (out += `${i + 1} 0 obj\n${o}\nendobj\n`)));
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${x}\n%%EOF`;
  return out;
}
fs.writeFileSync(path.join(R, '资料/长文档.pdf'), makePdf(20));
fs.writeFileSync(path.join(R, '笔记/长笔记.md'), ['# 长笔记', ...Array.from({ length: 150 }, (_, i) => `## 第 ${i + 1} 节\n\n用于测试后台标签恢复阅读位置的段落 ${i + 1}。`)].join('\n\n'));

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
const active = (win) => win.evaluate(() => window.__dock.activePanel.id);
const storedLayout = async (win) => {
  const ws = await win.evaluate(async () => window.kb.getWorkspace(await window.kb.getCurrentWorkspaceId()));
  return { dock: JSON.stringify(ws.layout), items: JSON.stringify([...ws.items].sort((a, b) => a.itemId.localeCompare(b.itemId))) };
};

let { app, win } = await launch();
const root = await win.evaluate((p) => window.kb.addRoot(p), R);
await win.waitForFunction(async () => (await window.kb.getIndexStatus()).every((s) => s.state === 'idle' && s.fileCount > 0), null, { timeout: 30000, polling: 200 });
const open = (rel, mode) => win.evaluate(([r, rel, mode]) => window.__kb.openByPath(r, rel, mode), [root.id, rel, mode]);

// 组 1：长笔记.md（滚到约 60%，之后成为后台标签）+ 读书笔记.md（前台）
await open('笔记/长笔记.md', 'tab');
await win.waitForSelector('[data-testid="reader-markdown"] h2');
const bgMd = await active(win);
await win.evaluate((id) => {
  const el = document.querySelector(`.view-root[data-item-id="${id}"] [data-testid="reader-markdown"]`);
  el.scrollTop = Math.round(0.6 * (el.scrollHeight - el.clientHeight));
}, bgMd);
await win.waitForTimeout(300);
await open('笔记/2026/读书笔记.md', 'tab');
// 组 2：长文档.pdf（第 7 页，之后成为后台）+ 讲义.pdf（前台）
await open('资料/长文档.pdf', 'right');
await win.waitForFunction((id) => !!document.querySelector(`.view-root[data-item-id="${id}"] .pdf-page[data-rendered="1"]`), await active(win), { timeout: 20000 });
const bgPdf = await active(win);
await win.evaluate((id) => {
  const el = document.querySelector(`.view-root[data-item-id="${id}"] [data-testid="reader-pdf"]`);
  el.scrollTop = el.querySelector('.pdf-page[data-page="7"]').offsetTop - el.querySelector('.pdf-toolbar').offsetHeight + 5;
}, bgPdf);
await win.waitForFunction((id) => document.querySelector(`.view-root[data-item-id="${id}"] [data-testid="reader-pdf"]`)?.dataset.page === '7', bgPdf, { timeout: 5000 });
await open('资料/论文/讲义.pdf', 'tab');
await win.waitForSelector('[data-testid="reader-pdf"] .pdf-page[data-rendered="1"]');
await win.evaluate(() => window.__kb.flush());
const items0 = await win.evaluate(() => window.__kb.items());
const mdScroll0 = items0[bgMd].state.data.scroll;
const pdfState0 = items0[bgPdf].state.data;
check('准备：两个分栏各有一个后台标签（Markdown 滚动约 60%、PDF 第 7 页）', mdScroll0 > 0.5 && pdfState0.page === 7, JSON.stringify({ mdScroll0, pdfState0 }));
// 不做空闲加载，便于断言“启动时没有加载”
await win.evaluate(() => window.kb.setLayout('settings.backgroundLoadDelayMs', -1));
await win.waitForTimeout(400);
const layout0 = await storedLayout(win);
await app.close();

// ---- 冷启动
fs.rmSync(path.join(USERDATA, 'startup-trace.json'), { force: true });
({ app, win } = await launch());
// 注意：waitForFunction 不会等待异步谓词返回的 Promise，这里在 Node 侧轮询
const waitMark = async (name, ms = 20000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if ((await win.evaluate(() => window.kb.getStartupTrace())).some((m) => m.name === name)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};
const gotVisible = await waitMark('renderer:visible-content-loaded');
const st = await win.evaluate(() => window.__kb.lazyState());
const dom = await win.evaluate(([a, b]) => ({
  // 隐藏标签的内容 DOM 被 dockview 摘下，所以用宿主登记的“已挂载视图”判断
  mountedBg: [a, b].filter((id) => window.__kb.lazyState().mounted.includes(id)),
  lazyTabs: document.querySelectorAll('.dv-tab[data-lazy="pending"]').length,
  visibleMounted: window.__dock.panels.filter((p) => p.api.isVisible).every((p) => !!document.querySelector(`.view-root[data-item-id="${p.id}"]`)),
  tabs: window.__dock.panels.length,
  groups: window.__dock.groups.length,
}), [bgMd, bgPdf]);
const pdfFetched = await win.evaluate((rid) => performance.getEntriesByType('resource').some((e) => e.name.includes(rid)), items0[bgPdf].ref);
check('冷启动：工作区完整恢复（4 个标签、2 个分栏），可见面板已加载（可见内容加载完成标记已到）', gotVisible && st.visible.done && dom.tabs === 4 && dom.groups === 2 && dom.visibleMounted, JSON.stringify(dom));
check('后台标签在启动时没有被加载：未挂载视图、标签带 data-lazy="pending"、后台 PDF 文件未被读取', dom.mountedBg.length === 0 && dom.lazyTabs === 2 && st.pending.includes(bgMd) && st.pending.includes(bgPdf) && !pdfFetched, JSON.stringify({ dom, st, pdfFetched }));
await win.screenshot({ path: path.join(VERIFY, 'lazy-startup.png') });

// 启动计时文件：三个指标
const traceFile = path.join(USERDATA, 'startup-trace.json');
const t0 = Date.now();
while (!fs.existsSync(traceFile) && Date.now() - t0 < 25000) await new Promise((r) => setTimeout(r, 200));
const trace = fs.existsSync(traceFile) ? JSON.parse(fs.readFileSync(traceFile, 'utf8')) : null;
const sm = trace?.summary ?? {};
check('startup-trace.json 有三个指标：窗口出现 ≤ 可交互 ≤ 可见内容加载完成', sm.windowShownMs > 0 && sm.interactiveMs >= sm.windowShownMs && sm.visibleContentLoadedMs >= sm.interactiveMs && !sm.visibleContentTimedOut, JSON.stringify(sm));
fs.copyFileSync(traceFile, path.join(VERIFY, 'startup-trace-lazy.json'));

// 布局数据不变（分级加载只在内容层）
await win.waitForTimeout(800);
const layout1 = await storedLayout(win);
check('分级加载不改布局数据：启动后保存的 dock 布局与条目（含后台标签的阅读状态）与关闭前完全相同', layout1.dock === layout0.dock && layout1.items === layout0.items);

// ---- 切到后台标签：加载并恢复阅读位置
await win.evaluate((id) => window.__dock.getPanel(id).api.setActive(), bgMd);
await win.waitForFunction((id) => !!document.querySelector(`.view-root[data-item-id="${id}"] [data-testid="reader-markdown"] h2`), bgMd, { timeout: 10000 });
await win.waitForTimeout(300);
const mdNow = await win.evaluate((id) => {
  const el = document.querySelector(`.view-root[data-item-id="${id}"] [data-testid="reader-markdown"]`);
  return +(el.scrollTop / (el.scrollHeight - el.clientHeight)).toFixed(4);
}, bgMd);
check('切到后台 Markdown 标签：内容加载，滚动位置恢复（±1%）', Math.abs(mdNow - mdScroll0) <= 0.01, `${mdScroll0} → ${mdNow}`);
await win.evaluate((id) => window.__dock.getPanel(id).api.setActive(), bgPdf);
await win.waitForFunction((id) => !!document.querySelector(`.view-root[data-item-id="${id}"] .pdf-page[data-rendered="1"]`), bgPdf, { timeout: 15000 });
await win.waitForTimeout(300);
const pdfNow = await win.evaluate((id) => {
  const el = document.querySelector(`.view-root[data-item-id="${id}"] [data-testid="reader-pdf"]`);
  return { page: Number(el.dataset.page), scale: Number(el.dataset.scale) };
}, bgPdf);
check('切到后台 PDF 标签：加载并恢复到第 7 页、原缩放', pdfNow.page === 7 && Math.abs(pdfNow.scale - pdfState0.scale) < 0.001, JSON.stringify({ pdfNow, pdfState0 }));
await win.screenshot({ path: path.join(VERIFY, 'lazy-after-switch.png') });
const st2 = await win.evaluate(() => window.__kb.lazyState());
check('切换过的后台标签不再处于待加载状态，标签上的 data-lazy 已去掉', st2.pending.length === 0 && (await win.$$('.dv-tab[data-lazy="pending"]')).length === 0, JSON.stringify(st2.pending));

// ---- 空闲加载：设置 300ms，回到前台标签后重启
await win.evaluate(([a, b]) => {
  window.__dock.panels.filter((p) => ![a, b].includes(p.id)).forEach((p) => p.api.setActive());
}, [bgMd, bgPdf]);
await win.evaluate(() => window.kb.setLayout('settings.backgroundLoadDelayMs', 300));
await win.evaluate(() => window.__kb.flush());
await win.waitForTimeout(300);
await app.close();
({ app, win } = await launch());
const idleStart = await win.evaluate(() => window.__kb.lazyState());
const idleOk = await win.waitForFunction(() => window.__kb.lazyState().pending.length === 0 && window.__kb.lazyState().deferredEver.length === 2, null, { timeout: 15000, polling: 100 }).then(() => true, () => false);
const idleDom = await win.evaluate(([a, b]) => ({
  mounted: [a, b].filter((id) => window.__kb.lazyState().mounted.includes(id)).length,
  active: window.__dock.panels.filter((p) => p.api.isActive).map((p) => p.id),
}), [bgMd, bgPdf]);
check('空闲时后台标签自动加载（可见内容就绪 + 设置的延迟之后逐个加载，不切换前台标签）', idleStart.pending.length === 2 && idleOk && idleDom.mounted === 2 && !idleDom.active.includes(bgMd) && !idleDom.active.includes(bgPdf), JSON.stringify({ idleStart: idleStart.pending.length, idleDom }));
await app.close();

// ---- 分级加载 + 收起成气泡：收起的面板按后台标签处理（不在启动时加载、不算“可见内容”），点气泡立即加载
({ app, win } = await launch());
await win.evaluate(() => window.kb.setLayout('settings.backgroundLoadDelayMs', -1));
const byTitle = (t) => win.evaluate((t) => window.__dock.panels.find((p) => p.title === t)?.id, t);
const fgMd = await byTitle('读书笔记.md');
const fgPdf = await byTitle('讲义.pdf');
// 先把前台 Markdown 收起：同组的长笔记成为可见标签；再让 PDF 组的长文档.pdf 保持后台
await win.evaluate((id) => window.__kb.pm.collapseToBubble(id), fgMd);
await win.evaluate((id) => window.__dock.getPanel(id).api.setActive(), fgPdf);
await win.waitForTimeout(300);
await win.evaluate(() => window.__kb.flush());
await win.waitForTimeout(300);
await app.close();
({ app, win } = await launch());
const gotVisibleC = await waitMark('renderer:visible-content-loaded');
const stC = await win.evaluate(() => window.__kb.lazyState());
const domC = await win.evaluate((id) => ({
  bubble: !!document.querySelector(`[data-testid="pm-bubble"][data-panel-id="${id}"]`),
  collapsed: window.__kb.pm.list().find((w) => w.id === id)?.mode,
  timedOut: false,
}), fgMd);
const traceC = await win.evaluate(() => window.kb.getStartupTrace());
check(
  '分级加载 + 收起：收起的面板在启动时不加载（不挂载视图、仍待加载），不计入“可见内容”；可见内容加载完成标记照常到达（没有等到超时）',
  gotVisibleC && domC.bubble && domC.collapsed === 'collapsed' && !stC.mounted.includes(fgMd) && stC.pending.includes(fgMd) && !stC.visible.expected.includes(fgMd) && stC.visible.done && !traceC.some((m) => m.name === 'renderer:visible-content-timeout'),
  JSON.stringify({ domC, stC }),
);
check('分级加载 + 收起：同组接替显示的标签与其他分栏可见标签已加载，另一分栏的后台标签仍待加载', stC.mounted.includes(bgMd) && stC.mounted.includes(fgPdf) && stC.pending.includes(bgPdf), JSON.stringify(stC));
await win.click(`[data-testid="pm-bubble"][data-panel-id="${fgMd}"]`);
const restoredC = await win.waitForFunction((id) => !!document.querySelector(`.view-root[data-item-id="${id}"] [data-testid="reader-markdown"] article > *`), fgMd, { timeout: 10000 }).then(() => true, () => false);
const stC2 = await win.evaluate(() => window.__kb.lazyState());
check('点气泡恢复：面板立即加载并显示内容（不等空闲加载），不再处于待加载状态；后台标签不受影响', restoredC && stC2.mounted.includes(fgMd) && !stC2.pending.includes(fgMd) && stC2.pending.includes(bgPdf) && (await win.evaluate((id) => window.__kb.pm.list().find((w) => w.id === id)?.mode, fgMd)) !== 'collapsed', JSON.stringify(stC2));
await win.screenshot({ path: path.join(VERIFY, 'lazy-collapsed-restored.png') });
await app.close();

fs.writeFileSync(path.join(VERIFY, 'e2e-lazy.json'), JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
