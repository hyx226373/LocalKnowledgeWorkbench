// 端到端：文本 / Markdown 原位编辑（第 9 轮 C）
// - Markdown：预览 / 编辑 / 分栏三种视图；分栏时预览实时跟随未保存的编辑
// - 保存走主进程服务层：Ctrl+S 直接保存（产品决定：不默认弹出改动预览；“查看改动”可随时预览，“保存前预览”可选打开），
//   每次保存留恢复记录（备份 + op_log），“撤销上次保存”逐级回到上一版
// - 外部软件同时修改：未保存时自动刷新；有未保存修改时提示、不冲掉；保存时冲突对话框（保留我的 / 采用外部的 / 对比后再决定）
// - 同一文件的另一个面板及时刷新；有未保存修改的面板只提示
// - .txt 编辑保存；GBK 文件可编辑、按原编码写回、状态栏显示编码；关闭未保存的面板后再打开恢复草稿；重启后视图模式保持
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE = process.env.KB_SAMPLE || '/workspace/kb-sample';
const VERIFY = path.join(ROOT, 'verify');
const TMP = path.join(ROOT, 'e2e/.tmp/edit');
const USERDATA = path.join(TMP, 'userdata');
const R = path.join(TMP, '样例根');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
fs.cpSync(SAMPLE, R, { recursive: true });
const MD = path.join(R, '笔记/2026/读书笔记.md');
const TXT = path.join(R, '笔记/待办.txt');
const GBK = path.join(R, '笔记/gbk编码.txt');
const md0 = fs.readFileSync(MD, 'utf8');
const gbk0 = fs.readFileSync(GBK);
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const results = [];
const check = (name, ok, detail = '') => (results.push({ name, ok: !!ok, detail }), console.log(`${ok ? '✔' : '✘'} ${name}${detail ? '  — ' + detail : ''}`));

async function launch() {
  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'], cwd: ROOT, env: { ...process.env, KB_USER_DATA: USERDATA } });
  const win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 860));
  await win.waitForFunction(() => window.__layoutRestored === true, null, { timeout: 30000 });
  return { app, win };
}
const until = (win, fn, arg, ms = 8000) => win.waitForFunction(fn, arg, { timeout: ms, polling: 100 }).then(() => true, () => false);
const panel = (win, itemId) => win.locator(`.view-root[data-item-id="${itemId}"]`);
const typeAtEnd = async (win, loc, text) => {
  await loc.focus();
  await loc.evaluate((t) => t.setSelectionRange(t.value.length, t.value.length));
  await win.keyboard.type(text);
};

let { app, win } = await launch();
const root = await win.evaluate((p) => window.kb.addRoot(p), R);
await win.waitForFunction(async () => (await window.kb.getIndexStatus()).every((s) => s.state === 'idle' && s.fileCount > 0), null, { timeout: 30000, polling: 200 });
const mdRid = await win.evaluate(([r]) => window.__kb.openByPath(r, '笔记/2026/读书笔记.md', 'tab'), [root.id]);
await win.waitForSelector('[data-testid="md-editor"] [data-testid="reader-markdown"] h1');
const A = await win.evaluate(() => window.__dock.activePanel.id);
const pa = panel(win, A);

// ---- 三种视图
const modes = {};
for (const m of ['edit', 'split', 'preview', 'split']) {
  await pa.locator(`[data-testid="mode-${m}"]`).click();
  modes[m] = { text: await pa.locator('[data-testid="editor-text"]').count(), preview: await pa.locator('[data-testid="reader-markdown"]').count() };
}
check('Markdown 有预览 / 编辑 / 分栏三种视图', modes.edit.text === 1 && modes.edit.preview === 0 && modes.preview.text === 0 && modes.preview.preview === 1 && modes.split.text === 1 && modes.split.preview === 1, JSON.stringify(modes));
await typeAtEnd(win, pa.locator('[data-testid="editor-text"]'), '\n## 新增小节\n\n在应用里直接写的一段。\n');
check('分栏：预览实时显示未保存的编辑；工具栏标“未保存”；磁盘文件未变', (await until(win, (id) => [...document.querySelectorAll(`.view-root[data-item-id="${id}"] [data-testid="reader-markdown"] h2`)].some((h) => h.textContent === '新增小节'), A)) && /未保存/.test(await pa.locator('[data-testid="editor-state"]').textContent()) && fs.readFileSync(MD, 'utf8') === md0);

// ---- 改动预览：工具栏“查看改动”随时可看（不写盘）
await pa.locator('[data-testid="editor-diff"]').click();
await win.waitForSelector('[data-testid="pending-diff-dialog"] [data-testid="pending-diff"]');
const diffAdds = await win.$$eval('[data-testid="pending-diff"] .kb-diff-line[data-kind="add"]', (els) => els.map((e) => e.textContent.trim()));
await win.screenshot({ path: path.join(VERIFY, 'edit-save-diff.png') });
check('“查看改动”显示未保存的差异（新增的行），不写盘', diffAdds.some((t) => t.includes('新增小节')) && diffAdds.some((t) => t.includes('在应用里直接写的一段')) && fs.readFileSync(MD, 'utf8') === md0, JSON.stringify(diffAdds));
await win.click('[data-testid="pending-diff-dialog"] .kb-dialog-actions button');
await win.waitForSelector('[data-testid="pending-diff-dialog"]', { state: 'detached' });
// ---- Ctrl+S：直接保存，不弹预览
await pa.locator('[data-testid="editor-text"]').press('Control+s');
const savedDirect = await until(win, (id) => document.querySelector(`.view-root[data-item-id="${id}"] [data-testid="editor-state"]`)?.textContent === '已保存', A);
check('Ctrl+S 直接保存（不弹出改动预览），保存后可撤销', savedDirect && (await win.locator('[data-testid="save-preview-dialog"]').count()) === 0 && (await pa.locator('[data-testid="editor-undo-save"]').isEnabled()));
const md1 = fs.readFileSync(MD, 'utf8');
const ops1 = await win.evaluate((rid) => window.kb.textHistory(rid), mdRid);
check('确认后经主进程服务层写盘；op_log 记录写入且带备份哈希（恢复记录）；资源 ID 不变', md1.includes('在应用里直接写的一段') && md1.startsWith(md0.trimEnd()) && ops1.length === 1 && !!ops1[0].beforeHash && (await win.evaluate(([r]) => window.kb.listDir(r, '笔记/2026'), [root.id])).find((e) => e.name === '读书笔记.md')?.resourceId === mdRid, JSON.stringify(ops1));

// ---- 同一文件的第二个面板
const B = 'item-second-md';
await win.evaluate(([rid, id]) => window.__kb.openItemRaw({ itemId: id, sourceKind: 'file', adapterId: 'builtin.markdown', ref: rid, displayMode: 'in-app-reader' }, 'right'), [mdRid, B]);
const pb = panel(win, B);
await pb.locator('[data-testid="reader-markdown"] h1').waitFor();
await typeAtEnd(win, pa.locator('[data-testid="editor-text"]'), '第二次保存。\n');
await pa.locator('[data-testid="editor-text"]').press('Control+s');
const refreshed = await until(win, (id) => (document.querySelector(`.view-root[data-item-id="${id}"] [data-testid="reader-markdown"]`)?.textContent ?? '').includes('第二次保存'), B);
check('同一文件在另一个面板（无未保存修改）中及时刷新为新内容', refreshed);
// B 有未保存修改时，A 再保存 → B 只提示，不冲掉
await pb.locator('[data-testid="mode-split"]').click();
await typeAtEnd(win, pb.locator('[data-testid="editor-text"]'), 'B 面板里没保存的字。');
await typeAtEnd(win, pa.locator('[data-testid="editor-text"]'), '第三次保存。\n');
await pa.locator('[data-testid="editor-text"]').press('Control+s');
const warned = await until(win, (id) => !!document.querySelector(`.view-root[data-item-id="${id}"] [data-testid="editor-external-change"]`), B);
const bText = await pb.locator('[data-testid="editor-text"]').inputValue();
await win.screenshot({ path: path.join(VERIFY, 'edit-external-change-banner.png') });
check('另一个面板有未保存修改时：显示“已在别处被修改”提示，未保存的编辑原样保留（不冲掉）', warned && bText.includes('B 面板里没保存的字') && !bText.includes('第三次保存'), JSON.stringify({ warned, tail: bText.slice(-80), disk: fs.readFileSync(MD, 'utf8').slice(-60) }));
// B 保存 → 冲突 → 对比 → 采用外部的
await pb.locator('[data-testid="editor-text"]').press('Control+s');
await win.waitForSelector('[data-testid="conflict-dialog"]');
await win.click('[data-testid="conflict-dialog"] [data-testid="conflict-compare"]');
await win.waitForSelector('[data-testid="conflict-compare-dialog"] [data-testid="conflict-diff"]');
const cmp = await win.$$eval('[data-testid="conflict-diff"] .kb-diff-line', (els) => els.filter((e) => e.dataset.kind !== 'ctx' && e.dataset.kind !== 'gap').map((e) => e.dataset.kind + ':' + e.textContent.trim()));
await win.screenshot({ path: path.join(VERIFY, 'edit-conflict-compare.png') });
check('保存时发现文件已变：冲突对话框 → “对比后再决定”显示外部版本与我的版本的差异', cmp.some((x) => x.startsWith('del') && x.includes('第三次保存')) && cmp.some((x) => x.startsWith('add') && x.includes('B 面板里没保存的字')), JSON.stringify(cmp));
const beforeTheirs = fs.readFileSync(MD, 'utf8');
await win.click('[data-testid="conflict-compare-dialog"] [data-testid="conflict-theirs"]');
await until(win, (id) => !document.querySelector(`.view-root[data-item-id="${id}"] [data-testid="editor-external-change"]`), B);
check('“采用外部的”：编辑器换成磁盘上的版本，文件不被写入', fs.readFileSync(MD, 'utf8') === beforeTheirs && (await pb.locator('[data-testid="editor-text"]').inputValue()) === beforeTheirs.replace(/\r\n/g, '\n'));
await win.evaluate((id) => window.__dock.getPanel(id)?.api.close(), B);

// ---- 外部软件修改
// 1) 没有未保存修改：自动刷新
fs.appendFileSync(MD, '外部软件追加的一行。\n');
check('外部软件修改文件、编辑器无未保存修改：内容自动刷新', await until(win, (id) => document.querySelector(`.view-root[data-item-id="${id}"] [data-testid="editor-text"]`)?.value.includes('外部软件追加的一行'), A, 10000));
// 2) 有未保存修改：提示；保存 → 冲突 → 保留我的；外部版本可撤销找回
await typeAtEnd(win, pa.locator('[data-testid="editor-text"]'), '我的修改 X。\n');
const external = fs.readFileSync(MD, 'utf8') + '外部第二次修改。\n';
fs.writeFileSync(MD, external);
check('外部修改时编辑器有未保存修改：提示且不冲掉', (await until(win, (id) => !!document.querySelector(`.view-root[data-item-id="${id}"] [data-testid="editor-external-change"]`), A, 10000)) && (await pa.locator('[data-testid="editor-text"]').inputValue()).includes('我的修改 X'));
await pa.locator('[data-testid="editor-text"]').press('Control+s');
await win.waitForSelector('[data-testid="conflict-dialog"]');
await win.screenshot({ path: path.join(VERIFY, 'edit-conflict-dialog.png') });
const dlgButtons = await win.$$eval('[data-testid="conflict-dialog"] button', (b) => b.map((x) => x.textContent.trim()));
check('冲突对话框给出三个选择：保留我的 / 采用外部的 / 对比后再决定（以及继续编辑），此时文件未被覆盖', ['保留我的', '采用外部的', '对比后再决定'].every((t) => dlgButtons.includes(t)) && fs.readFileSync(MD, 'utf8') === external, JSON.stringify(dlgButtons));
await win.click('[data-testid="conflict-dialog"] [data-testid="conflict-mine"]');
await until(win, (id) => document.querySelector(`.view-root[data-item-id="${id}"] [data-testid="editor-state"]`)?.textContent === '已保存', A);
const mine = fs.readFileSync(MD, 'utf8');
check('“保留我的”：写入我的版本（外部第二次修改不在其中）', mine.includes('我的修改 X') && !mine.includes('外部第二次修改'));
// 撤销上次保存 → 外部版本回来（被覆盖的外部版本已备份）
await pa.locator('[data-testid="editor-undo-save"]').click();
const undone1 = await until(win, (ext) => document.querySelector('[data-testid="editor-text"]')?.value === ext, external.replace(/\r\n/g, '\n'));
check('“撤销上次保存”：恢复为被覆盖前的外部版本（字节一致）', undone1 && fs.readFileSync(MD, 'utf8') === external);
// 逐级撤销到最初版本：之前在应用里保存过 3 次（第 1/2/3 次）+ 保留我的 1 次（已撤销）
let conflictUndoText = '';
let beforeConflictUndo = null;
for (let i = 0; i < 3; i++) {
  const pre = fs.readFileSync(MD, 'utf8');
  await pa.locator('[data-testid="editor-undo-save"]').click();
  const c = await win.waitForSelector('[data-testid="dialog"]', { timeout: 1500 }).catch(() => null);
  if (c) {
    conflictUndoText = await win.innerText('[data-testid="dialog"]');
    beforeConflictUndo = pre;
    await win.screenshot({ path: path.join(VERIFY, 'edit-undo-conflict-text.png') });
    await win.click('[data-testid="dialog-ok"]'); // 外部改过 → 确认仍然撤销（当前内容先备份）
  }
  await win.waitForTimeout(400);
}
check('撤销冲突的提示如实说明：当前内容先进备份库，可在“操作记录”里“恢复撤销前的内容”（不再写“仍可再撤销回来”）', /操作记录/.test(conflictUndoText) && /恢复撤销前的内容/.test(conflictUndoText) && !/再撤销回来/.test(conflictUndoText), conflictUndoText.replace(/\s+/g, ' ').slice(0, 160));
check('继续撤销可逐级回到最初的版本（外部改动处会先确认，当前内容先备份）', fs.readFileSync(MD, 'utf8') === md0, `${fs.readFileSync(MD, 'utf8').length} vs ${md0.length}`);
const allOps = await win.evaluate(() => window.kb.listOps(100));
check('每次保存/撤销都在 op_log 留记录（write/undo），备份库里有写入前内容', allOps.filter((o) => o.op === 'write').length >= 4 && allOps.filter((o) => o.op === 'undo').length >= 4 && allOps.filter((o) => o.op === 'write').every((o) => o.detail.beforeHash));

// ---- 撤销冲突时备份下来的内容：在操作记录里找到并恢复
await win.evaluate(() => window.__kb.openOpLog());
await win.waitForSelector('[data-testid="oplog-row"]');
const restRow = '[data-testid="oplog-row"][data-restore-state="available"]';
const hasRestore = await win.locator(restRow).count();
await win.waitForTimeout(400);
await win.screenshot({ path: path.join(VERIFY, 'oplog-restore-undo-backup.png') });
if (hasRestore) {
  await win.click(`${restRow} [data-testid="oplog-restore"]`);
  const c2 = await win.waitForSelector('[data-testid="dialog"]', { timeout: 1500 }).catch(() => null);
  if (c2) await win.click('[data-testid="dialog-ok"]'); // 撤销之后文件又被逐级撤销改过 → 确认
  await win.waitForTimeout(500);
}
const restoredOk = beforeConflictUndo !== null && fs.readFileSync(MD, 'utf8') === beforeConflictUndo;
check('操作记录里那条撤销记录提供“恢复撤销前的内容”，恢复后文件与撤销前字节一致', hasRestore === 1 && restoredOk, `${hasRestore} 条可恢复`);
const restoredRowState = await win.evaluate(() => [...document.querySelectorAll('[data-testid="oplog-row"]')].map((r) => r.dataset.restoreState).filter(Boolean));
check('恢复后那条显示“已恢复撤销前的内容”；恢复本身记为一条可撤销的写入', restoredRowState.includes('restored') && (await win.locator('[data-testid="oplog-row"][data-via="restore-backup"][data-undo-state="available"]').count()) === 1, JSON.stringify(restoredRowState));
await win.click('[data-testid="oplog-close"]');

// ---- .txt
const txtRid = await win.evaluate(([r]) => window.__kb.openByPath(r, '笔记/待办.txt', 'right'), [root.id]);
await win.waitForSelector('[data-testid="text-editor"]');
const T = await win.evaluate(() => window.__dock.activePanel.id);
const pt = panel(win, T);
await pt.locator('[data-testid="mode-edit"]').click();
await typeAtEnd(win, pt.locator('[data-testid="editor-text"]'), '\n- 新的待办');
// 打开“保存前预览”后，保存才先弹预览（可选，缺省关）
await pt.locator('[data-testid="editor-preview-toggle"] input').check();
await pt.locator('[data-testid="editor-save"]').click();
const pv = await win.waitForSelector('[data-testid="save-preview-dialog"] [data-testid="save-diff"]', { timeout: 5000 }).then(() => true, () => false);
const notYet = !fs.readFileSync(TXT, 'utf8').endsWith('- 新的待办');
await win.click('[data-testid="save-confirm"]');
check('.txt 在面板里直接编辑并保存；打开“保存前预览”时先显示差异、确认后才写盘', pv && notYet && (await until(win, (id) => document.querySelector(`.view-root[data-item-id="${id}"] [data-testid="editor-state"]`)?.textContent === '已保存', T)) && fs.readFileSync(TXT, 'utf8').endsWith('- 新的待办'));
await pt.locator('[data-testid="editor-preview-toggle"] input').uncheck();

// ---- GBK 只读
await win.evaluate(([r]) => window.__kb.openByPath(r, '笔记/gbk编码.txt', 'tab'), [root.id]);
await win.waitForSelector('[data-testid="text-editor"] [data-testid="reader-text"]:visible');
const G = await win.evaluate(() => window.__dock.activePanel.id);
await panel(win, G).locator('[data-testid="mode-edit"]').click();
const gro = await panel(win, G).locator('[data-testid="editor-text"]').evaluate((t) => t.readOnly);
const genc = await panel(win, G).locator('[data-testid="editor-encoding"]').textContent();
const gstatus = await win.locator('[data-testid="status-encoding"]').textContent().catch(() => '');
check('GBK 编码文件：显示正确、可编辑；工具栏与状态栏显示编码 GBK/GB18030', !gro && /GBK\/GB18030/.test(genc) && /GBK\/GB18030/.test(gstatus ?? '') && (await panel(win, G).locator('[data-testid="editor-text"]').inputValue()).includes('GBK 编码的文本文件'), `${genc} | ${gstatus}`);
await typeAtEnd(win, panel(win, G).locator('[data-testid="editor-text"]'), '\n追加：中文与符号①');
await panel(win, G).locator('[data-testid="editor-text"]').press('Control+s');
await until(win, (id) => document.querySelector(`.view-root[data-item-id="${id}"] [data-testid="editor-state"]`)?.textContent === '已保存', G);
const gbk1 = fs.readFileSync(GBK);
const asGbk = new TextDecoder('gbk').decode(gbk1);
let utf8Valid = true;
try { new TextDecoder('utf-8', { fatal: true }).decode(gbk1); } catch { utf8Valid = false; }
await win.screenshot({ path: path.join(VERIFY, 'edit-gbk-encoding.png') });
check('GBK 文件保存后仍是 GBK 编码（原内容字节不变，追加的文字按 GBK 写入，不是 UTF-8）', gbk1.subarray(0, gbk0.length).equals(gbk0) && asGbk.includes('追加：中文与符号①') && !utf8Valid, `${gbk0.length}→${gbk1.length}`);
await panel(win, G).locator('[data-testid="editor-undo-save"]').click();
check('GBK 文件“撤销上次保存”后字节与原文件一致', await until(win, () => true, null).then(async () => { for (let i = 0; i < 30 && Buffer.compare(fs.readFileSync(GBK), gbk0) !== 0; i++) await new Promise((r) => setTimeout(r, 100)); return Buffer.compare(fs.readFileSync(GBK), gbk0) === 0; }));

// ---- 未保存的修改：关闭面板后再打开恢复草稿
await win.evaluate((id) => window.__dock.getPanel(id)?.api.setActive(), T);
await pt.locator('[data-testid="editor-text"]').waitFor();
await typeAtEnd(win, pt.locator('[data-testid="editor-text"]'), '\n- 还没保存的草稿');
await win.waitForTimeout(800);
await win.evaluate((id) => window.__dock.getPanel(id)?.api.close(), T);
await win.evaluate(([r]) => window.__kb.openByPath(r, '笔记/待办.txt', 'right'), [root.id]);
const T2 = await win.evaluate(() => window.__dock.activePanel.id);
await panel(win, T2).locator('[data-testid="mode-edit"]').click();
const restored = await until(win, (id) => !!document.querySelector(`.view-root[data-item-id="${id}"] [data-testid="editor-draft-restored"]`) && document.querySelector(`.view-root[data-item-id="${id}"] [data-testid="editor-text"]`)?.value.includes('还没保存的草稿'), T2);
check('关闭有未保存修改的面板后再打开：恢复草稿并提示；磁盘文件未被写入', restored && !fs.readFileSync(TXT, 'utf8').includes('还没保存的草稿'));
await win.screenshot({ path: path.join(VERIFY, 'edit-markdown-split.png') });

// ---- 重启：视图模式保持（Markdown 分栏）
await win.evaluate(() => window.__kb.flush());
await app.close();
({ app, win } = await launch());
await win.waitForFunction((id) => !!document.querySelector(`.view-root[data-item-id="${id}"]`) || window.__dock.getPanel(id), A, { timeout: 10000 });
await win.evaluate((id) => window.__dock.getPanel(id)?.api.setActive(), A);
const modeAfter = await until(win, (id) => document.querySelector(`.view-root[data-item-id="${id}"] [data-testid="md-editor"]`)?.dataset.mode === 'split', A, 10000);
check('重启后 Markdown 面板的视图模式（分栏）保持（存于面板状态，不改布局格式）', modeAfter);
await app.close();

fs.writeFileSync(path.join(VERIFY, 'e2e-edit.json'), JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
