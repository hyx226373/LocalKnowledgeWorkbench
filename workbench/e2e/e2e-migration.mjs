// 端到端：数据迁移（docs/12）。
//   启动 #1（用户数据目录 A，资料在路径组 1）：两个根、三栏工作区（Markdown 滚动位置、PDF 页码、插件面板）、收藏、外观、第三方插件（安装 + 授权 + 存储）
//   → 菜单「文件 → 导出数据迁移包…」→ 迁移窗口导出
//   启动 #2（全新用户数据目录 B，资料复制到另一组路径）：菜单「导入数据迁移包…」→ 读取 → 映射根目录（自动匹配 + 浏览 + 手填）→ 导入
//   → 主窗口重新载入：打开原工作区，分栏、尺寸、阅读位置、收藏、外观、插件面板都对上；重启后仍然一致
//   启动 #3（全新用户数据目录 C，另一组路径，其中 1 个文件缺失）：导入 → PDF 面板显示“文件不可用”占位、收藏标为缺失、迁移窗口列出“缺失”
//   → 重新定位 → 面板恢复（资源 ID 不变）
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE = process.env.KB_SAMPLE || '/workspace/kb-sample';
const VERIFY = path.join(ROOT, 'verify');
const TMP = path.join(ROOT, 'e2e/.tmp/migration');
fs.rmSync(TMP, { recursive: true, force: true });
const UD = { a: path.join(TMP, 'userdata-旧电脑'), b: path.join(TMP, 'userdata-新电脑'), c: path.join(TMP, 'userdata-新电脑-缺文件') };
const SRC1 = path.join(TMP, '旧电脑/C/Users/amy/资料库');
const SRC2 = path.join(TMP, '旧电脑/C/Users/amy/写作');
const PKG = path.join(TMP, '导出/本地知识工作台-迁移.kbmigrate.zip');
const put = (p, c) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, c));
fs.cpSync(SAMPLE, SRC1, { recursive: true });
const longMd = ['# 第一章 绪论', '', ...Array.from({ length: 120 }, (_, i) => `## 第 ${i + 1} 节\n\n这是用于测试迁移后阅读位置的段落，第 ${i + 1} 段。`)].join('\n\n');
put(path.join(SRC2, '草稿/第一章.md'), longMd);
put(path.join(SRC2, '草稿/提纲.txt'), '一、绪论\n二、方法');
put(path.join(SRC2, '笔记/todo.note'), '- 迁移后插件面板仍能读取');
fs.mkdirSync(VERIFY, { recursive: true });
const PLUG = path.join(TMP, 'plugins/notes');
execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-adapter-plugin.mjs'), path.join(ROOT, 'e2e/fixtures/plugins/notes'), '--out', PLUG], { stdio: 'inherit' });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? '  — ' + detail : ''}`);
}

async function launch(userData) {
  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'], cwd: ROOT, env: { ...process.env, KB_USER_DATA: userData } });
  const win = await app.firstWindow();
  win.on('console', (m) => m.type() === 'error' && !/403|404|ERR_|Content Security Policy/.test(m.text()) && console.log('[renderer]', m.text()));
  await win.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800));
  await restored(win);
  return { app, win };
}
async function restored(win) {
  await win.waitForFunction(() => window.__layoutRestored === true, null, { timeout: 30000 });
  await waitReaders(win);
}
async function waitReaders(win) {
  await win.waitForFunction(
    () =>
      [...document.querySelectorAll('.kb-dock .dv-groupview')].every((g) => {
        const c = g.querySelector('.dv-content-container');
        if (!c) return false;
        if (c.querySelector('[data-testid="placeholder"]')) return true;
        const pdf = c.querySelector('[data-testid="reader-pdf"]');
        if (pdf) return !!pdf.querySelector('.pdf-page[data-rendered="1"]');
        const md = c.querySelector('[data-testid="reader-markdown"] article');
        if (md) return md.children.length > 0;
        if (c.querySelector('[data-testid="sandbox-view"]')) return !!c.querySelector('[data-testid="sandbox-view"][data-opened="true"]');
        return !!c.querySelector('[data-testid="reader-text"] pre, [data-testid="reader-image"] img');
      }),
    null,
    { timeout: 30000 },
  );
  await win.waitForTimeout(400);
}
async function addRoot(app, win, dir) {
  const n = await win.locator('[data-testid="root-row"]').count();
  await stubOpen(app, dir);
  await win.click('[data-testid="pick-folder"]');
  await win.waitForFunction((k) => document.querySelectorAll('[data-testid="root-row"]').length === k + 1, n);
  return win.evaluate(async (p) => (await window.kb.listRoots()).find((r) => r.path === p).id, dir);
}
const stubOpen = (app, p) => app.evaluate(({ dialog }, x) => void (dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [x] })), p);
const openP = (win, rootId, rel, mode) => win.evaluate(([r, p, m]) => window.__kb.openByPath(r, p, m), [rootId, rel, mode]);
const rid = (win, rootId, rel) =>
  win.evaluate(async ([r, p]) => {
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    return (await window.kb.listDir(r, dir)).find((x) => x.relPath === p)?.resourceId;
  }, [rootId, rel]);

/** 通过真实的应用菜单项打开迁移窗口（菜单栏默认隐藏，这里直接触发菜单项） */
async function openMigration(app, label) {
  const [mw] = await Promise.all([
    app.waitForEvent('window'),
    app.evaluate(({ Menu }, l) => {
      const find = (items) => {
        for (const it of items) {
          if (it.label === l) return it;
          const r = it.submenu && find(it.submenu.items);
          if (r) return r;
        }
      };
      find(Menu.getApplicationMenu().items).click();
    }, label),
  ]);
  await mw.waitForLoadState('domcontentloaded');
  await mw.waitForFunction(() => !!document.body.dataset.tab);
  await mw.setViewportSize({ width: 900, height: 700 }).catch(() => undefined);
  return mw;
}

/** 主窗口状态：分组位置/尺寸、标签、PDF 页码与缩放、文本滚动位置、占位、侧栏宽度 */
async function snap(win) {
  return win.evaluate(() => {
    const items = window.__kb.items();
    const groups = [...document.querySelectorAll('.kb-dock .dv-groupview')].map((g) => {
      const r = g.getBoundingClientRect();
      const c = g.querySelector('.dv-content-container');
      const pdf = c.querySelector('[data-testid="reader-pdf"]');
      const md = c.querySelector('[data-testid="reader-markdown"], [data-testid="reader-text"]');
      const ph = c.querySelector('[data-testid="placeholder"]');
      const sb = c.querySelector('[data-testid="sandbox-view"]');
      return {
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        tabs: [...g.querySelectorAll('.dv-tab')].map((t) => t.textContent.trim()),
        active: g.querySelector('.dv-tab.dv-active-tab')?.textContent.trim(),
        pdf: pdf ? { page: pdf.dataset.page, scale: pdf.dataset.scale, top: Math.round(pdf.scrollTop) } : null,
        text: md ? { top: Math.round(md.scrollTop) } : null,
        placeholder: ph ? ph.dataset.kind : null,
        sandbox: sb ? sb.dataset.adapterId : null,
      };
    });
    return {
      ws: window.__kb.currentWorkspaceId(),
      panels: window.__dock.panels.map((p) => ({ title: p.title, adapterId: items[p.params.itemId]?.adapterId, ref: items[p.params.itemId]?.ref })).sort((a, b) => (a.title + a.ref).localeCompare(b.title + b.ref)),
      groups,
      sidebar: Math.round(document.querySelector('[data-testid="sidebar"]').getBoundingClientRect().width),
      appearance: window.__kb.appearance(),
    };
  });
}
function diff(a, b, tol = 3) {
  const e = [];
  if (a.ws !== b.ws) e.push('工作区不同');
  if (JSON.stringify(a.panels) !== JSON.stringify(b.panels)) e.push('面板不同');
  if (JSON.stringify(a.appearance) !== JSON.stringify(b.appearance)) e.push('外观不同');
  if (a.groups.length !== b.groups.length) e.push(`分组数 ${a.groups.length}≠${b.groups.length}`);
  if (Math.abs(a.sidebar - b.sidebar) > tol) e.push(`侧栏 ${a.sidebar}≠${b.sidebar}`);
  a.groups.forEach((g, i) => {
    const h = b.groups[i];
    if (!h) return;
    for (const k of ['x', 'y', 'w', 'h']) if (Math.abs(g[k] - h[k]) > tol) e.push(`组${i}.${k} ${g[k]}≠${h[k]}`);
    if (JSON.stringify(g.tabs) !== JSON.stringify(h.tabs) || g.active !== h.active) e.push(`组${i} 标签不同`);
    if (g.placeholder !== h.placeholder) e.push(`组${i} 占位 ${g.placeholder}≠${h.placeholder}`);
    if (g.sandbox !== h.sandbox) e.push(`组${i} 插件面板不同`);
    if (!!g.pdf !== !!h.pdf || (g.pdf && (g.pdf.page !== h.pdf.page || g.pdf.scale !== h.pdf.scale || Math.abs(g.pdf.top - h.pdf.top) > 4))) e.push(`组${i} PDF ${JSON.stringify(g.pdf)}≠${JSON.stringify(h.pdf)}`);
    if (!!g.text !== !!h.text || (g.text && Math.abs(g.text.top - h.text.top) > 3)) e.push(`组${i} 滚动 ${JSON.stringify(g.text)}≠${JSON.stringify(h.text)}`);
  });
  return e;
}
const fmt = (s) => s.groups.map((g) => `${g.w}x${g.h}${g.pdf ? ` p${g.pdf.page}@${g.pdf.scale}` : ''}${g.text ? ` ↓${g.text.top}` : ''}${g.placeholder ? ` [${g.placeholder}]` : ''}${g.sandbox ? ' [插件]' : ''}`).join(' | ');
const favs = (win) => win.evaluate(async () => (await window.kb.listFavorites()).map((f) => ({ resourceId: f.resourceId, relPath: f.relPath, label: f.label, missing: f.missing })));

// ============================================================ 启动 #1：旧电脑
let { app, win } = await launch(UD.a);
const r1 = await addRoot(app, win, SRC1);
const r2 = await addRoot(app, win, SRC2);
await win.evaluate(() => window.__kb.setAppearance({ chrome: 'study', reading: 'bright', scheme: 'dark' }));
await openP(win, r2, '草稿/第一章.md', 'tab');
await win.waitForSelector('[data-testid="reader-markdown"] h1');
await openP(win, r2, '草稿/提纲.txt', 'tab');
await openP(win, r2, '草稿/第一章.md', 'tab'); // 切回 Markdown 标签
await openP(win, r1, '资料/论文/讲义.pdf', 'right');
await win.waitForSelector('[data-testid="reader-pdf"] .pdf-page[data-rendered="1"]', { timeout: 20000 });
// 第三方插件：开发者模式安装 → 打开 .note → 授权（只授予“写作”根）→ 插件存储
await win.evaluate(() => window.__kb.openPluginManager());
await win.waitForSelector('[data-testid="plugin-manager"]');
await win.check('[data-testid="dev-mode-toggle"]');
await win.waitForFunction(() => !document.querySelector('[data-testid="dev-install"]').disabled);
await stubOpen(app, PLUG);
await win.click('[data-testid="dev-install"]');
await win.waitForSelector('[data-testid="pm-plugin-test.notes"]');
await win.click('[data-testid="pm-close"]');
await win.waitForSelector('[data-testid="plugin-manager"]', { state: 'detached' });
await openP(win, r2, '笔记/todo.note', 'below');
await win.waitForSelector('[data-testid="perm-dialog"]', { timeout: 15000 });
await win.click('[data-testid="perm-allow"]');
await win.waitForSelector('[data-testid="sandbox-view"][data-adapter-id="test.notes.reader"][data-opened="true"]', { timeout: 20000 });
await win.evaluate(() => Promise.all([window.kb.adapterStorage('test.notes', 'set', 'view.sort', 'mtime'), window.kb.adapterStorage('test.notes', 'set', 'authToken', 'SECRET-e2e')]));
// 阅读位置：PDF 翻到第 2 页、Markdown 滚到 37%；拖动分栏改变尺寸
await win.evaluate(() => {
  const el = document.querySelector('[data-testid="reader-pdf"]');
  el.scrollTop = el.querySelector('.pdf-page[data-page="2"]').offsetTop - el.querySelector('.pdf-toolbar').offsetHeight + 5;
});
await win.waitForFunction(() => document.querySelector('[data-testid="reader-pdf"]')?.dataset.page === '2');
await win.evaluate(() => {
  const el = document.querySelector('[data-testid="reader-markdown"]');
  el.scrollTop = Math.round(0.37 * (el.scrollHeight - el.clientHeight));
});
// 分栏尺寸：左栏收窄、右侧上下两栏改为约 2:1（dockview API，与拖动分隔条走同一个布局变化事件）
await win.evaluate(() => {
  const g = window.__dock.groups;
  g[0].api.setSize({ width: 380 });
  g[1].api.setSize({ height: 480 });
});
await win.waitForTimeout(300);
// 收藏：Markdown、PDF、“写作”根
const ids = { md: await rid(win, r2, '草稿/第一章.md'), pdf: await rid(win, r1, '资料/论文/讲义.pdf') };
await win.evaluate(async ([a, b, rootRes]) => {
  await window.kb.addFavorite(a);
  await window.kb.addFavorite(b);
  await window.kb.addFavorite(rootRes);
}, [ids.md, ids.pdf, await win.evaluate(async (r) => (await window.kb.listRoots()).find((x) => x.id === r).resourceId, r2)]);
await win.evaluate(() => window.__kb.flush());
await win.waitForTimeout(800);
await win.evaluate(() => window.__kb.flush());
const S0 = await snap(win);
const F0 = await favs(win);
check('旧电脑：三栏工作区（Markdown + 文本 / PDF / 插件面板，已调整尺寸）、外观、收藏、插件授权就绪', S0.groups.length === 3 && S0.groups.some((g) => g.sandbox) && F0.length === 3 && Math.abs(S0.groups[0].w - 380) <= 3 && S0.groups[1].h > S0.groups[2].h + 50, fmt(S0));
await win.screenshot({ path: path.join(VERIFY, 'migration-1-source.png') });

let mw = await openMigration(app, '导出数据迁移包…');
check('菜单「文件 → 导出数据迁移包…」打开迁移窗口（导出页）', (await mw.evaluate(() => document.body.dataset.tab)) === 'export');
await mw.fill('[data-testid="export-path"]', PKG);
await mw.click('[data-testid="export-run"]');
await mw.waitForFunction(() => /已导出|失败/.test(document.querySelector('[data-testid="export-result"]').textContent), null, { timeout: 30000 });
const exportText = await mw.innerText('[data-testid="export-result"]');
check('导出成功：一致快照（integrity ok），3 个收藏、2 个根、1 个第三方插件；排除 1 个密钥样的插件存储项', /已导出/.test(exportText) && /快照完整性：ok/.test(exportText) && /3 个收藏/.test(exportText) && /2 个根目录/.test(exportText) && /1 个第三方插件/.test(exportText) && /1 个看起来像密钥/.test(exportText), exportText.replace(/\n/g, ' / '));
await mw.screenshot({ path: path.join(VERIFY, 'migration-2-export.png') });
await mw.close();
await app.close();
const pkgBytes = fs.statSync(PKG).size;
const pkgHasRaw = fs.readFileSync(PKG).includes(Buffer.from('迁移后插件面板仍能读取')); // 只是粗查（zip 已压缩）；单测里逐条目解压后检查

// 旧电脑“下线”：原资料路径在新电脑上不存在（模拟另一台电脑；否则自动建议会直接用原路径）
const OLD_GONE = path.join(TMP, '旧电脑-已下线');
fs.renameSync(path.join(TMP, '旧电脑'), OLD_GONE);
const OLD1 = path.join(OLD_GONE, 'C/Users/amy/资料库');
const OLD2 = path.join(OLD_GONE, 'C/Users/amy/写作');

// ============================================================ 启动 #2：新电脑（另一套用户数据目录 + 另一组资料路径）
const NEW = path.join(TMP, '新电脑');
const N1 = path.join(NEW, 'D 盘/资料（搬家后）');
const N2 = path.join(NEW, 'E 盘/写作'); // 与原路径最后一段同名 → 自动匹配
fs.cpSync(OLD1, N1, { recursive: true });
fs.cpSync(OLD2, N2, { recursive: true });
({ app, win } = await launch(UD.b));
check('新电脑：全新数据目录，启动时没有根目录与收藏', (await win.locator('[data-testid="root-row"]').count()) === 0 && (await favs(win)).length === 0);
mw = await openMigration(app, '导入数据迁移包…');
await mw.fill('[data-testid="import-path"]', PKG);
await mw.click('[data-testid="import-read"]');
await mw.waitForSelector('[data-testid="map-row"]');
const rows = await mw.$$eval('[data-testid="map-row"]', (els) => els.map((e) => ({ id: e.dataset.rootId, name: e.dataset.rootName, src: e.querySelector('code').textContent, val: e.querySelector('[data-testid="map-path"]').value })));
check('读取迁移包：列出每个根目录及其在旧电脑上的路径（原路径在本机不存在，新路径待填）', rows.length === 2 && rows.some((r) => r.id === r1 && r.src === SRC1) && rows.some((r) => r.id === r2 && r.src === SRC2) && rows.every((r) => r.val === ''), JSON.stringify(rows.map((r) => [r.name, r.src, r.val])));
await mw.fill('[data-testid="import-base"]', path.join(NEW, 'E 盘'));
await mw.click('[data-testid="import-suggest"]');
await mw.waitForFunction((id) => document.querySelector(`[data-testid="map-row"][data-root-id="${id}"] [data-testid="map-path"]`).value !== '', r2);
check('按上级文件夹自动匹配：「写作」→ 新电脑的 E 盘/写作', (await mw.inputValue(`[data-testid="map-row"][data-root-id="${r2}"] [data-testid="map-path"]`)) === N2);
await stubOpen(app, N1);
await mw.click(`[data-testid="map-row"][data-root-id="${r1}"] [data-testid="map-browse"]`);
await mw.waitForFunction((id) => document.querySelector(`[data-testid="map-row"][data-root-id="${id}"] [data-testid="map-path"]`).value !== '', r1);
check('「浏览…」选择「资料库」的新位置（另一个盘、另一个名字）', (await mw.inputValue(`[data-testid="map-row"][data-root-id="${r1}"] [data-testid="map-path"]`)) === N1);
await mw.screenshot({ path: path.join(VERIFY, 'migration-3-import-mapping.png') });
await mw.click('[data-testid="import-run"]');
await mw.waitForFunction(() => /导入完成|失败/.test(document.querySelector('[data-testid="import-result"]').textContent), null, { timeout: 60000 });
const importText = await mw.innerText('[data-testid="import-result"]');
check('导入完成：2 个根已映射，0 个缺失，导入前已自动备份', /导入完成/.test(importText) && /已映射 2 个根目录/.test(importText) && /找不到的文件：0 个/.test(importText) && /已备份到/.test(importText), importText.replace(/\n/g, ' / '));
await restored(win);
await win.waitForSelector('[data-testid="sandbox-view"][data-adapter-id="test.notes.reader"][data-opened="true"]', { timeout: 20000 });
await waitReaders(win);
const S1 = await snap(win);
let e = diff(S0, S1);
check('打开原工作区：同一工作区 ID、分栏与尺寸、标签、PDF 页码/缩放、Markdown 滚动位置、外观都一致', !e.length, e.join('; ') || fmt(S1));
const F1 = await favs(win);
check('收藏一致（同一批资源 ID，均可用）', JSON.stringify(F1) === JSON.stringify(F0), JSON.stringify(F1.map((f) => f.relPath)));
const roots1 = await win.evaluate(() => window.kb.listRoots());
check('根目录指向新电脑的新路径', roots1.map((r) => [r.id, r.path, r.status]).every(([id, p, s]) => s === 'ok' && p === (id === r1 ? N1 : N2)), JSON.stringify(roots1.map((r) => r.path)));
check('插件面板无需重新授权即可读取（授权按根 ID 保存）', (await win.locator('[data-testid="perm-dialog"]').count()) === 0 && S1.groups.some((g) => g.sandbox === 'test.notes.reader'));
const storage = await win.evaluate(() => Promise.all([window.kb.adapterStorage('test.notes', 'get', 'view.sort'), window.kb.adapterStorage('test.notes', 'get', 'authToken')]));
check('插件存储带过来了；看起来像令牌的键没有导出', storage[0] === 'mtime' && storage[1] === null, JSON.stringify(storage));
await win.screenshot({ path: path.join(VERIFY, 'migration-4-imported-workspace.png') });
await mw.close();
await win.evaluate(() => window.__kb.flush());
await app.close();
({ app, win } = await launch(UD.b));
await win.waitForSelector('[data-testid="sandbox-view"][data-adapter-id="test.notes.reader"][data-opened="true"]', { timeout: 20000 });
await waitReaders(win);
e = diff(S0, await snap(win));
check('新电脑重启后仍是导入的工作区与位置', !e.length, e.join('; '));
await app.close();

// ============================================================ 启动 #3：新电脑，资料库里缺 1 个文件（工作区中打开、且被收藏的 PDF）
const NEW2 = path.join(TMP, '新电脑2');
const M1 = path.join(NEW2, '资料 盘/资料库');
const M2 = path.join(NEW2, '资料 盘/写作');
fs.cpSync(OLD1, M1, { recursive: true });
fs.cpSync(OLD2, M2, { recursive: true });
fs.rmSync(path.join(M1, '资料/论文/讲义.pdf'));
({ app, win } = await launch(UD.c));
mw = await openMigration(app, '导入数据迁移包…');
await mw.fill('[data-testid="import-path"]', PKG);
await mw.click('[data-testid="import-read"]');
await mw.waitForSelector('[data-testid="map-row"]');
await mw.fill('[data-testid="import-base"]', path.join(NEW2, '资料 盘'));
await mw.click('[data-testid="import-suggest"]');
await mw.waitForFunction(() => [...document.querySelectorAll('[data-testid="map-path"]')].every((i) => i.value));
await mw.click('[data-testid="import-run"]');
await mw.waitForFunction(() => /导入完成|失败/.test(document.querySelector('[data-testid="import-result"]').textContent), null, { timeout: 60000 });
const importText2 = await mw.innerText('[data-testid="import-result"]');
check('缺 1 个文件时导入完成：报告 1 个被引用的文件找不到', /导入完成/.test(importText2) && /找不到的文件：1 个/.test(importText2), importText2.replace(/\n/g, ' / '));
await restored(win);
await win.waitForSelector('[data-testid="placeholder"][data-kind="resource-missing"]', { timeout: 20000 });
const S2 = await snap(win);
const pdfGroup = S2.groups.findIndex((g) => g.tabs.includes('讲义.pdf'));
check('原工作区照常打开：缺失的 PDF 面板显示“文件不可用”占位，其余面板与位置不变', pdfGroup >= 0 && S2.groups[pdfGroup].placeholder === 'resource-missing' && diff({ ...S0, groups: S0.groups.filter((_, i) => i !== pdfGroup) }, { ...S2, groups: S2.groups.filter((_, i) => i !== pdfGroup) }).length === 0, fmt(S2));
const F2 = await favs(win);
check('收藏记录保留，缺失的那个标为“缺失”（侧栏中禁用）', F2.length === 3 && F2.find((f) => f.resourceId === ids.pdf)?.missing === true && (await win.getAttribute('[data-testid="fav-row"][data-relpath="资料/论文/讲义.pdf"]', 'aria-disabled')) === 'true');
await win.screenshot({ path: path.join(VERIFY, 'migration-5-missing-placeholder.png') });
await mw.click('[data-testid="tab-repair"]');
await mw.waitForSelector('[data-testid="missing-row"]');
const missRows = await mw.$$eval('[data-testid="missing-row"]', (els) => els.map((e) => ({ id: e.dataset.resourceId, rel: e.dataset.relPath, text: e.innerText })));
check('迁移窗口「根目录与缺失文件」列出缺失的文件（缺失 · 收藏 · 工作区「默认工作区」引用），记录未删除', missRows.length === 1 && missRows[0].id === ids.pdf && /缺失/.test(missRows[0].text) && /收藏/.test(missRows[0].text) && /工作区/.test(missRows[0].text), JSON.stringify(missRows));
await mw.screenshot({ path: path.join(VERIFY, 'migration-6-missing-list.png') });
// 用户找回了文件，放在根里另一个位置 → 重新定位
put(path.join(M1, '找回/讲义.pdf'), fs.readFileSync(path.join(OLD1, '资料/论文/讲义.pdf')));
await mw.fill('[data-testid="missing-row"] [data-testid="relocate-path"]', path.join(M1, '找回/讲义.pdf'));
await mw.click('[data-testid="missing-row"] [data-testid="relocate-run"]');
await mw.waitForSelector('[data-testid="missing-none"]', { timeout: 15000 });
const relocText = await mw.innerText('[data-testid="repair-result"]');
check('重新定位成功，缺失列表清空', /已重新定位到 找回\/讲义\.pdf/.test(relocText), relocText);
// 面板：资源 ID 没变，占位应自动恢复为 PDF 阅读器；若渲染进程没有收到变化通知则重新载入窗口再看
let recovered = await win.waitForSelector('[data-testid="reader-pdf"] .pdf-page[data-rendered="1"]', { timeout: 8000 }).then(() => 'auto', () => null);
if (!recovered) {
  await win.reload();
  await restored(win);
  recovered = (await win.locator('[data-testid="reader-pdf"] .pdf-page[data-rendered="1"]').count()) ? 'after-reload' : null;
}
await waitReaders(win);
const S3 = await snap(win);
const F3 = await favs(win);
check(`重新定位后 PDF 面板恢复（${recovered === 'auto' ? '自动恢复' : recovered === 'after-reload' ? '重新载入窗口后恢复' : '未恢复'}），页码与缩放仍是导出时的值，收藏不再缺失`, !!recovered && S3.groups[pdfGroup]?.pdf?.page === S0.groups[pdfGroup]?.pdf?.page && S3.groups[pdfGroup]?.pdf?.scale === S0.groups[pdfGroup]?.pdf?.scale && F3.find((f) => f.resourceId === ids.pdf)?.missing === false, fmt(S3));
await win.screenshot({ path: path.join(VERIFY, 'migration-7-relocated.png') });
await mw.close();
await app.close();

const out = { at: new Date().toISOString(), package: { path: path.relative(ROOT, PKG), bytes: pkgBytes, rawMarkerFound: pkgHasRaw }, results };
fs.writeFileSync(path.join(VERIFY, 'e2e-migration-result.json'), JSON.stringify(out, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
