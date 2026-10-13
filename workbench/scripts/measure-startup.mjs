// 冷启动测量（docs/07 §4）：node scripts/measure-startup.mjs [次数=5] [--files 20000]
// 1) 准备：一个数据目录 + 一个根（生成的文件树：笔记、PDF、CSV，外加 node_modules/.git 等应被忽略的大目录），
//    工作区里打开 PDF、Markdown、CSV 三个面板（用 Playwright 操作一次后关闭）。
// 2) 用生产构建（out/）直接启动 electron（不经 Playwright，避免调试器开销）N 次，每次等 <数据目录>/startup-trace.json 更新后结束进程。
// 3) 输出各阶段的中位数与每次的数值，写 verify/startup-<标签>.json（标签用 --label，默认 run）。
// Linux 无 DISPLAY 时请用 xvfb-run 运行。
import { _electron as electron } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const N = Number(args.find((a) => /^\d+$/.test(a)) ?? 5);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const FILES = Number(opt('--files', 20000));
const LABEL = opt('--label', 'run');
const TMP = path.join(ROOT, 'e2e/.tmp/startup');
const USERDATA = path.join(TMP, 'userdata');
const RA = path.join(TMP, 'root');
const ELECTRON = path.join(ROOT, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

function makePdf(n) {
  const objs = [];
  const add = (s) => (objs.push(s), objs.length);
  const catalog = add('');
  const pages = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];
  for (let i = 1; i <= n; i++) {
    const t = `BT /F1 24 Tf 72 700 Td (Page ${i}) Tj ET`;
    const c = add(`<< /Length ${t.length} >>\nstream\n${t}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Contents ${c} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`;
  objs[pages - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${n} >>`;
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => (offs.push(out.length), (out += `${i + 1} 0 obj\n${o}\nendobj\n`)));
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${x}\n%%EOF`;
  return out;
}

async function prepare() {
  fs.rmSync(TMP, { recursive: true, force: true });
  const put = (p, c) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, c));
  put(path.join(RA, '说明.md'), '# 说明\n\n' + '冷启动测量用的笔记。\n\n'.repeat(200));
  put(path.join(RA, '资料/讲义.pdf'), makePdf(60));
  put(path.join(RA, '资料/数据.csv'), 'a,b\n' + Array.from({ length: 200 }, (_, i) => `${i},${i * 2}`).join('\n'));
  // 正常文件：FILES 的一半；node_modules 与 .git：另一半（应被忽略）
  const half = Math.floor(FILES / 2);
  for (let i = 0; i < half; i++) put(path.join(RA, `笔记/${Math.floor(i / 200)}/n${i}.md`), `# ${i}\n`);
  for (let i = 0; i < half; i++) put(path.join(RA, i % 2 ? `node_modules/pkg${Math.floor(i / 100)}/f${i}.js` : `.git/objects/${Math.floor(i / 100)}/o${i}`), 'x');
  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu'], cwd: ROOT, env: { ...process.env, KB_USER_DATA: USERDATA } });
  const win = await app.firstWindow();
  await win.waitForFunction(() => window.__layoutRestored === true, null, { timeout: 30000 });
  const rid = await win.evaluate((p) => window.kb.addRoot(p).then((r) => r.id), RA);
  await win.waitForFunction(async () => (await window.kb.getIndexStatus()).every((s) => s.state === 'idle'), null, { timeout: 120000, polling: 500 });
  await win.evaluate(([r]) => window.__kb.openByPath(r, '资料/讲义.pdf', 'tab'), [rid]);
  await win.evaluate(([r]) => window.__kb.openByPath(r, '说明.md', 'right'), [rid]);
  await win.evaluate(([r]) => window.__kb.openByPath(r, '资料/数据.csv', 'right'), [rid]);
  // 在 CSV 所在分栏再开一个标签，CSV 成为后台标签（第 9 轮 D：冷启动时不加载，切到它或空闲时再加载）
  await win.evaluate(([r]) => window.__kb.openByPath(r, '笔记/0/n1.md', 'tab'), [rid]);
  await win.waitForTimeout(1500);
  await win.evaluate(() => window.__kb.flush());
  await app.close();
}

function once() {
  const trace = path.join(USERDATA, 'startup-trace.json');
  fs.rmSync(trace, { force: true });
  return new Promise((resolve, reject) => {
    const p = spawn(ELECTRON, ['.', '--no-sandbox', '--disable-gpu'], { cwd: ROOT, env: { ...process.env, KB_USER_DATA: USERDATA, KB_STARTUP_TRACE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    p.stdout.on('data', (d) => (log += d));
    p.stderr.on('data', (d) => (log += d));
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (fs.existsSync(trace)) {
        clearInterval(iv);
        const j = JSON.parse(fs.readFileSync(trace, 'utf8'));
        p.kill('SIGTERM');
        p.once('exit', () => resolve({ ...j, log }));
      } else if (Date.now() - t0 > 60000) {
        clearInterval(iv);
        p.kill('SIGKILL');
        reject(new Error('60 秒内没有得到启动计时\n' + log.slice(-2000)));
      }
    }, 100);
  });
}

if (!args.includes('--no-prepare') || !fs.existsSync(USERDATA)) await prepare();
const runs = [];
for (let i = 0; i < N + 1; i++) {
  const r = await once();
  if (i > 0) runs.push(r); // 第 1 次预热（磁盘缓存），不计
  await new Promise((res) => setTimeout(res, 500));
}
const names = [...new Set(runs.flatMap((r) => r.marks.map((m) => m.name)))];
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const table = names.map((n) => ({ name: n, median: median(runs.map((r) => r.marks.find((m) => m.name === n)?.ms).filter((x) => x != null)), each: runs.map((r) => r.marks.find((m) => m.name === n)?.ms ?? null) })).sort((a, b) => (a.median ?? 0) - (b.median ?? 0));
console.log(`冷启动（${N} 次中位数，ms，距进程启动；根：${FILES} 个文件，其中一半在 node_modules/.git）：`);
for (const t of table) console.log(`${String(t.median).padStart(6)}  ${t.name.padEnd(36)} ${JSON.stringify(t.each)}`);
const sm = (k) => median(runs.map((r) => r.summary?.[k]).filter((x) => x != null));
const summary = { windowShownMs: sm('windowShownMs'), interactiveMs: sm('interactiveMs'), visibleContentLoadedMs: sm('visibleContentLoadedMs') };
console.log(`三个指标（中位数）：窗口出现 ${summary.windowShownMs} ms · 可交互 ${summary.interactiveMs} ms · 可见内容加载完成 ${summary.visibleContentLoadedMs} ms`);
fs.mkdirSync(path.join(ROOT, 'verify'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'verify', `startup-${LABEL}.json`), JSON.stringify({ label: LABEL, runs: N, files: FILES, platform: process.platform, summary, table }, null, 2));
