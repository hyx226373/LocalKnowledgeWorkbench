// r11-E：强制 Local* 回退时，状态栏与搜索区必须出现「仅文件名/路径搜索」
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-degraded-'));
const UD = path.join(TMP, 'userdata');
const SAMPLE = path.join(TMP, 'root');
fs.mkdirSync(SAMPLE, { recursive: true });
fs.writeFileSync(path.join(SAMPLE, 'note.md'), '试金石检索词庚辛\n');

const app = await electron.launch({
  args: ['.', '--no-sandbox', '--disable-gpu'],
  cwd: ROOT,
  env: { ...process.env, KB_USER_DATA: UD, KB_E2E: '1', KB_FORCE_INDEXER_FAIL: '1' },
});
const win = await app.firstWindow();
await win.waitForFunction(() => window.__layoutRestored === true, null, { timeout: 60000 });
await win.evaluate((p) => window.kb.addRoot(p), SAMPLE);
await win.waitForTimeout(2000);

const health = await win.evaluate(() => window.kb.getIndexHealth());
const bar = await win.locator('[data-testid="index-health-fallback"]').textContent().catch(() => '');
await win.fill('[data-testid="search-input"]', '试金石');
await win.waitForTimeout(400);
const deg = await win.locator('[data-testid="search-degraded"]').textContent().catch(() => '');

const okHealth = health?.engine === 'local-fallback' && health?.contentSearch === false;
const okBar = /仅文件名\/路径搜索/.test(bar || '');
const okSearch = /仅文件名\/路径搜索/.test(deg || '');
console.log(JSON.stringify({ health, bar, deg, okHealth, okBar, okSearch }, null, 2));
await app.close();
if (!(okHealth && okBar && okSearch)) process.exit(1);
console.log('e2e-index-degraded: pass');
