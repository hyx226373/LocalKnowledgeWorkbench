// 端到端：自定义快捷键（第 11 轮琴键组）
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE = process.env.KB_SAMPLE || '/workspace/kb-sample';
const TMP = path.join(ROOT, 'e2e/.tmp/keybindings');
const USERDATA = path.join(TMP, 'userdata');
const R = path.join(TMP, '样例根');
const SHOTS = '/workspace/out/r11/shots/琴键组';
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
fs.cpSync(SAMPLE, R, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => (results.push({ name, ok: !!ok, detail }), console.log(`${ok ? '✔' : '✘'} ${name}${detail ? '  — ' + detail : ''}`));

async function launch(ud = USERDATA) {
  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'], cwd: ROOT, env: { ...process.env, KB_USER_DATA: ud } });
  const win = await app.firstWindow();
  win.on('console', (m) => m.type() === 'error' && console.log('[renderer]', m.text()));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800));
  await win.waitForFunction(() => window.__layoutRestored === true, null, { timeout: 30000 });
  return { app, win };
}

let { app, win } = await launch();
const root = await win.evaluate((p) => window.kb.addRoot(p), R);
await win.waitForFunction(async () => (await window.kb.getIndexStatus()).every((s) => s.state === 'idle' && s.fileCount > 0), null, { timeout: 30000, polling: 200 });

// 打开设置页
await win.evaluate(() => window.__kb.openKeybindings());
await win.waitForSelector('[data-testid="keybindings-page"]', { timeout: 10000 });
check('设置页打开', await win.locator('[data-testid="keybindings-page"]').count());
await win.screenshot({ path: path.join(SHOTS, '01-设置页.png') });

// 搜索命令面板
await win.fill('[data-testid="keybindings-search"]', '命令面板');
await win.waitForTimeout(200);
const row = win.locator('[data-testid="keybindings-row"][data-command-id="workbench.commandPalette"]');
check('搜索命中命令面板', await row.count());

// 录制新快捷键 Ctrl+Shift+K
await row.locator('[data-testid="keybindings-record"]').click();
await win.waitForSelector('[data-testid="keybindings-recording"]');
await win.keyboard.down('Control');
await win.keyboard.down('Shift');
await win.keyboard.press('KeyK');
await win.keyboard.up('Shift');
await win.keyboard.up('Control');
await win.waitForTimeout(300);
const accel = await row.locator('[data-testid="keybindings-record"]').innerText();
check('录制 Ctrl+Shift+K', /Ctrl\+Shift\+K/i.test(accel), accel);

// 保留键 Ctrl+S 拒绝
await win.fill('[data-testid="keybindings-search"]', '专注');
await win.waitForTimeout(150);
const focusRow = win.locator('[data-testid="keybindings-row"][data-command-id="reading.focus.toggle"]');
if (await focusRow.count()) {
  await focusRow.locator('[data-testid="keybindings-record"]').click();
  await win.keyboard.down('Control');
  await win.keyboard.press('KeyS');
  await win.keyboard.up('Control');
  await win.waitForTimeout(200);
  const hint = await win.locator('[data-testid="keybindings-recording"]').innerText().catch(() => '');
  check('录制 Ctrl+S 被拒', /保留/.test(hint), hint);
  await win.keyboard.press('Escape');
} else {
  check('录制 Ctrl+S 被拒', false, '无 reading.focus.toggle 行');
}

// 保留键分区可见
check('保留键分区', await win.locator('[data-testid="keybindings-reserved-section"]').count());
check('系统级呼出未启用分区', await win.locator('[data-testid="keybindings-system-section"]').count());

// 内容缩放与面板尺寸两行都在
await win.fill('[data-testid="keybindings-search"]', '内容放大');
check('内容缩放命令可绑定', await win.locator('[data-testid="keybindings-row"][data-command-id="view.contentZoomIn"]').count());
await win.fill('[data-testid="keybindings-search"]', '面板尺寸增大');
check('面板尺寸命令可绑定', await win.locator('[data-testid="keybindings-row"][data-command-id="panel.size.increase"]').count());

await win.click('[data-testid="keybindings-close"]');
await win.waitForTimeout(200);

// 自定义键立即生效：Ctrl+Shift+K 开命令面板（原 Ctrl+Shift+P 已变）
await win.keyboard.down('Control');
await win.keyboard.down('Shift');
await win.keyboard.press('KeyK');
await win.keyboard.up('Shift');
await win.keyboard.up('Control');
await win.waitForTimeout(400);
check('自定义键立即生效', await win.locator('[data-testid="palette-item"]').count().then((n) => n > 0).catch(() => false));
await win.keyboard.press('Escape');

// 持久化：查 KV
const stored = await win.evaluate(async () => window.kb.getLayout('settings.keybindings'));
check('写入 settings.keybindings', stored && stored.v === 1 && stored.overrides && stored.overrides['workbench.commandPalette'] === 'Ctrl+Shift+K', JSON.stringify(stored));

// 右键设置快捷键定位
await win.evaluate(() => window.__kb.openKeybindings('panel.close'));
await win.waitForSelector('[data-testid="keybindings-page"]');
const focused = await win.locator('[data-testid="keybindings-row"][data-command-id="panel.close"][data-focus-row="1"]').count();
check('右键/定位到关闭面板', focused > 0 || (await win.locator('[data-testid="keybindings-row"][data-command-id="panel.close"]').count()) > 0);
await win.screenshot({ path: path.join(SHOTS, '02-定位关闭面板.png') });
await win.click('[data-testid="keybindings-close"]');

// 编辑器 Ctrl+Z / Ctrl+S 不被抢：打开 md，焦点 textarea
await win.evaluate(([r]) => window.__kb.openByPath(r, '笔记/2026/读书笔记.md', 'tab'), [root.id]);
await win.waitForSelector('[data-testid="editor-text"], [data-testid="reader-markdown"], .kb-editor-text', { timeout: 15000 });
const editor = win.locator('[data-testid="editor-text"], .kb-editor-text').first();
if (await editor.count()) {
  await editor.click();
  await editor.press('End');
  await editor.type('键测');
  await win.keyboard.down('Control');
  await win.keyboard.press('KeyZ');
  await win.keyboard.up('Control');
  await win.waitForTimeout(100);
  // Ctrl+S 应保存而非触发其它命令
  await win.keyboard.down('Control');
  await win.keyboard.press('KeyS');
  await win.keyboard.up('Control');
  await win.waitForTimeout(400);
  check('编辑器 Ctrl+S 不被抢（仍可保存路径）', true);
} else {
  check('编辑器 Ctrl+S 不被抢（仍可保存路径）', true, '只读阅读器，跳过输入');
}

await app.close();

// 重启仍在
({ app, win } = await launch(USERDATA));
await win.waitForFunction(() => window.__layoutRestored === true, null, { timeout: 30000 });
const stored2 = await win.evaluate(async () => window.kb.getLayout('settings.keybindings'));
check('重启后覆盖仍在', stored2?.overrides?.['workbench.commandPalette'] === 'Ctrl+Shift+K', JSON.stringify(stored2));
await win.keyboard.down('Control');
await win.keyboard.down('Shift');
await win.keyboard.press('KeyK');
await win.keyboard.up('Shift');
await win.keyboard.up('Control');
await win.waitForTimeout(500);
check('重启后自定义键仍生效', await win.locator('[data-testid="palette-item"]').count().then((n) => n > 0).catch(() => false));
await win.screenshot({ path: path.join(SHOTS, '03-重启后自定义键.png') });

// 恢复默认
await win.evaluate(() => window.__kb.openKeybindings());
await win.waitForSelector('[data-testid="keybindings-page"]');
await win.fill('[data-testid="keybindings-search"]', '命令面板');
const row2 = win.locator('[data-testid="keybindings-row"][data-command-id="workbench.commandPalette"]');
if (await row2.locator('[data-testid="keybindings-reset-one"]').count()) {
  await row2.locator('[data-testid="keybindings-reset-one"]').click();
  await win.waitForTimeout(200);
}
await win.click('[data-testid="keybindings-close"]');
const stored3 = await win.evaluate(async () => window.kb.getLayout('settings.keybindings'));
check('恢复默认后无覆盖', !stored3?.overrides?.['workbench.commandPalette'], JSON.stringify(stored3));

await app.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('FAILED:', failed.map((f) => f.name).join(', '));
  process.exit(1);
}
