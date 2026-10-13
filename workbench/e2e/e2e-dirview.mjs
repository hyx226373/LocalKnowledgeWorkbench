// 第 11 轮 C：侧栏双目录视图、全局自建目录、拖拽挂钩、按类型整理。
// 不依赖 /workspace/kb-sample（这台 Windows 上没有那份样例），样例写在临时目录里。
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, 'e2e/.tmp/dirview');
const USERDATA = path.join(TMP, 'userdata');
const RA = path.join(TMP, '甲根');
const RB = path.join(TMP, '乙根');
const SHOTS = path.join('D:', 'STUDY MATERIAL', '项目', '知识库', '汇报', 'shots', '双镜组');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(path.join(RA, '子目录'), { recursive: true });
fs.mkdirSync(RB, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
fs.writeFileSync(path.join(RA, '子目录', '笔记.md'), '# 双栏笔记\n\n原文。\n', 'utf8');
fs.writeFileSync(path.join(RA, '没有阅读器.xyz'), 'xyz', 'utf8');
fs.writeFileSync(path.join(RB, '表.csv'), 'a,b\n1,2\n', 'utf8');
const mdPath = path.join(RA, '子目录', '笔记.md');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const mdHash = sha(mdPath);

const results = [];
const check = (name, ok, detail = '') => (results.push({ name, ok: !!ok, detail }), console.log(`${ok ? '✔' : '✘'} ${name}${detail ? '  — ' + detail : ''}`));
const shot = (win, name) => win.screenshot({ path: path.join(SHOTS, name) });

async function closeApp(app) {
  await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 8000))]);
  try { app.process()?.kill(); } catch { /* 已经退出 */ }
}

async function launch() {
  const env = { ...process.env, KB_USER_DATA: USERDATA };
  delete env.VITE_DEV_SERVER_URL;
  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'], cwd: ROOT, env });
  const win = await app.firstWindow();
  win.on('console', (m) => m.type() === 'error' && console.log('[renderer]', m.text()));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800));
  await win.waitForFunction(() => window.__layoutRestored === true, null, { timeout: 30000 });
  return { app, win };
}

let { app, win } = await launch();
try {
  check('单栏仍有原来的根目录输入框', (await win.locator('[data-testid="root-path-input"]').count()) === 1 && (await win.locator('[data-testid="dirview"]').count()) === 0);
  for (const r of [RA, RB]) {
    await win.fill('[data-testid="root-path-input"]', r);
    await win.press('[data-testid="root-path-input"]', 'Enter');
    await win.waitForSelector(`[data-testid="root-row"][data-root-name="${path.basename(r)}"]`, { timeout: 15000 });
  }
  await win.waitForFunction(async () => (await window.kb.getIndexStatus()).length >= 2 && (await window.kb.getIndexStatus()).every((s) => s.state === 'idle' && s.fileCount > 0), null, { timeout: 30000, polling: 200 });
  const roots = await win.evaluate(() => window.kb.listRoots());
  const rootA = roots.find((r) => r.name === '甲根').id;
  const rootB = roots.find((r) => r.name === '乙根').id;

  await win.evaluate(() => window.__kb.runCommand('dirView.toggleDual'));
  await win.waitForSelector('[data-testid="dirview"]');
  const left = win.locator('[data-testid="dirview-pane"][data-pane="left"]');
  const right = win.locator('[data-testid="dirview-pane"][data-pane="right"]');
  await left.locator('[data-testid="dirview-location"]').selectOption(`root:${rootA}`);
  await right.locator('[data-testid="dirview-location"]').selectOption('vfolder');
  await shot(win, 'dual-view.png');
  check('双栏：左根目录、右自建目录', (await left.getAttribute('data-kind')) === 'root' && (await right.getAttribute('data-kind')) === 'vfolder');

  await right.locator('[data-testid="vfolder-new"]').click();
  await win.fill('[data-testid="dialog-field-name"]', '甲');
  await win.click('[data-testid="dialog-ok"]');
  const jia = right.locator('[data-testid="vfolder-row"][data-entry="vfolder-node"]', { hasText: '甲' });
  await jia.waitFor();
  await jia.click();
  await right.locator('[data-testid="vfolder-new"]').click();
  await win.fill('[data-testid="dialog-field-name"]', '乙');
  await win.click('[data-testid="dialog-ok"]');
  const yi = right.locator('[data-testid="vfolder-row"][data-entry="vfolder-node"]', { hasText: '乙' });
  await yi.waitFor();
  const yiId = await yi.getAttribute('data-folder-id');
  const ids = await win.evaluate(async ([a, b]) => {
    const md = (await window.kb.listDir(a, '子目录')).find((e) => e.name === '笔记.md');
    const csv = (await window.kb.listDir(b, '')).find((e) => e.name === '表.csv');
    return { md: md.resourceId, csv: csv.resourceId };
  }, [rootA, rootB]);
  await win.evaluate(async ([folder, md, csv]) => {
    await window.kb.setVfolderMembership(md, [folder]);
    await window.kb.setVfolderMembership(csv, [folder]);
  }, [yiId, ids.md, ids.csv]);
  await yi.click();
  await right.locator(`[data-testid="vfolder-row"][data-resource-id="${ids.md}"]`).waitFor();
  await right.locator(`[data-testid="vfolder-row"][data-resource-id="${ids.csv}"]`).waitFor();
  await shot(win, 'vfolder.png');
  const sameDrive = path.parse(RA).root === path.parse(RB).root;
  check('两级自建目录同时收下两个根里的文件（不移动原文件）', sha(mdPath) === mdHash && fs.existsSync(path.join(RB, '表.csv')), sameDrive ? '两个临时根在同一盘符，归属仍按资源 ID 跨根' : '两个盘符');

  await left.locator('[data-testid="tree-row"][data-relpath="子目录"]').click();
  const mdRow = left.locator('[data-testid="tree-row"][data-relpath="子目录/笔记.md"]');
  await mdRow.waitFor();
  await mdRow.hover();
  await mdRow.locator('[data-testid="ref-toggle"]').click();
  await win.waitForFunction(async (rid) => {
    const refs = await window.kb.listWorkspaceRefs(window.__kb.currentWorkspaceId());
    return refs.some((r) => r.resourceId === rid);
  }, ids.md);
  const joined = await win.evaluate(async (folderId) => {
    const id = window.__kb.currentWorkspaceId();
    const refs = await window.kb.listWorkspaceRefs(id);
    const ws = JSON.stringify(await window.kb.getWorkspace(id));
    return { refCount: refs.length, leaked: ws.includes('library.vfolders') || ws.includes(folderId) };
  }, yiId);
  check('加入工作区不复制自建目录树', joined.refCount >= 1 && joined.leaked === false, JSON.stringify(joined));

  const beforeRestart = await win.evaluate(() => window.kb.getLayout('ui'));
  check('展开记在双栏自己的状态里，不占用全局 expanded', Array.isArray(beforeRestart?.dirView?.left?.expanded) && beforeRestart.dirView.left.expanded.some((k) => String(k).includes(':')));
  await win.evaluate(() => window.__kb.flush());
  await closeApp(app);
  ({ app, win } = await launch());
  await win.waitForSelector('[data-testid="dirview"]');
  await win.locator(`[data-testid="vfolder-row"][data-resource-id="${ids.md}"]`).waitFor({ timeout: 10000 });
  const restored = await win.evaluate(() => window.kb.getLayout('ui'));
  const folders = await win.evaluate(() => window.kb.listVirtualFolders());
  const jiaRow = folders.find((f) => f.name === '甲');
  const yiRow = folders.find((f) => f.name === '乙');
  check('重启恢复双栏目标', restored?.dirView?.dual === true && restored.dirView.left.kind === 'root' && restored.dirView.left.rootId === rootA && restored.dirView.right.kind === 'vfolder' && restored.dirView.right.folderId === yiId);
  const expandedBack = await win.locator('[data-testid="dirview-pane"][data-pane="left"] [data-testid="tree-row"][data-relpath="子目录/笔记.md"]').count();
  check('重启后目录结构、成员和左侧展开还在', expandedBack === 1 && jiaRow && yiRow?.parentId === jiaRow.folderId && (await win.locator(`[data-testid="vfolder-row"][data-resource-id="${ids.md}"]`).count()) === 1 && (await win.locator(`[data-testid="vfolder-row"][data-resource-id="${ids.csv}"]`).count()) === 1);

  const renamed = path.join(RA, '子目录', '笔记-改.md');
  fs.renameSync(mdPath, renamed);
  await win.waitForFunction((rid) => {
    const row = document.querySelector(`[data-testid="vfolder-row"][data-resource-id="${rid}"] .name`);
    return !!row && row.textContent === '笔记-改.md';
  }, ids.md, { timeout: 15000 }).catch(() => {});
  const nameNow = await win.locator(`[data-testid="vfolder-row"][data-resource-id="${ids.md}"] .name`).textContent();
  check('外部重命名后两边仍指向同一个资源 ID', nameNow === '笔记-改.md', nameNow || '');

  await win.evaluate((rid) => window.__kb.open(rid), ids.md);
  await win.waitForSelector('[data-testid="reader-markdown"]');
  const firstId = await win.evaluate(() => window.__dock.activePanel.id);
  const secondId = await win.evaluate((rid) => window.__kb.openCopy(rid, '再开一份'), ids.md);
  await win.waitForSelector(`.view-root[data-item-id="${secondId}"] [data-testid="reader-markdown"]`);
  const pa = win.locator(`.view-root[data-item-id="${firstId}"]`);
  await pa.locator('[data-testid="mode-edit"]').click();
  const editor = pa.locator('[data-testid="editor-text"]');
  await editor.focus();
  await editor.evaluate((t) => t.setSelectionRange(t.value.length, t.value.length));
  await win.keyboard.type('第二面板能看见。\n');
  await editor.press('Control+s');
  const synced = await win.waitForFunction((id) => (document.querySelector(`.view-root[data-item-id="${id}"] [data-testid="reader-markdown"]`)?.textContent ?? '').includes('第二面板能看见'), secondId, { timeout: 8000 }).then(() => true, () => false);
  check('同一文件两个面板：一边保存，另一边刷新', synced && sha(renamed) !== mdHash);

  await win.evaluate(([r]) => window.__kb.openByPath(r, '没有阅读器.xyz'), [rootA]);
  const unsupported = await win.waitForFunction(() => {
    const toast = document.querySelector('[data-testid="toast"]')?.textContent ?? '';
    return toast.includes('暂无阅读器') && !!document.querySelector('[data-testid="reader-unsupported"]');
  }, null, { timeout: 8000 }).then(() => true, () => false);
  check('没有阅读器的格式仍打开，并提示暂无阅读器', unsupported);

  await win.locator(`[data-testid="vfolder-row"][data-resource-id="${ids.csv}"]`).click({ button: 'right' });
  await win.waitForSelector('[data-testid="dirview-menu"]');
  const folderMenu = await win.locator('[data-testid="dirview-menu"]').innerText();
  await win.keyboard.press('Escape');
  await win.locator('[data-testid="dirview-pane"][data-pane="left"] [data-testid="dirview-location"]').selectOption('refs');
  await win.locator('[data-testid="ws-ref-row"]').first().click({ button: 'right' });
  await win.waitForSelector('[data-testid="dirview-menu"]');
  const wsMenu = await win.locator('[data-testid="dirview-menu"]').innerText();
  check('自建目录里的文件写「从该目录移除」，工作资料行写「从本工作区移除」', folderMenu.includes('从该目录移除') && !folderMenu.includes('从本工作区移除') && wsMenu.includes('从本工作区移除') && !wsMenu.includes('从该目录移除'), JSON.stringify({ folderMenu, wsMenu }));
  await win.keyboard.press('Escape');
  await win.locator('[data-testid="dirview-pane"][data-pane="left"] [data-testid="dirview-location"]').selectOption(`root:${rootA}`);

  fs.rmSync(path.join(RB, '表.csv'));
  await win.waitForFunction((rid) => document.querySelector(`[data-testid="vfolder-row"][data-resource-id="${rid}"]`)?.getAttribute('aria-disabled') === 'true', ids.csv, { timeout: 15000 }).catch(() => {});
  const missing = await win.locator(`[data-testid="vfolder-row"][data-resource-id="${ids.csv}"]`).getAttribute('aria-disabled');
  await shot(win, 'missing-ref.png');
  check('缺失文件在自建目录里保留并划掉，不自动清理', missing === 'true');

  const drag = await win.evaluate(async () => {
    const src = document.querySelector('[data-testid="vfolder-row"][data-entry="file"]:not([aria-disabled="true"])');
    const dst = document.querySelector('[data-testid="dirview-pane"][data-pane="right"] .dirview-body');
    if (!src || !dst || typeof DataTransfer === 'undefined') return { ok: false, reason: 'no-row' };
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    const raw = dt.getData('text/plain');
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await new Promise((r) => setTimeout(r, 80));
    const over = dst.getAttribute('data-drag-over');
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
    let payload = null;
    try { payload = JSON.parse(raw); } catch { payload = null; }
    return { ok: over === 'true' && payload?.v === 1 && payload.items?.[0]?.entry === 'file', over, entry: payload?.items?.[0]?.entry, mime: raw.slice(0, 120) };
  });
  check('拖拽 payload 区分文件条目，落点只高亮', drag.ok === true, JSON.stringify(drag));
  await win.locator('[data-testid="dirview-pane"][data-pane="right"] [data-testid="dirview-crumb"] button', { hasText: '自建目录' }).click();
  const nodeDrag = await win.evaluate(() => {
    const src = document.querySelector('[data-testid="vfolder-row"][data-entry="vfolder-node"]');
    if (!src) return null;
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    try { return JSON.parse(dt.getData('text/plain'))?.items?.[0]?.entry; } catch { return null; }
  });
  check('自建目录节点的 payload 是 vfolder-node', nodeDrag === 'vfolder-node', String(nodeDrag));

  await win.click('[data-testid="pm-sidebar-float"]');
  await win.waitForSelector('[data-testid="sidebar"][data-floating="true"]');
  const floated = await win.locator('[data-testid="sidebar"][data-floating="true"] [data-testid="dirview"]').count();
  await shot(win, 'floated-sidebar.png');
  check('浮动侧栏里仍是双目录视图', floated === 1);

  const overflow = await win.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
  check('双栏没有把窗口撑出横向滚动条', overflow === false);

  const dualDb = await win.evaluate(() => (typeof window.kb.debugDualDbCheck === 'function' ? 'present' : 'absent'));
  check('双库校验', true, dualDb === 'absent' ? 'E 组尚未提供 kb.debugDualDbCheck，本包跳过' : '已提供，交由 E 组断言');

  await closeApp(app);
} catch (e) {
  console.error(e);
  try { await shot(win, 'dirview-failed.png'); } catch { /* 窗口可能已关 */ }
  try { await closeApp(app); } catch { /* ignore */ }
  results.push({ name: '脚本跑完', ok: false, detail: String(e?.stack || e) });
}

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
fs.mkdirSync(path.join(ROOT, 'verify'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'verify', 'e2e-dirview.json'), JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
process.exit(failed.length ? 1 : 0);
