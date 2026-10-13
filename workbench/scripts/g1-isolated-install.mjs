// G1: silent install of 0.2.3 into an isolated directory while WMI stays hung.
// Does not install to D:\study_dev. Restores registry and shortcuts afterwards.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const INST = path.resolve(process.env.KB_G1_INSTDIR || 'D:\\kb-r13-work\\install-0024\\app');
const SETUP = path.resolve(process.env.KB_G1_SETUP || 'D:\\kb-r13-work\\feed-0.2.3\\LocalKnowledgeWorkbench-0.2.3-win-x64-setup.exe');
const LOG_DIR = path.resolve('D:\\kb-r13-work\\install-0024\\g1');
const STAMP = path.join(LOG_DIR, 'proc-stamp.txt');
const INSTALL_LOG = path.join(LOG_DIR, 'g1-install.log');
const RUN_LOG = path.join(LOG_DIR, 'g1-run.log');
const RESULT = path.join(LOG_DIR, 'g1-result.json');
const AMY_EXE = 'D:\\study_dev\\LocalKnowledgeWorkbench\\LocalKnowledgeWorkbench.exe';
const AMY_DB = path.join(process.env.LOCALAPPDATA || '', 'LocalKnowledgeWorkbench', 'workbench.db');
const REG_KEYS = [
  'HKCU\\Software\\173de95e-f638-560d-b657-f1331a82173e',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\173de95e-f638-560d-b657-f1331a82173e',
];
const EXPECTED_INST = path.resolve('D:\\kb-r13-work\\install-0024\\app');

const startedAt = Date.now();
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

function assertSafeInst() {
  if (path.resolve(INST) !== EXPECTED_INST) throw new Error('install dir is not the isolated app path');
  if (/study_dev/i.test(INST)) throw new Error('install dir contains study_dev');
}

function psEncoded(script, timeoutMs) {
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
  if (!fs.existsSync(file)) return null;
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function versionOf(file) {
  if (!fs.existsSync(file)) return { exists: false };
  const script = `
$p = ${psQuote(file)}
$i = Get-Item -LiteralPath $p
$v = $i.VersionInfo
Write-Output ($i.Length.ToString())
Write-Output ($i.LastWriteTimeUtc.ToString('o'))
Write-Output ([string]$v.FileVersion)
Write-Output ([string]$v.ProductVersion)
`;
  const r = psEncoded(script, 20000);
  const rows = String(r.stdout || '').split(/\r?\n/).map((line) => line.trim());
  return {
    exists: true,
    size: Number(rows[0]),
    mtimeUtc: rows[1] || '',
    fileVersion: rows[2] || '',
    productVersion: rows[3] || '',
    status: r.status,
    stderr: String(r.stderr || '').trim(),
  };
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function amySnapshot(withHash) {
  const exe = versionOf(AMY_EXE);
  if (withHash && exe.exists) exe.sha256 = sha256(AMY_EXE);
  return { exe, db: fileStat(AMY_DB) };
}

function desktopDir() {
  const r = psEncoded("[Environment]::GetFolderPath('Desktop')", 15000);
  const dir = String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
  return dir || path.join(os.homedir(), 'Desktop');
}

function shortcutPaths() {
  const names = ['本地知识工作台.lnk'];
  const dirs = [desktopDir(), path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs')];
  const files = [];
  for (const dir of dirs) {
    for (const name of names) files.push(path.join(dir, name));
  }
  return files;
}

function exportReg(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const saved = [];
  for (const key of REG_KEYS) {
    const file = path.join(dir, key.replace(/[\\:]/g, '_') + '.reg');
    const r = spawnSync('reg.exe', ['export', key, file, '/y'], { encoding: 'utf8', windowsHide: true });
    saved.push({ key, file, status: r.status, stderr: String(r.stderr || '').trim(), exists: fs.existsSync(file) });
  }
  return saved;
}

function queryInstallLocation() {
  const r = spawnSync('reg.exe', ['query', REG_KEYS[0], '/v', 'InstallLocation'], { encoding: 'utf8', windowsHide: true });
  return { status: r.status, text: String(r.stdout || '').trim() };
}

// uninstallOldVersion reads UninstallString, then InstallLocation. KB_NSIS_INSTDIR
// only overrides $INSTDIR, so a live UninstallString still uninstalls Amy's tree.
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
  if (/study_dev/i.test(text)) throw new Error('refusing to run installer while UninstallString mentions study_dev');
  return removed;
}

function restoreReg(saved) {
  const restored = [];
  for (const item of saved) {
    if (!item.exists) {
      restored.push({ ...item, importStatus: null, skipped: true });
      continue;
    }
    const r = spawnSync('reg.exe', ['import', item.file], { encoding: 'utf8', windowsHide: true });
    restored.push({ key: item.key, importStatus: r.status, stderr: String(r.stderr || '').trim() });
  }
  return restored;
}

function copyIfExists(file, dest) {
  if (!fs.existsSync(file)) return { file, existed: false };
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(file, dest);
  return { file, existed: true, dest, size: fs.statSync(file).size };
}

function restoreFile(snap) {
  if (!snap.existed) {
    if (fs.existsSync(snap.file)) fs.rmSync(snap.file, { force: true });
    return { file: snap.file, action: 'removed-new' };
  }
  fs.copyFileSync(snap.dest, snap.file);
  return { file: snap.file, action: 'restored' };
}

function killTree(pid) {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
}

function parseStamp(text) {
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const start = line.match(/^start (\S+) mode (\S+)/);
    const end = line.match(/^end (\S+) exit (\d+)/);
    if (start) events.push({ kind: 'start', at: Date.parse(start[1]), mode: start[2], raw: line });
    else if (end) events.push({ kind: 'end', at: Date.parse(end[1]), code: Number(end[2]), raw: line });
  }
  const pairs = [];
  let open = null;
  for (const event of events) {
    if (event.kind === 'start') open = event;
    else if (event.kind === 'end' && open) {
      pairs.push({ mode: open.mode, ms: event.at - open.at, code: event.code, start: open.raw, end: event.raw });
      open = null;
    }
  }
  return { events, pairs };
}

function wmiHung() {
  const child = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'Get-CimInstance -ClassName Win32_Process | Select-Object -First 1 -ExpandProperty ProcessId'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (buf) => { stdout += buf.toString('utf8'); });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      killTree(child.pid);
      resolve({ hung: true, stdout: stdout.trim() });
    }, 8000);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve({ hung: false, stdout: stdout.trim() });
    });
  });
}

const result = {
  startedAt: new Date(startedAt).toISOString(),
  inst: INST,
  setup: SETUP,
  ok: false,
  reason: '',
};
let regSaved = [];
let shortcuts = [];
let amyBefore = null;

try {
  assertSafeInst();
  fs.mkdirSync(LOG_DIR, { recursive: true });
  amyBefore = amySnapshot(true);
  result.amyBefore = amyBefore;
  fs.writeFileSync(path.join(LOG_DIR, 'amy-before.json'), JSON.stringify(amyBefore, null, 2));
  regSaved = exportReg(path.join(LOG_DIR, 'reg-before'));
  result.regBefore = regSaved;
  result.installLocationBefore = queryInstallLocation();
  shortcuts = shortcutPaths().map((file) => copyIfExists(file, path.join(LOG_DIR, 'shortcuts', path.basename(path.dirname(file)) + '-' + path.basename(file))));
  result.shortcutsBefore = shortcuts;
  flushLog();

  if (!fs.existsSync(SETUP)) {
    result.reason = 'setup-missing';
    throw new Error('setup missing: ' + SETUP);
  }
  log('wmi probe start');
  const wmiStarted = Date.now();
  const wmi = await wmiHung();
  result.wmi = { ...wmi, ms: Date.now() - wmiStarted };
  log(`wmi hung=${wmi.hung} ms=${result.wmi.ms}`);
  if (!wmi.hung) {
    result.reason = 'wmi-not-hung';
    throw new Error('WMI returned within 8 seconds');
  }

  fs.rmSync(INST, { recursive: true, force: true });
  fs.mkdirSync(INST, { recursive: true });
  fs.rmSync(STAMP, { force: true });
  fs.rmSync(INSTALL_LOG, { force: true });
  if (!regSaved.every((item) => item.exists && item.status === 0)) {
    throw new Error('registry export failed; refusing to hide UninstallString');
  }
  result.hiddenUninstall = hideRegisteredUninstall();
  log('hid UninstallString so the installer cannot remove the registered tree');
  const env = { ...process.env, KB_NSIS_INSTDIR: INST, KB_PROC_STAMP: STAMP };
  delete env.ELECTRON_RUN_AS_NODE;
  const installStarted = Date.now();
  log('setup spawn');
  const child = spawn(SETUP, ['/S', '/LOG=' + INSTALL_LOG, '/D=' + INST], { env, windowsHide: true, stdio: 'ignore' });
  result.setupPid = child.pid;
  const install = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ code: null, timedOut: true }), 10 * 60 * 1000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut: false });
    });
  });
  result.installMs = Date.now() - installStarted;
  result.setupExit = install.code;
  result.setupTimedOut = install.timedOut;
  if (install.timedOut) killTree(child.pid);
  log(`setup exit=${install.code} ms=${result.installMs} timeout=${install.timedOut}`);

  const stampText = fs.existsSync(STAMP) ? fs.readFileSync(STAMP, 'utf8') : '';
  const installLog = fs.existsSync(INSTALL_LOG) ? fs.readFileSync(INSTALL_LOG, 'utf8') : '';
  fs.writeFileSync(path.join(LOG_DIR, 'proc-stamp.txt'), stampText, 'utf8');
  result.stamp = parseStamp(stampText);
  result.stampPath = STAMP;
  result.installLogPath = INSTALL_LOG;
  result.installLogBytes = Buffer.byteLength(installLog);
  const firstEnd = result.stamp.pairs[0];
  const reachedMs = firstEnd ? firstEnd.ms : null;
  result.probeMs = reachedMs;
  const customEvidence = /kb-proc:|process check timed out, assume not running/.test(installLog) || result.stamp.pairs.length > 0;
  result.customEvidence = customEvidence;
  const exe = path.join(INST, 'LocalKnowledgeWorkbench.exe');
  result.installed = versionOf(exe);
  const versionOk = /0\.2\.3/.test(result.installed.fileVersion || '') || /0\.2\.3/.test(result.installed.productVersion || '');
  const probesOk = result.stamp.pairs.length > 0
    && result.stamp.pairs.every((pair) => Number.isFinite(pair.ms) && pair.ms <= 5000)
    && result.stamp.pairs.every((pair) => pair.code === 11 || pair.code === 2);
  const stampSoon = firstEnd != null;
  const problems = [];
  if (install.timedOut || install.code !== 0) problems.push('setup-exit');
  if (!probesOk) problems.push('probe-time');
  if (!stampSoon) problems.push('probe-missing');
  if (!versionOk) problems.push('version');
  if (!customEvidence) problems.push('custom-evidence');
  if (!result.installed.exists) problems.push('exe-missing');
  result.problems = problems;
  result.ok = problems.length === 0;
  result.reason = result.ok ? 'pass' : problems.join(',');
} catch (err) {
  result.ok = false;
  result.reason = result.reason || (err instanceof Error ? err.message : String(err));
  result.error = err instanceof Error ? err.stack || err.message : String(err);
  log('ERROR ' + result.reason);
} finally {
  try {
    result.regRestore = restoreReg(regSaved);
    result.shortcutRestore = shortcuts.map(restoreFile);
    result.installLocationAfter = queryInstallLocation();
    result.registryMatches = result.installLocationBefore && result.installLocationAfter
      && result.installLocationBefore.text === result.installLocationAfter.text;
    if (result.installLocationBefore && !result.registryMatches) {
      result.ok = false;
      result.reason = (result.reason ? result.reason + ',' : '') + 'registry-not-restored';
    }
    const amyAfter = amySnapshot(true);
    result.amyAfter = amyAfter;
    const exeSame = JSON.stringify({
      size: amyBefore?.exe?.size, mtime: amyBefore?.exe?.mtimeUtc, file: amyBefore?.exe?.fileVersion, sha: amyBefore?.exe?.sha256,
    }) === JSON.stringify({
      size: amyAfter.exe?.size, mtime: amyAfter.exe?.mtimeUtc, file: amyAfter.exe?.fileVersion, sha: amyAfter.exe?.sha256,
    });
    result.amyExeUnchanged = exeSame;
    result.amyDb = { before: amyBefore?.db, after: amyAfter.db };
    if (!exeSame) {
      result.ok = false;
      result.reason = (result.reason ? result.reason + ',' : '') + 'amy-exe-changed';
    }
  } catch (err) {
    result.ok = false;
    result.restoreError = err instanceof Error ? err.message : String(err);
  }
  result.elapsedMs = Date.now() - startedAt;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(RESULT, JSON.stringify(result, null, 2));
  log(result.ok ? 'G1 PASS' : 'G1 FAIL ' + result.reason);
  log(`elapsedMs=${result.elapsedMs}`);
  flushLog();
  console.log(result.ok ? 'G1 PASS' : 'G1 FAIL');
  process.exit(result.ok ? 0 : 1);
}
