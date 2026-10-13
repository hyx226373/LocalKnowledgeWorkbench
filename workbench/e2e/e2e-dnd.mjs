// r11-D：真鼠标拖拽。同根移动、取消、无效落点、工作区引用、根排序、阅读区浮窗。
// 双目录：自建目录节点落到磁盘必须拒绝；目录里的文件条目落到真实文件夹要确认「将移动原文件」。
import { _electron as electron } from 'playwright';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, 'e2e/.tmp/dnd');
const USERDATA = path.join(TMP, 'userdata');
const A = path.join(TMP, '根甲');
const B = path.join(TMP, '根乙');
const SHOTS = path.resolve(ROOT, '../汇报/shots/榫卯组');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(A + '/笔记', { recursive: true });
fs.mkdirSync(A + '/归档', { recursive: true });
fs.mkdirSync(B + '/收件', { recursive: true });
fs.writeFileSync(path.join(A, '笔记/a.md'), '甲');
fs.writeFileSync(path.join(A, '笔记/b.md'), '乙');
fs.writeFileSync(path.join(A, '笔记/c.md'), '丙');
fs.writeFileSync(path.join(A, '笔记/d.md'), '丁');
fs.writeFileSync(path.join(A, '归档/占位.txt'), '占');
fs.writeFileSync(path.join(B, '收件/占位.txt'), '收');
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? '  — ' + detail : ''}`);
};

async function launch() {
  const env = { ...process.env, KB_USER_DATA: USERDATA };
  delete env.VITE_DEV_SERVER_URL;
  app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'],
    cwd: ROOT,
    env,
  });
  const win = await app.firstWindow();
  win.on('console', (m) => console.log('[renderer:' + m.type() + ']', m.text()));
  app.on('console', (m) => console.log('[main]', m.text()));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800));
  try {
    await win.waitForFunction(() => window.__layoutRestored === true, null, { timeout: 40000 });
  } catch (e) {
    const info = await win.evaluate(() => ({
      href: location.href,
      text: document.body ? document.body.innerText.slice(0, 500) : '',
      booted: !!document.querySelector('[data-testid="app"]'),
      dialog: document.querySelector('[data-testid="dialog"], [data-testid="custom-dialog"]')?.innerText ?? '',
    })).catch((err) => String(err));
    console.log('launch dump', JSON.stringify(info));
    await win.screenshot({ path: path.join(SHOTS, 'launch-failed.png') }).catch(() => {});
    throw e;
  }
  return { app, win };
}

const row = (win, rel) => win.locator(`[data-testid="sidebar"] [data-testid="tree-row"][data-relpath="${rel}"]`).first();

async function dismiss(win) {
  for (let i = 0; i < 4; i++) {
    if (!(await win.locator('.kb-dialog-backdrop').count())) return;
    const btn = win.locator('[data-testid="dnd-cancel-move"], [data-testid="dialog-cancel"], [data-testid="dialog-ok"]').first();
    if (await btn.count()) await btn.click();
    else await win.keyboard.press('Escape');
    await win.waitForTimeout(150);
  }
}

async function watchHints(win) {
  await win.evaluate(() => {
    const w = window;
    w.__dndHints = [];
    if (w.__dndObs) w.__dndObs.disconnect();
    const push = () => {
      const n = document.querySelector('[data-testid="dnd-hint"]');
      const t = (n && n.textContent ? n.textContent : '').trim();
      if (t && w.__dndHints[w.__dndHints.length - 1] !== t) w.__dndHints.push(t);
    };
    w.__dndObs = new MutationObserver(push);
    w.__dndObs.observe(document.body, { subtree: true, childList: true, characterData: true });
  });
}

async function seenHints(win) {
  const live = (await win.locator('[data-testid="dnd-hint"]').textContent().catch(() => '')) || '';
  const logged = await win.evaluate(() => window.__dndHints || []);
  return [...logged, live].filter(Boolean).join(' | ');
}

async function expandRoot(win, id) {
  const root = win.locator(`[data-testid="root-row"][data-root-id="${id}"]`);
  await root.click();
}

let app;
let win;
try {
  ({ app, win } = await launch());
  {
    const rootA = await win.evaluate((p) => window.kb.addRoot(p), A);
    const rootB = await win.evaluate((p) => window.kb.addRoot(p), B);
    await win.waitForFunction(async () => (await window.kb.getIndexStatus()).every((s) => s.state === 'idle' && s.fileCount > 0), null, { timeout: 30000, polling: 200 });
    await win.waitForFunction(() => document.querySelectorAll('[data-testid="root-row"]').length >= 2);
    await expandRoot(win, rootA.id);
    await row(win, '笔记').click();
    await row(win, '归档').waitFor();
    await row(win, '笔记/a.md').waitFor();

    const before = await win.evaluate(async ([id]) => (await window.kb.listDir(id, '笔记')).find((e) => e.name === 'a.md').resourceId, [rootA.id]);

    await row(win, '笔记/a.md').dragTo(row(win, '归档'));
    const dialog = win.locator('[data-testid="dnd-move-dialog"]');
    await dialog.waitFor({ timeout: 5000 });
    const text = await dialog.innerText();
    check('确认框写明将移动原文件', text.includes('将移动原文件'), text.replace(/\s+/g, ' ').slice(0, 180));
    await win.screenshot({ path: path.join(SHOTS, 'move-dialog.png') });
    await win.click('[data-testid="dnd-confirm-move"]');
    await win.waitForFunction(() => !document.querySelector('[data-testid="dnd-move-dialog"]'));
    const moved = fs.existsSync(path.join(A, '归档/a.md')) && !fs.existsSync(path.join(A, '笔记/a.md'));
    check('同根真移动落到磁盘', moved);
    const after = await win.evaluate((rid) => window.kb.getResource(rid), before);
    check('resourceId 不变', after && after.resourceId === before && after.relPath === '归档/a.md', JSON.stringify(after && { id: after.resourceId, rel: after.relPath }));

    const ops = await win.evaluate(() => window.kb.listOps(10));
    const moveOp = ops.find((o) => o.op === 'move' && o.resourceId === before && !o.undoneAt);
    const undone = moveOp ? await win.evaluate((id) => window.kb.opUndo(id), moveOp.id) : null;
    check('移动可撤销', !!moveOp && undone?.status === 'undone' && fs.existsSync(path.join(A, '笔记/a.md')));

    await row(win, '笔记/b.md').waitFor();
    await watchHints(win);
    await row(win, '笔记/b.md').dragTo(row(win, '笔记/c.md'));
    await win.waitForFunction(() => {
      const n = document.querySelector('[data-testid="dnd-hint"]');
      return !!(n && n.textContent && n.textContent.includes('此处不可放置'));
    }, null, { timeout: 8000 }).catch(() => {});
    const bar = await seenHints(win);
    check('无效落点提示且不移动', bar.includes('此处不可放置') && fs.existsSync(path.join(A, '笔记/b.md')) && !fs.existsSync(path.join(A, '归档/b.md')), bar || '(没有提示)');

    await dismiss(win);
    await watchHints(win);
    await row(win, '笔记/b.md').dragTo(win.locator('[data-testid="ws-refs"]'), { targetPosition: { x: 80, y: 36 } });
    await win.waitForTimeout(400);
    if (await win.locator('.kb-dialog-backdrop').count()) {
      console.log('ref dialog', (await win.locator('.kb-dialog').innerText()).replace(/\s+/g, ' ').slice(0, 240));
      await dismiss(win);
    }
    const refHint = await seenHints(win);
    const refs = await win.evaluate(async () => window.kb.listWorkspaceRefs(await window.kb.getCurrentWorkspaceId()));
    check('拖到本工作的资料只加引用', refHint.includes('加入本工作的资料') && refs.some((r) => r.relPath === '笔记/b.md') && fs.existsSync(path.join(A, '笔记/b.md')), `${refHint} ${JSON.stringify(refs.map((r) => r.relPath))}`);

    await row(win, '笔记/c.md').dragTo(row(win, '归档'));
    await dialog.waitFor({ timeout: 5000 });
    await win.click('[data-testid="dnd-cancel-move"]');
    await win.waitForFunction(() => !document.querySelector('.kb-dialog-backdrop'));
    check('取消批准则原文件不动', fs.existsSync(path.join(A, '笔记/c.md')) && !fs.existsSync(path.join(A, '归档/c.md')));

    await expandRoot(win, rootB.id);
    await dismiss(win);
    await win.locator(`[data-testid="root-row"][data-root-id="${rootB.id}"]`).dragTo(win.locator(`[data-testid="root-row"][data-root-id="${rootA.id}"]`));
    let order = null;
    try {
      await win.waitForFunction((id) => window.kb.getLayout('ui.rootOrder').then((o) => !!(o && Array.isArray(o.ids) && o.ids[0] === id)), rootB.id, { timeout: 8000 });
    } catch {
      /* 下面用实际读到的值判定 */
    }
    order = await win.evaluate(() => window.kb.getLayout('ui.rootOrder'));
    check('根列表调序写入 ui.rootOrder', !!(order && order.v === 1 && Array.isArray(order.ids) && order.ids[0] === rootB.id), JSON.stringify(order));

    await dismiss(win);
    await row(win, '笔记/c.md').dragTo(win.locator('[data-testid="dock"] .kb-watermark'));
    await win.waitForTimeout(500);
    const panels = await win.evaluate(() =>
      window.__dock.panels.map((p) => ({ title: p.title, floating: p.group.api.location.type === 'floating' })),
    );
    check('工作台空白处打开为浮窗', panels.some((p) => p.floating && /c\.md/.test(p.title)), JSON.stringify(panels));
    await win.screenshot({ path: path.join(SHOTS, 'float-open.png') });

    await row(win, '收件').click();
    const crossBefore = await win.evaluate(async ([id]) => (await window.kb.listDir(id, '笔记')).find((e) => e.name === 'c.md').resourceId, [rootA.id]);
    await watchHints(win);
    await row(win, '笔记/c.md').dragTo(row(win, '收件'));
    await dialog.waitFor({ timeout: 5000 });
    const crossText = await dialog.innerText();
    check('跨根确认框写明将移动原文件', crossText.includes('将移动原文件') && crossText.includes('跨根'), crossText.replace(/\s+/g, ' ').slice(0, 180));
    await win.click('[data-testid="dnd-confirm-move"]');
    await win.waitForFunction(() => !document.querySelector('[data-testid="dnd-move-dialog"]'));
    const crossMoved = fs.existsSync(path.join(B, '收件/c.md')) && !fs.existsSync(path.join(A, '笔记/c.md'));
    const crossAfter = await win.evaluate((rid) => window.kb.getResource(rid), crossBefore);
    const stillOpen = await win.evaluate(() => window.__dock.panels.some((p) => /c\.md/.test(p.title || '')));
    check('跨根真移动 resourceId 与面板仍在', crossMoved && crossAfter && crossAfter.resourceId === crossBefore && crossAfter.relPath === '收件/c.md' && stillOpen, JSON.stringify(crossAfter && { id: crossAfter.resourceId, rel: crossAfter.relPath, stillOpen }));
    const crossOps = await win.evaluate(() => window.kb.listOps(10));
    const crossOp = crossOps.find((o) => o.op === 'move' && o.resourceId === crossBefore && !o.undoneAt);
    const crossUndone = crossOp ? await win.evaluate((id) => window.kb.opUndo(id), crossOp.id) : null;
    check('跨根移动可撤销', !!crossOp && crossUndone?.status === 'undone' && fs.existsSync(path.join(A, '笔记/c.md')) && !fs.existsSync(path.join(B, '收件/c.md')));

    await dismiss(win);
    const dBefore = await win.evaluate(async ([id]) => (await window.kb.listDir(id, '笔记')).find((e) => e.name === 'd.md'), [rootA.id]);
    const folder = await win.evaluate(async () => window.kb.createVirtualFolder(null, '归类甲'));
    await win.evaluate(async ([id, folderId]) => window.kb.setVfolderMembership(id, [folderId]), [dBefore.resourceId, folder.folderId]);
    await win.keyboard.press('Control+Shift+P');
    await win.locator('[data-testid="command-palette"]').waitFor();
    await win.locator('[data-testid="palette-item"][data-command-id="dirView.toggleDual"]').click();
    await win.locator('[data-testid="dirview"]').waitFor();
    const leftPane = win.locator('[data-testid="dirview-pane"][data-pane="left"]');
    await leftPane.locator('[data-testid="dirview-location"]').selectOption('root:' + rootA.id);
    const archive = leftPane.locator('[data-testid="tree-row"][data-relpath="归档"]');
    await archive.waitFor();
    const rightPane = win.locator('[data-testid="dirview-pane"][data-pane="right"]');
    const node = rightPane.locator('[data-testid="vfolder-row"][data-entry="vfolder-node"][data-folder-id="' + folder.folderId + '"]');
    await node.waitFor();
    await watchHints(win);
    await node.dragTo(archive);
    await win.waitForFunction(() => {
      const n = document.querySelector('[data-testid="dnd-hint"]');
      const d = document.querySelector('.kb-dialog');
      const t = ((n && n.textContent) || '') + ((d && d.textContent) || '');
      return t.includes('自建目录节点') || t.includes('此处不可放置');
    }, null, { timeout: 8000 }).catch(() => {});
    const nodeHint = await seenHints(win);
    const nodeDialog = (await win.locator('.kb-dialog').count()) ? await win.locator('.kb-dialog').innerText() : '';
    const nodeText = `${nodeHint} ${nodeDialog}`;
    await dismiss(win);
    const nodeLanded = fs.existsSync(path.join(A, '归类甲')) || fs.existsSync(path.join(A, '归档/归类甲')) || fs.existsSync(path.join(A, '归档/d.md'));
    check('自建目录节点拖到磁盘文件夹被拒绝', !nodeLanded && (nodeText.includes('自建目录节点') || nodeText.includes('此处不可放置')), nodeText.replace(/\s+/g, ' ').slice(0, 180));
    await win.screenshot({ path: path.join(SHOTS, 'vfolder-node-reject.png') });

    await node.click();
    const vfile = rightPane.locator('[data-testid="vfolder-row"][data-entry="file"][data-resource-id="' + dBefore.resourceId + '"]');
    await vfile.waitFor();
    await vfile.dragTo(archive);
    await dialog.waitFor({ timeout: 8000 });
    const vtext = await dialog.innerText();
    check('自建目录里的文件拖到真实文件夹会确认将移动原文件', vtext.includes('将移动原文件'), vtext.replace(/\s+/g, ' ').slice(0, 180));
    await win.screenshot({ path: path.join(SHOTS, 'vfolder-file-move.png') });
    await win.click('[data-testid="dnd-confirm-move"]');
    await win.waitForFunction(() => !document.querySelector('[data-testid="dnd-move-dialog"]'));
    const vMoved = fs.existsSync(path.join(A, '归档/d.md')) && !fs.existsSync(path.join(A, '笔记/d.md'));
    const vAfter = await win.evaluate((rid) => window.kb.getResource(rid), dBefore.resourceId);
    check('自建目录里的文件真移动且 resourceId 不变', vMoved && vAfter && vAfter.resourceId === dBefore.resourceId && vAfter.relPath === '归档/d.md', JSON.stringify(vAfter && { id: vAfter.resourceId, rel: vAfter.relPath }));

    await win.screenshot({ path: path.join(SHOTS, 'after.png') });
  }
} catch (e) {
  check('端到端跑完', false, String(e && e.stack ? e.stack : e));
  try {
    const win = app ? await app.firstWindow() : null;
    if (win) await win.screenshot({ path: path.join(SHOTS, 'failed.png') });
  } catch {
    /* 窗口可能还没起来 */
  }
} finally {
  if (app) {
    await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 8000))]);
  }
  fs.mkdirSync(path.join(ROOT, 'verify'), { recursive: true });
  let testedCommit = '';
  try {
    testedCommit = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    testedCommit = '';
  }
  fs.writeFileSync(path.join(ROOT, 'verify/dnd.json'), JSON.stringify({ at: new Date().toISOString(), testedCommit, results }, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}
