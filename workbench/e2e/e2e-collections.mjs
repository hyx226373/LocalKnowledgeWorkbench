// 端到端：资料集合与工作区（第 9 轮 B）
// - 三个不同根目录、至少两种格式的文件加入同一项工作（“本工作的资料”），全部经界面操作（⊕）
// - 同一原文件被两个工作区引用
// - 移除引用后原文件仍在原位、字节不变；添加/移除过程中各根目录的文件清单不变（不移动、不复制）
// - 一键“全部打开”；重启后资料列表保持
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE = process.env.KB_SAMPLE || '/workspace/kb-sample';
const VERIFY = path.join(ROOT, 'verify');
const TMP = path.join(ROOT, 'e2e/.tmp/collections');
const USERDATA = path.join(TMP, 'userdata');
const RA = path.join(TMP, '甲-笔记');
const RB = path.join(TMP, '乙-论文');
const RC = path.join(TMP, '丙-图片');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
fs.cpSync(path.join(SAMPLE, '笔记'), RA, { recursive: true });
fs.cpSync(path.join(SAMPLE, '资料/论文'), RB, { recursive: true });
fs.cpSync(path.join(SAMPLE, '资料/图片'), RC, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => (results.push({ name, ok: !!ok, detail }), console.log(`${ok ? '✔' : '✘'} ${name}${detail ? '  — ' + detail : ''}`));
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const snapshot = () => {
  const out = {};
  for (const r of [RA, RB, RC]) {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else out[path.relative(TMP, p)] = sha(p) + ':' + fs.statSync(p).mtimeMs;
      }
    };
    walk(r);
  }
  return out;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function launch() {
  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'], cwd: ROOT, env: { ...process.env, KB_USER_DATA: USERDATA } });
  const win = await app.firstWindow();
  win.on('console', (m) => m.type() === 'error' && console.log('[renderer]', m.text()));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800));
  await win.waitForFunction(() => window.__layoutRestored === true, null, { timeout: 30000 });
  return { app, win };
}
const refRows = (win) => win.$$eval('[data-testid="ws-ref-row"]', (els) => els.map((e) => ({ rel: e.dataset.relpath, root: e.dataset.rootId, rid: e.dataset.resourceId, open: e.dataset.open === 'true', missing: e.getAttribute('aria-disabled') === 'true' })));
const row = (win, rel) => win.locator(`[data-testid="tree-row"][data-relpath="${rel}"]`).first();
const addViaUi = async (win, rel) => {
  const r = row(win, rel);
  await r.hover();
  await r.locator('[data-testid="ref-toggle"]').click();
  await win.waitForFunction((rel) => !!document.querySelector(`[data-testid="ws-ref-row"][data-relpath="${rel}"]`), rel, { timeout: 5000 });
};

const before = snapshot();
let { app, win } = await launch();
// 通过界面注册三个根（回车添加，会自动展开）
for (const r of [RA, RB, RC]) {
  await win.fill('[data-testid="root-path-input"]', r);
  await win.press('[data-testid="root-path-input"]', 'Enter');
  await win.waitForSelector(`[data-testid="root-row"][data-root-name="${path.basename(r)}"]`, { timeout: 10000 });
}
await win.waitForFunction(async () => (await window.kb.getIndexStatus()).length === 3 && (await window.kb.getIndexStatus()).every((s) => s.state === 'idle' && s.fileCount > 0), null, { timeout: 30000, polling: 200 });
const roots = await win.evaluate(() => window.kb.listRoots());
const idOf = (dir) => roots.find((x) => x.name === path.basename(dir)).id;

// 甲根：展开 2026 目录再加入 读书笔记.md；另加 待办.txt
await row(win, '2026').click();
await win.waitForSelector('[data-testid="tree-row"][data-relpath="2026/读书笔记.md"]');
await addViaUi(win, '2026/读书笔记.md');
await addViaUi(win, '待办.txt');
await addViaUi(win, '讲义.pdf'); // 乙根
await addViaUi(win, '照片.jpg'); // 丙根
let rows = await refRows(win);
const exts = new Set(rows.map((r) => r.rel.split('.').pop()));
const rootSet = new Set(rows.map((r) => r.root));
check('三个不同根目录、四种格式（md/txt/pdf/jpg）的文件经界面加入同一项工作', rows.length === 4 && rootSet.size === 3 && exts.size >= 2 && [RA, RB, RC].every((d) => rootSet.has(idOf(d))), JSON.stringify(rows.map((r) => r.rel)));
check('加入资料不移动、不复制、不修改任何原文件（三个根的文件清单、哈希、mtime 与加入前完全一致）', same(before, snapshot()));
const ws1 = await win.evaluate(() => window.__kb.currentWorkspaceId());
const sum1 = (await win.evaluate(() => window.kb.listWorkspaces())).find((w) => w.id === ws1);
check('工作区摘要显示跨根：rootIds 含 3 个根，refCount = 4', sum1.rootIds.length === 3 && sum1.refCount === 4, JSON.stringify({ rootIds: sum1.rootIds.length, refCount: sum1.refCount }));

// 一键全部打开
await win.click('[data-testid="ws-refs-open-all"]');
await win.waitForFunction(() => window.__kb.openRids().length === 4, null, { timeout: 15000 });
await win.waitForFunction(() => [...document.querySelectorAll('[data-testid="ws-ref-row"]')].every((e) => e.dataset.open === 'true'), null, { timeout: 5000 });
rows = await refRows(win);
check('“全部打开”：一键在标签中打开全部资料，资料行标记为已打开', rows.every((r) => r.open), JSON.stringify(rows.map((r) => r.open)));
await win.evaluate(() => window.__kb.flush());
await win.screenshot({ path: path.join(VERIFY, 'collections-refs.png') });

// 第二个工作区引用同一个 讲义.pdf
const pdfRid = rows.find((r) => r.rel === '讲义.pdf').rid;
const pdfAbs = path.join(RB, '讲义.pdf');
const pdfHash = sha(pdfAbs);
const pdfSize = fs.statSync(pdfAbs).size;
const ws2 = await win.evaluate(async () => (await window.kb.createWorkspace('第二项工作', '', { schema: 4, dock: null, shell: { sidebarWidth: 280 } }, [])).id);
await win.evaluate((id) => window.__kb.switchTo(id), ws2);
await win.waitForFunction(() => document.querySelectorAll('[data-testid="ws-ref-row"]').length === 0, null, { timeout: 5000 });
await addViaUi(win, '讲义.pdf');
const refBy = await win.evaluate((rid) => window.kb.workspacesReferencing(rid), pdfRid);
check('同一原文件被两个工作区引用（同一资源 ID，不产生副本）', refBy.length === 2 && refBy.some((w) => w.id === ws1) && refBy.some((w) => w.id === ws2) && (await refRows(win))[0].rid === pdfRid, JSON.stringify(refBy));

// 回到第一项工作，经界面移除 讲义.pdf 的引用
await win.evaluate((id) => window.__kb.switchTo(id), ws1);
await win.waitForFunction(() => document.querySelectorAll('[data-testid="ws-ref-row"]').length === 4, null, { timeout: 5000 });
const r = win.locator('[data-testid="ws-ref-row"][data-relpath="讲义.pdf"]');
await r.hover();
await r.locator('[data-testid="ws-ref-remove"]').click();
const dlg = await win.textContent('[data-testid="dialog"]');
await win.click('[data-testid="dialog-ok"]');
await win.waitForFunction(() => document.querySelectorAll('[data-testid="ws-ref-row"]').length === 3, null, { timeout: 5000 });
const ws2Refs = await win.evaluate((id) => window.kb.listWorkspaceRefs(id), ws2);
check('移除引用的确认框说明不删除原文件，并提示仍被“第二项工作”引用', /不会被删除/.test(dlg) && /第二项工作/.test(dlg), dlg.replace(/\s+/g, ' ').slice(0, 160));
check('确认框说明会一起关闭已打开的标签', /标签会一起关闭/.test(dlg), dlg.replace(/\s+/g, ' ').slice(0, 200));
check('移除引用后：原文件仍在原位、字节不变（sha256、大小）；另一工作区的引用不受影响', fs.existsSync(pdfAbs) && sha(pdfAbs) === pdfHash && fs.statSync(pdfAbs).size === pdfSize && ws2Refs.length === 1 && ws2Refs[0].resourceId === pdfRid && !ws2Refs[0].missing, `sha256=${pdfHash.slice(0, 12)}…`);
check('整个过程三个根的文件清单、哈希、mtime 与开始时完全一致（没有移动、复制或写入）', same(before, snapshot()));
check('产品决定：移除资料时关闭它已打开的标签', await win.waitForFunction((rid) => !window.__kb.openRids().includes(rid), pdfRid, { timeout: 5000 }).then(() => true, () => false));
// 有未保存内容的标签：先确认；选“先不移除”则引用与标签都保留，文件不被写入
const todoRow = rows.find((x) => x.rel === '待办.txt');
const todoAbs = path.join(RA, '待办.txt');
const todo0 = fs.readFileSync(todoAbs);
await win.evaluate((rid) => window.__kb.open(rid), todoRow.rid);
await win.waitForSelector('[data-testid="text-editor"]');
const T = await win.evaluate(() => window.__dock.activePanel.id);
await win.locator(`.view-root[data-item-id="${T}"] [data-testid="mode-edit"]`).click();
const ta = win.locator(`.view-root[data-item-id="${T}"] [data-testid="editor-text"]`);
await ta.focus();
await win.keyboard.type('未保存的一行');
await win.waitForFunction((id) => /未保存/.test(document.querySelector(`.view-root[data-item-id="${id}"] [data-testid="editor-state"]`)?.textContent ?? ''), T);
const tr = win.locator('[data-testid="ws-ref-row"][data-relpath="待办.txt"]');
await tr.hover();
await tr.locator('[data-testid="ws-ref-remove"]').click();
await win.click('[data-testid="dialog-ok"]');
await win.waitForFunction(() => /未保存/.test(document.querySelector('[data-testid="dialog"]')?.textContent ?? ''), null, { timeout: 5000 });
const dirtyDlg = await win.textContent('[data-testid="dialog"]');
await win.screenshot({ path: path.join(VERIFY, 'collections-remove-dirty-confirm.png') });
await win.click('[data-testid="dialog-cancel"]');
await win.waitForTimeout(300);
check('移除有未保存内容的资料：先确认；取消后引用与标签都保留，文件未被写入', /未保存/.test(dirtyDlg) && (await refRows(win)).length === 3 && (await win.evaluate((id) => !!window.__dock.getPanel(id), T)) && fs.readFileSync(todoAbs).equals(todo0), dirtyDlg.replace(/\s+/g, ' ').slice(0, 160));

// 重启：资料列表保持
await win.evaluate(() => window.__kb.flush());
await app.close();
({ app, win } = await launch());
await win.waitForFunction(() => document.querySelectorAll('[data-testid="ws-ref-row"]').length === 3, null, { timeout: 10000 }).catch(() => {});
rows = await refRows(win);
check('重启后“本工作的资料”保持（3 项，顺序不变）', rows.length === 3 && rows.map((x) => x.rel).join() === '2026/读书笔记.md,待办.txt,照片.jpg', JSON.stringify(rows.map((x) => x.rel)));

// 原文件被外部删除：资料行标为不可用（不自动删除引用）
fs.rmSync(path.join(RC, '照片.jpg'));
await win.waitForFunction(() => document.querySelector('[data-testid="ws-ref-row"][data-relpath="照片.jpg"]')?.getAttribute('aria-disabled') === 'true', null, { timeout: 15000 }).catch(() => {});
rows = await refRows(win);
check('原文件被外部删除后，资料行显示“不在原处”，引用保留（文件恢复后可再用）', rows.length === 3 && rows.find((x) => x.rel === '照片.jpg')?.missing === true, JSON.stringify(rows));
// 失效引用不自动清理，提供“修复…”（打开数据迁移窗口的“修复路径”页）
const repair = win.locator('[data-testid="ws-ref-row"][data-relpath="照片.jpg"] [data-testid="ws-ref-repair"]');
const nWin = app.windows().length;
await repair.click();
const opened = await app.waitForEvent('window', { timeout: 10000 }).then(() => true, () => app.windows().length > nWin);
await win.screenshot({ path: path.join(VERIFY, 'collections-missing-repair.png') });
check('失效的资料引用保留并提供“修复…”入口（打开“修复路径”）', (await repair.count()) === 1 && opened);
await app.close();

fs.writeFileSync(path.join(VERIFY, 'e2e-collections.json'), JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
