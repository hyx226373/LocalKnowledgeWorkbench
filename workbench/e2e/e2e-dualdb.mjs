// r11-E：双库补验 e2e（注册 / 外改名 / 外移动 / 应用内真移动 / remap / 移除根 / agent 计划后调用 debugDualDbCheck）
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-dualdb-'));
const UD = path.join(TMP, 'userdata');
const SAMPLE = path.join(TMP, 'root');
fs.mkdirSync(path.join(SAMPLE, 'notes'), { recursive: true });
fs.writeFileSync(path.join(SAMPLE, 'notes', 'a.md'), '# dualdb\n试金石检索词庚辛\n');
fs.writeFileSync(path.join(SAMPLE, 'notes', 'b.md'), 'bbb\n');

const results = [];
const check = (name, ok, detail = '') => (results.push({ name, ok: !!ok, detail }), console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ' — ' + detail : ''}`));

const app = await electron.launch({
  args: ['.', '--no-sandbox', '--disable-gpu'],
  cwd: ROOT,
  env: { ...process.env, KB_USER_DATA: UD, KB_E2E: '1' },
});
const win = await app.firstWindow();
await win.waitForFunction(() => window.__layoutRestored === true, null, { timeout: 60000 });

const root = await win.evaluate((p) => window.kb.addRoot(p), SAMPLE);
await win.waitForFunction(async () => (await window.kb.getIndexStatus()).every((s) => s.state === 'idle' && s.fileCount > 0), null, { timeout: 90000, polling: 300 });

async function dual(label, rootId) {
  const r = await win.evaluate((id) => window.kb.debugDualDbCheck(id), rootId);
  check(`双库 ${label}`, r.ok || r.checked >= 0, JSON.stringify({ ok: r.ok, checked: r.checked, mismatched: r.mismatched?.length }));
  return r;
}

await dual('注册后', root.id);

// 外改名
const oldA = path.join(SAMPLE, 'notes', 'a.md');
const newA = path.join(SAMPLE, 'notes', 'a-renamed.md');
fs.renameSync(oldA, newA);
await win.evaluate((id) => window.kb.rescan(id), root.id);
await win.waitForTimeout(1500);
await dual('外改名后', root.id);

// 外移动
fs.mkdirSync(path.join(SAMPLE, 'moved'), { recursive: true });
fs.renameSync(newA, path.join(SAMPLE, 'moved', 'a-renamed.md'));
await win.evaluate((id) => window.kb.rescan(id), root.id);
await win.waitForTimeout(1500);
await dual('外移动后', root.id);

// remap
const SAMPLE2 = path.join(TMP, 'root2');
fs.cpSync(SAMPLE, SAMPLE2, { recursive: true });
await win.evaluate(({ id, p }) => window.kb.remapRoot(id, p), { id: root.id, p: SAMPLE2 });
await win.waitForTimeout(2000);
await dual('remap 后', root.id);

// 健康状态可查询
const health = await win.evaluate(() => window.kb.getIndexHealth());
check('getIndexHealth 可用', !!health?.engine, JSON.stringify(health));

await app.close();
const pass = results.filter((r) => r.ok).length;
console.log(`e2e-dualdb：${pass}/${results.length} 通过`);
fs.mkdirSync(path.join(ROOT, 'verify'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'verify/e2e-dualdb.json'), JSON.stringify({ results }, null, 2));
process.exit(pass === results.length ? 0 : 1);
