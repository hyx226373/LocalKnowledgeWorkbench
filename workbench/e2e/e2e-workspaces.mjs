// 端到端：命名工作区（跨两个根）、切换/重启恢复、切换时与退出时立即保存、外观切换不改变布局与进度、
// 导出/导入、改名/按项目分组、删除、布局预设、file + web(桩) + app(桩) 混合条目。
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE = process.env.KB_SAMPLE || '/workspace/kb-sample';
const VERIFY = path.join(ROOT, 'verify');
const TMP = path.join(ROOT, 'e2e/.tmp');
const USERDATA = path.join(TMP, 'userdata-ws');
const R1 = path.join(TMP, 'root1 资料库'); // 路径含空格与中文
const R2 = path.join(TMP, 'root2 写作');
for (const d of [USERDATA, R1, R2]) fs.rmSync(d, { recursive: true, force: true });
fs.cpSync(SAMPLE, R1, { recursive: true });
fs.mkdirSync(path.join(R2, '草稿'), { recursive: true });
fs.mkdirSync(path.join(R2, '参考'), { recursive: true });
const longMd = ['# 第一章 绪论', '', ...Array.from({ length: 120 }, (_, i) => `## 第 ${i + 1} 节\n\n这是用于测试滚动位置的段落，第 ${i + 1} 段。工作区需要精确恢复阅读进度。`)].join('\n\n');
fs.writeFileSync(path.join(R2, '草稿/第一章.md'), longMd);
fs.writeFileSync(path.join(R2, '草稿/提纲.txt'), '一、绪论\n二、方法\n三、结果');
fs.copyFileSync(path.join(SAMPLE, '资料/论文/讲义.pdf'), path.join(R2, '参考/讲义副本.pdf'));
// 应被忽略的目录（与索引规则一致）：默认不出现在目录树中
fs.mkdirSync(path.join(R2, 'node_modules/pkg'), { recursive: true });
fs.writeFileSync(path.join(R2, 'node_modules/pkg/index.js'), '');
fs.mkdirSync(path.join(R2, '.git'), { recursive: true });
fs.writeFileSync(path.join(R2, '.git/HEAD'), 'ref: refs/heads/main');
fs.mkdirSync(VERIFY, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? '  — ' + detail : ''}`);
}

async function launch() {
  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'], cwd: ROOT, env: { ...process.env, KB_USER_DATA: USERDATA, KB_BUILTIN_ADAPTERS_DIR: 'none' /* r11-A：本脚本的混合工作区要求“未装 web.generic”，不加载内置适配器 */ } });
  const win = await app.firstWindow();
  win.on('console', (m) => m.type() === 'error' && !/403/.test(m.text()) && console.log('[renderer]', m.text()));
  await win.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800));
  const end = Date.now() + 20000;
  while (!(await win.evaluate(() => window.__layoutRestored === true))) {
    if (Date.now() > end) throw new Error('布局恢复超时');
    if (await win.locator('[data-testid="dialog"]').count()) await win.click('[data-testid="dialog-ok"]');
    await win.waitForTimeout(100);
  }
  await waitReaders(win);
  return { app, win };
}

/** 分组内容容器；web 条目用 dockview 的 'always' 渲染器，内容在分组外的覆盖层里，按当前标签的 itemId 找 */
// 分组内容：web 条目用 dockview 的 always 渲染器，内容在分组外的 .dv-render-overlay 中，按当前标签 itemId 查找（见 waitReaders/snap 内联函数）
const CONTENT_OF = null;
/** 等所有分组的当前标签内容就绪（PDF 已渲染、文本已出现、占位已显示） */
async function waitReaders(win) {
  await win.waitForFunction(
    (src) =>
      [...document.querySelectorAll('.kb-dock .dv-groupview')].every((g) => {
        const c = ((g) => {
  const c = g.querySelector('.dv-content-container');
  if (c && c.querySelector('.dv-react-part > *')) return c;
  const grp = (window.__dock?.groups || []).find((x) => x.element === g || g.contains(x.element) || x.element?.contains(g));
  const id = grp?.activePanel?.params?.itemId;
  const el = id && document.querySelector('.dv-render-overlay [data-item-id="' + id + '"]');
  return el ? el.closest('.dv-render-overlay') : c;
})(g);
        if (!c) return false;
        if (c.querySelector('[data-testid="placeholder"]')) return true;
        const pdf = c.querySelector('[data-testid="reader-pdf"]');
        if (pdf) return !!pdf.querySelector('.pdf-page[data-rendered="1"]');
        const md = c.querySelector('[data-testid="reader-markdown"] article');
        if (md) return md.children.length > 0;
        return !!c.querySelector('[data-testid="reader-text"] pre, [data-testid="view-csv-table"] table, [data-testid="reader-image"] img');
      }),
    CONTENT_OF,
    { timeout: 20000 },
  );
  await win.waitForTimeout(300);
}

async function snap(win) {
  return win.evaluate((src) => {
    const items = window.__kb.items();
    const dock = window.__dock;
    const contentOf = (g) => {
  const c = g.querySelector('.dv-content-container');
  if (c && c.querySelector('.dv-react-part > *')) return c;
  const grp = (window.__dock?.groups || []).find((x) => x.element === g || g.contains(x.element) || x.element?.contains(g));
  const id = grp?.activePanel?.params?.itemId;
  const el = id && document.querySelector('.dv-render-overlay [data-item-id="' + id + '"]');
  return el ? el.closest('.dv-render-overlay') : c;
};
    const groups = [...document.querySelectorAll('.kb-dock .dv-groupview')].map((g) => {
      const r = g.getBoundingClientRect();
      const c = contentOf(g);
      const pdf = c.querySelector('[data-testid="reader-pdf"]');
      const md = c.querySelector('[data-testid="reader-markdown"], [data-testid="reader-text"]');
      const ph = c.querySelector('[data-testid="placeholder"]');
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
        tabs: [...g.querySelectorAll('.dv-tab')].map((t) => t.textContent.trim()),
        active: g.querySelector('.dv-tab.dv-active-tab')?.textContent.trim(),
        pdf: pdf ? { page: pdf.dataset.page, scale: pdf.dataset.scale, top: Math.round(pdf.scrollTop) } : null,
        text: md ? { top: Math.round(md.scrollTop) } : null,
        placeholder: ph ? `${ph.dataset.sourceKind}:${ph.dataset.kind}` : null,
      };
    });
    return {
      ws: window.__kb.currentWorkspaceId(),
      name: document.querySelector('[data-testid="status-workspace"]')?.textContent.trim(),
      panels: dock.panels.map((p) => ({ title: p.title, adapterId: items[p.params.itemId]?.adapterId, ref: items[p.params.itemId]?.ref, kind: items[p.params.itemId]?.sourceKind })).sort((a, b) => (a.title + a.ref).localeCompare(b.title + b.ref)),
      groups,
      sidebar: Math.round(document.querySelector('[data-testid="sidebar"]').getBoundingClientRect().width),
    };
  }, CONTENT_OF);
}
function same(a, b, { tol = 3 } = {}) {
  const errs = [];
  if (a.ws !== b.ws) errs.push('工作区不同');
  if (JSON.stringify(a.panels) !== JSON.stringify(b.panels)) errs.push('面板不同');
  if (a.groups.length !== b.groups.length) errs.push(`分组数 ${a.groups.length}≠${b.groups.length}`);
  if (Math.abs(a.sidebar - b.sidebar) > tol) errs.push(`侧栏 ${a.sidebar}≠${b.sidebar}`);
  a.groups.forEach((g, i) => {
    const h = b.groups[i];
    if (!h) return;
    for (const k of ['x', 'y', 'w', 'h']) if (Math.abs(g[k] - h[k]) > tol) errs.push(`组${i}.${k} ${g[k]}≠${h[k]}`);
    if (JSON.stringify(g.tabs) !== JSON.stringify(h.tabs) || g.active !== h.active) errs.push(`组${i} 标签不同`);
    if (JSON.stringify(g.placeholder) !== JSON.stringify(h.placeholder)) errs.push(`组${i} 占位不同`);
    if (!!g.pdf !== !!h.pdf || (g.pdf && (g.pdf.page !== h.pdf.page || g.pdf.scale !== h.pdf.scale || Math.abs(g.pdf.top - h.pdf.top) > 4))) errs.push(`组${i} PDF ${JSON.stringify(g.pdf)}≠${JSON.stringify(h.pdf)}`);
    if (!!g.text !== !!h.text || (g.text && Math.abs(g.text.top - h.text.top) > 3)) errs.push(`组${i} 滚动 ${JSON.stringify(g.text)}≠${JSON.stringify(h.text)}`);
  });
  return errs;
}
const fmt = (s) => s.groups.map((g) => `${g.w}x${g.h}${g.pdf ? ` p${g.pdf.page}@${g.pdf.scale}` : ''}${g.text ? ` ↓${g.text.top}` : ''}${g.placeholder ? ` [${g.placeholder}]` : ''}`).join(' | ');

const nextFrames = (win) => win.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
async function openMenu(win) {
  if (!(await win.locator('[data-testid="ws-menu"]').count())) await win.click('[data-testid="ws-switcher"]');
  await win.waitForSelector('[data-testid="ws-menu"]');
}
async function closeMenu(win) {
  if (await win.locator('[data-testid="ws-menu"]').count()) await win.click('[data-testid="ws-switcher"]');
}
async function promptDialog(win, values) {
  await win.waitForSelector('[data-testid="dialog"]');
  for (const [k, v] of Object.entries(values)) await win.fill(`[data-testid="dialog-field-${k}"]`, v);
  await win.click('[data-testid="dialog-ok"]');
  await win.waitForSelector('[data-testid="dialog"]', { state: 'detached' });
}
async function createWs(win, name, project) {
  const before = await win.evaluate(() => window.__kb.currentWorkspaceId());
  await openMenu(win);
  await win.click('[data-testid="ws-new"]');
  await promptDialog(win, { name, project });
  await win.waitForFunction((b) => window.__kb.currentWorkspaceId() !== b, before);
  await win.waitForTimeout(200);
  return win.evaluate(() => window.__kb.currentWorkspaceId());
}
async function switchWs(win, id) {
  await openMenu(win);
  await win.click(`[data-testid="ws-item"][data-ws-id="${id}"]`);
  await win.waitForFunction((i) => window.__kb.currentWorkspaceId() === i, id);
  await waitReaders(win);
}
async function addRoot(app, win, dir) {
  const n = await win.locator('[data-testid="root-row"]').count();
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
  }, dir);
  await win.click('[data-testid="pick-folder"]');
  await win.waitForFunction((k) => document.querySelectorAll('[data-testid="root-row"]').length === k + 1, n);
  return win.evaluate(async (p) => (await window.kb.listRoots()).find((r) => r.path === p).id, dir);
}
const openP = (win, rootId, rel, mode) => win.evaluate(([r, p, m]) => window.__kb.openByPath(r, p, m), [rootId, rel, mode]);
async function scrollPdfTo(win, page) {
  await win.evaluate((n) => {
    const el = document.querySelector('[data-testid="reader-pdf"]');
    el.scrollTop = el.querySelector(`.pdf-page[data-page="${n}"]`).offsetTop - el.querySelector('.pdf-toolbar').offsetHeight + 5;
  }, page);
  await win.waitForFunction((n) => document.querySelector('[data-testid="reader-pdf"]')?.dataset.page === String(n), page);
}
const scrollMd = (win, f) =>
  win.evaluate((x) => {
    const el = document.querySelector('[data-testid="reader-markdown"]');
    el.scrollTop = Math.round(x * (el.scrollHeight - el.clientHeight));
  }, f);
async function dragFirstSash(win, dx) {
  const sash = win.locator('.kb-dock .dv-split-view-container.dv-horizontal > .dv-sash-container > .dv-sash').first();
  const sb = await sash.boundingBox();
  await win.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await win.mouse.down();
  await win.mouse.move(sb.x + sb.width / 2 + dx, sb.y + sb.height / 2, { steps: 10 });
  await win.mouse.up();
  await win.mouse.move(5, 790);
  await win.waitForTimeout(300);
}
/** 已保存的工作区；layout.items 按项目表重建（schema 4 的布局本身不内联条目） */
const stored = (win, id) =>
  win.evaluate(async (i) => {
    const ws = await window.kb.getWorkspace(i);
    return { ...ws, layout: { ...ws.layout, inlineItems: ws.layout.items, items: Object.fromEntries(ws.items.map((x) => [x.itemId, x])) } };
  }, id);

// ============================================================ 启动 #1
let { app, win } = await launch();
const r1 = await addRoot(app, win, R1);
const r2 = await addRoot(app, win, R2);
check('注册两个根（路径含空格与中文）', !!r1 && !!r2);
{
  const treeHas = (rel) => win.locator(`[data-testid="tree-row"][data-relpath="${rel}"]`).count();
  await win.locator('[data-testid="tree-row"][data-relpath="草稿"]').first().waitFor();
  const hidden = [await treeHas('node_modules'), await treeHas('.git')];
  await win.check('[data-testid="toggle-show-ignored"]');
  await win.locator('[data-testid="tree-row"][data-relpath="node_modules"][data-ignored="1"]').waitFor({ timeout: 5000 });
  const shown = [await treeHas('node_modules'), await treeHas('.git')];
  await win.uncheck('[data-testid="toggle-show-ignored"]');
  await win.waitForFunction(() => !document.querySelector('[data-testid="tree-row"][data-relpath="node_modules"]'), null, { timeout: 5000 });
  const search = await win.evaluate(() => window.kb.search('index.js'));
  check('目录树与索引同一套忽略规则：node_modules、.git 默认不显示；“显示被忽略的项”打开后以淡色显示，关闭后再隐藏；不进入搜索', hidden.every((n) => n === 0) && shown.every((n) => n === 1) && search.length === 0, JSON.stringify({ hidden, shown, search: search.length }));
}

// ---- 工作区「读文献」（项目：论文）：根1 的 PDF | 根2 的 Markdown
const ws1 = await createWs(win, '读文献', '论文');
await openP(win, r1, '资料/论文/讲义.pdf', 'tab');
await win.waitForSelector('[data-testid="reader-pdf"] .pdf-page[data-rendered="1"]');
await openP(win, r2, '草稿/第一章.md', 'right');
await waitReaders(win);
await win.click('[data-testid="pdf-zoom-in"]');
await win.waitForFunction(() => document.querySelector('[data-testid="reader-pdf"]')?.dataset.scale !== '1');
await waitReaders(win);
await scrollPdfTo(win, 2);
await scrollMd(win, 0.5);
await dragFirstSash(win, -110);
await win.waitForTimeout(300);
const S1 = await snap(win);
await win.screenshot({ path: path.join(VERIFY, 'ws-读文献.png') });
check('工作区「读文献」：根1 PDF（放大、第 2 页）| 根2 Markdown（滚动一半）', S1.groups.length === 2 && S1.groups[0].pdf?.page === '2' && S1.groups[1].text?.top > 0, fmt(S1));

// ---- 工作区「写作」（项目：写作）：根2 Markdown | 根2 PDF / 根1 txt（上下）
const ws2 = await createWs(win, '写作', '写作');
check('新建工作区从空布局开始', (await win.evaluate(() => window.__dock.panels.length)) === 0);
await openP(win, r2, '草稿/第一章.md', 'tab');
await waitReaders(win);
await openP(win, r2, '参考/讲义副本.pdf', 'right');
await waitReaders(win);
await openP(win, r1, '笔记/待办.txt', 'below');
await waitReaders(win);
await scrollPdfTo(win, 3);
await dragFirstSash(win, 140);
await scrollMd(win, 0.25);
await nextFrames(win);
let S2 = await snap(win);
// 立即切换（不等自动保存的 300ms）：切换前必须先写完
await switchWs(win, ws1);
const back1 = await snap(win);
let e = same(back1, S1);
check('切回「读文献」：标签/分栏/尺寸/PDF 页码与缩放/Markdown 滚动完全恢复', !e.length, e.join('; ') || fmt(back1));
await switchWs(win, ws2);
const back2 = await snap(win);
e = same(back2, S2);
check('切回「写作」（切换前的最后一次滚动未丢失）', !e.length, e.join('; ') || fmt(back2));
check('两个工作区的文件与分栏不同', JSON.stringify(S1.panels) !== JSON.stringify(S2.panels) && S1.groups.length === 2 && S2.groups.length === 3);
await win.screenshot({ path: path.join(VERIFY, 'ws-写作.png') });

// ---- 外观切换：外框 A（study）+ 阅读区 C（bright）+ 浅色 —— 不改变布局与进度
const topHeading = (w) =>
  w.evaluate(() => {
    const el = document.querySelector('[data-testid="reader-markdown"]');
    const top = el.getBoundingClientRect().top;
    return [...el.querySelectorAll('h1,h2')].find((h) => h.getBoundingClientRect().bottom > top + 1)?.textContent;
  });
// 精确锚点：视口顶部所在块（文章的第几个子元素）+ 视口顶边在块内的比例，以及读数用的字号/外框高度
const mdAnchor = (w) =>
  w.evaluate(() => {
    const el = document.querySelector('[data-testid="reader-markdown"]');
    const top = el.getBoundingClientRect().top;
    const kids = [...el.firstElementChild.children];
    const idx = kids.findIndex((n) => n.getBoundingClientRect().bottom > top + 1);
    const r = kids[idx].getBoundingClientRect();
    const p = el.querySelector('p');
    // 若按滚动比例恢复，视口顶部会是哪一块（用于说明本检查能区分两种策略）
    const max = el.scrollHeight - el.clientHeight;
    const ratio = el.scrollTop / max;
    return { ratio: +ratio.toFixed(4), idx, tag: kids[idx].tagName, text: kids[idx].textContent.slice(0, 24), frac: +((top - r.top) / r.height).toFixed(3), scrollTop: Math.round(el.scrollTop), viewTop: Math.round(top), clientH: el.clientHeight, fontSize: getComputedStyle(p).fontSize, lineHeight: getComputedStyle(p).lineHeight };
  });
// 先滚到一个块的中间（不是块边界），才能区分「按锚点」与「按像素/比例」；
// 文章开头插入一个不随字号缩放的固定高度块（相当于大图），使「保持比例」与「保持锚点」给出不同的位置
await win.evaluate(() => {
  const el = document.querySelector('[data-testid="reader-markdown"]');
  const fixed = document.createElement('div');
  fixed.id = 'kb-e2e-fixed-block';
  fixed.style.height = '3000px';
  el.firstElementChild.prepend(fixed);
  const kids = [...el.firstElementChild.children].filter((n) => n.tagName === 'P' && n.offsetHeight >= 20);
  const b = kids[Math.floor(kids.length / 2)];
  el.scrollTop += b.getBoundingClientRect().top - el.getBoundingClientRect().top + Math.round(b.offsetHeight * 0.4);
});
await nextFrames(win);
await win.waitForTimeout(100);
S2 = await snap(win); // 以滚到块中间后的状态为切换前基准
const A0 = await mdAnchor(win);
const headBefore = await topHeading(win);
await win.evaluate(() => window.__kb.flush());
const layoutBefore = (await stored(win, ws2)).layout;
// 外观弹层已迁入「更多」；保持阅读面板挂载，沿用弹层断言。
await win.click('[data-testid="top-more"]');
await win.click('[data-testid="appearance-button"]');
await win.selectOption('[data-testid="appearance-chrome"]', 'study');
await win.selectOption('[data-testid="appearance-reading"]', 'bright');
await win.selectOption('[data-testid="appearance-scheme"]', 'light');
await win.click('[data-testid="top-more"]');
await win.mouse.move(5, 790);
await win.waitForTimeout(600);
const attrs = await win.evaluate(() => [document.documentElement.dataset.kbChrome, document.documentElement.dataset.kbReading, document.documentElement.dataset.kbScheme].join());
const T = await snap(win);
await win.screenshot({ path: path.join(VERIFY, 'theme-switch-studyA-brightC-light.png') });
check('外框与阅读区可独立组合（study 外框 + bright 阅读区 + 浅色）', attrs === 'study,bright,light', attrs);
// 外框的尺寸令牌（顶栏/标签高度）不同，可用高度随之变化；分栏结构、宽度、水平位置与比例不变
const dockH = (x) => x.groups.reduce((m, g) => Math.max(m, g.y + g.h), 0) - Math.min(...x.groups.map((g) => g.y));
const ratioOk = T.groups.every((g, i) => Math.abs(g.h / dockH(T) - S2.groups[i].h / dockH(S2)) < 0.01);
e = same({ ...T, groups: T.groups.map((g, i) => ({ ...g, y: S2.groups[i].y, h: S2.groups[i].h, text: S2.groups[i].text })) }, S2);
check('外观切换后：标签、分栏结构、各栏宽度/水平位置、高度比例、PDF 页码/缩放/页内位置不变', !e.length && ratioOk, e.join('; ') || fmt(T));
check('外观切换后 Markdown 阅读位置不变（视口顶部仍是同一节）', (await topHeading(win)) === headBefore, `${headBefore}`);
const A1 = await mdAnchor(win);
const anchorOk = (a, b) => a.idx === b.idx && Math.abs(a.frac - b.frac) <= 0.05;
check(
  '外观切换（字号/行高/外框尺寸都变）后 Markdown 按锚点保持：视口顶部仍是同一块、块内位置相同，而 scrollTop 像素值已随排版改变',
  A0.fontSize !== A1.fontSize && A0.viewTop !== A1.viewTop && anchorOk(A0, A1) && A0.scrollTop !== A1.scrollTop && Math.abs(A0.ratio - A1.ratio) > 0.01,
  JSON.stringify({ before: A0, after: A1, note: '比例不同说明不是按比例/像素恢复' }),
);
await win.evaluate(() => window.__kb.flush());
const layoutAfter = (await stored(win, ws2)).layout;
const fileStates = (l) => JSON.stringify(Object.values(l.items).filter((i) => i.adapterId !== 'builtin.markdown').map((i) => [i.ref, i.state]));
check(
  '外观切换不改写工作区：条目、PDF 状态、侧栏宽度、网格结构相同（Markdown 只按新排版更新等价的滚动比例）',
  fileStates(layoutBefore) === fileStates(layoutAfter) && JSON.stringify(layoutBefore.shell) === JSON.stringify(layoutAfter.shell) && Object.keys(layoutBefore.items).join() === Object.keys(layoutAfter.items).join() && JSON.stringify(layoutBefore.dock.panels) === JSON.stringify(layoutAfter.dock.panels),
  `${fileStates(layoutBefore)} → ${fileStates(layoutAfter)}`,
);
// 外观弹层已迁入「更多」；保持阅读面板挂载，沿用弹层断言。
await win.click('[data-testid="top-more"]');
await win.click('[data-testid="appearance-button"]');
await win.selectOption('[data-testid="appearance-chrome"]', 'pro');
await win.selectOption('[data-testid="appearance-reading"]', 'pro');
await win.selectOption('[data-testid="appearance-scheme"]', 'dark');
await win.click('[data-testid="top-more"]');
await win.mouse.move(5, 790);
await win.waitForTimeout(600);
const A2 = await mdAnchor(win);
e = same(await snap(win), S2);
check('切回原外观：与切换前完全一致', !e.length, e.join('; '));
// 正文总高度不变、但锚点上方内容高度变了（外观 CSS 只改了部分块的尺寸）：ResizeObserver 不触发，靠外观切换事件校正
const A3 = await win.evaluate(() => {
  const el = document.querySelector('[data-testid="reader-markdown"]');
  const art = el.firstElementChild;
  const h0 = art.offsetHeight;
  document.getElementById('kb-e2e-fixed-block').style.height = '2000px';
  const tail = document.createElement('div');
  tail.id = 'kb-e2e-tail-block';
  tail.style.height = '1000px';
  art.append(tail);
  window.dispatchEvent(new Event('kb:appearance-changed'));
  return { sameHeight: art.offsetHeight === h0 };
});
await nextFrames(win);
await win.waitForTimeout(100);
const A4 = await mdAnchor(win);
check('外观变化但正文总高度不变（只有锚点上方的块变了尺寸）：仍按锚点校正', A3.sameHeight && anchorOk(A2, A4), JSON.stringify({ ...A3, A4 }));
await win.evaluate(() => {
  document.getElementById('kb-e2e-fixed-block')?.remove();
  document.getElementById('kb-e2e-tail-block')?.remove();
});
await nextFrames(win);
check('切回原外观后 Markdown 锚点仍是同一块、同一块内位置（像素值回到原值 ±2）', anchorOk(A0, A2) && Math.abs(A2.scrollTop - A0.scrollTop) <= 2, JSON.stringify(A2));

// ---- file + web(桩) + app(桩) 混合条目的工作区
const pdfRid = await win.evaluate(async ([r]) => (await window.kb.listDir(r, '资料/论文')).find((x) => x.name === '讲义.pdf').resourceId, [r1]);
const leaf = (id, n, size) => ({ type: 'leaf', size, data: { views: [id], activeView: id, id: String(n) } });
const mixedLayout = {
  schema: 3,
  shell: { sidebarWidth: 260 },
  items: {
    f1: { itemId: 'f1', sourceKind: 'file', adapterId: 'builtin.pdf', ref: pdfRid, displayMode: 'in-app-reader', state: { v: 1, data: { page: 2, scale: 1.4 } } },
    w1: { itemId: 'w1', sourceKind: 'web', adapterId: 'web.generic', ref: 'https://example.com/docs', displayMode: 'in-app-web', state: { v: 1, data: { scrollY: 300 } } },
    a1: { itemId: 'a1', sourceKind: 'app', adapterId: 'app.zotero', ref: 'profile-zotero', displayMode: 'external-managed', state: { v: 1, data: { collection: 'x' } } },
  },
  dock: {
    grid: { root: { type: 'branch', size: 760, data: [leaf('f1', 1, 520), leaf('w1', 2, 250), leaf('a1', 3, 250)] }, width: 1020, height: 760, orientation: 'HORIZONTAL' },
    panels: {
      f1: { id: 'f1', contentComponent: 'view', title: '讲义.pdf', params: { itemId: 'f1' } },
      w1: { id: 'w1', contentComponent: 'view', title: '网页：example.com', params: { itemId: 'w1' } },
      a1: { id: 'a1', contentComponent: 'view', title: '应用：Zotero', params: { itemId: 'a1' } },
    },
    activeGroup: '1',
  },
};
const wsMixed = await win.evaluate((l) => window.kb.createWorkspace('混合条目', '测试', l).then((w) => w.id), mixedLayout);
await win.evaluate((id) => window.__kb.switchTo(id), wsMixed);
await waitReaders(win);
const M = await snap(win);
await win.screenshot({ path: path.join(VERIFY, 'ws-mixed-items.png') });
const ph = M.groups.map((g) => g.placeholder);
check('混合工作区：web 条目（P2 已开放，未装 web.generic）与 app 条目（P3 第 9 轮已开放，未装 app.zotero）都显示“缺少适配器”占位', ph[1] === 'web:adapter-missing' && ph[2] === 'app:adapter-missing', JSON.stringify(ph));
check('混合工作区：file 条目精确恢复（第 2 页，140%）', M.groups[0].pdf?.page === '2' && M.groups[0].pdf?.scale === '1.4', JSON.stringify(M.groups[0].pdf));
check('占位文案说明来源、显示方式、开放阶段与引用', /web\.generic/.test(await win.locator('[data-testid="placeholder"][data-source-kind="web"]').innerText()) && /外部窗口启动/.test(await win.locator('[data-testid="placeholder"][data-source-kind="app"]').innerText()));
await win.evaluate(() => window.__kb.flush());
const mixedStored = (await stored(win, wsMixed)).layout;
check('桩条目（含其状态）原样保留，不被改写或丢弃', JSON.stringify(mixedStored.items.w1) === JSON.stringify(mixedLayout.items.w1) && JSON.stringify(mixedStored.items.a1) === JSON.stringify(mixedLayout.items.a1));

// ---- 退出前立即保存：在「写作」中滚动后马上关闭窗口
await switchWs(win, ws2);
await scrollMd(win, 0.8);
await nextFrames(win);
const S2b = await snap(win);
await app.close();

// ============================================================ 启动 #2：重启恢复
({ app, win } = await launch());
let R = await snap(win);
e = same(R, S2b);
check('重启后打开上次的工作区「写作」，关闭前最后一次滚动已保存', !e.length, e.join('; ') || fmt(R));
await switchWs(win, ws1);
R = await snap(win);
e = same(R, S1);
check('重启后「读文献」完全恢复', !e.length, e.join('; ') || fmt(R));
await switchWs(win, wsMixed);
R = await snap(win);
e = same(R, M);
check('重启后混合工作区恢复：file 精确恢复、web/app 仍为占位', !e.length, e.join('; ') || fmt(R));

// ---- 改名 + 按项目分组
await openMenu(win);
await win.locator(`[data-testid="ws-item"][data-ws-id="${ws2}"]`).hover();
await win.locator(`[data-testid="ws-item"][data-ws-id="${ws2}"] [data-testid="ws-rename"]`).click();
await promptDialog(win, { name: '写作-初稿', project: '论文' });
await openMenu(win);
await win.waitForSelector(`[data-testid="ws-item"][data-ws-id="${ws2}"][data-ws-name="写作-初稿"]`);
const groupNames = await win.$$eval('[data-testid="ws-group"]', (els) => els.map((g) => [g.dataset.project, [...g.querySelectorAll('[data-testid="ws-item"]')].map((i) => i.dataset.wsName)]));
check('改名并移到项目「论文」：菜单按项目分组', JSON.stringify(groupNames.find(([p]) => p === '论文')?.[1]?.slice().sort()) === JSON.stringify(['写作-初稿', '读文献'].sort()), JSON.stringify(groupNames));
await win.screenshot({ path: path.join(VERIFY, 'ws-menu-groups.png') });
await closeMenu(win);

// ---- 命令面板中的工作区命令
await win.keyboard.press('Control+Shift+P');
await win.waitForSelector('[data-testid="command-palette"]');
const cmdIds = await win.$$eval('[data-testid="palette-item"]', (els) => els.map((e) => e.dataset.commandId));
check('命令面板含工作区命令（新建/另存/改名/删除/导出/导入/切换到…）', ['workspace.new', 'workspace.saveAs', 'workspace.rename', 'workspace.delete', 'workspace.export', 'workspace.import', `workspace.switch.${ws1}`].every((c) => cmdIds.includes(c)));
await win.keyboard.press('Escape');

// ---- 导出 / 导入 .kblayout.json
await switchWs(win, ws1);
const exportPath = path.join(TMP, '导出 测试', '读文献.kblayout.json');
fs.mkdirSync(path.dirname(exportPath), { recursive: true });
await app.evaluate(({ dialog }, p) => {
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: p });
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
}, exportPath);
await openMenu(win);
await win.locator(`[data-testid="ws-item"][data-ws-id="${ws1}"]`).hover();
await win.locator(`[data-testid="ws-item"][data-ws-id="${ws1}"] [data-testid="ws-export"]`).click();
await win.waitForSelector('[data-testid="toast"]');
const exported = fs.readFileSync(exportPath, 'utf8');
check(
  '导出文件不含绝对路径、不含文件内容，带布局版本与资源的“根名 + 相对路径”',
  !exported.includes(R1) && !exported.includes(R2) && !exported.includes(USERDATA) && !exported.includes('这是用于测试滚动位置') && /"layoutSchema": 4/.test(exported) && exported.includes('草稿/第一章.md'),
  `${exported.length} 字节`,
);
await openMenu(win);
await win.click('[data-testid="ws-import"]');
await win.waitForFunction((n) => document.querySelector('[data-testid="status-workspace"]')?.textContent.includes(n), '读文献 (2)', { timeout: 10000 });
await waitReaders(win);
const wsImp = await win.evaluate(() => window.__kb.currentWorkspaceId());
R = await snap(win);
e = same({ ...R, ws: S1.ws }, S1);
check('导入为「读文献 (2)」并完全恢复', !e.length, e.join('; ') || fmt(R));

// ---- 布局预设：只改排列，不改条目与阅读状态
const presetIds = await (async () => {
  await openMenu(win);
  const ids = await win.$$eval('[data-testid="ws-preset"]', (els) => els.map((e) => e.dataset.presetId));
  return ids;
})();
await win.click('[data-testid="ws-preset"][data-preset-id="builtin.two-rows"]');
await win.waitForTimeout(600);
await waitReaders(win);
const P = await snap(win);
check(
  '应用布局预设「上下两栏」：分栏变为上下，标签/条目/PDF 页码与缩放不变',
  P.groups.length === 2 && P.groups[0].x === P.groups[1].x && P.groups[0].y < P.groups[1].y && JSON.stringify(P.panels) === JSON.stringify(S1.panels) && P.groups.some((g) => g.pdf?.page === '2' && g.pdf?.scale === S1.groups[0].pdf.scale),
  `${presetIds.join(',')} → ${fmt(P)}`,
);

// ---- 删除（只删布局记录，不动文件）
await openMenu(win);
await win.locator(`[data-testid="ws-item"][data-ws-id="${wsImp}"]`).hover();
await win.locator(`[data-testid="ws-item"][data-ws-id="${wsImp}"] [data-testid="ws-delete"]`).click();
await win.waitForSelector('[data-testid="dialog"]');
await win.click('[data-testid="dialog-ok"]');
await win.waitForFunction((id) => window.__kb.currentWorkspaceId() !== id, wsImp);
await waitReaders(win);
const list = await win.evaluate(() => window.kb.listWorkspaces());
check('删除当前工作区后切到其他工作区；文件不受影响', !list.some((w) => w.id === wsImp) && fs.existsSync(path.join(R1, '资料/论文/讲义.pdf')) && fs.existsSync(path.join(R2, '草稿/第一章.md')), list.map((w) => w.name).join(','));
await app.close();

// ============================================================ 启动 #3：改名与删除已持久化
({ app, win } = await launch());
const list3 = await win.evaluate(() => window.kb.listWorkspaces());
check('重启后工作区列表（改名、项目分组、删除）保持', list3.some((w) => w.id === ws2 && w.name === '写作-初稿' && w.project === '论文') && !list3.some((w) => w.id === wsImp) && list3.length === 4, list3.map((w) => `${w.project}/${w.name}`).join(','));
await switchWs(win, ws2);
e = same(await snap(win), S2b);
check('再次重启后「写作-初稿」仍完全恢复', !e.length, e.join('; '));
await app.close();

fs.writeFileSync(path.join(VERIFY, 'e2e-workspaces-result.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\nE2E（工作区）: ${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
