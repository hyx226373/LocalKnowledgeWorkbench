// 端到端验证：用 Playwright 的 _electron 驱动生产构建（out/）。
// 环境变量：KB_SAMPLE（样例根目录，默认 /workspace/kb-sample）
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE = process.env.KB_SAMPLE || '/workspace/kb-sample';
const VERIFY = path.join(ROOT, 'verify');
const USERDATA = path.join(ROOT, 'e2e/.tmp/userdata');
fs.rmSync(USERDATA, { recursive: true, force: true });
fs.mkdirSync(VERIFY, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? '  — ' + detail : ''}`);
}

let dialogs = [];
async function launch() {
  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu'], cwd: ROOT, env: { ...process.env, KB_USER_DATA: USERDATA } });
  const win = await app.firstWindow();
  win.on('console', (m) => m.type() === 'error' && !/403/.test(m.text()) && console.log('[renderer]', m.text()));
  await win.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800));
  // 插件授权提示（应用内对话框）→ 记录并点“允许”
  const end = Date.now() + 20000;
  while (!(await win.evaluate(() => window.__layoutRestored === true))) {
    if (Date.now() > end) throw new Error('布局恢复超时');
    const dlg = win.locator('[data-testid="dialog"]');
    if (await dlg.count()) {
      dialogs.push(await dlg.innerText());
      await win.click('[data-testid="dialog-ok"]');
    }
    await win.waitForTimeout(100);
  }
  return { app, win };
}

const row = (win, rel) => win.locator(`[data-testid="sidebar"] [data-testid="tree-row"][data-relpath="${rel}"]`).first();
async function act(locRow, testid) {
  await locRow.hover();
  await locRow.locator(`[data-testid="${testid}"]`).click();
  await locRow.page().waitForTimeout(100);
}
async function expand(win, rel) {
  await row(win, rel).click();
  await win.waitForTimeout(150);
}
async function groupBoxes(win) {
  return win.$$eval('.dv-groupview', (els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.x), w: Math.round(r.width), tabs: [...e.querySelectorAll('.dv-tab')].map((t) => t.textContent.trim()) };
    }),
  );
}
const waitPdf = (win) => win.waitForSelector('[data-testid="reader-pdf"] .pdf-page[data-rendered="1"]', { timeout: 20000 });
async function dockState(win) {
  return win.evaluate(() => {
    const api = window.__dock;
    return {
      panels: api.panels
        .map((p) => {
          const it = window.__kb.items()[p.params.itemId] ?? {};
          return { id: p.id, title: p.title, group: p.group.id, itemId: p.params.itemId, adapterId: it.adapterId, ref: it.ref };
        })
        .sort((a, b) => a.id.localeCompare(b.id)),
      groups: api.groups.length,
    };
  });
}
/** 已保存的布局（schema 4）+ 项目表条目（按 itemId 索引，便于断言） */
const storedLayout = (win) =>
  win.evaluate(async () => {
    const ws = await window.kb.getWorkspace(await window.kb.getCurrentWorkspaceId());
    return { ...ws.layout, inlineItems: ws.layout.items, items: Object.fromEntries(ws.items.map((i) => [i.itemId, i])) };
  });
async function setAppearance(win, chrome, reading, scheme) {
  await win.evaluate((a) => window.__kb.setAppearance(a), { chrome, reading, scheme });
  await win.waitForFunction(
    ([c, r, s]) => document.documentElement.dataset.kbChrome === c && document.documentElement.dataset.kbReading === r && document.documentElement.dataset.kbScheme === s,
    [chrome, reading, scheme],
  );
  await win.waitForTimeout(400);
}

/** 启动后（布局已恢复）再等 2 秒：不应出现任何对话框（授权框、确认框） */
async function startupDialogs(win) {
  await win.waitForTimeout(2000);
  return win.evaluate(() => [...document.querySelectorAll('.kb-dialog-backdrop, [data-testid="perm-dialog"], [data-testid="dialog"]')].map((e) => e.textContent.trim().slice(0, 80)));
}

// ============================================================ 第一次启动
let { app, win } = await launch();
const plugins1 = await win.$$eval('[data-testid^="plugin-"][data-status]', (els) => els.map((e) => [e.dataset.testid, e.dataset.status]));
const pluginIds = plugins1.map(([t]) => t.replace(/^plugin-/, '')).sort();
check(
  '插件宿主加载：工作台/阅读器适配器/演示插件 + 3 个主题包均激活',
  ['builtin.readers', 'builtin.workbench', 'demo.csv-table', 'kb.theme.bright', 'kb.theme.pro', 'kb.theme.study'].every((id) => pluginIds.includes(id)) && plugins1.every(([, s]) => s === 'active'),
  JSON.stringify(plugins1),
);
check('T22：内置示例插件不再弹出旧的字符串权限请求（第三方插件改为沙箱适配器 + 结构化授权，见 e2e-adapters）', dialogs.length === 0, JSON.stringify(dialogs));
const firstDlg = await startupDialogs(win);
check('首次启动不被任何对话框挡住：内置阅读器与内置示例插件（CSV 表格）启动时都不请求授权', dialogs.length === 0 && firstDlg.length === 0, JSON.stringify({ dialogs, firstDlg }));

{
  const menu = await app.evaluate(({ Menu, BrowserWindow }) => {
    const m = Menu.getApplicationMenu();
    const w = BrowserWindow.getAllWindows()[0];
    return { top: m.items.map((i) => i.label), sub: m.items.flatMap((i) => i.submenu.items.map((x) => x.label)).filter(Boolean), title: w.getTitle(), autoHide: w.isMenuBarAutoHide() };
  });
  const english = [...menu.top, ...menu.sub].filter((l) => /^(File|Edit|View|Window|Help|Undo|Redo|Cut|Copy|Paste|Select All|Quit|Reload|Toggle)/.test(l));
  check('应用菜单为中文（文件/编辑/视图/帮助），无 Electron 默认英文项；菜单栏默认隐藏（Alt 显示）；窗口标题「本地知识工作台」', english.length === 0 && menu.top.join() === '文件(&F),编辑(&E),视图(&V),帮助(&H)' && menu.autoHide && menu.title === '本地知识工作台', JSON.stringify({ top: menu.top, english, title: menu.title }));
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find((i) => i.label.startsWith('视图')).submenu.items.find((x) => x.label === '命令面板…').click());
  await win.waitForSelector('[data-testid="command-palette"]', { timeout: 5000 });
  check('菜单“视图 → 命令面板…”在渲染进程中执行工作台命令', true);
  await win.keyboard.press('Escape');
  await win.waitForSelector('[data-testid="command-palette"]', { state: 'detached', timeout: 5000 });
}

await win.fill('[data-testid="root-path-input"]', '/不存在的路径/xyz');
await win.press('[data-testid="root-path-input"]', 'Enter');
await win.waitForSelector('[data-testid="add-root-error"]');
check('输入不存在的路径时给出错误提示', (await win.textContent('[data-testid="add-root-error"]')).includes('不是可访问的文件夹'));

await app.evaluate(({ dialog }, p) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
}, SAMPLE);
await win.click('[data-testid="pick-folder"]');
await row(win, '笔记').waitFor();
check('通过文件夹选择器注册根并自动展开', true);
await win.waitForSelector('[data-testid="index-status"][data-state="idle"]', { timeout: 15000 });
check('状态栏显示索引状态', /已索引 \d+ 个文件/.test(await win.textContent('[data-testid="statusbar"]')));

for (const d of ['笔记', '资料', '资料/图片', '资料/论文', '笔记/2026']) await expand(win, d);

// ---- 每种视图（经视图注册表解析）
const shots = [
  ['笔记/待办.txt', 'reader-text', 'builtin.text', 'reader-text.png'],
  ['资料/图片/架构草图.png', 'reader-image', 'builtin.image', 'reader-png.png'],
  ['资料/图片/照片.jpg', 'reader-image', 'builtin.image', 'reader-jpg.png'],
  ['资料/报告.docx', 'reader-unsupported', 'builtin.unsupported', 'reader-unsupported.png'],
  ['资料/数据.csv', 'view-csv-table', 'demo.csv-table', 'reader-csv-plugin.png'],
  ['笔记/gbk编码.txt', 'reader-text', 'builtin.text', null],
];
for (const [rel, testid, vt, shot] of shots) {
  await row(win, rel).click();
  await win.waitForSelector(`.dv-groupview [data-view-type="${vt}"] [data-testid="${testid}"]:visible`, { timeout: 10000 });
  if (testid === 'reader-image') await win.waitForFunction(() => [...document.querySelectorAll('[data-testid="reader-image"] img')].some((i) => i.complete && i.naturalWidth > 0));
  if (shot) await win.screenshot({ path: path.join(VERIFY, shot) });
  check(`打开 ${rel} → 视图 ${vt}`, true);
}
check('GBK 编码文本正确解码', (await win.locator('[data-testid="reader-text"]:visible pre').textContent()).includes('GBK 编码的文本文件'));
await win.evaluate(() => window.__dock.panels.slice().forEach((p) => p.api.close()));

// ---- 收藏
await act(row(win, '笔记/2026/读书笔记.md'), 'fav-toggle');
await act(row(win, '资料/论文'), 'fav-toggle');
await act(win.locator('[data-testid="root-row"]'), 'fav-toggle');
await win.waitForSelector('[data-testid="fav-row"][data-relpath="笔记/2026/读书笔记.md"]');
check('收藏文件、子文件夹与根', (await win.locator('[data-testid="favorites"]').locator('.kb-tree-row').count()) >= 3);

// ---- md | pdf 并排
await row(win, '笔记/2026/读书笔记.md').click();
await win.waitForSelector('[data-testid="reader-markdown"] h1');
check(
  'Markdown 渲染且相对路径图片经 kbfile:// 加载',
  await win.waitForFunction(() => document.querySelector('[data-testid="reader-markdown"] img')?.naturalWidth > 0).then(() => true, () => false),
);
check('Markdown 中的 <script> 被过滤', (await win.locator('[data-testid="reader-markdown"] script').count()) === 0);
await win.screenshot({ path: path.join(VERIFY, 'reader-markdown.png') });
await act(row(win, '资料/论文/讲义.pdf'), 'open-right');
await waitPdf(win);
let boxes = await groupBoxes(win);
check('md 与 pdf 左右分栏', boxes.length === 2 && boxes[0].x < boxes[1].x, JSON.stringify(boxes));
await win.screenshot({ path: path.join(VERIFY, 'reader-pdf.png') });

// ---- 三个视觉方向：同一画面、三套令牌
await win.mouse.move(5, 790); // 移开悬停
for (const [id, letter] of [['study', 'a'], ['pro', 'b'], ['bright', 'c']]) {
  for (const scheme of ['light', 'dark']) {
    await setAppearance(win, id, id, scheme);
    await waitPdf(win);
    const vp = await win.evaluate(() => [innerWidth, innerHeight]);
    const file = `direction-${letter}-${scheme}.png`;
    await win.screenshot({ path: path.join(VERIFY, file) });
    check(`视觉方向 ${id}（${scheme}）截图 ${file}`, vp[0] === 1280 && vp[1] === 800, `${vp[0]}x${vp[1]}`);
  }
}
await setAppearance(win, 'bright', 'bright', 'light');
const tokenBg = await win.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--kb-color-bg').trim());
check('主题通过 CSS 变量生效（bright 浅色背景令牌）', tokenBg === '#eef1f7', tokenBg);
await setAppearance(win, 'pro', 'pro', 'dark');

// ---- PDF 视图状态：放大一次 + 滚到第 2 页
const scale0 = Number(await win.getAttribute('[data-testid="reader-pdf"]', 'data-scale'));
await win.click('[data-testid="pdf-zoom-in"]');
const scale1 = String(+(scale0 + 0.2).toFixed(2));
await win.waitForFunction((s) => document.querySelector('[data-testid="reader-pdf"]')?.dataset.scale === s, scale1);
await win.evaluate(() => {
  const el = document.querySelector('[data-testid="reader-pdf"]');
  el.scrollTop = el.querySelector('.pdf-page[data-page="2"]').offsetTop - el.querySelector('.pdf-toolbar').offsetHeight + 5;
});
await win.waitForFunction(() => document.querySelector('[data-testid="reader-pdf"]')?.dataset.page === '2');
check('PDF 视图状态（页码/缩放）由视图上报', true);

// ---- 插件视图 csv-table 进入同一分栏布局（在 pdf 右侧），并改变其状态（按“数量”降序）
await act(row(win, '资料/数据.csv'), 'open-right');
await win.waitForSelector('[data-testid="view-csv-table"] th[data-col="1"]');
await win.click('[data-testid="view-csv-table"] th[data-col="1"]');
await win.click('[data-testid="view-csv-table"] th[data-col="1"]');
await win.waitForSelector('[data-testid="view-csv-table"][data-sort-col="1"][data-desc="1"]');
boxes = await groupBoxes(win);
check('插件视图与内置视图同处一个分栏布局（3 栏）', boxes.length === 3, JSON.stringify(boxes.map((b) => b.tabs)));

// ---- 拖动分隔条
const sash = win.locator('.dv-split-view-container.dv-horizontal > .dv-sash-container > .dv-sash').first();
const sb = await sash.boundingBox();
await win.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
await win.mouse.down();
await win.mouse.move(sb.x - 120, sb.y + sb.height / 2, { steps: 12 });
await win.mouse.up();
await win.waitForTimeout(300);
const boxesAfter = await groupBoxes(win);
check('拖动分隔条后左栏变窄约 120px', Math.abs(boxes[0].w - boxesAfter[0].w - 120) <= 6, `${boxes[0].w} → ${boxesAfter[0].w}`);

const ss = await win.locator('[data-testid="sidebar-sash"]').boundingBox();
await win.mouse.move(ss.x + 2, ss.y + 200);
await win.mouse.down();
await win.mouse.move(300, ss.y + 200, { steps: 8 });
await win.mouse.up();
await win.waitForTimeout(300);
const sidebarW = Math.round((await win.locator('[data-testid="sidebar"]').boundingBox()).width);
check('侧栏宽度可拖动', Math.abs(sidebarW - 300) <= 3, String(sidebarW));

await win.fill('[data-testid="search-input"]', '讲义');
await win.waitForSelector('[data-testid="search-results"] .kb-search-hit .p');
check('顶部搜索按文件名命中', (await win.textContent('[data-testid="search-results"]')).includes('资料/论文/讲义.pdf'));
await win.fill('[data-testid="search-input"]', '');

// 命令面板（命令扩展点）
await win.keyboard.press('Control+Shift+P');
await win.waitForSelector('[data-testid="command-palette"]');
const cmds = await win.locator('[data-testid="command-palette"] [data-testid="palette-item"]').allTextContents();
check('Ctrl+Shift+P 打开命令面板，列出插件贡献的命令（外框/阅读区/工作区）', cmds.some((c) => c.includes('安静书房')) && cmds.some((c) => c.includes('书房排版')) && cmds.some((c) => c.includes('关闭所有标签')), cmds.join(' | '));
await win.keyboard.press('Escape');

const rootId = await win.getAttribute('[data-testid="root-row"]', 'data-root-id');
const esc = await win.evaluate(async (id) => ({
  r1: await fetch(`kbfile://root/${id}/..%2F..%2F..%2Fetc%2Fpasswd`).then((r) => r.status, () => 'neterr'),
  r2: await fetch(`kbfile://root/${id}/笔记/待办.txt`).then((r) => r.status, () => 'neterr'),
}), rootId);
check('渲染进程 fetch kbfile:// 越界返回 403，合法路径 200', esc.r1 === 403 && esc.r2 === 200, JSON.stringify(esc));

await win.waitForTimeout(800);
const stored = await storedLayout(win);
const paramKeys = new Set(Object.values(stored.dock.panels).flatMap((p) => Object.keys(p.params)));
const storedItems = Object.values(stored.items);
check(
  '布局 v4：面板 params 只含 itemId；条目存于项目表（布局不内联），为 file 来源、带适配器 id 与带版本的状态，组件统一为通用宿主',
  stored.schema === 4 &&
    stored.inlineItems === undefined &&
    [...paramKeys].join() === 'itemId' &&
    Object.values(stored.dock.panels).every((p) => p.contentComponent === 'view' && stored.items[p.params.itemId]) &&
    storedItems.every((i) => i.sourceKind === 'file' && i.displayMode === 'in-app-reader' && typeof i.adapterId === 'string') &&
    storedItems.some((i) => i.adapterId === 'builtin.pdf' && i.state?.v === 1 && i.state.data.page === 2),
  JSON.stringify(storedItems.map((i) => [i.adapterId, i.state])),
);
const before = { dock: await dockState(win), boxes: await groupBoxes(win), sidebarW };
await win.screenshot({ path: path.join(VERIFY, 'before-restart.png') });
await app.close();

// ============================================================ 重启 #1：全部恢复（含插件视图与视图状态）
({ app, win } = await launch());
await waitPdf(win);
await win.waitForSelector('[data-testid="reader-markdown"] h1');
await win.waitForSelector('[data-testid="view-csv-table"]');
const restartDlg = await startupDialogs(win);
{
  const tr = await win.evaluate(() => window.kb.getStartupTrace());
  const ms = (n) => tr.find((m) => m.name === n)?.ms ?? null;
  const shown = ms('window:shown'), inter = ms('renderer:interactive'), def = ms('deferred:start-interactive') ?? ms('deferred:start-timeout');
  check('冷启动计时：窗口显示 < 1.5 s、可交互 < 3 s；扫描/监听在可交互之后才开始（Playwright 下测得，含调试器开销）', shown != null && shown < 1500 && inter != null && inter < 3000 && def != null && def >= inter, JSON.stringify({ shown, interactive: inter, deferredStart: def }));
}
check('重启时恢复 CSV（内置示例插件）、PDF、Markdown 面板：不弹授权框（只有打开需要授权的第三方插件内容时才询问）', dialogs.length === 0 && restartDlg.length === 0, JSON.stringify({ dialogs, restartDlg }));
await win.waitForTimeout(600);
const after = { dock: await dockState(win), boxes: await groupBoxes(win), sidebarW: Math.round((await win.locator('[data-testid="sidebar"]').boundingBox()).width) };
check('重启后根目录恢复', (await win.locator('[data-testid="root-row"]').count()) === 1);
check('重启后收藏恢复', (await win.locator('[data-testid="fav-row"][data-relpath="笔记/2026/读书笔记.md"]').count()) === 1);
check('重启后目录树展开状态恢复', await row(win, '资料/论文/讲义.pdf').isVisible());
check('重启后标签页/分组/视图类型恢复（含插件视图）', JSON.stringify(before.dock) === JSON.stringify(after.dock), JSON.stringify(after.dock.panels.map((p) => p.adapterId)));
check(
  '重启后分栏尺寸恢复（±3px）',
  before.boxes.length === after.boxes.length && before.boxes.every((b, i) => Math.abs(b.w - after.boxes[i].w) <= 3),
  `${JSON.stringify(before.boxes.map((b) => b.w))} → ${JSON.stringify(after.boxes.map((b) => b.w))}`,
);
check('重启后侧栏宽度恢复', before.sidebarW === after.sidebarW, `${before.sidebarW} → ${after.sidebarW}`);
const pdfState = await win.$eval('[data-testid="reader-pdf"]', (e) => ({ page: e.dataset.page, scale: e.dataset.scale }));
check(`重启后 PDF 视图状态恢复（第 2 页，${Math.round(scale1 * 100)}%）`, pdfState.page === '2' && pdfState.scale === scale1, JSON.stringify(pdfState));
check('重启后插件视图状态恢复（按第 2 列降序）', (await win.locator('[data-testid="view-csv-table"][data-sort-col="1"][data-desc="1"]').count()) === 1);
check('外观恢复（外框/阅读区/明暗）', (await win.evaluate(() => Object.values({ c: document.documentElement.dataset.kbChrome, r: document.documentElement.dataset.kbReading, s: document.documentElement.dataset.kbScheme }).join())) === 'pro,pro,dark');
await win.screenshot({ path: path.join(VERIFY, 'after-restart.png') });

// ---- 运行时禁用插件 → 该面板立即变为占位，其他面板不受影响
await win.click('[data-testid="plugin-toggle-demo.csv-table"]');
await win.waitForSelector('[data-testid="placeholder"][data-adapter-id="demo.csv-table"][data-kind="adapter-disabled"]');
check('运行时禁用插件：其视图面板变为占位', (await win.locator('[data-testid="reader-pdf"]').count()) === 1 && (await win.locator('[data-testid="reader-markdown"]').count()) === 1);
await win.waitForTimeout(500);
await app.close();

// ============================================================ 重启 #2：视图类型未注册时恢复
({ app, win } = await launch());
await waitPdf(win);
await win.waitForSelector('[data-testid="reader-markdown"] h1');
await win.waitForSelector('[data-testid="placeholder"][data-adapter-id="demo.csv-table"][data-kind="adapter-disabled"]');
const after2 = { dock: await dockState(win), boxes: await groupBoxes(win) };
check('视图类型未注册：占位面板 + 其余布局完整恢复', JSON.stringify(after2.dock) === JSON.stringify(before.dock) && after2.boxes.every((b, i) => Math.abs(b.w - before.boxes[i].w) <= 3), JSON.stringify(after2.boxes.map((b) => b.w)));
check('插件面板显示 demo.csv-table 为“已禁用”', (await win.getAttribute('[data-testid="plugin-demo.csv-table"]', 'data-status')) === 'disabled');
await win.screenshot({ path: path.join(VERIFY, 'restore-missing-view.png') });
const storedMissing = await storedLayout(win);
check('占位不会改写布局（插件视图的类型与状态仍保留）', Object.values(storedMissing.items).some((i) => i.adapterId === 'demo.csv-table' && i.state?.data?.sortCol === 1));

// 重新启用 → 面板自动恢复为插件视图且状态仍在
await win.click('[data-testid="plugin-toggle-demo.csv-table"]');
await win.waitForSelector('[data-testid="view-csv-table"][data-sort-col="1"][data-desc="1"]');
check('重新启用插件后面板自动恢复（含状态）', true);

// ---- 外部重命名
const mdOld = path.join(SAMPLE, '笔记/2026/读书笔记.md');
const mdNew = path.join(SAMPLE, '笔记/2026/读书笔记-已重命名.md');
await win.waitForSelector('[data-testid="index-status"]:has-text("监听中")', { timeout: 10000 });
fs.renameSync(mdOld, mdNew);
check('外部重命名后收藏跟随到新路径', await win.waitForSelector('[data-testid="fav-row"][data-relpath="笔记/2026/读书笔记-已重命名.md"]', { timeout: 10000 }).then(() => true, () => false));
check(
  '外部重命名后已打开标签的标题更新、内容仍可读',
  (await win.waitForFunction(() => window.__dock.panels.some((p) => p.title === '读书笔记-已重命名.md'), null, { timeout: 5000 }).then(() => true, () => false)) &&
    (await win.locator('[data-testid="reader-markdown"] h1').count()) === 1,
);
await win.screenshot({ path: path.join(VERIFY, 'after-external-rename.png') });
await app.close();
fs.renameSync(mdNew, mdOld);

fs.writeFileSync(path.join(VERIFY, 'e2e-result.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\nE2E: ${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
