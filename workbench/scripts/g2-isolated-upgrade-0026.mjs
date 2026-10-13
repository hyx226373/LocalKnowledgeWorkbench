// Isolated in-app upgrade 0.2.3 -> 0.2.4. One Electron at a time.
// Do not run this file from the agent. The 0.2.3 tree is copied, not installed.
// UninstallString stays registered. Before apply, reg query must still succeed
// and its stdout must contain study_dev. Saved registry is imported in finally
// only after InstallLocation is compared. Never taskkill by image name.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve('D:\\kb-r13-work\\install-0024\\app');
const INST = path.resolve('D:\\kb-r13-work\\upgrade-0026\\app-023');
const USERDATA = path.resolve('D:\\kb-r13-work\\upgrade-0026\\userdata');
const FEED = path.resolve(process.env.KB_G2_FEED || 'D:\\kb-r13-work\\feed-0.2.4');
const SETUP_NAME = 'LocalKnowledgeWorkbench-0.2.4-win-x64-setup.exe';
const LOG_DIR = path.resolve('D:\\kb-r13-work\\upgrade-0026\\g2');
const INSTALL_LOG = path.join(LOG_DIR, 'install.log');
const STAMP = path.join(LOG_DIR, 'proc-stamp.txt');
const RESULT = path.join(LOG_DIR, 'g2-result.json');
const RUN_LOG = path.join(LOG_DIR, 'g2-run.log');
const PORT = 9546;
const FROM_VERSION = '0.2.3';
const TO_VERSION = '0.2.4';
const AMY_ROOT = 'D:\\study_dev\\LocalKnowledgeWorkbench';
const AMY_EXE = path.join(AMY_ROOT, 'LocalKnowledgeWorkbench.exe');
const AMY_DB = path.join(process.env.LOCALAPPDATA || '', 'LocalKnowledgeWorkbench', 'workbench.db');
const REG_KEYS = [
  'HKCU\\Software\\173de95e-f638-560d-b657-f1331a82173e',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\173de95e-f638-560d-b657-f1331a82173e',
];
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const startedAt = Date.now();
const ownPids = new Set();
const logLines = [];
function log(line) {
  const text = `[${new Date().toISOString()}] ${line}`;
  logLines.push(text);
  console.log(text);
}
function flushLog() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(RUN_LOG, logLines.join('\n') + '\n', 'utf8');
}
function addReason(reason, extra) {
  if (!reason || reason === 'pass') return extra;
  return reason + ',' + extra;
}
function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}
function psEncoded(script, timeoutMs = 20000) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return spawnSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
}
function psTimedOut(result) {
  return !!(result.error && (result.error.code === 'ETIMEDOUT' || result.signal));
}
function fileStat(file) {
  try {
    const st = fs.statSync(file);
    return { path: file, exists: true, size: st.size, mtimeUtc: st.mtime.toISOString() };
  } catch {
    return { path: file, exists: false };
  }
}
function sha256(file) {
  const hash = crypto.createHash('sha256');
  const input = fs.createReadStream(file);
  return new Promise((resolve, reject) => {
    input.on('data', (buf) => hash.update(buf));
    input.on('error', reject);
    input.on('end', () => resolve(hash.digest('hex')));
  });
}
function versionOf(file) {
  if (!fs.existsSync(file)) return { exists: false, path: file };
  const r = psEncoded(`
$i = Get-Item -LiteralPath ${psQuote(file)}
$v = $i.VersionInfo
Write-Output ($i.Length.ToString())
Write-Output ($i.LastWriteTimeUtc.ToString('o'))
Write-Output ([string]$v.FileVersion)
Write-Output ([string]$v.ProductVersion)
`);
  const rows = String(r.stdout || '').split(/\r?\n/).map((line) => line.trim());
  return { exists: true, path: file, size: Number(rows[0]), mtimeUtc: rows[1] || '', fileVersion: rows[2] || '', productVersion: rows[3] || '', stderr: String(r.stderr || '').trim() };
}
function versionIs(value, want) {
  const text = String(value || '').trim();
  if (!text.startsWith(want)) return false;
  const next = text.charAt(want.length);
  return next === '' || next === '.' || next === ' ' || next === '+' || next === '-';
}
async function amySnapshot() {
  const exe = versionOf(AMY_EXE);
  if (exe.exists) {
    try {
      exe.sha256 = await sha256(AMY_EXE);
    } catch (err) {
      exe.sha256Error = err instanceof Error ? err.message : String(err);
    }
  }
  // stat only; do not open the database
  return { exe, db: fileStat(AMY_DB) };
}
function exeHashSame(before, after) {
  if (!before || !after) return false;
  if (before.exists !== after.exists) return false;
  if (!before.exists) return true;
  return !!before.sha256 && before.sha256 === after.sha256;
}
function dbStatSame(before, after) {
  if (!before || !after) return false;
  if (before.exists !== after.exists) return false;
  if (!before.exists) return true;
  return before.size === after.size && before.mtimeUtc === after.mtimeUtc;
}
function normPath(value) {
  return String(value || '').replace(/\//g, '\\').replace(/\\+$/g, '').toLowerCase();
}
function underDir(file, dir) {
  const left = normPath(file);
  const root = normPath(dir);
  if (!left || !root) return false;
  return left === root || left.startsWith(root + '\\');
}
function desktopDir() {
  const r = psEncoded("[Environment]::GetFolderPath('Desktop')", 15000);
  const dir = String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
  return dir || path.join(os.homedir(), 'Desktop');
}
function shortcutPaths() {
  return [
    path.join(desktopDir(), '本地知识工作台.lnk'),
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', '本地知识工作台.lnk'),
  ];
}
function exportReg(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return REG_KEYS.map((key) => {
    const file = path.join(dir, key.replace(/[\\:]/g, '_') + '.reg');
    const r = spawnSync('reg.exe', ['export', key, file, '/y'], { encoding: 'utf8', windowsHide: true });
    return { key, file, status: r.status, exists: fs.existsSync(file), stderr: String(r.stderr || '').trim() };
  });
}
function queryInstallLocation() {
  const r = spawnSync('reg.exe', ['query', REG_KEYS[0], '/v', 'InstallLocation'], { encoding: 'utf8', windowsHide: true });
  return { status: r.status, text: String(r.stdout || '').trim() };
}
function queryUninstallString() {
  const r = spawnSync('reg.exe', ['query', REG_KEYS[1], '/v', 'UninstallString'], { encoding: 'utf8', windowsHide: true });
  const text = String(r.stdout || '');
  return {
    status: r.status,
    text: text.trim(),
    stderr: String(r.stderr || '').trim(),
    ok: r.status === 0 && /study_dev/i.test(text),
  };
}
function restoreReg(saved) {
  return saved.map((item) => {
    if (!item.exists) return { key: item.key, skipped: true };
    const r = spawnSync('reg.exe', ['import', item.file], { encoding: 'utf8', windowsHide: true });
    return { key: item.key, importStatus: r.status, stderr: String(r.stderr || '').trim() };
  });
}
function copyIfExists(file, dest) {
  if (!fs.existsSync(file)) return { file, existed: false };
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(file, dest);
  return { file, existed: true, dest };
}
function restoreShortcut(snap) {
  if (!snap.existed) {
    if (fs.existsSync(snap.file)) fs.rmSync(snap.file, { force: true });
    return { file: snap.file, action: 'removed-new' };
  }
  fs.copyFileSync(snap.dest, snap.file);
  return { file: snap.file, action: 'restored' };
}
function taskkillPid(pid) {
  const n = Number(pid);
  if (!n || n === process.pid) return { pid, skipped: true, reason: 'refuse' };
  const r = spawnSync('taskkill', ['/PID', String(n), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
  return { pid: n, status: r.status, stderr: String(r.stderr || '').trim() };
}
function killTree(pid) {
  if (!pid || !ownPids.has(pid)) return { pid, skipped: true, reason: 'not-owned' };
  return taskkillPid(pid);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function loadChromium() {
  const candidates = [path.join(ROOT, 'package.json'), 'D:\\STUDY MATERIAL\\项目\\知识库\\kb-wt-r13-021\\package.json'];
  for (const pkg of candidates) {
    const mod = path.join(path.dirname(pkg), 'node_modules', 'playwright');
    if (fs.existsSync(mod)) return createRequire(pkg)('playwright').chromium;
  }
  throw new Error('playwright not found');
}
function baseEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;
  delete env.NODE_OPTIONS;
  env.KB_USER_DATA = USERDATA;
  env.KB_UPDATE_FEED = FEED;
  env.KB_UPDATE_AUTO_CHECK = '0';
  env.KB_UPDATE_CHECK_DELAY_MS = '3600000';
  env.KB_UPDATE_NO_RELAUNCH = '1';
  env.KB_UPDATE_TEST_HOOK = '1';
  env.KB_NSIS_INSTDIR = INST;
  env.KB_PROC_STAMP = STAMP;
  env.KB_UPDATE_INSTALL_SILENT = '1';
  env.KB_UPDATE_ASSUME_QUIT = '1';
  env.KB_UPDATE_INSTALL_LOG = INSTALL_LOG;
  delete env.KB_UPDATE_APPLY;
  return env;
}
function parseProcRows(stdout) {
  const rows = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const pid = Number(parts[0]);
    const name = (parts[1] || '').trim();
    const exe = parts.slice(2).join('\t').trim();
    if (pid > 0 && name) rows.push({ pid, name, exe });
  }
  return rows;
}
function listWatchProcs() {
  const r = psEncoded(`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$amy = 'D:\\study_dev\\LocalKnowledgeWorkbench'
Get-Process | ForEach-Object {
  $name = [string]$_.ProcessName
  $take = $false
  if ($name -eq 'old-uninstaller') { $take = $true }
  elseif ($name -like 'LocalKnowledgeWorkbench*') { $take = $true }
  elseif ($name -like 'Uninstall*') { $take = $true }
  elseif ($name -like '*LocalKnowledge*') { $take = $true }
  $procPath = ''
  if (-not $take) {
    try { $procPath = [string]$_.Path } catch {}
    if ($procPath -and ($procPath -eq $amy -or $procPath.StartsWith($amy + '\\', [StringComparison]::OrdinalIgnoreCase))) { $take = $true }
  } else {
    try { $procPath = [string]$_.Path } catch {}
  }
  if ($take) { Write-Output ($_.Id.ToString() + [char]9 + $name + [char]9 + $procPath) }
}
`, 12000);
  return { timedOut: psTimedOut(r), status: r.status, rows: parseProcRows(r.stdout), stderr: String(r.stderr || '').trim() };
}
function isOldUninstaller(row) {
  if (String(row.name || '').toLowerCase() === 'old-uninstaller') return true;
  return path.basename(String(row.exe || '')).toLowerCase() === 'old-uninstaller.exe';
}
function isSetupRow(row) {
  if (row.exe && underDir(row.exe, AMY_ROOT)) return false;
  const exe = String(row.exe || '').toLowerCase();
  const name = String(row.name || '').toLowerCase();
  if (exe.endsWith(SETUP_NAME.toLowerCase())) return true;
  return name.startsWith('localknowledgeworkbench') && name.includes('setup');
}
function parseStamp(text) {
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const start = line.match(/^start (\S+) mode (\S+)/);
    const end = line.match(/^end (\S+) exit (\d+)/);
    if (start) events.push({ kind: 'start', at: Date.parse(start[1]), mode: start[2] });
    else if (end) events.push({ kind: 'end', at: Date.parse(end[1]), code: Number(end[2]) });
  }
  const pairs = [];
  let open = null;
  for (const event of events) {
    if (event.kind === 'start') open = event;
    else if (event.kind === 'end' && open) {
      pairs.push({ mode: open.mode, ms: event.at - open.at, code: event.code });
      open = null;
    }
  }
  return { pairs, text };
}
function findAsarBackups(root) {
  const found = [];
  if (!fs.existsSync(root)) return found;
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name === 'app.asar') found.push(full);
    }
  };
  walk(root);
  return found;
}
function decodeLog(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { encoding: 'utf8', text: buf.toString('utf8').replace(/^\uFEFF/, '') };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { encoding: 'utf16le', text: buf.toString('utf16le').replace(/^\uFEFF/, '') };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf);
    swapped.swap16();
    return { encoding: 'utf16be', text: swapped.toString('utf16le').replace(/^\uFEFF/, '') };
  }
  let zero = 0;
  const n = Math.min(buf.length, 512);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) zero += 1;
  if (buf.length >= 4 && zero * 4 > n) {
    return { encoding: 'utf16le', text: buf.toString('utf16le').replace(/^\uFEFF/, '') };
  }
  return { encoding: 'utf8', text: buf.toString('utf8').replace(/^\uFEFF/, '') };
}
function readInstallLog(file) {
  if (!fs.existsSync(file)) return { exists: false, text: '', encoding: '', bytes: 0, shadow: false };
  const buf = fs.readFileSync(file);
  const decoded = decodeLog(buf);
  return { exists: true, encoding: decoded.encoding, bytes: buf.length, text: decoded.text, shadow: decoded.text.includes('kb-reg-shadow: HKCU redirected') };
}
async function waitPort(child) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error('app exited before CDP ' + child.exitCode);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return;
    } catch { /* not yet */ }
    await sleep(250);
  }
  throw new Error('CDP port did not open');
}
async function findPage(browser) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    for (const ctx of browser.contexts()) {
      for (const candidate of ctx.pages()) {
        const ok = await candidate.evaluate(() => !!(window.kb && window.kb.aboutInfo)).catch(() => false);
        if (ok) return candidate;
      }
    }
    await sleep(250);
  }
  throw new Error('no page with window.kb');
}
function launchApp(tag) {
  const exe = path.join(INST, 'LocalKnowledgeWorkbench.exe');
  const stdout = fs.createWriteStream(path.join(LOG_DIR, `${tag}-stdout.log`));
  const stderr = fs.createWriteStream(path.join(LOG_DIR, `${tag}-stderr.log`));
  const child = spawn(exe, [`--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], {
    env: baseEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  ownPids.add(child.pid);
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  fs.writeFileSync(path.join(LOG_DIR, `${tag}-pid.txt`), String(child.pid));
  return child;
}
function armSetupWait(pid, waiters) {
  const script = `
$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue
if (-not $p) { Write-Output 'GONE'; exit 0 }
if (-not $p.WaitForExit(540000)) { Write-Output 'TIMEOUT'; exit 3 }
Write-Output ('EXIT ' + [string]$p.ExitCode)
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  ownPids.add(child.pid);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (buf) => { stdout += buf.toString('utf8'); });
  child.stderr.on('data', (buf) => { stderr += buf.toString('utf8'); });
  const done = new Promise((resolve) => {
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      ownPids.delete(child.pid);
      resolve({ setupPid: pid, waiterPid: child.pid, code, stdout: stdout.trim(), stderr: stderr.trim() });
    };
    child.once('close', finish);
    child.once('error', (err) => finish(err && err.code ? String(err.code) : null));
  });
  waiters.push(done);
}
async function watchInstall(since) {
  const baselineSnap = listWatchProcs();
  const baselineOk = !baselineSnap.timedOut;
  const baselinePids = new Set(baselineSnap.rows.map((row) => row.pid));
  const violations = [];
  const preexistingOld = [];
  const seen = new Set();
  const killedOld = [];
  const setupPids = new Set();
  const waiters = [];
  let watchTimedOut = baselineSnap.timedOut;
  let sawSetup = false;
  let finished = false;
  const deadline = Date.now() + 10 * 60 * 1000;
  const note = (row) => {
    const oldUn = isOldUninstaller(row);
    const underAmy = !!(row.exe && underDir(row.exe, AMY_ROOT));
    const fresh = !baselinePids.has(row.pid);
    // A stuck old-uninstaller that is already running before this install is not
    // evidence that this installer launched uninstallOldVersion. taskkill on that
    // pid can sit until its own timeout, so leave it alone.
    if (oldUn && baselineOk && !fresh) {
      const key = row.pid + '|' + row.name + '|' + row.exe;
      if (!seen.has(key)) {
        seen.add(key);
        preexistingOld.push({ pid: row.pid, name: row.name, exe: row.exe });
        log(`preexisting old-uninstaller pid ${row.pid} ${row.exe}`);
      }
      return;
    }
    if ((oldUn && fresh) || (baselineOk && underAmy && fresh)) {
      const key = row.pid + '|' + row.name + '|' + row.exe;
      if (!seen.has(key)) {
        seen.add(key);
        violations.push({ pid: row.pid, name: row.name, exe: row.exe, oldUninstaller: oldUn, underAmy, fresh });
        log(`foreign process pid ${row.pid} ${row.name} ${row.exe}`);
      }
      if (oldUn && !killedOld.some((item) => item.pid === row.pid)) {
        const killed = taskkillPid(row.pid);
        killedOld.push(killed);
        log(`ended old-uninstaller pid ${row.pid} status ${killed.status}`);
      }
    }
    if (isSetupRow(row) && !setupPids.has(row.pid)) {
      sawSetup = true;
      setupPids.add(row.pid);
      ownPids.add(row.pid);
      log(`setup pid ${row.pid} ${row.exe}`);
      armSetupWait(row.pid, waiters);
    }
  };
  let timedOut = false;
  while (Date.now() < deadline) {
    const snap = listWatchProcs();
    if (snap.timedOut) {
      watchTimedOut = true;
      await sleep(250);
      continue;
    }
    for (const row of snap.rows) note(row);
    if (sawSetup && !snap.rows.some((row) => setupPids.has(row.pid))) {
      await sleep(400);
      const again = listWatchProcs();
      if (again.timedOut) {
        watchTimedOut = true;
      } else {
        for (const row of again.rows) note(row);
        if (!again.rows.some((row) => setupPids.has(row.pid))) {
          finished = true;
          break;
        }
      }
    }
    await sleep(250);
  }
  if (!finished && Date.now() >= deadline) timedOut = true;
  if (timedOut) {
    for (const pid of setupPids) killTree(pid);
  }
  let waiterResults = [];
  if (waiters.length) {
    const settled = await Promise.race([
      Promise.all(waiters),
      sleep(20000).then(() => null),
    ]);
    if (settled) waiterResults = settled;
  }
  const waiterStdout = waiterResults.map((item) => item.stdout).filter(Boolean).join('\n');
  return {
    missing: !sawSetup,
    sawSetup,
    timedOut,
    watchTimedOut,
    baselineOk,
    baseline: baselineSnap.rows,
    setupPids: [...setupPids],
    violations,
    preexistingOldUninstaller: preexistingOld,
    killedOldUninstaller: killedOld,
    waiterResults,
    waiterStdout,
    ms: Date.now() - since,
  };
}

if (!INST.startsWith('D:\\kb-r13-work\\upgrade-0026\\') || /study_dev/i.test(INST) || underDir(INST, AMY_ROOT)) {
  console.error('G2 FAIL unsafe install dir');
  process.exit(1);
}
if (!USERDATA.startsWith('D:\\kb-r13-work\\upgrade-0026\\') || /study_dev/i.test(USERDATA)) {
  console.error('G2 FAIL unsafe user data dir');
  process.exit(1);
}
if (/study_dev/i.test(FEED) || underDir(FEED, AMY_ROOT) || /study_dev/i.test(SRC) || underDir(SRC, AMY_ROOT)) {
  console.error('G2 FAIL refusing study_dev feed or source');
  process.exit(1);
}

const result = {
  startedAt: new Date(startedAt).toISOString(),
  inst: INST,
  userdata: USERDATA,
  feed: FEED,
  fromVersion: FROM_VERSION,
  toVersion: TO_VERSION,
  ok: false,
  steps: {},
};
let regSaved = [];
let shortcuts = [];
let amyBefore = null;
let child = null;
let browser = null;

try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  amyBefore = await amySnapshot();
  result.amyBefore = amyBefore;
  regSaved = exportReg(path.join(LOG_DIR, 'reg-before'));
  result.installLocationBefore = queryInstallLocation();
  if (!regSaved.every((item) => item.exists && item.status === 0)) {
    throw new Error('registry export failed; refusing to continue');
  }
  shortcuts = shortcutPaths().map((file, index) => copyIfExists(file, path.join(LOG_DIR, 'shortcuts', index + '-' + path.basename(file))));
  const setupPath = path.join(FEED, SETUP_NAME);
  const latest = path.join(FEED, 'latest.yml');
  if (!fs.existsSync(setupPath) || !fs.existsSync(latest)) throw new Error('feed-0.2.4 is incomplete: ' + FEED);
  if (!fs.existsSync(path.join(SRC, 'LocalKnowledgeWorkbench.exe'))) throw new Error('0.2.3 app tree missing');
  const copyStarted = Date.now();
  fs.rmSync(INST, { recursive: true, force: true });
  fs.cpSync(SRC, INST, { recursive: true });
  result.steps.copy = { ms: Date.now() - copyStarted };
  const beforeVer = versionOf(path.join(INST, 'LocalKnowledgeWorkbench.exe'));
  result.beforeVersion = beforeVer;
  if (!versionIs(beforeVer.fileVersion, FROM_VERSION) || !versionIs(beforeVer.productVersion, FROM_VERSION)) {
    throw new Error('copied exe is not 0.2.3: ' + JSON.stringify(beforeVer));
  }
  fs.rmSync(USERDATA, { recursive: true, force: true });
  fs.mkdirSync(USERDATA, { recursive: true });
  fs.rmSync(STAMP, { force: true });
  fs.rmSync(INSTALL_LOG, { force: true });
  const asar = path.join(INST, 'resources', 'app.asar');
  const asarStarted = Date.now();
  result.asarBefore = { path: asar, size: fs.statSync(asar).size, sha256: await sha256(asar), ms: Date.now() - asarStarted };

  const chromium = loadChromium();
  const bootStarted = Date.now();
  child = launchApp('old');
  await waitPort(child);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  let page = await findPage(browser);
  const about = await page.evaluate(() => window.kb.aboutInfo());
  result.aboutBefore = about;
  result.steps.boot = { ms: Date.now() - bootStarted };
  log('about ' + JSON.stringify(about));
  if (!versionIs(about?.version, FROM_VERSION)) throw new Error('running version is not 0.2.3');
  if (/study_dev/i.test(String(about?.installDir || ''))) throw new Error('installDir is study_dev');
  if (path.resolve(about.installDir).toLowerCase() !== INST.toLowerCase()) throw new Error('installDir is ' + about.installDir);

  const checkStarted = Date.now();
  page.setDefaultTimeout(600000);
  let snap = await page.evaluate(() => window.kb.updateCheck());
  const checkDeadline = Date.now() + 10 * 60 * 1000;
  while (!(snap && snap.downloaded && snap.available && snap.available.version === TO_VERSION)) {
    if (Date.now() > checkDeadline) throw new Error('download timeout ' + JSON.stringify(snap));
    if (snap && (snap.phase === 'failed' || snap.error)) throw new Error('update failed ' + JSON.stringify(snap));
    await sleep(500);
    snap = await page.evaluate(() => window.kb.updateState());
  }
  result.snapshot = snap;
  result.steps.download = { ms: Date.now() - checkStarted };
  const downloads = path.join(USERDATA, 'update-downloads');
  result.downloads = fs.existsSync(downloads) ? fs.readdirSync(downloads).map((name) => {
    const full = path.join(downloads, name);
    return { name, size: fs.statSync(full).size, path: full };
  }) : [];
  log('downloaded ' + JSON.stringify(result.downloads));

  const uninstall = queryUninstallString();
  result.uninstallBeforeApply = uninstall;
  if (!uninstall.ok) {
    throw new Error('UninstallString missing or does not mention study_dev; refusing to apply');
  }
  log('UninstallString still present and mentions study_dev');
  const installStarted = Date.now();
  const setupWait = watchInstall(installStarted);
  let applyError = null;
  try {
    await page.evaluate(() => window.kb.updateApply({ actionId: 'app.installUpdate', when: 'now' }));
  } catch (err) {
    applyError = err instanceof Error ? err.message : String(err);
  }
  const appExit = await new Promise((resolve) => {
    if (child.exitCode != null) return resolve(child.exitCode);
    const timer = setTimeout(() => resolve('timeout'), 180000);
    child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  result.appExit = appExit;
  result.applyError = applyError;
  result.setup = await setupWait;
  result.steps.install = { ms: Date.now() - installStarted };
  log('setup ' + JSON.stringify({
    missing: result.setup.missing,
    sawSetup: result.setup.sawSetup,
    timedOut: result.setup.timedOut,
    watchTimedOut: result.setup.watchTimedOut,
    violations: result.setup.violations,
    waiterStdout: result.setup.waiterStdout,
  }));
  await browser.close().catch(() => undefined);
  browser = null;
  if (child.pid && child.exitCode == null) killTree(child.pid);

  const backups = findAsarBackups(path.join(USERDATA, 'update-backups'));
  result.backupAsars = [];
  for (const file of backups) {
    result.backupAsars.push({ path: file, size: fs.statSync(file).size, sha256: await sha256(file) });
  }
  const backupOk = result.backupAsars.some((item) => item.sha256 === result.asarBefore.sha256 && item.size === result.asarBefore.size);
  result.backupOk = backupOk;
  const afterVer = versionOf(path.join(INST, 'LocalKnowledgeWorkbench.exe'));
  result.afterVersion = afterVer;
  const stamp = parseStamp(fs.existsSync(STAMP) ? fs.readFileSync(STAMP, 'utf8') : '');
  result.stamp = stamp;
  result.stampPath = STAMP;
  const probeOk = stamp.pairs.length > 0 && stamp.pairs.every((pair) => Number.isFinite(pair.ms) && pair.ms <= 5000);
  result.probeOk = probeOk;
  let installLog = { exists: false, text: '', encoding: '', bytes: 0, shadow: false };
  try {
    installLog = readInstallLog(INSTALL_LOG);
  } catch (err) {
    installLog = { exists: false, text: '', encoding: '', bytes: 0, shadow: false, error: err instanceof Error ? err.message : String(err) };
  }
  result.installLog = { path: INSTALL_LOG, exists: installLog.exists, encoding: installLog.encoding, bytes: installLog.bytes, shadow: installLog.shadow, error: installLog.error };

  const relaunchStarted = Date.now();
  child = launchApp('new');
  await waitPort(child);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  page = await findPage(browser);
  const aboutAfter = await page.evaluate(() => window.kb.aboutInfo());
  result.aboutAfter = aboutAfter;
  result.steps.relaunch = { ms: Date.now() - relaunchStarted };
  log('about after ' + JSON.stringify(aboutAfter));
  await browser.close().catch(() => undefined);
  browser = null;
  killTree(child.pid);

  const versionOk = versionIs(afterVer.fileVersion, TO_VERSION)
    && versionIs(afterVer.productVersion, TO_VERSION)
    && versionIs(aboutAfter?.version, TO_VERSION);
  const instOk = path.resolve(aboutAfter?.installDir || '').toLowerCase() === INST.toLowerCase()
    && !/study_dev/i.test(String(aboutAfter?.installDir || ''));
  const setupText = String(result.setup?.waiterStdout || '');
  const setupExplicitFail = /TIMEOUT/.test(setupText) || /EXIT\s+(?!0\b)\d+/.test(setupText);
  result.setupExitText = setupText;
  const foreign = result.setup?.violations || [];
  const problems = [];
  if (!backupOk) problems.push('backup-asar');
  if (!versionOk) problems.push('version');
  if (!instOk) problems.push('install-dir');
  if (!probeOk) problems.push('probe');
  if (!installLog.shadow) problems.push('install-log');
  if (foreign.length > 0) problems.push('foreign-process');
  if (result.setup?.watchTimedOut) problems.push('proc-watch');
  if (setupExplicitFail || result.setup?.timedOut || result.setup?.missing) problems.push('setup-exit');
  if (appExit === 'timeout') problems.push('app-exit');
  result.problems = problems;
  result.ok = problems.length === 0;
  result.reason = result.ok ? 'pass' : problems.join(',');
} catch (err) {
  result.ok = false;
  result.reason = err instanceof Error ? err.message : String(err);
  result.error = err instanceof Error ? err.stack || err.message : String(err);
  log('ERROR ' + result.reason);
} finally {
  try { if (browser) await browser.close(); } catch { /* already closed */ }
  for (const pid of ownPids) killTree(pid);
  try {
    if (result.installLocationBefore) {
      result.installLocationBeforeImport = queryInstallLocation();
      result.registryUntouched = result.installLocationBefore.status === result.installLocationBeforeImport.status
        && result.installLocationBefore.text === result.installLocationBeforeImport.text;
      if (!result.registryUntouched) {
        result.ok = false;
        result.reason = addReason(result.reason, 'registry-changed');
      }
    }
    result.regRestore = restoreReg(regSaved);
    if ((result.regRestore || []).some((item) => item.importStatus != null && item.importStatus !== 0)) {
      result.ok = false;
      result.reason = addReason(result.reason, 'registry-import');
    }
    result.shortcutRestore = shortcuts.map(restoreShortcut);
    result.installLocationAfter = queryInstallLocation();
    const amyAfter = await amySnapshot();
    result.amyAfter = amyAfter;
    const exeSame = exeHashSame(amyBefore && amyBefore.exe, amyAfter.exe);
    const dbSame = dbStatSame(amyBefore && amyBefore.db, amyAfter.db);
    result.amyExeUnchanged = !!exeSame;
    result.amyDbUnchanged = !!dbSame;
    if (amyBefore && !exeSame) {
      result.ok = false;
      result.reason = addReason(result.reason, 'amy-exe-changed');
    }
    if (amyBefore && !dbSame) {
      result.ok = false;
      result.reason = addReason(result.reason, 'amy-db-changed');
    }
  } catch (err) {
    result.ok = false;
    result.restoreError = err instanceof Error ? err.message : String(err);
  }
  result.ownPids = [...ownPids];
  result.elapsedMs = Date.now() - startedAt;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(RESULT, JSON.stringify(result, null, 2));
  log(result.ok ? 'G2 PASS' : 'G2 FAIL ' + result.reason);
  log(`elapsedMs=${result.elapsedMs}`);
  flushLog();
  console.log(result.ok ? 'G2 PASS' : 'G2 FAIL');
  process.exit(result.ok ? 0 : 1);
}
