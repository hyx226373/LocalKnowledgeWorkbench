#!/usr/bin/env node
// 主题截图：把固定的“功能基准界面”和“组件状态表”按浅色、深色各渲染一次。
//
//   npm run theme:shots -- <主题包文件夹 | 内置主题 id> [--out <输出文件夹>] [--chrome <id>] [--reading <id>]
//
// 例（Windows）：npm run theme:shots -- "D:\STUDY MATERIAL\项目\知识库\themes\a" --out "D:\STUDY MATERIAL\项目\知识库\themes\a\shots"
// 例（内置）：  npm run theme:shots -- study --out verify/theme-shots/study
//
// 不依赖 xvfb（只有在 Linux 且没有图形显示时才自动用 xvfb-run 包一层）；路径可含空格与中文；
// 以 --force-device-scale-factor=1 + 视口模拟固定为 1280×800，与屏幕缩放、窗口大小无关。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';
const W = 1280;
const H = 800;

function die(msg) {
  console.error(`\n✘ ${msg}\n`);
  process.exit(2);
}
function parseArgs(argv) {
  const o = { target: null, out: null, chrome: null, reading: null, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = argv[++i];
    else if (a === '--chrome') o.chrome = argv[++i];
    else if (a === '--reading') o.reading = argv[++i];
    else if (a === '--keep-temp') o.keep = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (!o.target) o.target = a;
    else die(`多余的参数：${a}`);
  }
  return o;
}
const args = parseArgs(process.argv.slice(2));
if (args.help || !args.target) {
  console.log('用法：npm run theme:shots -- <主题包文件夹 | 内置主题 id> [--out <输出文件夹>] [--chrome <外框样式 id>] [--reading <阅读区样式 id>]');
  process.exit(args.help ? 0 : 2);
}

// ---- Linux 无图形显示 → 用 xvfb-run 重新执行自己（Windows / macOS 不需要）
if (process.platform === 'linux' && !process.env.KB_SHOTS_IN_XVFB && (!process.env.DISPLAY || process.env.KB_SHOTS_XVFB === '1')) {
  const r = spawnSync('xvfb-run', ['-a', '-s', `-screen 0 ${W + 320}x${H + 200}x24`, process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, KB_SHOTS_IN_XVFB: '1' },
  });
  if (r.error) die('没有图形显示且找不到 xvfb-run。请在桌面环境中运行，或安装 xvfb。');
  process.exit(r.status ?? 1);
}

// ---- 找到主题包
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const builtinDirs = fs.existsSync(path.join(ROOT, 'themes')) ? fs.readdirSync(path.join(ROOT, 'themes')).map((d) => path.join(ROOT, 'themes', d)).filter((d) => fs.existsSync(path.join(d, 'theme.json'))) : [];
let packDir = null;
let isBuiltin = false;
const asPath = path.resolve(process.cwd(), args.target);
if (fs.existsSync(path.join(asPath, 'theme.json'))) packDir = asPath;
else {
  packDir = builtinDirs.find((d) => path.basename(d) === args.target || readJson(path.join(d, 'theme.json')).id === args.target) ?? null;
  if (!packDir) die(`找不到主题包：${args.target}\n  应为包含 theme.json 的文件夹，或内置主题 id（${builtinDirs.map((d) => path.basename(d)).join(' / ')}）`);
}
isBuiltin = builtinDirs.some((d) => path.resolve(d) === path.resolve(packDir));
let manifest;
try {
  manifest = readJson(path.join(packDir, 'theme.json'));
} catch (e) {
  die(`theme.json 不是合法 JSON：${e.message}`);
}
const packId = String(manifest.id ?? '');
if (!isBuiltin) {
  const clash = builtinDirs.find((d) => readJson(path.join(d, 'theme.json')).id === packId);
  if (clash) die(`主题包 id「${packId}」与内置主题重复。请在 theme.json 里改成自己的 id（例如 contractor.a）。`);
}
const chromeIds = (manifest.contributes?.chromeThemes ?? []).map((t) => t.id);
const readingIds = (manifest.contributes?.readingThemes ?? []).map((t) => t.id);
const chrome = args.chrome ?? chromeIds[0] ?? 'pro';
const reading = args.reading ?? readingIds[0] ?? 'pro';
const outDir = path.resolve(process.cwd(), args.out ?? (isBuiltin ? path.join(ROOT, 'verify', 'theme-shots', path.basename(packDir)) : path.join(packDir, 'shots')));
fs.mkdirSync(outDir, { recursive: true });
console.log(`主题包：${packId}（${isBuiltin ? '内置' : packDir}）\n外框样式：${chrome}　阅读区样式：${reading}\n输出：${outDir}`);

// ---- 需要时先构建
if (!fs.existsSync(path.join(ROOT, 'out', 'main', 'index.js')) || !fs.existsSync(path.join(ROOT, 'out', 'renderer', 'index.html'))) {
  console.log('未找到构建产物 out/，先执行 npm run build …');
  const r = spawnSync(IS_WIN ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit', shell: IS_WIN });
  if (r.status !== 0) die('构建失败（npm run build）');
}

const { _electron: electron } = await import('playwright');

// ---- 临时数据目录与样例根（路径里故意带空格与中文）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-shots-'));
const userData = path.join(tmp, 'user data');
const sampleRoot = path.join(tmp, '基准 样例');
fs.cpSync(path.join(ROOT, 'theme-kit', 'bench-sample'), sampleRoot, { recursive: true });

const env = { ...process.env, KB_USER_DATA: userData };
delete env.ELECTRON_RUN_AS_NODE;
if (!isBuiltin) env.KB_THEME_DIRS = packDir;
const launchArgs = ['.', '--force-device-scale-factor=1', ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [])];
const app = await electron.launch({ args: launchArgs, cwd: ROOT, env });
const report = { at: new Date().toISOString(), pack: packId, packDir: isBuiltin ? `themes/${path.basename(packDir)}` : packDir, chrome, reading, viewport: null, errors: [], warnings: [], shots: [], tokens: {} };
try {
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setContentSize(s.W, s.H), { W, H });
  const cdp = await win.context().newCDPSession(win);
  const fixViewport = (h = H, w = W) => cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await fixViewport();

  // 插件授权（演示 CSV 插件） → 允许
  const end = Date.now() + 30000;
  while (!(await win.evaluate(() => window.__layoutRestored === true))) {
    if (Date.now() > end) throw new Error('应用启动超时');
    if (await win.locator('[data-testid="dialog"]').count()) await win.click('[data-testid="dialog-ok"]');
    await win.waitForTimeout(100);
  }

  const tr = (await win.evaluate(() => window.__kb.themeReport())).find((p) => p.id === packId);
  if (!tr) report.errors.push(`应用没有加载主题包 ${packId}`);
  else {
    report.errors.push(...tr.errors);
    report.warnings.push(...tr.warnings);
    report.contributes = { chrome: tr.chrome, reading: tr.reading, presets: tr.presets };
  }
  const st = (await win.evaluate(() => window.__kb.pluginStatus())).find((p) => p.id === packId);
  if (st && st.status !== 'active') report.errors.push(`主题包状态：${st.status}${st.message ? '：' + st.message : ''}`);

  // ---- 搭建功能基准界面
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
  }, sampleRoot);
  await win.click('[data-testid="pick-folder"]');
  await win.waitForSelector('[data-testid="root-row"]');
  await win.waitForSelector('[data-testid="index-status"][data-state="idle"]', { timeout: 20000 }).catch(() => {});
  const rootId = await win.getAttribute('[data-testid="root-row"]', 'data-root-id');
  const row = (rel) => win.locator(`[data-testid="sidebar"] [data-testid="tree-row"][data-relpath="${rel}"]`).first();
  for (const d of ['笔记', '资料', '资料/论文']) {
    await row(d).click();
    await win.waitForTimeout(150);
  }
  for (const rel of ['笔记/基准阅读.md', '资料/论文']) {
    await row(rel).hover();
    await row(rel).locator('[data-testid="fav-toggle"]').click();
    await win.waitForTimeout(100);
  }
  const openP = (rel, mode) => win.evaluate(([r, p, m]) => window.__kb.openByPath(r, p, m), [rootId, rel, mode]);
  await openP('笔记/基准阅读.md', 'tab');
  await openP('资料/论文/讲义.pdf', 'right');
  await openP('资料/数据.csv', 'below');
  await openP('资料/图片/架构草图.png', 'tab');
  await win.locator('.dv-tab', { hasText: '数据.csv' }).click();
  await row('笔记/基准阅读.md').click(); // 树中选中当前文件
  const ready = async () => {
    await win.waitForSelector('[data-testid="reader-pdf"] .pdf-page[data-rendered="1"]', { timeout: 30000 });
    await win.waitForFunction(() => [...document.querySelectorAll('[data-testid="reader-markdown"] img')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 15000 });
    await win.waitForSelector('[data-testid="view-csv-table"] table', { timeout: 15000 });
    await win.evaluate(() => document.fonts.ready);
    await win.waitForTimeout(400);
  };
  await ready();

  // ---- CDP：强制伪类（悬停/按下/焦点）
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const MAP = { hover: ['hover'], active: ['active', 'hover'], focus: ['focus', 'focus-visible'] };
  async function forceStates(selector, fixed) {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector });
    let n = 0;
    for (const nodeId of nodeIds) {
      let s = fixed;
      if (!s) {
        const { attributes } = await cdp.send('DOM.getAttributes', { nodeId });
        s = attributes[attributes.indexOf('data-force-state') + 1];
      }
      if (MAP[s]) {
        await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: MAP[s] });
        n++;
      }
    }
    return n;
  }

  async function bench(scheme) {
    await win.evaluate((a) => window.__kb.setAppearance(a), { chrome, reading, scheme });
    await win.waitForTimeout(300);
    const applied = await win.evaluate(() => ({ c: document.documentElement.dataset.kbChrome, r: document.documentElement.dataset.kbReading, s: document.documentElement.dataset.kbScheme }));
    if (applied.c !== chrome) report.errors.push(`${scheme}：外框样式「${chrome}」未生效（实际 ${applied.c}）`);
    if (applied.r !== reading) report.errors.push(`${scheme}：阅读区样式「${reading}」未生效（实际 ${applied.r}）`);
    await win.fill('[data-testid="search-input"]', '讲义');
    await win.waitForSelector('[data-testid="search-results"] .kb-search-hit .p');
    await win.mouse.move(W - 4, H - 4);
    await ready();
    const sashes = await forceStates('.kb-dock .dv-sash.dv-enabled', 'hover');
    if (!sashes) report.warnings.push('基准界面中没有找到可悬停的分隔条');
    await win.waitForTimeout(200);
    report.viewport = await win.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]);
    const file = `bench-${scheme}.png`;
    await win.screenshot({ path: path.join(outDir, file) });
    report.shots.push(file);
    report.tokens[scheme] = await win.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      const o = {};
      for (let i = 0; i < cs.length; i++) if (cs[i].startsWith('--kb-')) o[cs[i].slice(5)] = cs.getPropertyValue(cs[i]).trim();
      return o;
    });
    await win.fill('[data-testid="search-input"]', '');
    await win.keyboard.press('Escape');
  }
  async function sheet(scheme) {
    await win.evaluate((a) => window.__kb.setAppearance(a), { chrome, reading, scheme });
    await win.evaluate(() => window.__kb.showStatesSheet(true));
    await win.waitForSelector('[data-testid="states-sheet"]');
    await win.evaluate(() => document.fonts.ready);
    await win.waitForTimeout(500);
    const n = await forceStates('[data-force-state]');
    // 权威组件清单（theme-contract.json components）中的每个组件、每个已定义状态都必须渲染出来
    const cover = await win.evaluate(() => ({
      rows: document.querySelectorAll('[data-testid="states-sheet"] tr[data-component]').length,
      unrendered: [...document.querySelectorAll('tr[data-component][data-rendered="0"]')].map((e) => e.getAttribute('data-component')),
      missing: [...document.querySelectorAll('td[data-missing]')].map((e) => e.getAttribute('data-missing')),
      cells: document.querySelectorAll('[data-testid="states-sheet"] td[data-state]').length,
    }));
    report.coverage = cover;
    if (cover.unrendered.length) report.errors.push(`组件状态表缺少渲染器：${cover.unrendered.join('、')}`);
    if (cover.missing.length) report.errors.push(`组件状态表缺少状态格子：${cover.missing.join('、')}`);
    // 组件状态表按内容的完整宽高截图（不裁切任何状态列）
    const w = await win.evaluate(() => Math.ceil(Math.max(document.documentElement.scrollWidth, document.querySelector('[data-testid="states-sheet"]').scrollWidth)));
    await fixViewport(H, Math.max(W, w));
    await win.waitForTimeout(200);
    const h = await win.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
    await fixViewport(Math.max(H, h), Math.max(W, w));
    await win.waitForTimeout(300);
    const file = `states-${scheme}.png`;
    await win.screenshot({ path: path.join(outDir, file) });
    report.shots.push(file);
    await fixViewport();
    await win.evaluate(() => window.__kb.showStatesSheet(false));
    await win.waitForTimeout(300);
    return n;
  }

  for (const scheme of ['light', 'dark']) {
    await bench(scheme);
    const n = await sheet(scheme);
    if (scheme === 'light') report.forcedStates = n;
    // 回到基准界面（状态表关闭后重新等待内容渲染）
    await win.waitForSelector('.kb-dock .dv-groupview');
  }
  if (report.viewport && (report.viewport[0] !== W || report.viewport[1] !== H || report.viewport[2] !== 1)) report.warnings.push(`视口不是 ${W}×${H}@1x：${report.viewport.join('×')}`);
} catch (e) {
  report.errors.push('截图过程出错：' + String(e?.stack ?? e));
} finally {
  await app.close().catch(() => {});
  if (!args.keep) fs.rmSync(tmp, { recursive: true, force: true });
}

report.errors = [...new Set(report.errors)];
report.warnings = [...new Set(report.warnings)];
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
const md = [
  `# 主题截图报告：${packId}`,
  '',
  `- 时间：${new Date(report.at).toLocaleString('zh-CN', { hour12: false })}（本机时区）`,
  `- 外框样式：\`${chrome}\`　阅读区样式：\`${reading}\``,
  `- 视口：${report.viewport ? report.viewport.join(' × ') : '—'}`,
  `- 截图：${report.shots.join('、') || '无'}`,
  `- 已强制的伪类状态：${report.forcedStates ?? '—'} 个`,
  `- 组件状态表：${report.coverage ? `${report.coverage.rows} 个组件、${report.coverage.cells} 个状态格子（缺失 ${report.coverage.missing.length}）` : '—'}`,
  '',
  `## 错误（${report.errors.length}）`,
  ...(report.errors.length ? report.errors.map((x) => `- ${x}`) : ['- 无']),
  '',
  `## 警告（${report.warnings.length}）`,
  ...(report.warnings.length ? report.warnings.map((x) => `- ${x}`) : ['- 无']),
  '',
].join('\n');
fs.writeFileSync(path.join(outDir, 'report.md'), md);
console.log(`\n${report.errors.length ? '✘' : '✔'} ${report.shots.length} 张截图，${report.errors.length} 个错误，${report.warnings.length} 个警告 → ${path.join(outDir, 'report.md')}`);
process.exit(report.errors.length ? 1 : 0);
