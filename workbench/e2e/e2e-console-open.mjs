// 控制台打开：单项、整组失败摘要、同资源再开一份、拖入索引不移动原文件。
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, `e2e/.tmp/console-open-${Date.now()}`);
const USERDATA = path.join(TMP, 'userdata');
const SAMPLE = path.join(TMP, '样例根');
const SHOTS = path.resolve(ROOT, '..', '汇报', 'shots', '控制台F2');
const NOTE = path.join(SAMPLE, '笔记.md');
const EXTRA = path.join(SAMPLE, '附件.md');
const CONSOLE = path.join(SAMPLE, '周复盘.kbconsole.md');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(SAMPLE, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
fs.writeFileSync(NOTE, '# 笔记正文\n', 'utf8');
fs.writeFileSync(EXTRA, '# 附件正文\n保持不动\n', 'utf8');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? '  — ' + detail : ''}`);
};

const extraBefore = fs.statSync(EXTRA);
const extraText = fs.readFileSync(EXTRA, 'utf8');
let app;
try {
  const env = { ...process.env, KB_USER_DATA: USERDATA };
  delete env.VITE_DEV_SERVER_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    cwd: ROOT,
    env,
  });
  const win = await app.firstWindow();
  win.on('console', (message) => {
    if (message.type() === 'error') console.log('[renderer]', message.text());
  });
  const readyAt = Date.now() + 30000;
  while (!(await win.evaluate(() => window.__layoutRestored === true).catch(() => false))) {
    if (Date.now() > readyAt) throw new Error('布局恢复超时');
    const dlg = win.locator('[data-testid="dialog"]');
    if (await dlg.count()) await win.click('[data-testid="dialog-ok"]');
    await win.waitForTimeout(100);
  }
  const root = await win.evaluate((dir) => window.kb.addRoot(dir, '样例'), SAMPLE);
  const listing = await win.evaluate((id) => window.kb.listDir(id, ''), root.id);
  const note = listing.find((entry) => entry.relPath === '笔记.md');
  const extra = listing.find((entry) => entry.relPath === '附件.md');
  check('样例文件已入库', !!note?.resourceId && !!extra?.resourceId, JSON.stringify(listing.map((entry) => entry.relPath)));

  const body = `---
kbConsole: 1
title: 周复盘
---

# 周复盘

\`\`\`kb-console v=1
{
  "kind": "console",
  "version": 1,
  "index": {
    "items": [
      {
        "id": "note",
        "title": "笔记",
        "order": 1,
        "openAs": "tab",
        "ref": { "type": "path-hint", "rootId": ${JSON.stringify(root.id)}, "relPath": "笔记.md" }
      },
      {
        "id": "missing",
        "title": "缺失",
        "order": 2,
        "openAs": "tab",
        "ref": { "type": "resource", "resourceId": "00000000-0000-4000-8000-000000000099" }
      },
      {
        "id": "again",
        "title": "笔记再开",
        "order": 3,
        "openAs": "split-right",
        "includeInGroupOpen": false,
        "ref": { "type": "resource", "resourceId": ${JSON.stringify(note.resourceId)} }
      },
      {
        "id": "float-extra",
        "title": "附件浮窗",
        "order": 4,
        "openAs": "float",
        "includeInGroupOpen": false,
        "ref": { "type": "resource", "resourceId": ${JSON.stringify(extra.resourceId)} }
      }
    ]
  }
}
\`\`\`
`;
  fs.writeFileSync(CONSOLE, body, 'utf8');
  await win.evaluate((id) => window.__kb.openByPath(id, '周复盘.kbconsole.md', 'tab'), root.id);
  await win.waitForSelector('[data-testid="console-root"]');
  const consolePanelId = await win.evaluate(() => window.__dock.activePanel.id);
  const focusConsole = async () => {
    await win.evaluate((id) => window.__dock.getPanel(id)?.api.setActive(), consolePanelId);
    await win.waitForSelector('[data-testid="console-root"]');
  };
  await win.click('[data-testid="console-item"][data-id="note"] [data-testid="console-open-one"]');
  await win.waitForFunction(() => window.__dock.panels.length === 2);
  const afterOne = await win.evaluate((resourceId) => {
    return Object.values(window.__kb.items()).filter((item) => item.sourceKind === 'file' && item.ref === resourceId).length;
  }, note.resourceId);
  check('开单项 tab 打开笔记', afterOne === 1, String(afterOne));

  await focusConsole();
  await win.click('[data-testid="console-open-group"]');
  await win.waitForFunction(() => /失败/.test(document.querySelector('[data-testid="toast"]')?.textContent || ''));
  const summary = await win.locator('[data-testid="toast"]').innerText();
  const panelsAfterGroup = await win.evaluate(() => window.__dock.panels.length);
  check('开整组失败摘要且坏引用不建面板', /missing/.test(summary) && /失败/.test(summary) && panelsAfterGroup === 2, summary);

  await focusConsole();
  await win.click('[data-testid="console-item"][data-id="again"] [data-testid="console-open-one"]');
  await win.waitForFunction((resourceId) => {
    return Object.values(window.__kb.items()).filter((item) => item.sourceKind === 'file' && item.ref === resourceId).length >= 2;
  }, note.resourceId);
  const duplicated = await win.evaluate((resourceId) => {
    const ids = Object.values(window.__kb.items())
      .filter((item) => item.sourceKind === 'file' && item.ref === resourceId)
      .map((item) => item.itemId);
    return { ids, panels: ids.filter((id) => window.__dock.getPanel(id)).length };
  }, note.resourceId);
  check('同一 resourceId 分屏再开一份', duplicated.ids.length === 2 && new Set(duplicated.ids).size === 2 && duplicated.panels === 2, JSON.stringify(duplicated));

  await focusConsole();
  await win.click('[data-testid="console-item"][data-id="float-extra"] [data-testid="console-open-one"]');
  await win.waitForFunction((resourceId) => {
    return Object.values(window.__kb.items()).some((item) => item.sourceKind === 'file' && item.ref === resourceId);
  }, extra.resourceId);
  const floated = await win.evaluate((resourceId) => {
    const item = Object.values(window.__kb.items()).find((entry) => entry.sourceKind === 'file' && entry.ref === resourceId);
    const layout = window.__kb.pm.serialize();
    return { itemId: item?.itemId ?? '', order: layout.order ?? [], floats: Object.keys(layout.floats ?? {}) };
  }, extra.resourceId);
  check('自由窗口走现有 panelManager.float', floated.order.includes(floated.itemId) || floated.floats.includes(floated.itemId), JSON.stringify(floated));

  await focusConsole();
  await win.evaluate(() => document.querySelector('[data-testid="console-root"] [data-testid="console-mode-edit"]')?.click());
  await win.waitForSelector('[data-testid="console-index-drop"][data-drop="edit"]');
  const payload = JSON.stringify({
    v: 1,
    items: [{ resourceId: extra.resourceId, sourceKind: 'file', from: { kind: 'root', rootId: root.id, relPath: '附件.md' } }],
  });
  await win.evaluate((mime) => {
    const el = document.querySelector('[data-testid="console-index-drop"][data-drop="edit"]');
    const transfer = new DataTransfer();
    transfer.setData(mime, 'pending');
    el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, 'application/x-kb-resource+json');
  await win.waitForSelector('[data-testid="console-drop-hint"]');
  const hint = await win.locator('[data-testid="console-drop-hint"]').innerText();
  check('拖过索引区的文案', hint === '加入控制台索引（不移动原文件）', hint);

  await win.evaluate(({ mime, raw }) => {
    const el = document.querySelector('[data-testid="console-index-drop"][data-drop="edit"]');
    const transfer = new DataTransfer();
    transfer.setData(mime, raw);
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, { mime: 'application/x-kb-resource+json', raw: payload });

  const started = Date.now();
  let written = '';
  while (Date.now() - started < 8000) {
    written = fs.readFileSync(CONSOLE, 'utf8');
    if (written.includes('附件.md') && written.includes(extra.resourceId)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const extraAfter = fs.statSync(EXTRA);
  check(
    '拖入索引只改控制台文件',
    written.includes('附件.md') && written.includes(extra.resourceId) && fs.readFileSync(EXTRA, 'utf8') === extraText && extraAfter.mtimeMs === extraBefore.mtimeMs && extraAfter.size === extraBefore.size,
    JSON.stringify({ mtime: [extraBefore.mtimeMs, extraAfter.mtimeMs], size: [extraBefore.size, extraAfter.size], has: written.includes('附件.md') }),
  );
  await win.screenshot({ path: path.join(SHOTS, 'open.png') });
} finally {
  try { app?.process()?.kill(); } catch { /* 进程可能已经退出 */ }
}

const failed = results.filter((item) => !item.ok);
if (failed.length) {
  console.log(JSON.stringify(failed, null, 2));
  process.exit(1);
}
