// G2: isolated in-app upgrade 0.2.2 -> 0.2.3. One Electron at a time.
// The 0.2.2 setup is not run. KB_NSIS_INSTDIR overrides $INSTDIR only.
// uninstallOldVersion still follows UninstallString, so that value is removed
// for the duration of the run and the saved registry is imported afterwards.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve('D:\\workspace\\kb-work\\pack-0022-staging-b\\release\\win-unpacked');
const INST = path.resolve(process.env.KB_G2_INSTDIR || 'D:\\workspace\\kb-work\\install-0024\\app-022');
const USERDATA = path.resolve('D:\\workspace\\kb-work\\install-0024\\upgrade-userdata');
const FEED = path.resolve(process.env.KB_G2_FEED || 'D:\\workspace\\kb-work\\feed-0.2.3');
const SETUP_NAME = 'LocalKnowledgeWorkbench-0.2.3-win-x64-setup.exe';
const LOG_DIR = path.resolve('D:\\workspace\\kb-work\\install-0024\\g2');
const STAMP = path.join(LOG_DIR, 'proc-stamp.txt');
const RESULT = path.join(LOG_DIR, 'g2-result.json');
const RUN_LOG = path.join(LOG_DIR, 'g2-run.log');
const PORT = Number(process.env.KB_G2_PORT || 9534);
const OWNER_EXE = 'D:\\example_dev\\LocalKnowledgeWorkbench\\LocalKnowledgeWorkbench.exe';
const OWNER_DB = path.join(process.env.LOCALAPPDATA || '', 'LocalKnowledgeWorkbench', 'workbench.db');
const REG_KEYS = [
  'HKCU\\Software\\173de95e-f638-560d-b657-f1331a82173e',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\173de95e-f638-560d-b657-f1331a82173e',
];

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
function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}
function psEncoded(script, timeoutMs = 20000) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
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
function ownerSnapshot() {
  const exe = versionOf(OWNER_EXE);
  return { exe, db: fileStat(OWNER_DB) };
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
function hideRegisteredUninstall() {
  const key = REG_KEYS[1];
  const removed = [];
  for (const value of ['UninstallString', 'QuietUninstallString']) {
    const r = spawnSync('reg.exe', ['delete', key, '/v', value, '/f'], { encoding: 'utf8', windowsHide: true });
    removed.push({ value, status: r.status, stderr: String(r.stderr || '').trim() });
  }
  const check = spawnSync('reg.exe', ['query', key, '/v', 'UninstallString'], { encoding: 'utf8', windowsHide: true });
  const text = String(check.stdout || '');
  if (check.status === 0 && /UninstallString/i.test(text)) {
    throw new Error('refusing to run installer while UninstallString is still registered');
  }
  if (/example_dev/i.test(text)) throw new Error('refusing to run installer while UninstallString mentions example_dev');
  return removed;
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
function killTree(pid) {
  if (!pid || !ownPids.has(pid)) return { pid, skipped: true };
  const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
  return { pid, status: r.status };
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function loadChromium() {
  const candidates = [path.join(ROOT, 'package.json'), 'D:\\workspace\\kb\\kb-wt-r13-021\\package.json'];
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
  delete env.KB_UPDATE_APPLY;
  return env;
}
function listProcs() {
  const r = psEncoded(`
Get-Process | Where-Object { $_.ProcessName -like 'LocalKnowledgeWorkbench*' } | ForEach-Object {
  $path = $null
  try { $path = $_.Path } catch {}
  if (-not $path) { try { $path = $_.MainModule.FileName } catch {} }
  if ($path) { Write-Output ($_.Id.ToString() + [char]9 + $path) }
}
`, 20000);
  const rows = [];
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const pid = Number(line.slice(0, tab));
    const exe = line.slice(tab + 1).trim();
    if (pid > 0 && exe) rows.push({ pid, exe });
  }
  return rows;
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
async function waitSetupExit(since) {
  const deadline = Date.now() + 10 * 60 * 1000;
  let seen = null;
  while (Date.now() < deadline) {
    const rows = listProcs().filter((row) => row.exe.toLowerCase().endsWith(SETUP_NAME.toLowerCase()) && !/example_dev/i.test(row.exe));
    if (!seen && rows[0]) {
      seen = rows[0];
      log(`setup pid ${seen.pid} ${seen.exe}`);
      const waiter = psEncoded(`
$p = Get-Process -Id ${seen.pid} -ErrorAction SilentlyContinue
if (-not $p) { Write-Output 'GONE'; exit 0 }
if (-not $p.WaitForExit(540000)) { Write-Output 'TIMEOUT'; exit 3 }
Write-Output ('EXIT ' + [string]$p.ExitCode)
`, 560000);
      return { pid: seen.pid, exe: seen.exe, waiterStatus: waiter.status, waiterStdout: String(waiter.stdout || '').trim(), waiterStderr: String(waiter.stderr || '').trim(), ms: Date.now() - since };
    }
    if (seen) break;
    await sleep(200);
  }
  return seen ? { ...seen, missedWait: true, ms: Date.now() - since } : { missing: true, ms: Date.now() - since };
}

if (!INST.startsWith('D:\\workspace\\kb-work\\install-0024\\') || /example_dev/i.test(INST)) {
  console.error('G2 FAIL unsafe install dir');
  process.exit(1);
}

const result = { startedAt: new Date(startedAt).toISOString(), inst: INST, feed: FEED, ok: false, steps: {} };
let regSaved = [];
let shortcuts = [];
let ownerBefore = null;
let child = null;
let browser = null;

try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  ownerBefore = ownerSnapshot();
  result.ownerBefore = ownerBefore;
  regSaved = exportReg(path.join(LOG_DIR, 'reg-before'));
  result.installLocationBefore = queryInstallLocation();
  if (!regSaved.every((item) => item.exists && item.status === 0)) {
    throw new Error('registry export failed; refusing to hide UninstallString');
  }
  result.hiddenUninstall = hideRegisteredUninstall();
  log('hid UninstallString so the installer cannot remove the registered tree');
  shortcuts = shortcutPaths().map((file, index) => copyIfExists(file, path.join(LOG_DIR, 'shortcuts', index + '-' + path.basename(file))));
  const setupPath = path.join(FEED, SETUP_NAME);
  const latest = path.join(FEED, 'latest.yml');
  if (!fs.existsSync(setupPath) || !fs.existsSync(latest)) throw new Error('feed-0.2.3 is incomplete');
  if (!fs.existsSync(path.join(SRC, 'LocalKnowledgeWorkbench.exe'))) throw new Error('0.2.2 win-unpacked missing');
  const copyStarted = Date.now();
  fs.rmSync(INST, { recursive: true, force: true });
  fs.cpSync(SRC, INST, { recursive: true });
  result.steps.copy = { ms: Date.now() - copyStarted };
  const beforeVer = versionOf(path.join(INST, 'LocalKnowledgeWorkbench.exe'));
  result.beforeVersion = beforeVer;
  if (!String(beforeVer.fileVersion || beforeVer.productVersion).startsWith('0.2.2')) throw new Error('copied exe is not 0.2.2: ' + JSON.stringify(beforeVer));
  fs.rmSync(USERDATA, { recursive: true, force: true });
  fs.mkdirSync(USERDATA, { recursive: true });
  fs.rmSync(STAMP, { force: true });
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
  if (!String(about?.version).startsWith('0.2.2')) throw new Error('running version is not 0.2.2');
  if (/example_dev/i.test(String(about?.installDir || ''))) throw new Error('installDir is example_dev');
  if (path.resolve(about.installDir).toLowerCase() !== INST.toLowerCase()) throw new Error('installDir is ' + about.installDir);

  const checkStarted = Date.now();
  page.setDefaultTimeout(600000);
  let snap = await page.evaluate(() => window.kb.updateCheck());
  const checkDeadline = Date.now() + 10 * 60 * 1000;
  while (!(snap && snap.downloaded && snap.available && snap.available.version === '0.2.3')) {
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

  const beforeApply = spawnSync('reg.exe', ['query', REG_KEYS[1], '/v', 'UninstallString'], { encoding: 'utf8', windowsHide: true });
  if (beforeApply.status === 0 && /example_dev/i.test(String(beforeApply.stdout || ''))) {
    throw new Error('UninstallString points at example_dev; refusing apply');
  }
  const installStarted = Date.now();
  const setupWait = waitSetupExit(installStarted);
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
  log('setup ' + JSON.stringify(result.setup));
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

  const versionOk = String(afterVer.fileVersion || afterVer.productVersion).includes('0.2.3') && String(aboutAfter?.version).startsWith('0.2.3');
  const instOk = path.resolve(aboutAfter?.installDir || '').toLowerCase() === INST.toLowerCase() && !/example_dev/i.test(String(aboutAfter?.installDir || ''));
  const setupText = String(result.setup?.waiterStdout || '');
  const setupExplicitFail = /TIMEOUT/.test(setupText) || /EXIT\s+(?!0\b)\d+/.test(setupText);
  result.setupExitText = setupText;
  const problems = [];
  if (!backupOk) problems.push('backup-asar');
  if (!versionOk) problems.push('version');
  if (!instOk) problems.push('install-dir');
  if (!probeOk) problems.push('probe');
  if (setupExplicitFail) problems.push('setup-exit');
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
    result.regRestore = restoreReg(regSaved);
    result.shortcutRestore = shortcuts.map(restoreShortcut);
    result.installLocationAfter = queryInstallLocation();
    result.registryMatches = !!(result.installLocationBefore && result.installLocationAfter
      && result.installLocationBefore.text === result.installLocationAfter.text);
    if (result.installLocationBefore && !result.registryMatches) {
      result.ok = false;
      result.reason = (result.reason ? result.reason + ',' : '') + 'registry-not-restored';
    }
    const ownerAfter = ownerSnapshot();
    result.ownerAfter = ownerAfter;
    const exeSame = ownerBefore && ownerBefore.exe.size === ownerAfter.exe.size
      && ownerBefore.exe.mtimeUtc === ownerAfter.exe.mtimeUtc
      && ownerBefore.exe.fileVersion === ownerAfter.exe.fileVersion;
    result.ownerExeUnchanged = !!exeSame;
    if (ownerBefore && !exeSame) {
      result.ok = false;
      result.reason = (result.reason ? result.reason + ',' : '') + 'user-exe-changed';
    }
  } catch (err) {
    result.ok = false;
    result.restoreError = err instanceof Error ? err.message : String(err);
  }
  result.elapsedMs = Date.now() - startedAt;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(RESULT, JSON.stringify(result, null, 2));
  log(result.ok ? 'G2 PASS' : 'G2 FAIL ' + result.reason);
  log(`elapsedMs=${result.elapsedMs}`);
  flushLog();
  console.log(result.ok ? 'G2 PASS' : 'G2 FAIL');
  process.exit(result.ok ? 0 : 1);
}
