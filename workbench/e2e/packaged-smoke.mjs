// 冒烟（旧版，仅适用于未打 fuses 的产物：Playwright 需要 --inspect）：启动打包产物（asar），验证 better-sqlite3 加载、worker 扫描可用。
// 打了 fuses 的正式产物请用 e2e/packaged-fuses-smoke.mjs（npm run smoke:packaged）。构建无 fuses 的产物：electron-builder --linux dir -c.electronFuses=null
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
const exe = process.argv[2];
const ud = '/tmp/kb-pkg-smoke';
fs.rmSync(ud, { recursive: true, force: true });
const app = await electron.launch({ executablePath: exe, args: ['--no-sandbox', '--disable-gpu'], env: { ...process.env, KB_USER_DATA: ud } });
const win = await app.firstWindow();
await win.waitForFunction(() => window.__layoutRestored === true);
await win.evaluate((p) => window.kb.addRoot(p), process.env.KB_SAMPLE || '/workspace/kb-sample');
let st = null;
for (let i = 0; i < 150 && !st; i++) {
  const s = await win.evaluate(() => window.kb.getIndexStatus());
  if (s[0] && s[0].state === 'idle' && s[0].fileCount > 0) st = s[0];
  else await new Promise((r) => setTimeout(r, 100));
}
if (!st) throw new Error('打包产物中索引扫描未完成');
console.log('packaged smoke OK:', JSON.stringify(st));
await app.close();
