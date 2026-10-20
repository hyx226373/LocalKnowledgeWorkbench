// 用打好的安装目录打开夹具，截真实 KaTeX 和流程图。不打开已安装的工作台。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const EXE = process.env.KB_PACK_EXE;
const WORK = 'D:/workspace/kb-work/pack-0015';
const FIXTURE = path.join(WORK, 'reader-fixture');
const USERDATA = path.join(WORK, 'reader-userdata');
const OUT = path.join(WORK, 'shots');
const PORT = 9495;
if (!EXE || !fs.existsSync(EXE)) {
  console.error('设置 KB_PACK_EXE 为 win-unpacked 里的 exe');
  process.exit(2);
}

const md = `# 字形

行内 $E=mc^2$，行间

$$
\\int_0^1 x^2 \\, dx = \\frac{1}{3}
$$

\`\`\`mermaid
flowchart LR
  A[资料] --> B[索引]
\`\`\`
`;

fs.rmSync(FIXTURE, { recursive: true, force: true });
fs.rmSync(USERDATA, { recursive: true, force: true });
fs.mkdirSync(FIXTURE, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(FIXTURE, 'glyphs.md'), md, 'utf8');

const env = { ...process.env, KB_USER_DATA: USERDATA };
delete env.ELECTRON_RUN_AS_NODE;
delete env.VITE_DEV_SERVER_URL;

const child = spawn(EXE, [`--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const log = [];
child.stdout.on('data', (buf) => log.push(buf));
child.stderr.on('data', (buf) => log.push(buf));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitPort() {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return;
    } catch { /* 还没开 */ }
    await sleep(200);
  }
  throw new Error('调试端口没有打开');
}

try {
  await waitPort();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const deadline = Date.now() + 30000;
  let page;
  while (!page && Date.now() < deadline) {
    for (const ctx of browser.contexts()) {
      for (const candidate of ctx.pages()) {
        const ok = await candidate.evaluate(() => !!(window.kb && window.__kb)).catch(() => false);
        if (ok) page = candidate;
      }
    }
    if (!page) await sleep(200);
  }
  if (!page) throw new Error('没有找到应用页面');
  await page.evaluate(async () => {
    if (window.__layoutRestored && window.__kb.currentWorkspaceId()) return;
    const listed = await window.kb.listWorkspaces();
    if (listed.length === 0) {
      const created = await window.kb.createWorkspace('字形', '', { schema: 4, dock: null, shell: { sidebarWidth: 280 } }, []);
      await window.__kb.switchTo(created.id);
      return;
    }
    await window.__kb.switchTo(listed[0].id);
  });
  await page.waitForFunction(() => window.__layoutRestored === true, null, { timeout: 20000 });
  const opened = await page.evaluate(async (dir) => {
    const root = await window.kb.addRoot(dir, 'reader-shot');
    const id = await window.__kb.openByPath(root.id, 'glyphs.md', 'tab');
    return { rootId: root.id, resourceId: id };
  }, FIXTURE.replace(/\\/g, '/'));
  await page.waitForSelector('.katex', { timeout: 20000 });
  await page.waitForSelector('.kb-mermaid-drawn svg', { timeout: 20000 });
  const net = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /^https?:/i.test(n)));
  await page.evaluate(() => {
    const mount = document.querySelector('[data-testid="ws-overview-mount"]');
    if (mount && !mount.hasAttribute('hidden')) document.querySelector('[data-testid="ws-overview-toggle"]')?.click();
    document.querySelector('.katex-display')?.scrollIntoView({ block: 'center' });
  });
  await sleep(600);
  const katex = page.locator('.katex-display').first();
  const mermaid = page.locator('.kb-mermaid-drawn').first();
  const katexBox = await katex.boundingBox();
  const mermaidBox = await mermaid.boundingBox();
  const katexText = await katex.innerText();
  const katexPath = path.join(OUT, 'katex-glyphs.png');
  const mermaidPath = path.join(OUT, 'mermaid-glyphs.png');
  if (!katexBox || !mermaidBox) throw new Error('字形区域没有布局');
  await page.screenshot({ path: katexPath, clip: katexBox });
  await page.screenshot({ path: mermaidPath, clip: mermaidBox });
  const fonts = await page.evaluate(() => {
    const el = document.querySelector('.katex');
    const style = el ? getComputedStyle(el) : null;
    const svg = document.querySelector('.kb-mermaid-drawn svg');
    const labels = svg
      ? Array.from(svg.querySelectorAll('.nodeLabel, text, span'))
          .map((node) => (node.textContent || '').replace(/\s+/g, ''))
          .filter(Boolean)
      : [];
    return {
      fontFamily: style?.fontFamily ?? '',
      katexCount: document.querySelectorAll('.katex').length,
      mermaidSvg: document.querySelectorAll('.kb-mermaid-drawn svg').length,
      mermaidSourceLeft: document.querySelectorAll('pre.kb-mermaid').length,
      mermaidText: labels.join('|'),
    };
  });
  const result = { opened, katexBox, mermaidBox, katexText, fonts, net, pid: child.pid, exe: EXE };
  fs.writeFileSync(path.join(OUT, 'reader-shot.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (fonts.mermaidSvg < 1 || fonts.mermaidSourceLeft !== 0) throw new Error('流程图没有画出来');
  if (!String(fonts.mermaidText).includes('资料') || !String(fonts.mermaidText).includes('索引')) throw new Error('流程图文字不对');
  await browser.close();
} catch (err) {
  fs.writeFileSync(path.join(WORK, 'reader-shot-error.txt'), String(err && err.stack ? err.stack : err) + '\n' + Buffer.concat(log).toString('utf8').slice(-4000));
  console.error(err);
  process.exitCode = 1;
} finally {
  if (child.pid) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  }
}
