// 端到端（第 9 轮接线）：外部程序项目（R1/R2/R3）——以 SDK 模板 templates/app-adapter（Notepad++）为例。
//   Linux 上没有 Notepad++：用 KB_E2E_APP_HARNESS=1 的“模拟外部程序”（src/main/adapters/appHarness.ts）替换
//   找 exe / 签名校验 / spawn / 路径形式 / 超限确认 五个平台依赖；授权、应用档案、参数模板、启动前备份、
//   退出后记入操作记录、统一撤销、超限默认不启动、重启不自动启动都走真实代码。
//   ⚠ 没有在 Windows 上实测：真实 Notepad++ 的签名、启动、原生确认框、窗口跟踪（R8）都不在本测试范围。
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SDK = process.env.KB_ADAPTER_SDK_DIR || path.resolve(ROOT, '../kb-adapter-sdk');
const TMP = path.join(ROOT, 'e2e/.tmp');
const VERIFY = path.join(ROOT, 'verify');
const USERDATA = path.join(TMP, 'userdata-apps');
const RA = path.join(TMP, 'apps 资料');
const PLUG = path.join(TMP, 'plugins-apps');
for (const d of [USERDATA, RA, PLUG]) fs.rmSync(d, { recursive: true, force: true });
fs.mkdirSync(VERIFY, { recursive: true });
const put = (p, c) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, c));
const NOTE0 = '外部程序编辑示例\n第二行\n';
put(path.join(RA, '笔记.txt'), NOTE0);
put(path.join(RA, '旁边.txt'), '不应被备份\n');
// 超过备份上限（64 MB）的文件
const BIG = path.join(RA, '大日志.log');
{
  const fd = fs.openSync(BIG, 'w');
  const chunk = Buffer.alloc(1024 * 1024, 0x61);
  for (let i = 0; i < 65; i++) fs.writeSync(fd, chunk);
  fs.closeSync(fd);
}
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const BIG_SHA = sha(BIG);

const PID = 'example.notepadpp';
const AID = 'example.notepadpp.app';
const PLUGIN_DIR = path.join(PLUG, 'notepadpp');
execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-adapter-plugin.mjs'), path.join(SDK, 'templates/app-adapter'), '--out', PLUGIN_DIR], { stdio: 'inherit' });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? '  — ' + detail : ''}`);
}
const consoleErrors = [];
async function launch() {
  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'], cwd: ROOT, env: { ...process.env, KB_USER_DATA: USERDATA, KB_E2E_APP_HARNESS: '1' } });
  const win = await app.firstWindow();
  win.on('console', (m) => {
    if (m.type() === 'error' && !/403|ERR_|Content Security Policy|Refused to/.test(m.text())) consoleErrors.push(m.text());
  });
  await win.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800));
  await win.waitForFunction(() => window.__layoutRestored === true, null, { timeout: 20000 });
  await win.waitForTimeout(500);
  return { app, win };
}
const stubOpen = (app, p) =>
  app.evaluate(({ dialog }, x) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [x] });
  }, p);
const harness = (app) => app.evaluate(() => {
  const h = globalThis.__kbAppHarness;
  return h ? { launches: h.launches, confirmPrompts: h.confirmPrompts, confirmAnswer: h.confirmAnswer } : null;
});
const realPath = (app, w) => app.evaluate((_e, x) => globalThis.__kbAppHarness.realPath(x), w);
const exitPid = (app, pid) => app.evaluate((_e, p) => globalThis.__kbAppHarness.exit(p, 0), pid);
const setConfirm = (app, v) => app.evaluate((_e, x) => void (globalThis.__kbAppHarness.confirmAnswer = x), v);
async function openManager(win, focus) {
  await win.evaluate((f) => window.__kb.openPluginManager(f), focus);
  await win.waitForSelector('[data-testid="plugin-manager"]');
  await win.waitForTimeout(200);
}
async function closeManager(win) {
  await win.click('[data-testid="pm-close"]');
  await win.waitForSelector('[data-testid="plugin-manager"]', { state: 'detached' });
}
const view = (itemId) => `.view-root[data-item-id="${itemId}"] [data-testid="sandbox-view"][data-adapter-id="${AID}"]`;
const viewText = (win, itemId) => win.evaluate((s) => document.querySelector(s)?.innerText ?? '', view(itemId));
const waitText = async (win, itemId, re, timeout = 15000) => {
  try {
    await win.waitForFunction(([s, src]) => new RegExp(src).test(document.querySelector(s)?.innerText ?? ''), [view(itemId), re.source], { timeout });
    return true;
  } catch {
    console.log('当前面板文本：', JSON.stringify(await viewText(win, itemId)));
    return false;
  }
};
const backupRecords = () => {
  const dirs = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'record.json' && /app-backups/.test(p)) dirs.push(JSON.parse(fs.readFileSync(p, 'utf8')));
    }
  };
  walk(USERDATA);
  return dirs.sort((a, b) => a.at - b.at);
};
async function newItem(win, rid, label) {
  const before = await win.evaluate(() => Object.keys(window.__kb.items()));
  await win.evaluate(([a, r]) => void window.__kb.newAppItem(a, r), [AID, rid]);
  await win.waitForSelector('[data-testid="app-profile-dialog"]', { timeout: 10000 });
  await win.fill('[data-testid="app-profile-label"]', label);
  return before;
}
async function createdItemId(win, before) {
  await win.waitForFunction((b) => Object.values(window.__kb.items()).some((i) => i.sourceKind === 'app' && !b.includes(i.itemId)), before, { timeout: 10000 });
  return win.evaluate((b) => Object.values(window.__kb.items()).find((i) => i.sourceKind === 'app' && !b.includes(i.itemId)).itemId, before);
}

// ============================================================ 准备：登记根、开发者模式安装模板插件
let { app, win } = await launch();
check('测试构建启用了模拟外部程序（KB_E2E_APP_HARNESS=1，仅未打包时生效）', !!(await harness(app)));
await stubOpen(app, RA);
await win.click('[data-testid="pick-folder"]');
await win.waitForFunction(() => document.querySelectorAll('[data-testid="root-row"]').length === 1);
const ra = await win.evaluate(async () => (await window.kb.listRoots())[0].id);
await win.waitForFunction(async (r) => (await window.kb.listDir(r, '')).length >= 3, ra, { timeout: 15000 });
const entries = await win.evaluate((r) => window.kb.listDir(r, ''), ra);
const ridOf = (n) => (entries.find((e) => e.name === n) ?? {}).resourceId;
const noteRid = ridOf('笔记.txt');
const bigRid = ridOf('大日志.log');
await openManager(win);
await win.check('[data-testid="dev-mode-toggle"]');
await win.waitForFunction(() => !document.querySelector('[data-testid="dev-install"]').disabled);
await stubOpen(app, PLUGIN_DIR);
await win.click('[data-testid="dev-install"]');
await win.waitForSelector(`[data-testid="pm-plugin-${PID}"]`, { timeout: 10000 });
const pmText = await win.innerText(`[data-testid="pm-plugin-${PID}"]`);
check('插件管理里 Notepad++ 条目可用：显示方式“外部窗口启动”，不再是“尚未开放”', /外部窗口启动/.test(pmText) && !/尚未开放/.test(pmText) && (await win.evaluate((id) => document.querySelector(`[data-testid="pm-plugin-${id}"]`)?.dataset.status, PID)) !== 'disabled', pmText.replace(/\s+/g, ' ').slice(0, 160));
await closeManager(win);

// ============================================================ 新建项目：应用档案 → 授权
let before = await newItem(win, noteRid, 'Notepad++ · 笔记');
const dlgText = await win.innerText('[data-testid="app-profile-dialog"]');
check('新建外部程序项目：应用档案对话框只让选声明过的参数模板与文件槽位', /打开文件/.test(dlgText) && (await win.locator('[data-testid="app-profile-slot-file"]').count()) === 1, dlgText.replace(/\s+/g, ' ').slice(0, 160));
await win.screenshot({ path: path.join(VERIFY, 'apps-profile-dialog.png') });
await win.click('[data-testid="app-profile-create"]');
const A = await createdItemId(win, before);
await win.waitForSelector('[data-testid="perm-dialog"]', { timeout: 10000 });
const permText = await win.innerText('[data-testid="perm-dialog"]');
check('首次打开：授权框说明启动 Notepad++、外部窗口启动与可恢复范围', /Notepad\+\+/.test(permText) && /外部窗口启动/.test(permText), permText.replace(/\s+/g, ' ').slice(0, 200));
await win.waitForTimeout(400);
await win.screenshot({ path: path.join(VERIFY, 'apps-permission.png') });
// 产品决定 7：授权框完整显示可恢复说明的全部条目；内容太长时对话框可以滚动
const scopeLis = await win.$$eval('[data-testid="perm-dialog"] [data-testid="perm-scope"] li', (els) => els.map((e) => e.textContent ?? ''));
const recLis = scopeLis.filter((l) => l.startsWith('可恢复：'));
const notRec = scopeLis.find((l) => l.startsWith('不可恢复：')) ?? '';
check('授权框列出可恢复说明的全部条目（3 条：记入操作记录可撤销、备份上限、保留 14 天）和全部不可恢复条目', recLis.length === 3 && recLis.some((l) => /记入操作记录，可撤销回启动前的内容/.test(l)) && recLis.some((l) => /不备份也启动/.test(l)) && recLis.some((l) => /保留 14 天/.test(l) && /备份已过期，无法撤销/.test(l)) && /注册表/.test(notRec) && /超过 14 天的外部改动/.test(notRec), JSON.stringify(recLis).slice(0, 200));
const origSize = await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.isVisible()) ?? BrowserWindow.getAllWindows()[0];
  const s = w.getSize();
  w.setSize(1000, 560);
  return s;
});
await win.waitForTimeout(600);
const scroll = await win.evaluate(() => {
  const dlg = document.querySelector('[data-testid="perm-dialog"]');
  const body = dlg?.querySelector('.kb-perm-body');
  const allow = dlg?.querySelector('[data-testid="perm-allow"]')?.getBoundingClientRect();
  if (!dlg || !body || !allow) return null;
  const r = { overflowY: getComputedStyle(body).overflowY, scrollable: body.scrollHeight > body.clientHeight + 4, dialogBottom: Math.round(dlg.getBoundingClientRect().bottom), allowBottom: Math.round(allow.bottom), vh: innerHeight };
  body.scrollTop = body.scrollHeight;
  return r;
});
check('窗口较矮时：授权框高度不超出窗口，正文可以滚动，“允许/拒绝”按钮始终可见', !!scroll && scroll.overflowY === 'auto' && scroll.scrollable && scroll.dialogBottom <= scroll.vh && scroll.allowBottom <= scroll.vh, JSON.stringify(scroll));
await win.waitForTimeout(300);
await win.screenshot({ path: path.join(VERIFY, 'apps-permission-scroll.png') });
await app.evaluate(({ BrowserWindow }, s) => {
  const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.isVisible()) ?? BrowserWindow.getAllWindows()[0];
  w.setSize(s[0], s[1]);
}, origSize);
await win.waitForTimeout(400);
await win.click('[data-testid="perm-allow"]');
await win.waitForSelector('[data-testid="perm-dialog"]', { state: 'detached' });
check('面板如实标注“外部窗口启动”，未自动启动程序', (await waitText(win, A, /外部窗口启动/)) && /未启动/.test(await viewText(win, A)) && (await harness(app)).launches.length === 0);

// ============================================================ 启动：参数来自模板，只备份目标文件
await win.click(`${view(A)} [data-testid="ui-button"][data-action="launch"]`);
await win.waitForFunction(async () => true);
let h = await harness(app);
for (let i = 0; i < 50 && h.launches.length === 0; i++) (await win.waitForTimeout(100), (h = await harness(app)));
const L1 = h.launches[0];
const argFile = L1?.argv[L1.argv.length - 1];
check('点“启动”：经主进程按模板启动 notepad++.exe -multiInst -nosession <文件>', !!L1 && /Notepad\+\+\\notepad\+\+\.exe$/.test(L1.exe) && JSON.stringify(L1.argv.slice(0, 2)) === '["-multiInst","-nosession"]' && L1.argv.length === 3 && (await realPath(app, argFile)) === path.join(RA, '笔记.txt'), JSON.stringify(L1 ?? null));
await waitText(win, A, /启动前已备份 1 个文件/);
const recs1 = backupRecords();
check('启动前只备份目标文件（不复制整个文件夹）', recs1.length === 1 && recs1[0].files.length === 1 && recs1[0].files[0].relPath === '笔记.txt' && !recs1[0].targetUnprotected, JSON.stringify(recs1.map((r) => r.files.map((f) => f.relPath))));
check('面板显示备份摘要：记入操作记录、可撤销', /记入操作记录，可撤销/.test(await viewText(win, A)));
await win.screenshot({ path: path.join(VERIFY, 'apps-running.png') });

// ============================================================ 外部修改 → 退出 → 记入操作记录 → 统一撤销
fs.writeFileSync(path.join(RA, '笔记.txt'), '被外部程序改过的内容\n');
await exitPid(app, L1.pid);
const bannerOk = await win.waitForSelector(`.view-root[data-item-id="${A}"] [data-testid="app-changes-banner"]`, { timeout: 15000 }).then(() => true, () => false);
const bannerText = bannerOk ? await win.innerText(`.view-root[data-item-id="${A}"] [data-testid="app-changes-banner"]`) : '';
check('程序退出后：被修改的文件记入操作记录，面板提示并提供“撤销外部修改”', bannerOk && /笔记\.txt/.test(bannerText) && /操作记录/.test(bannerText), bannerText.replace(/\s+/g, ' '));
const ops = await win.evaluate(() => window.kb.listOps(20));
const extOp = ops.find((o) => JSON.stringify(o).includes('external-app'));
check('操作记录里有一条外部程序写入（via external-app，带备份哈希）', !!extOp && /笔记\.txt/.test(JSON.stringify(extOp)), JSON.stringify(extOp ?? null).slice(0, 200));
check('面板状态变为“已退出”', await waitText(win, A, /已退出/));
await win.screenshot({ path: path.join(VERIFY, 'apps-changes-banner.png') });
await win.click(`.view-root[data-item-id="${A}"] [data-testid="app-undo-external"]`);
await win.waitForTimeout(300);
if (await win.locator('[data-testid="dialog-ok"]').count()) await win.click('[data-testid="dialog-ok"]');
const restored = await win.waitForFunction(() => true).then(async () => {
  for (let i = 0; i < 50; i++) {
    if (fs.readFileSync(path.join(RA, '笔记.txt'), 'utf8') === NOTE0) return true;
    await win.waitForTimeout(100);
  }
  return false;
});
check('“撤销外部修改”：文件恢复为启动前内容（字节一致），提示条消失', restored && (await win.locator(`.view-root[data-item-id="${A}"] [data-testid="app-changes-banner"]`).count()) === 0);
const ops2 = await win.evaluate(() => window.kb.listOps(20));
check('撤销也记入操作记录（undo）', ops2.some((o) => o.kind === 'undo' || o.op === 'undo' || JSON.stringify(o).includes('"undo"')), JSON.stringify(ops2[0] ?? null).slice(0, 160));
check('旁边的文件没有被备份或改动', fs.readFileSync(path.join(RA, '旁边.txt'), 'utf8') === '不应被备份\n');

// ============================================================ 操作记录：外部改动的备份保留 14 天，过期后不能撤销
await win.click(`${view(A)} [data-testid="ui-button"][data-action="launch"]`);
for (let i = 0; i < 50 && (await harness(app)).launches.length < 2; i++) await win.waitForTimeout(100);
const L2 = (await harness(app)).launches[1];
await waitText(win, A, /运行中|正在启动/);
fs.writeFileSync(path.join(RA, '笔记.txt'), '第二次外部修改\n');
await exitPid(app, L2.pid);
await win.waitForSelector(`.view-root[data-item-id="${A}"] [data-testid="app-changes-banner"]`, { timeout: 15000 });
await win.evaluate(() => window.__kb.openOpLog());
await win.waitForSelector('[data-testid="oplog-row"]');
const extRowSel = '[data-testid="oplog-row"][data-via="external-app"]';
const firstExt = async () => win.evaluate((s) => { const r = document.querySelector(s); return r ? { state: r.dataset.undoState, text: r.innerText, disabled: r.querySelector('[data-testid="oplog-undo"]')?.disabled ?? null } : null; }, extRowSel);
const before14 = await firstExt();
check('操作记录（视图 → 操作记录…）列出外部程序修改，来源写明程序，撤销可用', before14?.state === 'available' && /外部程序修改（Notepad\+\+）/.test(before14.text) && before14.disabled === false, JSON.stringify(before14));
await win.waitForTimeout(400);
await win.screenshot({ path: path.join(VERIFY, 'oplog-external-available.png') });
const purged = await app.evaluate(() => globalThis.__kbAppHarness.expireAfterDays(15));
await win.click('[data-testid="oplog-close"]');
await win.evaluate(() => window.__kb.openOpLog());
await win.waitForFunction((s) => document.querySelector(s)?.dataset.undoState === 'expired', extRowSel, { timeout: 5000 }).catch(() => {});
const after14 = await firstExt();
check('14 天后：备份自动清理，这条显示「备份已过期，无法撤销」，撤销按钮变灰', after14?.state === 'expired' && /备份已过期，无法撤销/.test(after14.text) && after14.disabled === true && purged.blobsRemoved >= 1, JSON.stringify({ after14, purged }));
await win.waitForTimeout(400);
await win.screenshot({ path: path.join(VERIFY, 'oplog-external-expired.png') });
await win.click('[data-testid="oplog-close"]');
await win.click(`.view-root[data-item-id="${A}"] [data-testid="app-undo-external"]`);
await win.waitForTimeout(400);
check('面板上的“撤销外部修改”同样拒绝（如实提示备份已过期），文件不变', fs.readFileSync(path.join(RA, '笔记.txt'), 'utf8') === '第二次外部修改\n' && /备份已过期/.test(await win.innerText(`.view-root[data-item-id="${A}"]`)));
fs.writeFileSync(path.join(RA, '笔记.txt'), NOTE0);

// ============================================================ 超过备份上限：默认不启动
before = await newItem(win, bigRid, 'Notepad++ · 大日志');
await win.click('[data-testid="app-profile-create"]');
const B = await createdItemId(win, before);
await waitText(win, B, /未启动/);
const n0 = (await harness(app)).launches.length;
await win.click(`${view(B)} [data-testid="ui-button"][data-action="launch"]`);
await waitText(win, B, /超过备份上限/);
h = await harness(app);
check('文件超过备份上限：弹确认框（默认“不启动”），未确认时不启动', h.confirmPrompts.length === 1 && h.launches.length === n0 && /超过备份上限/.test(await viewText(win, B)), h.confirmPrompts[0] ?? '');
await win.screenshot({ path: path.join(VERIFY, 'apps-over-limit.png') });
await setConfirm(app, true);
await win.click(`${view(B)} [data-testid="ui-button"][data-action="launch"]`);
for (let i = 0; i < 50 && (await harness(app)).launches.length === n0; i++) await win.waitForTimeout(100);
h = await harness(app);
await waitText(win, B, /本次未备份/);
check('用户选“不备份也启动”后才启动，面板如实显示“本次未备份，外部修改不可恢复”', h.launches.length === n0 + 1 && /不可恢复/.test(await viewText(win, B)));
await exitPid(app, h.launches[h.launches.length - 1].pid);
check('超限文件未被复制进备份区，原文件未变', !backupRecords().some((r) => r.files.some((f) => f.relPath === '大日志.log')) && sha(BIG) === BIG_SHA);
await setConfirm(app, false);

// ============================================================ 工作台关闭期间外部程序仍在运行（产品决定）
const NOTE = path.join(RA, '笔记.txt');
const opsCount = () => win.evaluate(async () => (await window.kb.listOps(1000)).length);
const nL = (await harness(app)).launches.length;
await win.click(`${view(A)} [data-testid="ui-button"][data-action="launch"]`);
for (let i = 0; i < 50 && (await harness(app)).launches.length === nL; i++) await win.waitForTimeout(100);
const L3 = (await harness(app)).launches[nL];
await waitText(win, A, /运行中|正在启动/);
const ops0 = await opsCount();
fs.writeFileSync(NOTE, 'v1 运行中改的\n');
await win.waitForTimeout(1500);
check('工作台运行中、程序还没退出：改动不提前记入操作记录', (await opsCount()) === ops0, `${ops0} 条`);
// 关闭工作台时程序仍在运行（模拟：把 pid 记进 aliveFile），关闭期间再改一次
fs.writeFileSync(path.join(USERDATA, 'e2e-harness-alive.json'), JSON.stringify([L3.pid]));
await win.evaluate(() => window.__kb.flush());
await app.close();
fs.writeFileSync(NOTE, 'v2 关闭期间改的\n');
({ app, win } = await launch());
await waitText(win, A, /外部窗口启动/, 20000);
const crSel = `.view-root[data-item-id="${A}"] [data-testid="app-changes-banner"][data-after-restart="true"]`;
const crOk = await win.waitForSelector(crSel, { timeout: 20000 }).then(() => true, () => false);
const crText = crOk ? await win.innerText(crSel) : '';
const opsAfterStart = await win.evaluate(async () => (await window.kb.listOps(1000)).filter((o) => o.detail.via === 'external-app'));
const closureOp = opsAfterStart.find((o) => o.detail.afterRestart && o.detail.label);
check('下次启动：对比未结束会话的目标文件哈希，补记进操作记录并标注「工作台关闭期间的外部修改」', crOk && /工作台关闭期间的外部修改/.test(crText) && closureOp?.detail.label === '工作台关闭期间的外部修改', crText.replace(/\s+/g, ' '));
await win.waitForTimeout(400);
await win.screenshot({ path: path.join(VERIFY, 'apps-closed-period-banner.png') });
await win.evaluate(() => window.__kb.openOpLog());
await win.waitForSelector('[data-testid="oplog-row"]');
const srcText = await win.evaluate((id) => document.querySelector(`[data-testid="oplog-row"][data-op-id="${id}"] [data-testid="oplog-source"]`)?.textContent ?? '', closureOp?.id);
check('操作记录里这条的来源写为“工作台关闭期间的外部修改（Notepad++）”', /工作台关闭期间的外部修改（Notepad\+\+）/.test(srcText), srcText);
await win.waitForTimeout(400);
await win.screenshot({ path: path.join(VERIFY, 'oplog-closed-period.png') });
await win.click('[data-testid="oplog-close"]');
// 程序仍在运行：重启后的修改要等它退出才记
const ops1 = await opsCount();
fs.writeFileSync(NOTE, 'v3 重启后运行中改的\n');
await win.waitForTimeout(4000);
check('重启后程序仍在运行：之后的修改不提前记（等程序退出）', (await opsCount()) === ops1);
check('模拟程序退出', await app.evaluate((_e, p) => globalThis.__kbAppHarness.exit(p), L3.pid));
let exitRecorded = false;
for (let i = 0; i < 50 && !exitRecorded; i++) {
  exitRecorded = (await opsCount()) > ops1;
  if (!exitRecorded) await win.waitForTimeout(300);
}
const exitOp = (await win.evaluate(() => window.kb.listOps(5)))[0];
check('程序退出后：只记重启基准之后的修改（v2→v3），不标注关闭期间', exitRecorded && exitOp.op === 'write' && exitOp.detail.via === 'external-app' && !exitOp.detail.afterRestart && exitOp.detail.beforeHash === closureOp?.detail.afterHash, JSON.stringify({ exitOp, closure: closureOp }).slice(0, 900));
const u1 = await win.evaluate((id) => window.kb.opUndo(id), exitOp.id);
const v2Back = fs.readFileSync(NOTE, 'utf8') === 'v2 关闭期间改的\n';
const u2 = await win.evaluate((id) => window.kb.opUndo(id), closureOp?.id);
check('两条可以逐条撤销：先回到 v2，再回到启动前的内容', u1.status === 'undone' && v2Back && u2.status === 'undone' && fs.readFileSync(NOTE, 'utf8') === NOTE0, `${u1.status}/${u2.status}`);

// ============================================================ 重启：不自动启动；停用后占位文案
await win.evaluate(() => window.__kb.flush());
await app.close();
({ app, win } = await launch());
await waitText(win, A, /外部窗口启动/, 20000);
await win.waitForTimeout(800);
check('重启恢复工作区：外部程序项目保留，不自动启动程序', (await harness(app)).launches.length === 0 && /未启动|已退出/.test(await viewText(win, A)));
await openManager(win, PID);
await win.click(`[data-testid="pm-toggle-${PID}"]`);
await win.waitForFunction((id) => document.querySelector(`[data-testid="pm-plugin-${id}"]`)?.dataset.status === 'disabled', PID);
await closeManager(win);
await win.waitForSelector(`[data-testid="placeholder"][data-adapter-id="${AID}"]`, { timeout: 10000 });
const ph = await win.innerText(`[data-testid="placeholder"][data-adapter-id="${AID}"] [data-testid="placeholder-display-mode"]`).catch(() => '');
check('R3：占位页如实写显示方式（外部窗口启动：程序在自己的窗口中运行）', /外部窗口启动/.test(ph) && !/外部程序（/.test(ph), ph.replace(/\s+/g, ' '));
await win.screenshot({ path: path.join(VERIFY, 'apps-placeholder.png') });
check('全程渲染进程无未处理错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
await app.close();

fs.writeFileSync(path.join(VERIFY, 'e2e-apps.json'), JSON.stringify({ when: new Date().toISOString(), note: '模拟外部程序（未在 Windows 上实测）', results }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\nE2E（外部程序项目）: ${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
