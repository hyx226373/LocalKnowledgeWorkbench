// Proves the installer probe script stays inside 4 seconds and does not name CIM/WMI.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nsh = path.join(root, 'build', 'installer.nsh');
const ps1 = path.join(root, 'build', 'kb-proc-check.ps1');
const outDir = 'D:\\kb-r13-work\\install-0024';
const logPath = path.join(outDir, 'verify-proc-check.txt');
const forbidden = ['Get-CimInstance', 'Get-WmiObject', 'wmic', 'Win32_Process'];
const lines = [];
let failed = false;

function say(line) {
  lines.push(line);
  console.log(line);
}
function fail(line) {
  failed = true;
  say('FAIL ' + line);
}
function pass(line) {
  say('PASS ' + line);
}

fs.mkdirSync(outDir, { recursive: true });

const nshText = fs.readFileSync(nsh, 'utf8');
const psText = fs.readFileSync(ps1, 'utf8');
for (const word of forbidden) {
  if (nshText.includes(word)) fail(`installer.nsh contains ${word}`);
  else pass(`installer.nsh has no ${word}`);
  if (psText.includes(word)) fail(`kb-proc-check.ps1 contains ${word}`);
  else pass(`kb-proc-check.ps1 has no ${word}`);
}
if (!nshText.includes('!macro customCheckAppRunning')) fail('missing customCheckAppRunning');
else pass('customCheckAppRunning is defined');
if (!nshText.includes('process check timed out, assume not running')) fail('missing timeout detail text');
else pass('timeout detail text present');
if (!psText.includes('WaitForExit')) fail('ps1 has no WaitForExit');
else pass('ps1 waits with a timeout');
if (!psText.includes('$BudgetMs = 4000')) fail('budget is not 4000 ms');
else pass('budget is 4000 ms');

function runPs(file, env, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file],
      { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: null, ms: Date.now() - started, stdout, stderr, killed: true });
    }, timeoutMs);
    child.stdout.on('data', (buf) => { stdout += buf.toString('utf8'); });
    child.stderr.on('data', (buf) => { stderr += buf.toString('utf8'); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, ms: Date.now() - started, stdout, stderr, killed: false });
    });
  });
}

const stamp = path.join(outDir, 'verify-stamp.txt');
fs.rmSync(stamp, { force: true });
const env = { ...process.env, KB_PROC_INSTDIR: 'C:\\__kb_no_such_dir__', KB_PROC_MODE: 'check', KB_PROC_STAMP: stamp };
delete env.ELECTRON_RUN_AS_NODE;
const probe = await runPs(ps1, env, 8000);
say(`probe code=${probe.code} ms=${probe.ms} killed=${probe.killed}`);
if (probe.stderr.trim()) say('probe stderr ' + probe.stderr.trim().slice(0, 400));
if (probe.killed || probe.ms >= 6000) fail(`probe wall clock ${probe.ms}ms`);
else pass(`probe finished in ${probe.ms}ms`);
if (probe.code !== 11 && probe.code !== 2) fail(`probe exit ${probe.code}, want 11 or 2`);
else pass(`probe exit ${probe.code}`);
const stampText = fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8') : '';
say('stamp:\n' + stampText.trim());
if (!/start /.test(stampText) || !/end /.test(stampText)) fail('stamp missing start/end');
else pass('stamp has start and end');

const sleepFile = path.join(outDir, 'verify-sleep.ps1');
fs.writeFileSync(sleepFile, [
  '$ErrorActionPreference = "Stop"',
  '$ps = Join-Path $env:SystemRoot "System32\\WindowsPowerShell\\v1.0\\powershell.exe"',
  '$child = Start-Process -FilePath $ps -ArgumentList @("-NoProfile","-Command","Start-Sleep -Seconds 30") -PassThru -WindowStyle Hidden',
  '$done = $child.WaitForExit(4000)',
  'if (-not $done) {',
  '  Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue',
  '  exit 2',
  '}',
  'exit 0',
  '',
].join('\r\n'), 'ascii');
const timed = await runPs(sleepFile, process.env, 8000);
say(`timeout-wrapper code=${timed.code} ms=${timed.ms} killed=${timed.killed}`);
if (timed.killed || timed.ms >= 6000) fail(`timeout wrapper wall clock ${timed.ms}ms`);
else pass(`timeout wrapper finished in ${timed.ms}ms`);
if (timed.code !== 2) fail(`timeout wrapper exit ${timed.code}, want 2`);
else pass('timeout wrapper exit 2');

const liveFile = path.join(outDir, 'verify-live.ps1');
fs.writeFileSync(liveFile, [
  '$ErrorActionPreference = "SilentlyContinue"',
  '$procs = @(Get-Process -Name "LocalKnowledgeWorkbench")',
  'foreach ($proc in $procs) {',
  '  $path = $null',
  '  try { $path = $proc.Path } catch {}',
  '  if (-not $path) { try { $path = $proc.MainModule.FileName } catch {} }',
  '  if ($path) { Write-Output $path }',
  '}',
  'exit 0',
  '',
].join('\r\n'), 'ascii');
const live = await runPs(liveFile, process.env, 8000);
const livePaths = live.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
say(`live processes ${livePaths.length} in ${live.ms}ms`);
if (livePaths.length === 0) {
  pass('no LocalKnowledgeWorkbench process; positive path match skipped');
} else {
  const hit = livePaths[0];
  const dir = path.dirname(hit);
  const hitStamp = path.join(outDir, 'verify-live-stamp.txt');
  fs.rmSync(hitStamp, { force: true });
  const hitRun = await runPs(ps1, { ...env, KB_PROC_INSTDIR: dir, KB_PROC_MODE: 'check', KB_PROC_STAMP: hitStamp }, 8000);
  say(`live-dir code=${hitRun.code} ms=${hitRun.ms} dir=${dir}`);
  if (hitRun.code !== 10) fail(`expected exit 10 for ${dir}, got ${hitRun.code}`);
  else pass('path prefix match exit 10');
  const miss = await runPs(ps1, { ...env, KB_PROC_INSTDIR: 'C:\\__kb_no_such_dir__', KB_PROC_MODE: 'check', KB_PROC_STAMP: path.join(outDir, 'verify-miss-stamp.txt') }, 8000);
  say(`other-dir code=${miss.code} ms=${miss.ms}`);
  if (miss.code !== 11 && miss.code !== 2) fail(`other dir exit ${miss.code}`);
  else pass('other directory is not treated as running');
}

say(failed ? 'VERIFY FAIL' : 'VERIFY PASS');
fs.writeFileSync(logPath, lines.join('\n') + '\n', 'utf8');
process.exit(failed ? 1 : 0);
