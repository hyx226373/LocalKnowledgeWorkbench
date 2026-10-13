/** 用同一份隔离用户数据再开一次，确认抽屉选择还在。不发送系统鼠标。 */
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.KB_R40_PROOF_DIR;
const USER = process.env.KB_USER_DATA;
const app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, KB_USER_DATA: USER } });
const win = await app.firstWindow();
await win.waitForFunction(() => window.__layoutRestored === true, null, { timeout: 90000 });
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0];
  w.setBounds({ x: 60, y: 30, width: 1280, height: 800 });
  w.showInactive();
});
await win.waitForTimeout(400);
const cards = await win.evaluate(() => [...document.querySelectorAll('[data-testid^="drawer-card-"]')].map((el) => ({
  id: el.getAttribute('data-module'),
  pressed: el.getAttribute('aria-pressed'),
})));
console.log('cards', JSON.stringify(cards));
await win.screenshot({ path: path.join(OUT, '25-after-relaunch.png') });
await app.close();
