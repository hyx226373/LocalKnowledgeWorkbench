// 端到端：agent 提出计划 → UI 看差异 → 批准 → 自动执行；agent 无法 approve
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, 'e2e/.tmp/plans');
const USERDATA = path.join(TMP, 'userdata');
const R = path.join(TMP, 'root');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(path.join(R, 'notes'), { recursive: true });
fs.writeFileSync(path.join(R, 'notes', 'todo.md'), '# 待办\n原始内容 ALPHA\n');
fs.writeFileSync(path.join(R, 'notes', 'body.md'), '独一无二的正文词戊己庚在这一行\n');

const results = [];
const check = (name, ok, detail = '') => (results.push({ name, ok: !!ok, detail }), console.log(`${ok ? '✔' : '✘'} ${name}${detail ? '  — ' + detail : ''}`));

const app = await electron.launch({
  args: ['.', '--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'],
  cwd: ROOT,
  env: { ...process.env, KB_USER_DATA: USERDATA },
});
const win = await app.firstWindow();
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 860));
await win.waitForFunction(() => window.__layoutRestored === true, null, { timeout: 30000 });

const root = await win.evaluate((p) => window.kb.addRoot(p), R);
await win.waitForFunction(async () => (await window.kb.getIndexStatus()).every((s) => s.state === 'idle' && s.fileCount > 0), null, { timeout: 60000, polling: 200 });

// 等正文索引（后台）
await new Promise((r) => setTimeout(r, 3000));
let bodyHit = false;
for (let i = 0; i < 30; i++) {
  const hits = await win.evaluate((q) => window.kb.search(q), '戊己');
  if (hits.some((h) => (h.snippet || h.name || '').includes('戊己') || h.matchKind === 'content' || (h.relPath || '').includes('body'))) {
    bodyHit = true;
    check('正文搜索可命中「戊己」', true, JSON.stringify(hits.slice(0, 2)));
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
if (!bodyHit) {
  const hits = await win.evaluate((q) => window.kb.search(q), '戊己');
  check('正文搜索可命中「戊己」', false, JSON.stringify(hits));
}

const info = await win.evaluate(() => window.kb.agentInfo());
check('agent loopback 已启动', !!(info && info.url && info.port), JSON.stringify(info));

const token = info ? JSON.parse(fs.readFileSync(info.tokenFile, 'utf8')).token : '';
const rid = await win.evaluate(([rootId]) => window.kb.listDir(rootId, 'notes').then((ents) => ents.find((e) => e.name === 'todo.md')?.resourceId), [root.id]);
const hash = await win.evaluate((id) => window.kb.textStat(id).then((s) => s.hash), rid);

// agent propose via HTTP
const proposeRes = await fetch(info.url, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'plans.create',
    params: { title: 'e2e改写', ops: [{ kind: 'write', resourceId: rid, content: '# 待办\n已批准写入 BETA\n', expectedHash: hash }] },
  }),
});
const proposeJson = await proposeRes.json();
check('agent propose 返回 plan', !!(proposeJson.result && proposeJson.result.plan && proposeJson.result.plan.planId), JSON.stringify(proposeJson).slice(0, 300));
const planId = proposeJson.result?.plan?.planId;
const contentHash = proposeJson.result?.plan?.contentHash || proposeJson.result?.preview?.contentHash;

const deny = await fetch(info.url, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'plans.approve', params: { planId, contentHash } }),
});
check('agent 直接 approve 被拒 403', deny.status === 403, `status=${deny.status}`);

// UI：打开待批准 → review → approve
await win.click('[data-testid="pending-plans-btn"]');
await win.waitForSelector('[data-testid="pending-plans-dialog"]');
const pendingCount = await win.evaluate(() => window.kb.opsPending().then((p) => p.length));
check('待批准列表含 agent 计划', pendingCount >= 1, `count=${pendingCount}`);

await win.click(`[data-testid="pending-plan-${planId}"]`);
await win.waitForSelector('[data-testid="pending-plan-review"] [data-testid="plan-diff"], [data-testid="pending-plan-review"] .meta');
await win.click('[data-testid="pending-plan-approve"]');
await win.waitForFunction(async () => (await window.kb.opsPending()).length === 0, null, { timeout: 15000 }).catch(() => null);

const disk = fs.readFileSync(path.join(R, 'notes', 'todo.md'), 'utf8');
check('批准后自动执行写入 BETA', disk.includes('BETA'), disk.slice(0, 80));

await win.click('[data-testid="pending-plans-close"]').catch(() => {});
await app.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n计划 e2e：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
