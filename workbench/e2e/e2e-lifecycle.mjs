// 端到端（第 9 轮）：插件停用 / 缺失（插件文件被删）/ 升级（版本号与清单字段变化）时，工作区条目保留占位与可迁移状态。
//   夹具 e2e/fixtures/plugins/stateful（.stv 计数器），构建时改写 manifest 得到三个版本：
//     v1 0.1.0 stateSchemaVersion 1 { count }
//     v2 0.2.0 stateSchemaVersion 2 { clicks }，fs.read 扩展名增加 stv2（清单字段变化 → declHash 变化 → 重新询问授权）；有 v1→v2 迁移
//     v3 0.3.0 stateSchemaVersion 3 { total }，故意没有 v2→v3 迁移 → 迁移失败：保留原状态并提示，不丢数据
//     v4 0.4.0 / v5 0.5.0：恢复旧状态时直接抛错 → 宿主兜底保留（v5 验证已有保留时再保留一份，提示条「旧状态已保留，插件新版本无法读取」）
//   每种情况都跨重启检查（条目与状态写在数据库里）。
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, 'e2e/.tmp');
const USERDATA = path.join(TMP, 'userdata-lifecycle');
const RA = path.join(TMP, 'lifecycle 资料');
const PLUG = path.join(TMP, 'plugins-lifecycle');
for (const d of [USERDATA, RA, PLUG]) fs.rmSync(d, { recursive: true, force: true });
const put = (p, c) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, c));
put(path.join(RA, 'a.stv'), 'counter');
put(path.join(RA, '说明.md'), '# 其他面板\n\n不受插件状态影响。');

const PID = 'test.stateful';
const AID = 'test.stateful.reader';
function buildVariant(v, version, exts) {
  const src = path.join(PLUG, `src-v${v}`);
  fs.cpSync(path.join(ROOT, 'e2e/fixtures/plugins/stateful'), src, { recursive: true });
  const m = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
  m.version = version;
  const a = m.contributes.adapters[0];
  a.stateSchemaVersion = v;
  a.permissions[0].extensions = exts;
  a.match.file.extensions = exts;
  if (v === 2) a.stateMigrations = [{ from: 1, to: 2, note: 'count → clicks' }];
  if (v === 5) {
    // v5：同样不认识任何旧状态（v4 的 { score } 也读不了）——验证已有保留的旧状态时再保留一份、两份都不丢
    const f = path.join(src, 'src/index.ts');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace("3: 'total' }", "3: 'total', 4: 'score', 5: 'points' }").replace('function restore(data: unknown, v: number): S {', "function restore(data: unknown, v: number): S {\n  if (v < CUR) throw new Error('v5 不认识旧状态');"));
  }
  if (v === 4) {
    // v4：模拟写得不严谨的插件——恢复旧状态时直接抛错（R4：宿主兜底保留旧状态）
    const f = path.join(src, 'src/index.ts');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace("3: 'total' }", "3: 'total', 4: 'score' }").replace('function restore(data: unknown, v: number): S {', "function restore(data: unknown, v: number): S {\n  if (v < CUR) throw new Error('v4 不认识旧状态');"));
  }
  fs.writeFileSync(path.join(src, 'manifest.json'), JSON.stringify(m, null, 2));
  const out = path.join(PLUG, `v${v}`);
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-adapter-plugin.mjs'), src, '--out', out], { stdio: 'inherit' });
  return out;
}
const V1 = buildVariant(1, '0.1.0', ['stv']);
const V2 = buildVariant(2, '0.2.0', ['stv', 'stv2']);
const V3 = buildVariant(3, '0.3.0', ['stv', 'stv2']);
const V4 = buildVariant(4, '0.4.0', ['stv', 'stv2']);
const V5 = buildVariant(5, '0.5.0', ['stv', 'stv2']);
const VERIFY = path.join(ROOT, 'verify');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? '  — ' + detail : ''}`);
}
const consoleErrors = [];
async function launch() {
  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'], cwd: ROOT, env: { ...process.env, KB_USER_DATA: USERDATA } });
  const win = await app.firstWindow();
  win.on('console', (m) => {
    if (m.type() === 'error' && !/403|ERR_|Content Security Policy|Refused to/.test(m.text())) consoleErrors.push(m.text());
  });
  await win.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800));
  await win.waitForFunction(() => window.__layoutRestored === true, null, { timeout: 20000 });
  await win.waitForTimeout(500);
  return { app, win };
}
const stubOpen = (app, p) =>
  app.evaluate(({ dialog }, x) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [x] });
  }, p);
async function openManager(win, focus) {
  await win.evaluate((f) => window.__kb.openPluginManager(f), focus);
  await win.waitForSelector('[data-testid="plugin-manager"]');
  await win.waitForTimeout(200);
}
async function closeManager(win) {
  await win.click('[data-testid="pm-close"]');
  await win.waitForSelector('[data-testid="plugin-manager"]', { state: 'detached' });
}
async function installDev(app, win, dir, keepOpen = false) {
  await openManager(win);
  await stubOpen(app, dir);
  await win.click('[data-testid="dev-install"]');
  await win.waitForFunction(([id, ver]) => (document.querySelector(`[data-testid="pm-plugin-${id}"]`)?.innerText ?? '').includes(ver), [PID, JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version], { timeout: 10000 });
  if (!keepOpen) await closeManager(win);
}
const itemOf = (win) => win.evaluate((a) => Object.values(window.__kb.items()).find((i) => i.adapterId === a) ?? null, AID);
const dbItem = (win) => win.evaluate(async (a) => (await window.kb.getWorkspace(await window.kb.getCurrentWorkspaceId())).items.find((i) => i.adapterId === a) ?? null, AID);
const phKind = (win) => win.evaluate((a) => document.querySelector(`[data-testid="placeholder"][data-adapter-id="${a}"]`)?.dataset.kind ?? null, AID);
const VIEW = `[data-testid="sandbox-view"][data-adapter-id="${AID}"]`;
const viewText = (win) => win.evaluate((s) => document.querySelector(s)?.innerText ?? '', VIEW);
const waitHeading = async (win, re) => {
  try {
    await win.waitForFunction(([s, src]) => new RegExp(src).test(document.querySelector(s)?.innerText ?? ''), [VIEW, re.source], { timeout: 20000 });
  } catch (e) {
    console.log('当前面板文本：', JSON.stringify(await viewText(win)), '占位：', await phKind(win));
    throw e;
  }
};
const mdOk = (win) => win.locator('[data-testid="reader-markdown"] h1').count();
const flushClose = async (app, win) => {
  await win.evaluate(() => window.__kb.flush());
  await app.close();
};

// ============================================================ 启动 #1：安装 v1，计数到 3
let { app, win } = await launch();
await stubOpen(app, RA);
await win.click('[data-testid="pick-folder"]');
await win.waitForFunction(() => document.querySelectorAll('[data-testid="root-row"]').length === 1);
const ra = await win.evaluate(async () => (await window.kb.listRoots())[0].id);
await win.evaluate(([r]) => window.__kb.openByPath(r, '说明.md', 'tab'), [ra]);
await win.waitForSelector('[data-testid="reader-markdown"] h1');
await openManager(win);
await win.check('[data-testid="dev-mode-toggle"]');
await win.waitForFunction(() => !document.querySelector('[data-testid="dev-install"]').disabled);
await closeManager(win);
await installDev(app, win, V1);
await win.evaluate(([r]) => window.__kb.openByPath(r, 'a.stv', 'right'), [ra]);
await win.waitForSelector('[data-testid="perm-dialog"]', { timeout: 10000 });
await win.click('[data-testid="perm-allow"]');
await waitHeading(win, /版本 v1 · 计数 0/);
for (let i = 0; i < 3; i++) await win.click(`${VIEW} [data-testid="ui-button"][data-action="inc"]`);
await waitHeading(win, /版本 v1 · 计数 3/);
await win.waitForTimeout(600);
const s1 = (await itemOf(win))?.state;
check('v1：视图状态带版本号写入条目 {v:1, data:{count:3}}', JSON.stringify(s1) === JSON.stringify({ v: 1, data: { count: 3 } }), JSON.stringify(s1));

// ============================================================ 停用
await openManager(win, PID);
await win.click(`[data-testid="pm-toggle-${PID}"]`);
await win.waitForFunction((id) => document.querySelector(`[data-testid="pm-plugin-${id}"]`)?.dataset.status === 'disabled', PID);
await closeManager(win);
await win.waitForSelector(`[data-testid="placeholder"][data-adapter-id="${AID}"][data-kind="adapter-disabled"]`, { timeout: 10000 });
const phDisabled = await win.innerText(`[data-testid="placeholder"][data-adapter-id="${AID}"]`);
check('停用：面板变为“适配器已停用”占位，条目与状态 {v:1,count:3} 原样保留，其他面板不受影响', JSON.stringify((await itemOf(win))?.state) === JSON.stringify(s1) && (await mdOk(win)) === 1, phDisabled.replace(/\s+/g, ' ').slice(0, 120));
await flushClose(app, win);
({ app, win } = await launch());
await win.waitForSelector(`[data-testid="placeholder"][data-adapter-id="${AID}"][data-kind="adapter-disabled"]`, { timeout: 10000 });
check('停用后重启：仍为占位，数据库中的条目状态未变', JSON.stringify((await dbItem(win))?.state) === JSON.stringify(s1) && (await mdOk(win)) === 1, JSON.stringify((await dbItem(win))?.state));
await openManager(win, PID);
await win.click(`[data-testid="pm-toggle-${PID}"]`);
await win.waitForFunction((id) => document.querySelector(`[data-testid="pm-plugin-${id}"]`)?.dataset.status === 'active', PID);
await closeManager(win);
await waitHeading(win, /版本 v1 · 计数 3/);
check('重新启用：面板自动恢复，计数 3', /版本 v1 · 计数 3/.test(await viewText(win)));
await flushClose(app, win);

// ============================================================ 缺失：插件文件被删除（应用未运行时）
const pluginDir = path.join(USERDATA, 'plugins', PID);
check('插件安装在数据目录 plugins/<id>', fs.existsSync(path.join(pluginDir, 'manifest.json')));
fs.rmSync(pluginDir, { recursive: true, force: true });
({ app, win } = await launch());
await win.waitForSelector(`[data-testid="placeholder"][data-adapter-id="${AID}"][data-kind="adapter-missing"]`, { timeout: 10000 });
const phMissing = await win.innerText(`[data-testid="placeholder"][data-adapter-id="${AID}"]`);
check('插件文件被删除：面板为“缺少适配器”占位，条目与状态保留，其他面板正常', JSON.stringify((await itemOf(win))?.state) === JSON.stringify(s1) && (await mdOk(win)) === 1 && !(await win.evaluate(() => window.kb.listAdapterPlugins())).some((p) => p.id === 'test.stateful'), phMissing.replace(/\s+/g, ' ').slice(0, 120));
await win.waitForTimeout(800);
check('缺失期间的自动保存不会删掉条目或改写状态', JSON.stringify((await dbItem(win))?.state) === JSON.stringify(s1));
await installDev(app, win, V1);
await waitHeading(win, /版本 v1 · 计数 3/);
check('重新安装同一版本：授权保留（不再询问），面板恢复到计数 3', (await win.locator('[data-testid="perm-dialog"]').count()) === 0 && /计数 3/.test(await viewText(win)));

// ============================================================ 升级 v2：版本号与清单字段（扩展名）变化 + 迁移成功
await installDev(app, win, V2, true);
await win.waitForSelector('[data-testid="perm-dialog"]', { timeout: 15000 });
const permV2 = await win.innerText('[data-testid="perm-dialog"]');
check('升级到 0.2.0：权限声明变化（扩展名 + stv2）→ 重新询问授权', /stv2/.test(permV2), permV2.replace(/\s+/g, ' ').slice(0, 160));
if (!(await win.isChecked(`[data-testid="perm-root-${ra}"]`))) await win.check(`[data-testid="perm-root-${ra}"]`);
await win.click('[data-testid="perm-allow"]');
await win.waitForSelector('[data-testid="perm-dialog"]', { state: 'detached' });
await closeManager(win);
await waitHeading(win, /版本 v2 · 计数 3/);
check('升级 v1→v2：调用插件的状态迁移钩子（count → clicks），计数仍为 3，无“已重置”提示', /版本 v2 · 计数 3/.test(await viewText(win)) && !/已重置/.test(await viewText(win)) && (await win.locator(`${VIEW} [data-testid="sandbox-notice"]`).count()) === 0);
await win.click(`${VIEW} [data-testid="ui-button"][data-action="inc"]`);
await waitHeading(win, /版本 v2 · 计数 4/);
await win.waitForTimeout(600);
const s2 = (await itemOf(win))?.state;
check('迁移后保存：条目状态变为 {v:2, data:{clicks:4}}', JSON.stringify(s2) === JSON.stringify({ v: 2, data: { clicks: 4 } }), JSON.stringify(s2));
await flushClose(app, win);

// ============================================================ 升级 v3：迁移失败 → 保留原状态并提示
({ app, win } = await launch());
await waitHeading(win, /版本 v2 · 计数 4/);
await installDev(app, win, V3);
// R5 产品决定：升级后不自动重载，面板上显示提示条「插件已更新，点此重新加载」
const upd = await win.waitForSelector(`${VIEW} [data-testid="plugin-updated-banner"]`, { timeout: 10000 }).then(() => true, () => false);
const updText = upd ? await win.innerText(`${VIEW} [data-testid="plugin-updated-banner"]`) : '';
check('R5：升级后面板不自动重载（仍是 v2），显示提示条「插件已更新，点此重新加载」', upd && /插件已更新，点此重新加载/.test(updText) && /版本 v2 · 计数 4/.test(await viewText(win)), updText.replace(/\s+/g, ' ').slice(0, 120));
await win.screenshot({ path: path.join(VERIFY, 'lifecycle-plugin-updated.png') });
await win.click(`${VIEW} [data-testid="plugin-updated-reload"]`);
await waitHeading(win, /版本 v3 · 计数 0/);
check('点提示条后重新加载为 v3，提示条消失', (await win.locator(`${VIEW} [data-testid="plugin-updated-banner"]`).count()) === 0 && /版本 v3/.test(await viewText(win)));
await flushClose(app, win);
({ app, win } = await launch());
await waitHeading(win, /版本 v3 · 计数 0/);
const t3 = await viewText(win);
check('升级 v2→v3 缺少迁移步骤：面板提示“旧版本的视图状态无法迁移，已原样保留”，不报错、不变成占位', /无法迁移，已原样保留/.test(t3) && /缺少 v2→v3 的迁移步骤/.test(t3) && (await phKind(win)) === null, t3.replace(/\s+/g, ' ').slice(0, 160));
check('迁移失败后未保存前：条目里仍是原状态 {v:2, clicks:4}', JSON.stringify((await dbItem(win))?.state) === JSON.stringify(s2), JSON.stringify((await dbItem(win))?.state));
await win.click(`${VIEW} [data-testid="ui-button"][data-action="inc"]`);
await waitHeading(win, /版本 v3 · 计数 1/);
await win.waitForTimeout(600);
const s3 = (await itemOf(win))?.state;
check('迁移失败后继续使用并保存：旧状态原样随新状态保存（legacy = {v:2, data:{clicks:4}}），没有丢', s3?.v === 3 && s3.data.total === 1 && JSON.stringify(s3.data.legacy?.data) === JSON.stringify({ clicks: 4 }) && s3.data.legacy?.v === 2, JSON.stringify(s3));
await flushClose(app, win);
({ app, win } = await launch());
await waitHeading(win, /版本 v3 · 计数 1/);
check('重启后：仍提示已保留旧状态，legacy 数据仍在', /已原样保留/.test(await viewText(win)) && JSON.stringify((await dbItem(win))?.state?.data?.legacy?.data) === JSON.stringify({ clicks: 4 }));

// ============================================================ R4：插件恢复状态时抛错 → 宿主兜底保留旧状态，之后的保存不覆盖
const s3saved = (await dbItem(win))?.state;
await installDev(app, win, V4);
await win.waitForSelector(`${VIEW} [data-testid="plugin-updated-banner"]`, { timeout: 10000 });
await win.click(`${VIEW} [data-testid="plugin-updated-reload"]`);
await waitHeading(win, /版本 v4 · 计数 0/);
const pb = await win.waitForSelector(`${VIEW} [data-testid="preserved-banner"]`, { timeout: 5000 }).then(() => true, () => false);
await win.waitForTimeout(600);
let st4 = (await dbItem(win))?.state;
check('R4：插件恢复旧状态失败（抛错）→ 宿主原样保留旧状态并提示', pb && JSON.stringify(st4?.preserved?.data) === JSON.stringify(s3saved?.data) && st4?.preserved?.v === 3, JSON.stringify(st4?.preserved ?? null).slice(0, 160));
await win.screenshot({ path: path.join(VERIFY, 'lifecycle-preserved.png') });
await win.click(`${VIEW} [data-testid="ui-button"][data-action="inc"]`);
await waitHeading(win, /版本 v4 · 计数 1/);
await win.waitForTimeout(800);
st4 = (await dbItem(win))?.state;
check('R4：继续使用并保存后，新状态写入，旧状态仍保留（没有被覆盖）', st4?.v === 4 && st4.data?.score === 1 && JSON.stringify(st4.preserved?.data) === JSON.stringify(s3saved?.data), JSON.stringify(st4).slice(0, 200));
await flushClose(app, win);
({ app, win } = await launch());
await waitHeading(win, /版本 v4 · 计数 1/);
st4 = (await dbItem(win))?.state;
check('R4：重启后提示仍在、保留的旧状态仍在', (await win.locator(`${VIEW} [data-testid="preserved-banner"]`).count()) === 1 && JSON.stringify(st4?.preserved?.data) === JSON.stringify(s3saved?.data));
const bannerText4 = await win.innerText(`${VIEW} [data-testid="preserved-banner"]`).catch(() => '');
check('提示条文案：「旧状态已保留，插件新版本无法读取」+「丢弃旧状态」', /旧状态已保留，插件新版本无法读取/.test(bannerText4) && /丢弃旧状态/.test(bannerText4), bannerText4.replace(/\s+/g, ' '));

// ============================================================ 产品决定 6：点「重新加载」后新版本仍读不了 → 提示条，不悄悄回到默认视图；已保留的旧状态不丢
const s4saved = st4;
await installDev(app, win, V5);
await win.waitForSelector(`${VIEW} [data-testid="plugin-updated-banner"]`, { timeout: 10000 });
await win.click(`${VIEW} [data-testid="plugin-updated-reload"]`);
await waitHeading(win, /版本 v5 · 计数 0/);
const pb5 = await win.waitForSelector(`${VIEW} [data-testid="preserved-banner"]`, { timeout: 5000 }).then(() => true, () => false);
const bannerText5 = pb5 ? await win.innerText(`${VIEW} [data-testid="preserved-banner"]`) : '';
await win.waitForTimeout(600);
let st5 = (await dbItem(win))?.state;
check('重新加载为 v5、读不了当前状态：面板显示「旧状态已保留，插件新版本无法读取」和「丢弃旧状态」', pb5 && /旧状态已保留，插件新版本无法读取/.test(bannerText5) && (await win.locator(`${VIEW} [data-testid="preserved-discard"]`).count()) === 1, bannerText5.replace(/\s+/g, ' '));
check('已有保留的旧状态时再保留一份：v4 的当前状态成为新的保留，v3 的旧状态挪进 earlier，两份都在', st5?.preserved?.v === 4 && JSON.stringify(st5.preserved.data) === JSON.stringify(s4saved?.data) && st5.preserved.earlier?.[0]?.v === 3 && JSON.stringify(st5.preserved.earlier[0].data) === JSON.stringify(s3saved?.data), JSON.stringify(st5?.preserved ?? null).slice(0, 240));
await win.waitForTimeout(400);
await win.screenshot({ path: path.join(VERIFY, 'lifecycle-reload-preserved.png') });
await flushClose(app, win);
({ app, win } = await launch());
await waitHeading(win, /版本 v5 · 计数 0/);
st5 = (await dbItem(win))?.state;
check('重启后：提示条仍在，两份旧状态仍在', (await win.locator(`${VIEW} [data-testid="preserved-banner"]`).count()) === 1 && st5?.preserved?.v === 4 && st5.preserved.earlier?.length === 1);
await win.click(`${VIEW} [data-testid="preserved-discard"]`);
await win.waitForTimeout(800);
st5 = (await dbItem(win))?.state ?? null;
check('用户点“丢弃旧状态”后才移除（两份都删，插件还没保存过新状态 → 回到默认状态）', !st5?.preserved && (await win.locator(`${VIEW} [data-testid="preserved-banner"]`).count()) === 0 && /版本 v5 · 计数 0/.test(await viewText(win)), JSON.stringify(st5));
await win.click(`${VIEW} [data-testid="ui-button"][data-action="inc"]`);
await waitHeading(win, /版本 v5 · 计数 1/);
await win.waitForTimeout(800);
st5 = (await dbItem(win))?.state;
check('丢弃后继续使用：保存 v5 新状态，不再提示', st5?.v === 5 && st5.data?.points === 1 && !st5.preserved && (await win.locator(`${VIEW} [data-testid="preserved-banner"]`).count()) === 0, JSON.stringify(st5));
check('全程渲染进程无未处理错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
await app.close();

fs.writeFileSync(path.join(TMP, 'e2e-lifecycle-result.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\nE2E（插件停用/缺失/升级）: ${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
