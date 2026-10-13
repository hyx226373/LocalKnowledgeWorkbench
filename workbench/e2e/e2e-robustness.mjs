// 端到端：第三方插件健壮性（T13 剩余）。在真实应用中：
//   看门狗：死循环插件（点击后 / 打开时）在几秒内被发现并终止其进程，面板变为 adapter-error 占位；
//           期间主窗口与其他面板（Markdown、另一个插件）保持响应（测主线程最大停顿与切换标签耗时）
//   消息洪泛 → 终止；open() 异步挂起 → 生命周期超时；重试后恢复（新进程）
//   审计记录：拒绝（恶意插件）、批量计划提交/拒绝、看门狗、超时，在插件管理中可见
//   性能：打开 5 个第三方插件面板的耗时与内存；300 页 PDF 滚动帧率（有/无 5 个插件面板）
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SDK = process.env.KB_ADAPTER_SDK_DIR || path.resolve(ROOT, '../kb-adapter-sdk');
const VERIFY = path.join(ROOT, 'verify');
const TMP = path.join(ROOT, 'e2e/.tmp');
const USERDATA = path.join(TMP, 'userdata-robust');
const RA = path.join(TMP, 'robust 资料A');
const RB = path.join(TMP, 'robust 资料B');
const PLUG = path.join(TMP, 'plugins-robust');
for (const d of [USERDATA, RA, RB, PLUG]) fs.rmSync(d, { recursive: true, force: true });
const put = (p, c) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, c));
put(path.join(RA, 'loop/spin.loop'), 'busy-action');
put(path.join(RA, 'loop/open.loop'), 'busy-open');
put(path.join(RA, 'loop/hang.loop'), 'hang-open');
put(path.join(RA, 'loop/flood.loop'), 'flood');
put(path.join(RA, '说明.md'), '# 说明\n\n' + Array.from({ length: 80 }, (_, i) => `第 ${i + 1} 段：其他面板在插件卡死时应保持响应。`).join('\n\n'));
put(path.join(RA, 'n/todo.note'), '- 第一行');
for (let i = 1; i <= 5; i++) put(path.join(RA, `json/data${i}.json`), JSON.stringify({ id: i, name: `数据 ${i}`, items: Array.from({ length: 50 }, (_, k) => ({ k, v: `值 ${k}`, tags: ['a', 'b'] })) }, null, 2));
put(path.join(RB, 'secret.json'), '{"secret":"SECRET-ROOT-B"}');
put(path.join(RA, 'big.pdf'), makePdf(300));
fs.mkdirSync(VERIFY, { recursive: true });
const build = (src, name) => {
  const out = path.join(PLUG, name);
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-adapter-plugin.mjs'), src, '--out', out], { stdio: 'inherit' });
  return out;
};
const P_JSON = build(path.join(SDK, 'templates/file-adapter'), 'json-viewer');
const P_LOOP = build(path.join(ROOT, 'e2e/fixtures/plugins/loop'), 'loop');
const P_EVIL = build(path.join(ROOT, 'e2e/fixtures/plugins/evil'), 'evil');
const P_NOTES = build(path.join(ROOT, 'e2e/fixtures/plugins/notes'), 'notes');
const JA = 'example.json-viewer.reader';
const LA = 'test.loop.reader';

/** 最小 PDF：n 页，每页一行文字（Helvetica） */
function makePdf(n) {
  const objs = [];
  const add = (s) => (objs.push(s), objs.length);
  const catalog = add('');
  const pages = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];
  for (let i = 1; i <= n; i++) {
    const text = `BT /F1 28 Tf 72 700 Td (Page ${i} of ${n}) Tj ET BT /F1 12 Tf 72 660 Td (Lorem ipsum dolor sit amet, page ${i}.) Tj ET`;
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
  return out;
}

const results = [];
const metrics = {};
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? '  — ' + detail : ''}`);
}
const consoleErrors = [];
async function launch() {
  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'], cwd: ROOT, env: { ...process.env, KB_USER_DATA: USERDATA } });
  const win = await app.firstWindow();
  for (const st of [app.process().stdout, app.process().stderr]) st.on('data', (d) => String(d).split('\n').filter((l) => /\[watchdog\]|渲染进程退出/.test(l)).forEach((l) => console.log('   ' + l.trim())));
  win.on('crash', () => console.log('   !! 主窗口页面崩溃'));
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
async function addRoot(app, win, dir) {
  const n = await win.locator('[data-testid="root-row"]').count();
  await stubOpen(app, dir);
  await win.click('[data-testid="pick-folder"]');
  await win.waitForFunction((k) => document.querySelectorAll('[data-testid="root-row"]').length === k + 1, n);
  return win.evaluate(async (p) => (await window.kb.listRoots()).find((r) => r.path === p).id, dir);
}
const openP = (win, rootId, rel, mode) => win.evaluate(([r, p, m]) => window.__kb.openByPath(r, p, m), [rootId, rel, mode]);
const itemsOf = (win, adapterId) => win.evaluate((a) => Object.values(window.__kb.items()).filter((i) => i.adapterId === a), adapterId);
async function openManager(win, focus) {
  await win.evaluate((f) => window.__kb.openPluginManager(f), focus);
  await win.waitForSelector('[data-testid="plugin-manager"]');
  await win.waitForTimeout(200);
}
async function closeManager(win) {
  await win.click('[data-testid="pm-close"]');
  await win.waitForSelector('[data-testid="plugin-manager"]', { state: 'detached' });
}
async function installDev(app, win, dir, id) {
  await openManager(win);
  await stubOpen(app, dir);
  await win.click('[data-testid="dev-install"]');
  await win.waitForSelector(`[data-testid="pm-plugin-${id}"]`);
  await closeManager(win);
}
async function allowOnce(win) {
  await win.waitForSelector('[data-testid="perm-dialog"]', { timeout: 10000 });
  await win.click('[data-testid="perm-allow"]');
  await win.waitForSelector('[data-testid="perm-dialog"]', { state: 'detached' });
}
const closeItems = (win, adapterId) =>
  win.evaluate((a) => {
    for (const it of Object.values(window.__kb.items())) if (it.adapterId === a) window.__dock.getPanel(it.itemId)?.api.close();
  }, adapterId);
async function waitIndexed(win, rootId, rel) {
  for (let i = 0; i < 60; i++) {
    const ok = await win.evaluate(async ([r, p]) => {
      const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
      return (await window.kb.listDir(r, dir)).some((x) => x.relPath === p);
    }, [rootId, rel]);
    if (ok) return true;
    await win.waitForTimeout(250);
  }
  return false;
}
/** 主线程停顿探针：每 50 ms 一次，记录最大额外延迟 */
const lagStart = (win) =>
  win.evaluate(() => {
    clearInterval(window.__lagIv);
    const lag = (window.__lag = { max: 0, n: 0, frameMax: 0, frames: 0, gen: (window.__lag?.gen ?? 0) + 1 });
    let last = performance.now();
    window.__lagIv = setInterval(() => {
      const n = performance.now();
      lag.max = Math.max(lag.max, n - last - 50);
      lag.n++;
      last = n;
    }, 50);
    // 渲染帧间隔（主窗口是否还在出帧）
    let lf = performance.now();
    const raf = (t) => {
      if (window.__lag !== lag) return;
      lag.frameMax = Math.max(lag.frameMax, t - lf);
      lag.frames++;
      lf = t;
      requestAnimationFrame(raf);
    };
    requestAnimationFrame(raf);
  });
const lagRead = (win) => win.evaluate(() => ({ maxMs: Math.round(window.__lag.max), samples: window.__lag.n, maxFrameGapMs: Math.round(window.__lag.frameMax), frames: window.__lag.frames }));
const procs = (win) => win.evaluate(() => window.kb.pluginProcesses());
const appPids = (app) => app.evaluate(({ app }) => app.getAppMetrics().map((m) => m.pid));
const appMem = (app) => app.evaluate(({ app }) => app.getAppMetrics().reduce((n, m) => n + m.memory.workingSetSize, 0));
const lastKill = (win) => win.evaluate(() => window.__kb.watchdogStats().kills.at(-1));

// ============================================================ 启动
const { app, win } = await launch();
const ra = await addRoot(app, win, RA);
const rb = await addRoot(app, win, RB);
await openManager(win);
await win.check('[data-testid="dev-mode-toggle"]');
await win.waitForFunction(() => !document.querySelector('[data-testid="dev-install"]').disabled);
await closeManager(win);
await installDev(app, win, P_LOOP, 'test.loop');
await installDev(app, win, P_JSON, 'example.json-viewer');
for (const f of ['loop/spin.loop', 'json/data5.json', 'big.pdf', '说明.md']) await waitIndexed(win, ra, f);

// 其他面板：Markdown（内置）+ JSON 查看器（另一个第三方插件）
await openP(win, ra, '说明.md', 'tab');
await win.waitForSelector('[data-testid="reader-markdown"] h1');
await openP(win, ra, 'json/data1.json', 'right');
await allowOnce(win);
await win.waitForSelector(`[data-testid="sandbox-view"][data-adapter-id="${JA}"][data-opened="true"]`, { timeout: 20000 });

// ============================================================ 看门狗：点击后死循环
await openP(win, ra, 'loop/spin.loop', 'below');
await allowOnce(win);
await win.waitForSelector(`[data-testid="sandbox-view"][data-adapter-id="${LA}"][data-opened="true"]`, { timeout: 20000 });
const before = (await procs(win)).find((p) => p.pluginId === 'test.loop');
const jsonProc = (await procs(win)).find((p) => p.pluginId === 'example.json-viewer');
const mainPid = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.mainFrame.osProcessId);
check('插件 iframe 运行在独立进程中（与主窗口、与其他插件都不同）', before?.isolated && jsonProc?.isolated && !before.pids.includes(mainPid) && !before.pids.some((p) => jsonProc.pids.includes(p)), JSON.stringify({ mainPid, loop: before?.pids, json: jsonProc?.pids }));

await lagStart(win);
const t0 = Date.now();
await win.click(`[data-testid="sandbox-view"][data-adapter-id="${LA}"] [data-testid="ui-button"][data-action="spin"]`);
// 插件卡死期间：切换到 Markdown 标签、滚动它、在另一个插件面板里展开节点
await win.waitForTimeout(800);
const tSwitch = Date.now();
const scrolled = await win.evaluate(() => {
  const el = document.querySelector('[data-testid="reader-markdown"]');
  el.scrollTop = 300;
  return el.scrollTop;
});
const scrollMs = Date.now() - tSwitch;
const tJson = Date.now();
await win.click(`[data-testid="sandbox-view"][data-adapter-id="${JA}"] [role="treeitem"][data-node-id="$.items"] > .kb-ui-tree-row [data-testid="ui-tree-toggle"]`).catch(() => undefined);
await win.waitForFunction((a) => document.querySelector(`[data-testid="sandbox-view"][data-adapter-id="${a}"] [role="treeitem"][data-node-id="$.items"]`)?.getAttribute('aria-expanded') === 'true', JA, { timeout: 5000 }).catch(() => undefined);
const jsonMs = Date.now() - tJson;
const jsonExpanded = await win.evaluate((a) => document.querySelector(`[data-testid="sandbox-view"][data-adapter-id="${a}"] [role="treeitem"][data-node-id="$.items"]`)?.getAttribute('aria-expanded') === 'true', JA);
const ph = await win.waitForSelector(`[data-testid="placeholder"][data-kind="adapter-error"][data-adapter-id="${LA}"]`, { timeout: 15000 }).then(
  () => Date.now() - t0,
  () => null,
);
const lag = await lagRead(win);
const kill = await lastKill(win);
await win.waitForTimeout(1000); // 主进程在 iframe 卸载 250 ms 后终止进程
const pidsAfter = await appPids(app);
metrics.watchdogBusyAction = { detectedAfterClickMs: ph, heartbeatSilenceMs: kill?.detectedMs, mainThreadMaxStallMs: lag.maxMs, lagSamples: lag.samples, mainWindowMaxFrameGapMs: lag.maxFrameGapMs, mainWindowFrames: lag.frames, markdownScrollMs: scrollMs, otherPluginExpandMs: jsonMs, killedPids: before?.pids, pidsStillAlive: before?.pids.filter((p) => pidsAfter.includes(p)) };
check('死循环（点击后）：几秒内被发现，面板变为 adapter-error 占位', ph !== null && ph < 6000 && kill?.kind === 'busy', `${ph} ms（心跳静默 ${kill?.detectedMs} ms）`);
check('插件进程被终止（pid 已不在应用进程列表中）', before && before.pids.every((p) => !pidsAfter.includes(p)), JSON.stringify(before?.pids));
check('卡死期间主窗口保持响应：主线程定时器最大额外延迟 < 200 ms，渲染帧最大间隔 < 250 ms', lag.maxMs < 200 && lag.samples > 40 && lag.maxFrameGapMs < 250, `定时器最大延迟 ${lag.maxMs} ms（${lag.samples} 个 50 ms 采样），帧最大间隔 ${lag.maxFrameGapMs} ms（${lag.frames} 帧）`);
check('卡死期间其他面板可操作：Markdown 可滚动，另一个插件（JSON 查看器）能展开节点', scrolled > 0 && jsonExpanded, `滚动 ${scrollMs} ms，JSON 展开 ${jsonMs} ms`);
const phText = await win.innerText(`[data-testid="placeholder"][data-adapter-id="${LA}"]`);
check('占位说明原因（没有响应、已停止进程）并提供“重试”“从工作区移除”', phText.includes('没有响应') && phText.includes('已停止') && phText.includes('重试') && phText.includes('从工作区移除'), phText.replace(/\s+/g, ' ').slice(0, 160));
check('JSON 查看器（另一个插件）仍在运行', (await win.locator(`[data-testid="sandbox-view"][data-adapter-id="${JA}"][data-opened="true"]`).count()) === 1);
await win.waitForTimeout(450);
await win.screenshot({ path: path.join(VERIFY, 'robust-watchdog-placeholder.png') });

// 重试：改成正常模式后点“重试”→ 新进程，正常打开
put(path.join(RA, 'loop/spin.loop'), 'ok');
await win.click(`[data-testid="placeholder"][data-adapter-id="${LA}"] [data-testid="placeholder-action-retry"]`);
await win.waitForSelector(`[data-testid="sandbox-view"][data-adapter-id="${LA}"][data-opened="true"]`, { timeout: 20000 });
const after = (await procs(win)).find((p) => p.pluginId === 'test.loop');
check('重试后在新进程中正常打开', !!after && !after.pids.some((p) => before.pids.includes(p)) && (await win.innerText(`[data-testid="sandbox-view"][data-adapter-id="${LA}"]`)).includes('模式：ok'), JSON.stringify(after?.pids));
await closeItems(win, LA);

// ============================================================ 打开时死循环
await lagStart(win);
const t1 = Date.now();
await openP(win, ra, 'loop/open.loop', 'below');
const ph2 = await win.waitForSelector(`[data-testid="placeholder"][data-kind="adapter-error"][data-adapter-id="${LA}"]`, { timeout: 20000 }).then(
  () => Date.now() - t1,
  () => null,
);
const lag2 = await lagRead(win);
metrics.watchdogBusyOpen = { detectedAfterOpenMs: ph2, mainThreadMaxStallMs: lag2.maxMs, mainWindowMaxFrameGapMs: lag2.maxFrameGapMs };
check('死循环（打开时）：被发现并显示占位，主线程无明显停顿', ph2 !== null && ph2 < 8000 && lag2.maxMs < 200, `${ph2} ms，最大停顿 ${lag2.maxMs} ms`);
await closeItems(win, LA);

// ============================================================ 消息洪泛
const t2 = Date.now();
await openP(win, ra, 'loop/flood.loop', 'below');
const ph3 = await win.waitForSelector(`[data-testid="placeholder"][data-kind="adapter-error"][data-adapter-id="${LA}"]`, { timeout: 20000 }).then(
  () => Date.now() - t2,
  () => null,
);
const k3 = await lastKill(win);
metrics.watchdogFlood = { detectedAfterOpenMs: ph3, kind: k3?.kind };
check('消息洪泛：被发现并终止', ph3 !== null && k3?.kind === 'flood' && (await win.innerText(`[data-testid="placeholder"][data-adapter-id="${LA}"]`)).includes('条消息'), `${ph3} ms`);
await closeItems(win, LA);

// ============================================================ 异步挂起（open() 永不完成）→ 生命周期超时
const t3 = Date.now();
await openP(win, ra, 'loop/hang.loop', 'below');
const ph4 = await win.waitForSelector(`[data-testid="placeholder"][data-kind="adapter-error"][data-adapter-id="${LA}"]`, { timeout: 25000 }).then(
  () => Date.now() - t3,
  () => null,
);
const t4text = ph4 ? await win.innerText(`[data-testid="placeholder"][data-adapter-id="${LA}"]`) : '';
metrics.lifecycleTimeout = { detectedAfterOpenMs: ph4 };
check('open() 异步挂起：约 10 秒后按超时显示占位（不需要杀进程）', ph4 !== null && ph4 >= 9000 && ph4 < 16000 && t4text.includes('超时'), `${ph4} ms`);
await closeItems(win, LA);

// ============================================================ 审计：恶意插件的拒绝 + 批量计划
await installDev(app, win, P_EVIL, 'test.evil');
const otherRid = await win.evaluate(async (r) => (await window.kb.listDir(r, '')).find((x) => x.relPath === 'secret.json')?.resourceId, rb);
const mdRid = await win.evaluate(async (r) => (await window.kb.listDir(r, '')).find((x) => x.relPath === '说明.md')?.resourceId, ra);
put(path.join(RA, 'probe.evil'), JSON.stringify({ targets: { otherRoot: otherRid, wrongExt: mdRid, otherRootUrl: `kbfile://res/${otherRid}/secret.json` } }));
await waitIndexed(win, ra, 'probe.evil');
await openP(win, ra, 'probe.evil', 'below');
await allowOnce(win);
await win.waitForFunction(() => /RESULT: (ALL BLOCKED|LEAKED)/.test(document.querySelector('[data-testid="sandbox-view"][data-plugin-id="test.evil"]')?.innerText ?? ''), null, { timeout: 30000 });
await closeItems(win, 'test.evil.reader');
await installDev(app, win, P_NOTES, 'test.notes');
await openP(win, ra, 'n/todo.note', 'below');
await allowOnce(win);
const appendBtn = '[data-testid="sandbox-view"][data-plugin-id="test.notes"] [data-testid="ui-button"][data-action="append"]';
await win.waitForSelector(appendBtn);
await win.click(appendBtn);
await allowOnce(win); // fileops.write
await win.waitForSelector('[data-testid="plan-dialog"]');
await win.click('[data-testid="plan-reject"]');
await win.waitForFunction(() => /user-rejected/.test(document.querySelector('[data-testid="sandbox-view"][data-plugin-id="test.notes"]')?.innerText ?? ''));
await win.click(appendBtn);
await win.waitForSelector('[data-testid="plan-dialog"]');
await win.click('[data-testid="plan-approve"]');
await win.waitForFunction(() => /已执行 1 步/.test(document.querySelector('[data-testid="sandbox-view"][data-plugin-id="test.notes"]')?.innerText ?? ''));
await closeItems(win, 'test.notes.reader');

const audit = await win.evaluate(async () => {
  const by = {};
  for (const id of ['test.loop', 'test.evil', 'test.notes']) by[id] = (await window.kb.listPluginAudit(id, 200)).map((e) => ({ kind: e.kind, code: e.code, detail: e.detail, count: e.count }));
  return by;
});
const loopKinds = audit['test.loop'].map((e) => e.kind);
check('审计：看门狗终止与生命周期超时都有记录', loopKinds.filter((k) => k === 'watchdog').length >= 3 && loopKinds.includes('timeout'), JSON.stringify(loopKinds));
const evilDenied = audit['test.evil'].filter((e) => e.kind === 'denied');
check('审计：恶意插件的越界读取被逐条记录（含根名/相对路径，不含绝对路径与内容）', evilDenied.length >= 3 && evilDenied.some((e) => e.detail.includes('robust 资料B/secret.json')) && !JSON.stringify(audit).includes(RB) && !JSON.stringify(audit).includes('SECRET-ROOT-B'), `${evilDenied.length} 条：${evilDenied.slice(0, 2).map((e) => e.detail).join(' | ')}`);
const notesKinds = audit['test.notes'].map((e) => e.kind).reverse();
check('审计：批量计划的提交、拒绝、批准都有记录', ['plan-submitted', 'plan-rejected', 'plan-approved'].every((k) => notesKinds.includes(k)) && notesKinds.indexOf('plan-rejected') < notesKinds.indexOf('plan-approved'), JSON.stringify(notesKinds));

// 插件管理中可见
await openManager(win, 'test.evil');
await win.click('[data-testid="pm-audit-test.evil"] > summary');
await win.waitForSelector('[data-testid="pm-audit-test.evil"] [data-testid="audit-row"][data-kind="denied"]');
await win.click('[data-testid="pm-audit-test.notes"] > summary');
await win.click('[data-testid="pm-audit-test.loop"] > summary');
await win.waitForSelector('[data-testid="pm-audit-test.loop"] [data-testid="audit-row"][data-kind="watchdog"]');
const uiRows = await win.$$eval('[data-testid="audit-row"]', (els) => els.map((e) => e.dataset.kind));
const evilSummary = await win.innerText('[data-testid="pm-audit-test.evil"] > summary');
check('插件管理显示审计记录（拒绝、计划、看门狗），并统计拒绝/异常条数', uiRows.includes('denied') && uiRows.includes('plan-submitted') && uiRows.includes('plan-approved') && uiRows.includes('watchdog') && /拒绝\/异常 \d+ 条/.test(evilSummary), evilSummary);
await win.check('[data-testid="pm-audit-filter-test.notes"]');
const notesFiltered = await win.$$eval('[data-testid="pm-audit-test.notes"] [data-testid="audit-row"]', (els) => els.map((e) => e.dataset.kind));
check('“只看拒绝与异常”过滤掉正常的计划记录', !notesFiltered.includes('plan-approved'), JSON.stringify(notesFiltered));
await win.uncheck('[data-testid="pm-audit-filter-test.notes"]');
await win.evaluate(() => document.querySelector('[data-testid="pm-audit-test.evil"]')?.scrollIntoView({ block: 'start' }));
await win.waitForTimeout(450);
await win.screenshot({ path: path.join(VERIFY, 'robust-audit-log.png') });
await win.evaluate(() => document.querySelector('[data-testid="pm-audit-test.loop"]')?.scrollIntoView({ block: 'start' }));
await win.waitForTimeout(200);
await win.screenshot({ path: path.join(VERIFY, 'robust-audit-log-watchdog.png') });
await closeManager(win);

// ============================================================ 性能（T13 验收 4）
await closeItems(win, JA);
await win.evaluate(() => {
  for (const it of Object.values(window.__kb.items())) window.__dock.getPanel(it.itemId)?.api.close();
});
await win.waitForTimeout(800);
await openP(win, ra, 'big.pdf', 'tab');
await win.waitForSelector('[data-testid="reader-pdf"] .pdf-page[data-rendered="1"]', { timeout: 30000 });
const pdfPages = await win.$$eval('[data-testid="reader-pdf"] .pdf-page', (els) => els.length);
const fps = () =>
  win.evaluate(async () => {
    const el = document.querySelector('[data-testid="reader-pdf"]');
    el.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 500));
    let frames = 0;
    let worst = 0;
    const t0 = performance.now();
    let last = t0;
    await new Promise((res) => {
      const step = (t) => {
        frames++;
        worst = Math.max(worst, t - last);
        last = t;
        el.scrollTop += 40;
        if (t - t0 < 4000) requestAnimationFrame(step);
        else res();
      };
      requestAnimationFrame(step);
    });
    const dt = performance.now() - t0;
    return { fps: +((frames * 1000) / dt).toFixed(1), worstFrameMs: Math.round(worst), scrolledTo: el.scrollTop };
  });
const fps3 = async () => {
  const runs = [await fps(), await fps(), await fps()];
  const sorted = [...runs].sort((a, b) => a.fps - b.fps);
  return { fps: sorted[1].fps, worstFrameMs: sorted[1].worstFrameMs, runs: runs.map((r) => r.fps) };
};
await fps(); // 预热
const base = await fps3();
const memBefore = await appMem(app);
const opens = [];
await lagStart(win);
for (let i = 1; i <= 5; i++) {
  const t = Date.now();
  await openP(win, ra, `json/data${i}.json`, i === 1 ? 'right' : 'below');
  await win.waitForFunction(([a, n]) => document.querySelectorAll(`[data-testid="sandbox-view"][data-adapter-id="${a}"][data-opened="true"]`).length === n, [JA, i], { timeout: 20000 });
  opens.push(Date.now() - t);
}
const openLag = await lagRead(win);
await win.waitForTimeout(1500);
const memAfter = await appMem(app);
const pp = (await procs(win)).find((p) => p.pluginId === 'example.json-viewer');
const withPlugins = await fps3();
metrics.perf = {
  pdfPages,
  openMs: opens,
  openMsMedian: [...opens].sort((a, b) => a - b)[2],
  mainThreadMaxStallDuringOpensMs: openLag.maxMs,
  pluginPanels: pp?.frames,
  pluginProcesses: pp?.pids.length,
  pluginProcessMemMB: pp ? +(pp.workingSetKB / 1024).toFixed(1) : null,
  appMemBeforeMB: +(memBefore / 1024).toFixed(1),
  appMemAfterMB: +(memAfter / 1024).toFixed(1),
  appMemDeltaMB: +((memAfter - memBefore) / 1024).toFixed(1),
  pdfScrollFpsAloneRuns: base.runs,
  pdfScrollFpsWith5PluginsRuns: withPlugins.runs,
  pdfScrollFpsAlone: base.fps,
  pdfScrollFpsWith5Plugins: withPlugins.fps,
  pdfWorstFrameAloneMs: base.worstFrameMs,
  pdfWorstFrameWith5PluginsMs: withPlugins.worstFrameMs,
  fpsDropPct: +(((base.fps - withPlugins.fps) / base.fps) * 100).toFixed(1),
};
console.log('性能：', JSON.stringify(metrics.perf));
check('300 页 PDF 已打开', pdfPages === 300, String(pdfPages));
check('打开 5 个第三方插件面板：每个 < 3 秒', opens.every((t) => t < 3000), opens.join(' / ') + ' ms');
check('5 个插件面板运行时 PDF 滚动帧率下降不超过 20%（各测 3 次取中位数）', metrics.perf.fpsDropPct <= 20, `${base.fps} → ${withPlugins.fps} fps（${metrics.perf.fpsDropPct}%；单次 ${base.runs.join('/')} → ${withPlugins.runs.join('/')}）`);
check('5 个面板同属一个插件 → 共用一个独立进程；内存增量记录在结果中', pp?.frames === 5 && pp.isolated, `进程 ${pp?.pids.length} 个，插件进程 ${metrics.perf.pluginProcessMemMB} MB，应用总内存 +${metrics.perf.appMemDeltaMB} MB`);
await win.screenshot({ path: path.join(VERIFY, 'robust-perf-5-panels.png') });

check('全程渲染进程无未处理错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
await app.close();

fs.writeFileSync(path.join(VERIFY, 'e2e-robustness-result.json'), JSON.stringify({ at: new Date().toISOString(), results, metrics }, null, 2));
const pass = results.filter((r) => r.ok).length;
console.log(`\nE2E（健壮性）: ${pass}/${results.length} 通过`);
process.exit(pass === results.length ? 0 : 1);
