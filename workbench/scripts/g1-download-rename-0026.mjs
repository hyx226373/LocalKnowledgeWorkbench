// r14-026-C 隔离下载改名门禁。纯 Node，不启动 Electron，不运行安装包。
// 用仓库里的 esbuild 把 download.ts 打成临时 cjs，再调用 downloadVerified / replaceDestWithPart。
// 缺导出时退出码 2，不算通过。
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = 'D:\\kb-r13-work\\upgrade-0026\\g1';
const DOWNLOAD_DIR = 'D:\\kb-r13-work\\upgrade-0026\\g1-downloads';
const RUN_LOG = path.join(LOG_DIR, 'g1-run.log');
const RESULT = path.join(LOG_DIR, 'g1-result.json');
const ENTRY = path.join(root, 'src', 'shared', 'update', 'download.ts');
const EPERM_RENAME = 'EPERM: operation not permitted, rename';
const NEEDED = ['downloadVerified', 'replaceDestWithPart'];

const logLines = [];
const uncaught = [];

function assertSafe(dir) {
  const resolved = path.resolve(dir);
  if (/study_dev/i.test(resolved)) throw new Error(`拒绝写入 study_dev：${resolved}`);
  return resolved;
}

function pushLog(text) {
  logLines.push(text);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(RUN_LOG, `${text}\n`);
}

function log(line) {
  const text = `[${new Date().toISOString()}] ${line}`;
  pushLog(text);
  process.stdout.write(`${text}\n`);
}

function hookConsole() {
  for (const name of ['log', 'info', 'warn', 'error']) {
    const orig = console[name].bind(console);
    console[name] = (...args) => {
      const text = args.map((item) => {
        if (typeof item === 'string') return item;
        if (item instanceof Error) return item.stack || item.message;
        return String(item);
      }).join(' ');
      pushLog(`[console.${name}] ${text}`);
      orig(...args);
    };
  }
}

function writeResult(result) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(RESULT, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

function finish(code, result) {
  writeResult(result);
  log(`exit ${code} ok=${result.ok === true}`);
  process.exit(code);
}

function bundlePath() {
  const dir = assertSafe(os.tmpdir());
  return path.join(dir, `kb-g1-download-rename-0026-${process.pid}.cjs`);
}

async function loadDownload() {
  const outfile = bundlePath();
  await build({
    absWorkingDir: root,
    entryPoints: [ENTRY],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    logLevel: 'silent',
  });
  try {
    return require(outfile);
  } finally {
    fs.rmSync(outfile, { force: true });
  }
}

function missingExports(mod) {
  return NEEDED.filter((name) => typeof mod?.[name] !== 'function');
}

async function runCase(name, fn, forbidEperm) {
  const started = Date.now();
  const from = logLines.length;
  try {
    await fn();
    const slice = logLines.slice(from).join('\n');
    if (forbidEperm && slice.includes(EPERM_RENAME)) {
      throw new Error('日志出现未捕获的 rename EPERM');
    }
    if (uncaught.length > 0) throw new Error(`有未捕获异常：${uncaught.length}`);
    const ms = Date.now() - started;
    log(`通过 ${name} ${ms}ms`);
    return { name, ok: true, ms };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const error = raw.includes(EPERM_RENAME) ? '日志出现未捕获的 rename EPERM' : raw;
    const ms = Date.now() - started;
    log(`失败 ${name} ${ms}ms：${error}`);
    return { name, ok: false, ms, error };
  }
}

async function caseOverwrite(downloadVerified) {
  const source = path.join(DOWNLOAD_DIR, 'case1-source.bin');
  const dest = path.join(DOWNLOAD_DIR, 'case1-dest.bin');
  const part = `${dest}.part`;
  const sourceBytes = Buffer.alloc(64 * 1024, 0x5a);
  sourceBytes.write('g1-source-0026', 0, 'utf8');
  const oldDest = Buffer.from('g1-dest-old-not-source');
  fs.writeFileSync(source, sourceBytes);
  fs.writeFileSync(dest, oldDest);
  if (sourceBytes.equals(fs.readFileSync(dest))) throw new Error('预写 dest 与源相同，用例无效');
  await fs.promises.rm(part, { force: true }).catch(() => undefined);
  log('case1 已预写同名 dest，内容与源不同');
  await downloadVerified({
    source,
    dest,
    expectedSha512: createHash('sha512').update(sourceBytes).digest('base64'),
    expectedSize: sourceBytes.length,
    rateLimitBytesPerSec: null,
    onProgress() {},
  });
  const got = fs.readFileSync(dest);
  if (!got.equals(sourceBytes)) throw new Error(`dest 与源不一致：${got.length} 字节`);
  if (fs.existsSync(part)) throw new Error('成功后仍有 .part');
  log('case1 dest 与源字节一致，没有 .part');
}

function holdNoShareDelete(file) {
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Node 24 的 fs.openSync 带 FILE_SHARE_DELETE，单独打开时 rm 仍会成功。
  // 这个句柄只共享读取，不共享删除，rm/rename 才会失败。
  const command = [
    "$ErrorActionPreference = 'Stop'",
    '$p = $env:KB_G1_HOLD',
    "$s = [System.IO.File]::Open($p, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)",
    "[Console]::Out.WriteLine('HELD')",
    '[Console]::Out.Flush()',
    '$null = [Console]::In.ReadLine()',
    '$s.Dispose()',
  ].join('; ');
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ['-NoProfile', '-Command', command], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, KB_G1_HOLD: file },
    });
    const stderr = [];
    let out = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('占住 dest 超时'));
    }, 15000);
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
      if (settled || !out.includes('HELD')) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        async release() {
          try {
            child.stdin.write('release\n');
            child.stdin.end();
          } catch { /* 句柄已结束 */ }
          await new Promise((done) => {
            const wait = setTimeout(done, 5000);
            child.once('exit', () => {
              clearTimeout(wait);
              done();
            });
          });
        },
      });
    });
    child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`占住 dest 失败，退出 ${code}：${stderr.join('') || out}`));
    });
  });
}

async function caseLocked(replaceDestWithPart) {
  if (process.platform !== 'win32') throw new Error('占用 dest 用例只在 Windows 上跑');
  const dest = path.join(DOWNLOAD_DIR, 'case2-dest.bin');
  const part = `${dest}.part`;
  fs.writeFileSync(dest, 'occupied-dest');
  fs.writeFileSync(part, 'occupied-part');
  let fd = null;
  let hold = null;
  try {
    fd = fs.openSync(dest, 'r');
    hold = await holdNoShareDelete(dest);
    log('case2 已用 fs.openSync 占住 dest，且不共享删除');
    let thrown = null;
    try {
      await replaceDestWithPart(part, dest);
    } catch (err) {
      thrown = err;
    }
    const message = thrown ? String(thrown.message || thrown) : '';
    if (!thrown) throw new Error('占用 dest 时应当抛出安装包改名失败，但调用成功返回');
    if (!message.includes('安装包改名失败')) throw new Error(`错误文案不含安装包改名失败：${message}`);
    if (fs.existsSync(part)) throw new Error('失败后 part 仍在');
    log(`case2 预期内失败，part 已删除：${message}`);
  } finally {
    if (hold) await hold.release();
    if (fd != null) {
      try { fs.closeSync(fd); } catch { /* 句柄已关 */ }
    }
  }
}

async function main() {
  hookConsole();
  process.on('uncaughtException', (err) => {
    uncaught.push(err);
    pushLog(`[uncaught] ${err && (err.stack || err.message) || err}`);
  });
  process.on('unhandledRejection', (err) => {
    uncaught.push(err);
    const text = err instanceof Error ? err.stack || err.message : String(err);
    pushLog(`[unhandledRejection] ${text}`);
  });
  assertSafe(LOG_DIR);
  assertSafe(DOWNLOAD_DIR);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  fs.writeFileSync(RUN_LOG, '');
  log(`g1 download rename gate root=${root}`);
  const mod = await loadDownload();
  const missing = missingExports(mod);
  const kinds = NEEDED.map((name) => `${name}=${typeof mod?.[name]}`).join(' ');
  log(`已打包 ${ENTRY}。${kinds}`);
  if (missing.length > 0) {
    const reason = `缺少导出：${missing.join('、')}。当前基线还没有 A 的下载改名，缺导出不算通过。`;
    log(reason);
    finish(2, { ok: false, reason, missing, cases: [] });
  }
  const cases = [];
  cases.push(await runCase('预先同名 dest 下载后与源一致', () => caseOverwrite(mod.downloadVerified), true));
  cases.push(await runCase('占用 dest 改名失败且删除 part', () => caseLocked(mod.replaceDestWithPart), false));
  const leaked = uncaught.some((err) => String(err && (err.stack || err.message) || err).includes(EPERM_RENAME));
  if (leaked) log('失败：有未捕获的 rename EPERM');
  const ok = cases.every((item) => item.ok) && uncaught.length === 0 && !leaked;
  finish(ok ? 0 : 1, { ok, cases });
}

main().catch((err) => {
  const reason = err instanceof Error ? err.stack || err.message : String(err);
  try { log(reason); } catch { process.stderr.write(`${reason}\n`); }
  try { writeResult({ ok: false, reason, cases: [] }); } catch { /* 结果写失败仍以退出码为准 */ }
  process.exit(1);
});
