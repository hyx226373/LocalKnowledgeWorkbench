// 打包产物冒烟 + Electron fuses 验证（docs/07 §7）：node e2e/packaged-fuses-smoke.mjs [可执行文件]
// 默认可执行文件：release/linux-unpacked/kb-workbench（npm run dist:linux-dir）。Linux 无 DISPLAY 时用 xvfb-run。
// 打了 fuses 的产物不接受 --inspect / ELECTRON_RUN_AS_NODE，所以不能用 Playwright 控制；这里直接启动进程，
// 以 <数据目录>/startup-trace.json（启动计时）判断应用确实从 asar 启动、打开了 SQLite、worker 扫描完成。
// 1) 正常启动：数据目录预先用开发构建注册一个根 → 打包产物启动后 trace 中有 renderer:interactive 与 deferred:scans-done
// 2) ELECTRON_RUN_AS_NODE=1 exe -e <写文件>：不执行脚本（runAsNode 关闭），而是正常启动应用
// 3) NODE_OPTIONS=--require <写文件的脚本>：脚本不执行（nodeOptions 关闭）
// 4) --inspect=<端口>：端口上没有调试器（nodeCliInspectArguments 关闭）
// 5) fuses 读数：@electron/fuses read
import { _electron as electron } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = path.resolve(process.argv[2] || path.join(ROOT, 'release/linux-unpacked/kb-workbench'));
const SAMPLE = process.env.KB_SAMPLE || '/workspace/kb-sample';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-fuses-'));
const results = [];
const check = (name, ok, detail = '') => (results.push({ name, ok: !!ok, detail }), console.log(`${ok ? '✔' : '✘'} ${name}${detail ? '  — ' + detail : ''}`));

/** 启动打包产物，等 startup-trace.json 出现（或超时），然后结束进程 */
function runPackaged({ userData, env = {}, args = [], timeoutMs = 30000, waitFor = 'deferred:scans-done' }) {
  const trace = path.join(userData, 'startup-trace.json');
  fs.rmSync(trace, { force: true });
  return new Promise((resolve) => {
    const p = spawn(EXE, ['--no-sandbox', '--disable-gpu', ...args], { env: { ...process.env, KB_USER_DATA: userData, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    p.stdout.on('data', (d) => (log += d));
    p.stderr.on('data', (d) => (log += d));
    const t0 = Date.now();
    const iv = setInterval(() => {
      let j = null;
      try {
        j = JSON.parse(fs.readFileSync(trace, 'utf8'));
      } catch {}
      if ((j && j.marks.some((m) => m.name === waitFor)) || Date.now() - t0 > timeoutMs) {
        clearInterval(iv);
        p.kill('SIGTERM');
        const killer = setTimeout(() => p.kill('SIGKILL'), 3000);
        p.once('exit', (code) => (clearTimeout(killer), resolve({ trace: j, log, code, ms: Date.now() - t0 })));
      }
    }, 100);
  });
}

// ---- 预先准备数据目录：开发构建（未打 fuses）注册一个根
const UD = path.join(TMP, 'userdata');
{
  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu'], cwd: ROOT, env: { ...process.env, KB_USER_DATA: UD } });
  const win = await app.firstWindow();
  await win.waitForFunction(() => window.__layoutRestored === true, null, { timeout: 30000 });
  await win.evaluate((p) => window.kb.addRoot(p), SAMPLE);
  await win.waitForFunction(async () => (await window.kb.getIndexStatus()).every((s) => s.state === 'idle' && s.fileCount > 0), null, { timeout: 60000, polling: 300 });
  await app.close();
}

// 1) 正常启动
const r1 = await runPackaged({ userData: UD });
const names = (r1.trace?.marks ?? []).map((m) => m.name);
check('打包产物从 app.asar 启动：打开 SQLite、渲染进程可交互、worker 扫描已注册的根完成', names.includes('main:service-open') && names.includes('renderer:interactive') && names.includes('deferred:scans-done'), JSON.stringify(r1.trace?.summary ?? r1.log.slice(-400)));
const forkErr = /child_process\.fork\(\) is not supported when the runAsNode fuse is disabled/i.test(r1.log);
const localFallback = /@kb 栈启动失败，回退 Local\*/.test(r1.log);
check('打包态无 child_process.fork 报错（r11-E utilityProcess）', !forkErr, r1.log.slice(-500));
check('打包态未静默回退 Local*（@kb 栈应就绪）', !localFallback, r1.log.slice(-500));

// 2) ELECTRON_RUN_AS_NODE
const marker2 = path.join(TMP, 'run-as-node.txt');
const r2 = await runPackaged({ userData: path.join(TMP, 'ud2'), env: { ELECTRON_RUN_AS_NODE: '1' }, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker2)}, 'pwn')`], waitFor: 'renderer:interactive' });
check('runAsNode 关闭：ELECTRON_RUN_AS_NODE=1 不会把产物当 Node 运行（脚本未执行，应用照常启动）', !fs.existsSync(marker2) && !!r2.trace, JSON.stringify({ marker: fs.existsSync(marker2), started: !!r2.trace }));

// 3) NODE_OPTIONS
const evil = path.join(TMP, 'evil.cjs');
const marker3 = path.join(TMP, 'node-options.txt');
fs.writeFileSync(evil, `require('fs').writeFileSync(${JSON.stringify(marker3)}, 'pwn')`);
const r3 = await runPackaged({ userData: path.join(TMP, 'ud3'), env: { NODE_OPTIONS: `--require ${evil}` }, waitFor: 'renderer:interactive' });
check('nodeOptions 关闭：NODE_OPTIONS=--require 的脚本不执行', !fs.existsSync(marker3) && !!r3.trace, JSON.stringify({ marker: fs.existsSync(marker3), started: !!r3.trace }));

// 4) --inspect
const port = 9339;
let listening = null;
const probe = () => new Promise((res) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => (s.destroy(), res(true))); s.once('error', () => res(false)); });
const p4 = runPackaged({ userData: path.join(TMP, 'ud4'), args: [`--inspect=${port}`], waitFor: 'renderer:interactive' });
await new Promise((r) => setTimeout(r, 2500));
listening = await probe();
const r4 = await p4;
check('nodeCliInspectArguments 关闭：--inspect 不开启调试端口', listening === false && !/Debugger listening/.test(r4.log), JSON.stringify({ listening, started: !!r4.trace }));

// 5) fuses 读数
const read = execFileSync(process.execPath, [path.join(ROOT, 'node_modules/@electron/fuses/dist/bin.js'), 'read', '--app', EXE], { encoding: 'utf8' });
const want = { RunAsNode: 'Disabled', EnableCookieEncryption: 'Enabled', EnableNodeOptionsEnvironmentVariable: 'Disabled', EnableNodeCliInspectArguments: 'Disabled', EnableEmbeddedAsarIntegrityValidation: 'Enabled', OnlyLoadAppFromAsar: 'Enabled' };
const bad = Object.entries(want).filter(([k, v]) => !new RegExp(`${k} is ${v}`).test(read));
check('fuses 读数与 package.json build.electronFuses 一致', bad.length === 0, bad.length ? JSON.stringify(bad) : Object.keys(want).join('、'));

const pass = results.filter((r) => r.ok).length;
console.log(`打包冒烟（fuses）：${pass}/${results.length} 通过（${path.relative(ROOT, EXE)}）`);
fs.mkdirSync(path.join(ROOT, 'verify'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'verify', 'packaged-fuses-smoke.json'), JSON.stringify({ exe: path.relative(ROOT, EXE), results }, null, 2));
process.exit(pass === results.length ? 0 : 1);
