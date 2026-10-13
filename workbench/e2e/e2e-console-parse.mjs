// 控制台文件：打开样例能看到按 order 排列的索引和坏块提示。不要求真的打开条目面板（F2）。
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, `e2e/.tmp/console-parse-${Date.now()}`);
const USERDATA = path.join(TMP, 'userdata');
const SAMPLE = path.join(TMP, '样例根');
const SHOTS = path.resolve(ROOT, '..', '汇报', 'shots', '控制台F1');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(SAMPLE, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

const good = `---
kbConsole: 1
title: 论文周复盘
description: 打开本周材料
---

# 论文周复盘

\`\`\`kb-console v=1
{
  "kind": "console",
  "version": 1,
  "index": {
    "titleNote": "本周材料",
    "items": [
      {
        "id": "note",
        "title": "笔记",
        "order": 2,
        "openAs": "tab",
        "ref": { "type": "resource", "resourceId": "11111111-1111-4111-8111-111111111111" }
      },
      {
        "id": "paper",
        "title": "论文",
        "order": 1,
        "openAs": "float",
        "ref": { "type": "resource", "resourceId": "22222222-2222-4222-8222-222222222222" }
      }
    ]
  }
}
\`\`\`

\`\`\`kb-console
{ this is not json
\`\`\`
`;
fs.writeFileSync(path.join(SAMPLE, '周复盘.kbconsole.md'), good, 'utf8');
fs.writeFileSync(
  path.join(SAMPLE, '未知版本.kbconsole.md'),
  '```kb-console v=9\n{ "kind": "console", "version": 9, "index": { "items": [] } }\n```\n',
  'utf8',
);
fs.writeFileSync(path.join(SAMPLE, '普通.md'), '# 普通笔记\n\n这不是控制台。\n', 'utf8');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? '  — ' + detail : ''}`);
};

const env = { ...process.env, KB_USER_DATA: USERDATA };
delete env.VITE_DEV_SERVER_URL;
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
const appLaunch = await electron.launch({
  args: ['.', '--no-sandbox', '--disable-gpu'],
  cwd: ROOT,
  env,
});
app = appLaunch;
const win = await app.firstWindow();
win.on('console', (m) => {
  if (m.type() === 'error') console.log('[renderer]', m.text());
});
const readyAt = Date.now() + 30000;
while (!(await win.evaluate(() => window.__layoutRestored === true).catch(() => false))) {
  if (Date.now() > readyAt) throw new Error('布局恢复超时');
  const dlg = win.locator('[data-testid="dialog"]');
  if (await dlg.count()) await win.click('[data-testid="dialog-ok"]');
  await win.waitForTimeout(100);
}
const root = await win.evaluate((p) => window.kb.addRoot(p, '样例'), SAMPLE);
const rid = await win.evaluate((id) => window.__kb.openByPath(id, '周复盘.kbconsole.md', 'tab'), root.id);
await win.waitForSelector('[data-testid="console-root"]', { timeout: 15000 });
const titles = await win.$$eval('[data-testid="console-item"] strong', (els) => els.map((e) => e.textContent.trim()));
const note = await win.locator('[data-testid="console-title-note"]').innerText();
const auto = await win.locator('[data-testid="console-root"]').getAttribute('data-auto-open');
const panelsAfterOpen = await win.evaluate(() => window.__dock.panels.length);
check('索引按 order 显示说明，且没有自动开整组', titles.join(',') === '论文,笔记' && note.includes('本周材料') && auto === 'off' && panelsAfterOpen === 1, JSON.stringify({ titles, note, auto, panelsAfterOpen, rid }));
const bad = await win.locator('[data-testid="console-block-error"]').innerText();
check('坏块有错误摘要', /坏 JSON/.test(bad), bad);
await win.click('[data-testid="console-open-group"]');
await win.waitForFunction(() => /失败/.test(document.querySelector('[data-testid="console-notice"]')?.textContent || ''));
const notice = await win.locator('[data-testid="console-notice"]').innerText();
const panelsAfterClick = await win.evaluate(() => window.__dock.panels.length);
check('样例里的资源不存在时，开整组给出失败摘要且不建面板', /失败/.test(notice) && panelsAfterClick === 1, notice);
await win.screenshot({ path: path.join(SHOTS, 'parse.png') });

await win.evaluate((id) => window.__kb.openByPath(id, '未知版本.kbconsole.md', 'tab'), root.id);
await win.waitForSelector('[data-testid="console-unknown-version"]');
const unknown = await win.locator('[data-testid="console-unknown-version"]').first().innerText();
check('未知版本只读提示', unknown.includes('未知控制台版本'), unknown);

await win.evaluate((id) => window.__kb.openByPath(id, '普通.md', 'tab'), root.id);
await win.waitForFunction(() => {
  const id = window.__dock.activePanel?.id;
  const root = document.querySelector(`.view-root[data-item-id="${id}"]`);
  return !!root?.querySelector('[data-testid="reader-markdown"]');
});
const plain = await win.evaluate(() => {
  const id = window.__dock.activePanel.id;
  const root = document.querySelector(`.view-root[data-item-id="${id}"]`);
  return {
    text: root?.querySelector('[data-testid="reader-markdown"]')?.textContent ?? '',
    console: !!root?.querySelector('[data-testid="console-root"]'),
  };
});
check('普通 Markdown 仍走阅读器', plain.text.includes('普通笔记') && plain.console === false, plain.text.slice(0, 40));
await win.screenshot({ path: path.join(SHOTS, 'plain-md.png') });

} finally {
  try { app?.process()?.kill(); } catch { /* 进程可能已经退出 */ }
}
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log(JSON.stringify(failed, null, 2));
  process.exit(1);
}
