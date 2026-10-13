// 隔离 CDP：球场指挥室外框/阅读区出现在外观菜单，深色令牌生效；第二次启动撞上 amy.touchline。
// 不使用 SendInput，也不用 Playwright 的鼠标/键盘。窗口放到屏幕外，不 focus、不 setAlwaysOnTop。
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE = 'D:\\kb-r13-work\\theme-0023';
const USERDATA = path.join(EVIDENCE, 'userdata');
const SHOTS = path.join(EVIDENCE, 'shots');
const AMY_SRC = 'C:\\Users\\sana2\\AppData\\Local\\LocalKnowledgeWorkbench\\themes\\amy.touchline';
const AMY_DST = path.join(USERDATA, 'themes', 'amy.touchline');
const PROTECTED_PIDS = new Set([6444, 18580, 23756, 26696, 32008, 35504, 39640]);
const STYLE_SELECTORS = {
  chromeToken: "document.documentElement; getComputedStyle(el).getPropertyValue('--kb-color-bg')",
  chromeUsed: 'body; getComputedStyle(el).backgroundColor',
  readingToken: "document.documentElement; getComputedStyle(el).getPropertyValue('--kb-read-bg')",
};

const mode = process.argv[2] || 'all';
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(USERDATA, { recursive: true });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeJson(name, data) {
  fs.writeFileSync(path.join(EVIDENCE, name), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

const LIST_PROC = path.join(EVIDENCE, 'list-proc.exe');

function listProcs() {
  try {
    const out = execFileSync(LIST_PROC, [], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    const rows = [];
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [pid, ppid, name, ...image] = line.split('\t');
      rows.push({ pid: Number(pid), ppid: Number(ppid), name: name ?? '', image: image.join('\t') });
    }
    return { error: null, rows };
  } catch (err) {
    return { error: String(err.message ?? err), rows: [] };
  }
}

function listElectron() {
  const listed = listProcs();
  const pids = listed.rows.filter((row) => /^electron\.exe$/i.test(row.name)).map((row) => row.pid);
  return { error: listed.error, pids, rows: listed.rows };
}

function isProtectedRow(row) {
  if (!row) return false;
  if (PROTECTED_PIDS.has(row.pid)) return true;
  const blob = `${row.name}\n${row.image}`;
  return /LocalKnowledgeWorkbench\.exe/i.test(blob) || /study_dev[\\/]+LocalKnowledgeWorkbench/i.test(blob);
}

function descendants(root, rows) {
  const own = new Set(root ? [root] : []);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (own.has(row.ppid) && !own.has(row.pid)) {
        own.add(row.pid);
        grew = true;
      }
    }
  }
  return own;
}

function killOwned(pid, allowed) {
  if (!pid || !allowed.has(pid) || PROTECTED_PIDS.has(pid)) return { pid, killed: false, reason: 'protected-or-outside-tree' };
  const row = listProcs().rows.find((item) => item.pid === pid);
  if (!row) return { pid, killed: false, reason: 'already-gone' };
  if (isProtectedRow(row)) return { pid, killed: false, reason: 'protected-install' };
  if (!/^(electron|node)\.exe$/i.test(row.name)) return { pid, killed: false, reason: 'unexpected-name', name: row.name };
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true, timeout: 4000 });
    return { pid, killed: true, reason: 'taskkill', name: row.name };
  } catch (err) {
    return { pid, killed: false, reason: String(err.message ?? err), name: row.name };
  }
}

async function waitNoElectron(maxMs) {
  const started = Date.now();
  let last = listElectron();
  while (Date.now() - started < maxMs) {
    last = listElectron();
    const foreign = (last.pids ?? []).filter((pid) => !PROTECTED_PIDS.has(pid));
    if (!last.error && foreign.length === 0) return { ok: true, ...last };
    await sleep(1500);
  }
  return { ok: false, ...last };
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

async function launchApp() {
  const env = { ...process.env, KB_USER_DATA: USERDATA };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${USERDATA}`, '--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'],
    cwd: ROOT,
    env,
    timeout: 120000,
  });
  try {
    const win = await app.firstWindow({ timeout: 120000 });
    await app.evaluate(({ BrowserWindow }) => {
      const current = BrowserWindow.getAllWindows()[0];
      if (current) current.setPosition(-2400, -2400);
    });
    win.on('console', (message) => {
      if (message.type() === 'error') console.log('[renderer]', message.text());
    });
    return { app, win };
  } catch (err) {
    await shutdown(app);
    throw err;
  }
}

async function shot(win, file) {
  try {
    await win.screenshot({ path: file });
    return file;
  } catch (err) {
    return `failed: ${String(err.message ?? err)}`;
  }
}

async function shutdown(app) {
  if (!app) return { exited: true, pid: null, kills: [] };
  const proc = app.process();
  const pid = proc?.pid ?? null;
  let metrics = [];
  try {
    metrics = await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().map((row) => row.pid));
  } catch {
    metrics = [];
  }
  let closeError = null;
  try {
    await Promise.race([
      app.evaluate(({ app: electronApp }) => electronApp.exit(0)),
      sleep(4000).then(() => {
        throw new Error('app.exit timeout');
      }),
    ]);
  } catch (err) {
    closeError = String(err.message ?? err);
  }
  await sleep(800);
  const kills = [];
  const snapshot = listProcs();
  const tree = descendants(pid, snapshot.rows);
  for (const item of metrics) if (item) tree.add(item);
  if (pid) tree.add(pid);
  for (const row of snapshot.rows) {
    if (!tree.has(row.pid)) continue;
    if (!/^(electron|node)\.exe$/i.test(row.name)) continue;
    kills.push(killOwned(row.pid, tree));
  }
  await sleep(400);
  const still = listElectron();
  const ownLeft = (still.rows ?? []).filter((row) => tree.has(row.pid) && /^electron\.exe$/i.test(row.name));
  for (const row of ownLeft) kills.push(killOwned(row.pid, tree));
  await sleep(400);
  let after = listElectron();
  let remain = (after.rows ?? []).filter((row) => tree.has(row.pid) && /^electron\.exe$/i.test(row.name));
  const deadline = Date.now() + 5000;
  while (remain.length && Date.now() < deadline) {
    await sleep(400);
    after = listElectron();
    remain = (after.rows ?? []).filter((row) => tree.has(row.pid) && /^electron\.exe$/i.test(row.name));
  }
  return { exited: remain.length === 0, pid, closeError, kills, electronPids: after.pids ?? [], metrics, tree: [...tree] };
}

function normColor(value) {
  const text = String(value ?? '').trim().toLowerCase().replace(/\s+/g, '');
  const hex = text.match(/^#([0-9a-f]{6})$/);
  if (hex) {
    const n = hex[1];
    return `rgb(${parseInt(n.slice(0, 2), 16)},${parseInt(n.slice(2, 4), 16)},${parseInt(n.slice(4, 6), 16)})`;
  }
  const rgb = text.match(/^rgba?\((\d+),(\d+),(\d+)/);
  if (rgb) return `rgb(${rgb[1]},${rgb[2]},${rgb[3]})`;
  return text;
}

function hasTouchline(options) {
  return Array.isArray(options) && options.some((row) => row.text === '球场指挥室' && row.value === 'touchline');
}

async function readOptions(win) {
  return win.evaluate(() => {
    const read = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      return [...el.querySelectorAll('option')].map((option) => ({ text: option.text, value: option.value }));
    };
    return {
      chrome: read('[data-testid="appearance-chrome"]'),
      reading: read('[data-testid="appearance-reading"]'),
    };
  });
}

async function openMenu(win) {
  const clicked = await win.evaluate(() => {
    const button = document.querySelector('[data-testid="appearance-button"]');
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  });
  if (!clicked) return false;
  await win.waitForSelector('[data-testid="appearance-chrome"]', { timeout: 10000 });
  return true;
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function snapshotDir(dir) {
  if (!fs.existsSync(dir)) return null;
  const out = {};
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (!fs.statSync(abs).isFile()) continue;
    out[name] = { size: fs.statSync(abs).size, sha256: hashFile(abs) };
  }
  return out;
}

async function ready(win, expectAmy) {
  await win.waitForSelector('[data-testid="appearance-button"]', { timeout: 90000 });
  await win.waitForFunction(() => {
    const kb = window.__kb;
    return !!kb && typeof kb.pluginStatus === 'function' && typeof kb.themeReport === 'function';
  }, null, { timeout: 30000 });
  await win.waitForFunction((wantAmy) => {
    const rows = window.__kb.pluginStatus();
    const ids = rows.map((row) => row.id);
    if (!ids.includes('kb.theme.touchline')) return false;
    if (wantAmy && !ids.includes('amy.touchline')) return false;
    return true;
  }, expectAmy, { timeout: 20000 }).catch(() => undefined);
}

async function park(app) {
  await app.evaluate(({ BrowserWindow }) => {
    const current = BrowserWindow.getAllWindows()[0];
    if (current) current.setPosition(-2400, -2400);
  });
}

async function runClean() {
  const report = {
    phase: 'clean',
    pass: false,
    selectors: STYLE_SELECTORS,
    pluginStatus: null,
    themeReport: null,
    options: null,
    dataset: null,
    computed: null,
    screenshots: {},
    checks: [],
    error: null,
    electron: null,
  };
  const gate = await waitNoElectron(180000);
  if (!gate.ok) {
    report.error = `启动前仍有其他 electron.exe: ${(gate.pids ?? []).join(',')}`;
    report.electron = { before: gate };
    writeJson('cdp-clean.json', report);
    return { exited: true, report };
  }
  let app;
  try {
    const launched = await launchApp();
    app = launched.app;
    const win = launched.win;
    await ready(win, false);
    await park(app);
    report.pluginStatus = await win.evaluate(() => window.__kb.pluginStatus());
    report.themeReport = await win.evaluate(() => window.__kb.themeReport());
    const opened = await openMenu(win);
    report.checks.push({ name: '打开外观菜单', ok: opened });
    if (opened) {
      report.options = await readOptions(win);
      report.screenshots.menu = await shot(win, path.join(SHOTS, 'menu-dark.png'));
    }
    const chromeOk = hasTouchline(report.options?.chrome);
    const readingOk = hasTouchline(report.options?.reading);
    report.checks.push({ name: '外框选项含球场指挥室/touchline', ok: chromeOk, detail: report.options?.chrome ?? null });
    report.checks.push({ name: '阅读区选项含球场指挥室/touchline', ok: readingOk, detail: report.options?.reading ?? null });
    await win.evaluate(() => window.__kb.setAppearance({ chrome: 'touchline', reading: 'touchline', scheme: 'dark' }));
    await win.waitForFunction(
      () => document.documentElement.dataset.kbChrome === 'touchline'
        && document.documentElement.dataset.kbReading === 'touchline'
        && document.documentElement.dataset.kbScheme === 'dark',
      null,
      { timeout: 10000 },
    ).catch(() => undefined);
    const applied = await win.evaluate((selectors) => {
      const root = document.documentElement;
      const rootStyle = getComputedStyle(root);
      const bodyStyle = getComputedStyle(document.body);
      return {
        dataset: {
          kbChrome: root.dataset.kbChrome ?? '',
          kbReading: root.dataset.kbReading ?? '',
          kbScheme: root.dataset.kbScheme ?? '',
        },
        computed: {
          selectors,
          chromeToken: rootStyle.getPropertyValue('--kb-color-bg').trim(),
          chromeUsed: bodyStyle.backgroundColor,
          readingToken: rootStyle.getPropertyValue('--kb-read-bg').trim(),
        },
      };
    }, STYLE_SELECTORS);
    report.dataset = applied.dataset;
    report.computed = applied.computed;
    report.screenshots.applied = await shot(win, path.join(SHOTS, 'applied-dark.png'));
    const datasetOk = applied.dataset.kbChrome === 'touchline' && applied.dataset.kbReading === 'touchline' && applied.dataset.kbScheme === 'dark';
    const colorOk = normColor(applied.computed.chromeToken) === 'rgb(20,26,34)' || normColor(applied.computed.chromeUsed) === 'rgb(20,26,34)';
    report.checks.push({ name: 'dataset kbChrome/kbReading/kbScheme', ok: datasetOk, detail: applied.dataset });
    report.checks.push({ name: '深色 --kb-color-bg 或 body 背景为 #141a22', ok: colorOk, detail: applied.computed });
    report.pass = report.checks.every((item) => item.ok);
  } catch (err) {
    report.error = String(err && err.stack ? err.stack : err);
    report.pass = false;
  } finally {
    report.electron = await shutdown(app);
  }
  writeJson('cdp-clean.json', report);
  console.log(`clean pass=${report.pass} electronExited=${report.electron?.exited}`);
  return { exited: !!report.electron?.exited, report };
}

function copyAmy() {
  const before = snapshotDir(AMY_SRC);
  if (!before) throw new Error(`找不到只读源主题: ${AMY_SRC}`);
  fs.mkdirSync(path.dirname(AMY_DST), { recursive: true });
  fs.cpSync(AMY_SRC, AMY_DST, { recursive: true });
  const after = snapshotDir(AMY_SRC);
  const same = JSON.stringify(before) === JSON.stringify(after);
  if (!same) throw new Error('拷贝后源主题哈希变化，已中止');
  return { before, after, destination: AMY_DST, sourceUnchanged: same };
}

async function runConflict() {
  const report = {
    phase: 'conflict',
    pass: false,
    pluginStatus: null,
    themeReport: null,
    options: null,
    amy: null,
    builtin: null,
    copy: null,
    checks: [],
    error: null,
    electron: null,
  };
  try {
    report.copy = copyAmy();
  } catch (err) {
    report.error = String(err && err.stack ? err.stack : err);
    writeJson('cdp-conflict.json', report);
    return report;
  }
  const gate = await waitNoElectron(60000);
  if (!gate.ok) {
    report.error = `冲突启动前仍有 electron.exe: ${(gate.pids ?? []).join(',')}`;
    report.electron = { before: gate };
    writeJson('cdp-conflict.json', report);
    return report;
  }
  let app;
  try {
    const launched = await launchApp();
    app = launched.app;
    const win = launched.win;
    await ready(win, true);
    await park(app);
    report.pluginStatus = await win.evaluate(() => window.__kb.pluginStatus());
    report.themeReport = await win.evaluate(() => window.__kb.themeReport());
    const opened = await openMenu(win);
    report.checks.push({ name: '冲突启动仍能打开外观菜单', ok: opened });
    if (opened) report.options = await readOptions(win);
    report.builtin = (report.pluginStatus ?? []).find((row) => row.id === 'kb.theme.touchline') ?? null;
    report.amy = (report.pluginStatus ?? []).find((row) => row.id === 'amy.touchline') ?? null;
    const builtinOk = report.builtin?.status === 'active';
    const amyOk = report.amy?.status === 'error' && typeof report.amy?.message === 'string' && report.amy.message.includes('重复注册');
    const optionOk = hasTouchline(report.options?.chrome) && hasTouchline(report.options?.reading);
    report.checks.push({ name: 'kb.theme.touchline 为 active', ok: builtinOk, detail: report.builtin });
    report.checks.push({ name: 'amy.touchline 为 error 且 message 含重复注册', ok: amyOk, detail: report.amy });
    report.checks.push({ name: '下拉仍可选球场指挥室/touchline', ok: optionOk, detail: report.options });
    report.pass = report.checks.every((item) => item.ok);
  } catch (err) {
    report.error = String(err && err.stack ? err.stack : err);
    report.pass = false;
  } finally {
    report.electron = await shutdown(app);
  }
  writeJson('cdp-conflict.json', report);
  console.log(`conflict pass=${report.pass} amy=${report.amy?.status} ${report.amy?.message ?? ''} electronExited=${report.electron?.exited}`);
  return report;
}

let cleanExited = true;
if (mode === 'clean' || mode === 'all') {
  fs.rmSync(AMY_DST, { recursive: true, force: true });
  const clean = await runClean();
  cleanExited = clean.exited;
}
if (mode === 'conflict' || mode === 'all') {
  if (!cleanExited) {
    writeJson('cdp-conflict.json', {
      phase: 'conflict',
      pass: false,
      error: '干净启动的 Electron 未退出，未进行第二次启动',
      pluginStatus: null,
      themeReport: null,
      amy: null,
    });
    process.exit(1);
  }
  const conflict = await runConflict();
  if (!conflict.pass || conflict.electron?.exited === false) process.exit(1);
}
const cleanReport = fs.existsSync(path.join(EVIDENCE, 'cdp-clean.json')) ? JSON.parse(fs.readFileSync(path.join(EVIDENCE, 'cdp-clean.json'), 'utf8')) : null;
if (cleanReport && cleanReport.pass === false) process.exit(1);
