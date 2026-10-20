// A1 发版门禁。用隔离的数据目录冷启动，正文索引结束后读 startup-trace.json。
// 超阈值时退出码 1，并打印最慢的主进程 / 渲染进程调用。
// 不碰 用户的已安装进程，不把日志写进资料根目录。
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = 'D:/workspace/kb-work';
const SRC = 'D:/kb-backup-0011/local';
const USERDATA = path.join(WORK, 'userdata-accept');
const ELECTRON = path.join(ROOT, 'node_modules/electron/dist/electron.exe');

const INTERACTIVE_MS = 2000;
const LOOP_P99_MS = 100;
const OP_P95_MS = 200;
const RUNS = Number(process.env.KB_PERF_RUNS || 5);

function envFor(extra = {}) {
  const env = {
    ...process.env,
    ...extra,
    KB_USER_DATA: USERDATA,
    KB_STARTUP_TRACE: '1',
    KB_PERF_BOUNDS: '1',
    KB_STALL_LOG: path.join(WORK, 'stall.log'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;
  return env;
}

const PDF_DIR = path.join(WORK, 'pdf-fixture');
const DELETE_DIR = path.join(WORK, 'delete-root-0014');

function writeTinyPdf(file) {
  const text = `%PDF-1.1
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 12 Tf 20 100 Td (kb perf pdf) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF
`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function prepareFixtures() {
  writeTinyPdf(path.join(PDF_DIR, 'perf.pdf'));
  fs.rmSync(DELETE_DIR, { recursive: true, force: true });
  fs.mkdirSync(DELETE_DIR, { recursive: true });
  fs.writeFileSync(path.join(DELETE_DIR, 'note.txt'), 'delete-root probe\n');
}

function copyLibrary() {
  if (!fs.existsSync(path.join(SRC, 'workbench.db'))) throw new Error('缺少隔离库 ' + SRC);
  fs.rmSync(USERDATA, { recursive: true, force: true });
  fs.cpSync(SRC, USERDATA, { recursive: true });
  for (const name of ['instance.lock', 'child-pids.json', 'startup-trace.json']) {
    fs.rmSync(path.join(USERDATA, name), { force: true });
  }
}

function waitTrace(timeoutMs, appearMs = 90000) {
  const file = path.join(USERDATA, 'startup-trace.json');
  const started = Date.now();
  let seen = false;
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      try {
        const json = JSON.parse(fs.readFileSync(file, 'utf8'));
        seen = true;
        if (json.runtime && json.runtime.contentIndexDone === true) {
          if (process.env.KB_CPU_PROF) {
            const prof = fs.readdirSync(WORK).find((name) => {
              if (!/^main\.cpuprofile\.\d+(\.err)?$/.test(name)) return false;
              return fs.statSync(path.join(WORK, name)).mtimeMs >= started;
            });
            if (!prof) return;
          }
          clearInterval(timer);
          resolve(json);
          return;
        }
      } catch {
        /* 文件还没写完 */
      }
      if (!seen && Date.now() - started > appearMs) {
        clearInterval(timer);
        reject(new Error('启动轨迹没有出现'));
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('等待正文索引结束超时'));
      }
    }, 400);
  });
}

function percentile(values, q) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((q / 100) * sorted.length) - 1))];
}

function topCalls(calls) {
  const ranked = [...calls].sort((a, b) => b.ms - a.ms).slice(0, 10);
  return ranked;
}

async function waitForDebug(port) {
  const started = Date.now();
  while (Date.now() - started < 20000) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch { /* 端口还没开 */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('调试端口没有打开');
}

async function deleteRegisteredRoot(page) {
  const started = Date.now();
  const added = await page.evaluate(async (dir) => {
    const roots = await window.kb.listRoots();
    const hit = roots.find((r) => String(r.path || '').replace(/\\/g, '/').toLowerCase().includes('delete-root-0014'));
    if (hit) return hit;
    return window.kb.addRoot(dir, 'perf-delete');
  }, DELETE_DIR.replace(/\\/g, '/'));
  await new Promise((resolve) => setTimeout(resolve, 800));
  const removed = await Promise.race([
    fs.promises.rm(DELETE_DIR, { recursive: true, force: true }).then(() => ({ ok: true })).catch((err) => ({ ok: false, error: String(err && err.message ? err.message : err) })),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: '删除超过 8 秒' }), 8000)),
  ]);
  const gone = !fs.existsSync(DELETE_DIR);
  const alive = await page.evaluate(async () => {
    const t = performance.now();
    const roots = await window.kb.listRoots();
    return { ms: Math.round(performance.now() - t), n: roots.length };
  });
  return { ms: Date.now() - started, added: added && (added.id || added.name || true), removed, gone, alive };
}

function appHangsSince(since, pid) {
  const command = `$start = [DateTimeOffset]::FromUnixTimeMilliseconds(${since.getTime()}).LocalDateTime; Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Application Hang'; StartTime=$start} -ErrorAction SilentlyContinue | Where-Object { $_.Message -match '(^|\\D)${pid}(\\D|$)' -and $_.Message -match 'kb-wt-r13-021' } | ForEach-Object { [pscustomobject]@{ TimeCreated = $_.TimeCreated.ToString('o'); Id = $_.Id; Message = $_.Message.Substring(0, [Math]::Min(400, $_.Message.Length)) } } | ConvertTo-Json -Compress`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 20000 }, (err, stdout) => {
      if (err && !stdout) {
        resolve({ error: String(err.message || err), events: [] });
        return;
      }
      const text = String(stdout || '').trim();
      if (!text) {
        resolve({ events: [] });
        return;
      }
      try {
        const parsed = JSON.parse(text);
        resolve({ events: Array.isArray(parsed) ? parsed : [parsed] });
      } catch {
        resolve({ error: '事件日志不是 JSON', raw: text.slice(0, 500), events: [] });
      }
    });
  });
}

async function soakAndHangs(page, pid) {
  const started = new Date();
  const samples = [];
  const until = Date.now() + 10 * 60 * 1000;
  while (Date.now() < until) {
    const sample = await page.evaluate(async () => {
      const t = performance.now();
      const roots = await window.kb.listRoots();
      const big = roots.find((r) => r.name === '专业课') ?? roots[0];
      if (big) await window.kb.listDir(big.id, '');
      await window.kb.search('总结');
      return Math.round(performance.now() - t);
    });
    samples.push(sample);
    console.log(`[perf] 连续操作 ${samples.length} 次 ${sample} ms`);
    const left = until - Date.now();
    if (left <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(20000, left)));
  }
  const hangs = await appHangsSince(started, pid);
  return { pid, minutes: 10, samples: samples.length, maxMs: samples.reduce((n, v) => Math.max(n, v), 0), hangs };
}

async function dragPanel(page) {
  const handles = page.locator('.dv-sash');
  const n = await handles.count();
  for (let i = 0; i < n; i += 1) {
    const sash = handles.nth(i);
    const box = await sash.boundingBox().catch(() => null);
    if (!box || box.width < 1 || box.height < 1) continue;
    const vertical = box.height >= box.width;
    const x = box.x + box.width / 2;
    const y = box.y + Math.min(Math.max(box.height / 2, 4), Math.max(box.height - 2, 4));
    const started = Date.now();
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + (vertical ? 64 : 0), y + (vertical ? 0 : 64), { steps: 8 });
    await page.mouse.up();
    const after = await sash.boundingBox().catch(() => null);
    const moved = !!after && (Math.abs(after.x - box.x) > 4 || Math.abs(after.y - box.y) > 4);
    if (moved) return { ms: Date.now() - started, moved: true, kind: vertical ? 'sash-v' : 'sash-h' };
  }
  return { ms: 0, moved: false, kind: 'sash', count: n };
}

async function moveWindow(page) {
  const started = performance.now();
  const result = await page.evaluate(async () => {
    if (typeof window.kb.perfBounds !== 'function') return null;
    return window.kb.perfBounds();
  });
  return { ms: Math.round(performance.now() - started), bounds: result };
}

async function interactiveRun() {
  const calls = [];
  const port = 9477;
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${port}`, '--no-sandbox', '--disable-gpu'], {
    cwd: ROOT,
    env: envFor(process.env.KB_CPU_PROF ? { KB_CPU_PROF: process.env.KB_CPU_PROF } : {}),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logFile = path.join(WORK, 'perf-child-stderr.txt');
  child.stdout.on('data', (buf) => fs.appendFileSync(logFile, buf));
  child.stderr.on('data', (buf) => fs.appendFileSync(logFile, buf));
  let browser;
  try {
    await waitForDebug(port);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = browser.contexts()[0]?.pages()[0] ?? await browser.contexts()[0].waitForEvent('page');
    await page.waitForFunction(() => window.__layoutRestored === true, null, { timeout: 30000 });
    console.log('[perf] 布局已恢复，开始测拖动和打开');
    const drag = await moveWindow(page);
    calls.push({ side: 'renderer', name: 'window-drag', ms: drag.ms });
    const panel = await dragPanel(page);
    calls.push({ side: 'renderer', name: 'panel-drag', ms: panel.ms });
  const timed = await page.evaluate(async () => {
    const samples = [];
    const time = async (name, fn) => {
      const t = performance.now();
      await fn();
      samples.push({ side: 'renderer', name, ms: Math.round(performance.now() - t) });
    };
    const pdfDir = 'D:/workspace/kb-work/pdf-fixture';
    const havePdf = (await window.kb.listRoots()).some((r) => String(r.path || '').replace(/\\/g, '/').toLowerCase().includes('pdf-fixture'));
    if (!havePdf) await window.kb.addRoot(pdfDir, 'perf-pdf');
    const roots = await window.kb.listRoots();
    const big = roots.find((r) => r.name === '专业课') ?? roots[0];
    let md = null;
    let pdf = null;
    const queue = roots.map((r) => ({ rootId: r.id, rel: '' }));
    let walks = 0;
    while (queue.length && (!md || !pdf) && walks < 30) {
      walks += 1;
      const cur = queue.shift();
      const entries = await window.kb.listDir(cur.rootId, cur.rel);
      for (const entry of entries) {
        if (!md && entry.ext === 'md') md = { rootId: entry.rootId, rel: entry.relPath };
        if (!pdf && entry.ext === 'pdf') pdf = { rootId: entry.rootId, rel: entry.relPath };
        if (entry.kind === 'dir' && cur.rel.split('/').length < 2) queue.push({ rootId: entry.rootId, rel: entry.relPath });
      }
    }
    if (big) await time('listDir:专业课', () => window.kb.listDir(big.id, ''));
    await time('search', () => window.kb.search('总结'));
    const workspaces = await window.kb.listWorkspaces();
    const current = window.__kb.currentWorkspaceId();
    const other = workspaces.find((w) => w.id !== current);
    if (other) await time('switch-workspace', () => window.__kb.switchTo(other.id));
    if (md) await time('open-md', () => window.__kb.openByPath(md.rootId, md.rel, 'tab'));
    const loadsBefore = window.__kbPdfLoads ?? 0;
    if (pdf) await time('open-pdf', () => window.__kb.openByPath(pdf.rootId, pdf.rel, 'tab'));
    const loadsAfterOpen = window.__kbPdfLoads ?? 0;
    const deadline = Date.now() + 8000;
    let loadsAfterWait = window.__kbPdfLoads ?? 0;
    while (pdf && loadsAfterWait <= loadsBefore && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      loadsAfterWait = window.__kbPdfLoads ?? 0;
    }
    return {
      samples,
      md,
      pdf,
      loadsBefore,
      loadsAfterOpen,
      loadsAfterWait,
      roots: roots.length,
    };
  });
    calls.push(...timed.samples.map(({ side, name, ms }) => ({ side, name, ms })));
    const trace = await waitTrace(6 * 60 * 1000);
    const loadsAfterIndex = await page.evaluate(() => window.__kbPdfLoads ?? 0);
    const deleted = await deleteRegisteredRoot(page);
    const soak = await soakAndHangs(page, child.pid);
    return { trace, calls, pid: child.pid, pdf: { ...timed, loadsAfterIndex }, dragMs: drag.ms, drag, panel, deleted, soak };
  } finally {
    await browser?.close().catch(() => undefined);
    if (child.exitCode === null && child.pid) {
      try { process.kill(child.pid); } catch { /* 已经退出 */ }
    }
    if (child.exitCode === null) {
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 8000)),
      ]);
    }
  }
}

function coldRun(opts = {}) {
  fs.rmSync(path.join(USERDATA, 'startup-trace.json'), { force: true });
  return new Promise((resolve, reject) => {
    let settled = false;
    let interactiveTimer;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      if (interactiveTimer) clearInterval(interactiveTimer);
      reject(err);
    };
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      if (interactiveTimer) clearInterval(interactiveTimer);
      resolve(value);
    };
    const child = spawn(ELECTRON, ['.', '--no-sandbox', '--disable-gpu'], {
      cwd: ROOT,
      env: envFor(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    if (opts.interactiveWithinMs) {
      const stallPath = path.join(WORK, 'stall.log');
      const startSize = fs.existsSync(stallPath) ? fs.statSync(stallPath).size : 0;
      const started = Date.now();
      interactiveTimer = setInterval(() => {
        try {
          const buf = fs.readFileSync(stallPath);
          const added = buf.subarray(startSize).toString('utf8');
          if (added.includes('renderer:interactive')) {
            clearInterval(interactiveTimer);
            interactiveTimer = undefined;
            return;
          }
        } catch { /* 标记还没写 */ }
        if (Date.now() - started > opts.interactiveWithinMs) {
          fs.appendFileSync(path.join(WORK, 'perf-child-stderr.txt'), `\n--- no interactive in ${opts.interactiveWithinMs} ---\n${log.slice(-4000)}\n`);
          try { process.kill(child.pid); } catch { /* 已经退出 */ }
          fail(new Error('60 秒内没有可交互标记'));
        }
      }, 300);
    }
    waitTrace(4 * 60 * 1000).then(
      (trace) => {
        const pid = child.pid;
        const done = new Promise((finish) => child.once('exit', () => finish()));
        try { process.kill(pid); } catch (err) { fail(err); return; }
        const giveUp = setTimeout(() => fail(new Error('子进程没有退出')), 15000);
        done.then(() => {
          clearTimeout(giveUp);
          succeed({ trace, pid, log: log.slice(-2000) });
        });
      },
      (err) => {
        fs.appendFileSync(path.join(WORK, 'perf-child-stderr.txt'), `\n--- cold fail ---\n${log.slice(-4000)}\n`);
        try { process.kill(child.pid); } catch { /* 已经退出 */ }
        fail(err);
      },
    );
  });
}

function killedParentRun() {
  fs.rmSync(path.join(USERDATA, 'startup-trace.json'), { force: true });
  return new Promise((resolve, reject) => {
    const child = spawn(ELECTRON, ['.', '--no-sandbox', '--disable-gpu'], {
      cwd: ROOT,
      env: envFor(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const file = path.join(USERDATA, 'startup-trace.json');
    const started = Date.now();
    const timer = setInterval(() => {
      try {
        const json = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (json.summary && json.summary.interactiveMs > 0) {
          clearInterval(timer);
          const pid = child.pid;
          try { process.kill(pid); } catch (err) { reject(err); return; }
          child.once('exit', () => resolve({ pid, interactiveMs: json.summary.interactiveMs }));
        }
      } catch { /* 还没写出 */ }
      if (Date.now() - started > 60000) {
        clearInterval(timer);
        try { process.kill(child.pid); } catch { /* ignore */ }
        reject(new Error('杀掉父进程前没有看到可交互'));
      }
    }, 300);
  });
}

function summarize(trace) {
  const runtime = trace.runtime ?? {};
  return {
    interactiveMs: trace.summary?.interactiveMs ?? null,
    contentIndexDoneMs: trace.summary?.contentIndexDoneMs ?? null,
    eventLoopP99: runtime.eventLoopDelayMs?.p99 ?? null,
    dbWait: runtime.dbWaitMs ?? null,
    longTask: runtime.rendererLongTaskMs ?? null,
    bodyReads: runtime.contentBodyReads ?? null,
    contentIndexDone: runtime.contentIndexDone === true,
  };
}

function gate(runs, ops) {
  const failures = [];
  for (const run of runs) {
    if (!(run.interactiveMs > 0) || run.interactiveMs >= INTERACTIVE_MS) failures.push(`第 ${run.n} 次可交互 ${run.interactiveMs} ms`);
    if (!(run.eventLoopP99 < LOOP_P99_MS)) failures.push(`第 ${run.n} 次事件循环 p99 ${run.eventLoopP99} ms`);
    if (run.n > 1 && run.bodyReads !== 0) failures.push(`第 ${run.n} 次正文读取 ${run.bodyReads}`);
  }
  const opMs = ops.map((op) => op.ms);
  if (percentile(opMs, 95) >= OP_P95_MS) failures.push(`操作 p95 ${percentile(opMs, 95)} ms`);
  return failures;
}

const calls = [];
const runs = [];
let first = null;
const failures = [];
try {
  prepareFixtures();
  copyLibrary();
  fs.writeFileSync(path.join(WORK, 'stall.log'), '');
  first = await interactiveRun();
  calls.push(...first.calls);
  const firstSummary = summarize(first.trace);
  runs.push({ n: 1, ...firstSummary, pdf: first.pdf, dragMs: first.dragMs });
  console.log('[perf] 第 1 次', JSON.stringify(firstSummary));

  for (let n = 2; n <= RUNS; n += 1) {
    const result = await coldRun();
    const summary = summarize(result.trace);
    runs.push({ n, ...summary });
    console.log(`[perf] 第 ${n} 次`, JSON.stringify(summary));
  }

  const killed = await killedParentRun();
  console.log('[perf] 只结束父进程', killed.pid);
  const afterKill = await coldRun({ interactiveWithinMs: 60000 });
  const afterSummary = summarize(afterKill.trace);
  runs.push({ n: RUNS + 1, afterKill: true, killedPid: killed.pid, ...afterSummary });
  console.log('[perf] 结束后再启动', JSON.stringify(afterSummary));
} catch (err) {
  failures.push(String(err && err.message ? err.message : err));
  console.error('[perf] 中断', failures[failures.length - 1]);
}

const measured = calls.filter((call) => call.name !== 'search' && call.name !== 'panel-drag');
const extra = calls.filter((call) => call.name === 'search' || call.name === 'panel-drag');
failures.push(...gate(runs.filter((run) => !run.afterKill), measured));
if (!extra.some((call) => call.name === 'search') || !extra.some((call) => call.name === 'panel-drag')) {
  failures.push('没有量到搜索或面板拖动');
}
if (percentile(extra.map((call) => call.ms), 95) >= OP_P95_MS) {
  failures.push(`搜索和面板拖动 p95 ${percentile(extra.map((call) => call.ms), 95)} ms`);
}
const again = runs.find((run) => run.afterKill);
if (first?.pdf && first.pdf.loadsAfterIndex !== first.pdf.loadsAfterWait) {
  failures.push(`PDF 加载次数从 ${first.pdf.loadsAfterWait} 变成 ${first.pdf.loadsAfterIndex}`);
}
if (runs.some((run) => run.afterKill) && !again?.contentIndexDone) failures.push('杀掉父进程后的下一次启动没有走完正文索引');
if (again && again.bodyReads !== 0) failures.push(`结束后再启动正文读取 ${again.bodyReads}`);
if (again && !(again.eventLoopP99 < LOOP_P99_MS)) failures.push(`杀掉父进程后再启动事件循环 p99 ${again?.eventLoopP99} ms`);
if (again && !(again.interactiveMs > 0 && again.interactiveMs < 8000)) failures.push(`杀掉父进程后再启动可交互 ${again?.interactiveMs} ms`);
if (again && !(again.interactiveMs > 0 && again.interactiveMs < 60000)) failures.push(`杀掉父进程后再启动 60 秒内没有可交互 ${again?.interactiveMs} ms`);
if (first?.panel && first.panel.moved !== true) failures.push('面板拖动没有移动分隔条');
if (first?.deleted && (!first.deleted.gone || !(first.deleted.alive && first.deleted.alive.ms < 2000))) {
  failures.push(`删除已登记的根失败 ${JSON.stringify(first.deleted)}`);
}
if (first?.soak?.hangs?.error) failures.push(`AppHang 查询失败 ${first.soak.hangs.error}`);
if (first?.soak && first.soak.hangs && first.soak.hangs.events && first.soak.hangs.events.length) {
  failures.push(`连续操作期间有 AppHang ${first.soak.hangs.events.length} 条`);
}
const report = {
  at: new Date().toISOString(),
  thresholds: { interactiveMs: INTERACTIVE_MS, eventLoopP99: LOOP_P99_MS, opP95: OP_P95_MS },
  targets: { md: first?.pdf?.md ?? null, pdf: first?.pdf?.pdf ?? null },
  runs,
  calls,
  panelDrag: first?.panel ?? null,
  deletedRoot: first?.deleted ?? null,
  soak: first?.soak ?? null,
  slowestMain: topCalls(calls.filter((c) => c.side === 'main')),
  slowestRenderer: topCalls(calls.filter((c) => c.side === 'renderer')),
  startupSlowest: topCalls(
    (first?.trace?.marks ?? []).map((mark) => ({ side: mark.side, name: mark.name, ms: mark.ms })),
  ),
  failures,
};
fs.writeFileSync(path.join(WORK, 'perf-startup.json'), JSON.stringify(report, null, 2));
console.log('[perf] 最慢的渲染调用');
for (const row of report.slowestRenderer) console.log(`  ${row.ms} ms  ${row.name}`);
console.log('[perf] 最慢的启动标记');
for (const row of report.startupSlowest) console.log(`  ${row.ms} ms  ${row.side}  ${row.name}`);
if (failures.length) {
  console.error('[perf] 未通过');
  for (const line of failures) console.error('  ' + line);
  process.exit(1);
}
console.log('[perf] 通过');
