// 端到端：P1 适配器宿主（H1–H8）。在真实应用中：
//   开发者模式安装 SDK 文件适配器模板（JSON 查看器）→ 打开 .json 弹出带范围的授权 → 拒绝一次 → 占位且其他面板正常恢复（含重启）
//   → 查看权限 → 允许 → JSON 树打开、展开状态保存 → 外观切换保持 → 重启恢复 → 撤销 → 占位
//   → 恶意插件读不到授权范围外的文件、绕不过 kbfile 授权、碰不到父窗口、注入不了 HTML
//   → 批量计划（fileops.write）对话框：拒绝 / 批准并写入操作记录
//   → 卸载对话框：保留数据（条目成为“缺少适配器”占位，重装后恢复）/ 删除数据 + 移除条目
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SDK = process.env.KB_ADAPTER_SDK_DIR || path.resolve(ROOT, '../kb-adapter-sdk');
const VERIFY = path.join(ROOT, 'verify');
const TMP = path.join(ROOT, 'e2e/.tmp');
const USERDATA = path.join(TMP, 'userdata-adapters');
const RA = path.join(TMP, 'adapters 资料A');
const RB = path.join(TMP, 'adapters 资料B');
const PLUG = path.join(TMP, 'plugins');
for (const d of [USERDATA, RA, RB, PLUG]) fs.rmSync(d, { recursive: true, force: true });
const put = (p, c) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, c));
put(path.join(RA, 'data/config.json'), JSON.stringify({ name: '工作台', version: 2, items: [{ id: 1, tags: ['a', 'b'] }, { id: 2, tags: [] }], nested: { deep: { flag: true, note: '<b>不是 HTML</b>' } } }, null, 2));
put(path.join(RA, 'data/说明.md'), '# 说明\n\n这是同一个根里的 Markdown（恶意插件不应读到）。\n\nSECRET-MD');
put(path.join(RB, 'other.json'), '{"secret":"SECRET-ROOT-B"}');
put(path.join(RA, 'n/todo.note'), '- 第一行');
fs.mkdirSync(VERIFY, { recursive: true });
const build = (src, name) => {
  const out = path.join(PLUG, name);
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-adapter-plugin.mjs'), src, '--out', out], { stdio: 'inherit' });
  return out;
};
const P_JSON = build(path.join(SDK, 'templates/file-adapter'), 'json-viewer');
const P_EVIL = build(path.join(ROOT, 'e2e/fixtures/plugins/evil'), 'evil');
const P_NOTES = build(path.join(ROOT, 'e2e/fixtures/plugins/notes'), 'notes');
const JV = 'example.json-viewer';
const JA = 'example.json-viewer.reader';

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
async function addRoot(app, win, dir) {
  const n = await win.locator('[data-testid="root-row"]').count();
  await stubOpen(app, dir);
  await win.click('[data-testid="pick-folder"]');
  await win.waitForFunction((k) => document.querySelectorAll('[data-testid="root-row"]').length === k + 1, n);
  return win.evaluate(async (p) => (await window.kb.listRoots()).find((r) => r.path === p).id, dir);
}
const stubOpen = (app, p) =>
  app.evaluate(({ dialog }, x) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [x] });
  }, p);
const openP = (win, rootId, rel, mode) => win.evaluate(([r, p, m]) => window.__kb.openByPath(r, p, m), [rootId, rel, mode]);
const rid = (win, rootId, rel) =>
  win.evaluate(async ([r, p]) => {
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    return (await window.kb.listDir(r, dir)).find((x) => x.relPath === p)?.resourceId;
  }, [rootId, rel]);
const itemOf = (win, adapterId) => win.evaluate((a) => Object.values(window.__kb.items()).find((i) => i.adapterId === a), adapterId);
const placeholderKind = (win, adapterId) => win.evaluate((a) => document.querySelector(`[data-testid="placeholder"][data-adapter-id="${a}"]`)?.dataset.kind ?? null, adapterId);
async function openManager(win, focus) {
  await win.evaluate((f) => window.__kb.openPluginManager(f), focus);
  await win.waitForSelector('[data-testid="plugin-manager"]');
  await win.waitForTimeout(200);
}
async function closeManager(win) {
  await win.click('[data-testid="pm-close"]');
  await win.waitForSelector('[data-testid="plugin-manager"]', { state: 'detached' });
}
async function installDev(app, win, dir, id) {
  await openManager(win);
  await stubOpen(app, dir);
  await win.click('[data-testid="dev-install"]');
  await win.waitForSelector(`[data-testid="pm-plugin-${id}"]`);
  const st = await win.getAttribute(`[data-testid="pm-plugin-${id}"]`, 'data-status');
  await closeManager(win);
  return st;
}
const treeLabels = (win) => win.$$eval('[data-testid="sandbox-view"][data-adapter-id="example.json-viewer.reader"] [role="treeitem"]', (els) => els.map((e) => e.dataset.nodeId + (e.getAttribute('aria-expanded') === 'true' ? '+' : '')));
const waitTree = (win) => win.waitForSelector(`[data-testid="sandbox-view"][data-adapter-id="${JA}"][data-opened="true"] [role="tree"]`, { timeout: 20000 });
const mdOk = (win) => win.locator('[data-testid="reader-markdown"] h1').count();

// ============================================================ 启动 #1
let { app, win } = await launch();
const ra = await addRoot(app, win, RA);
const rb = await addRoot(app, win, RB);
check('注册两个根（A：数据与笔记，B：另一个资料库）', !!ra && !!rb);

// 其他面板：A 根里的 Markdown（内置阅读器）
await openP(win, ra, 'data/说明.md', 'tab');
await win.waitForSelector('[data-testid="reader-markdown"] h1');

// ---- 开发者模式安装（D7）
await openManager(win);
check('未开启开发者模式时不能安装本地插件（按钮禁用，主进程也拒绝）', (await win.locator('[data-testid="dev-install"]').isDisabled()) && (await win.evaluate(() => window.kb.installAdapterPluginFromFolder().then(() => 'ok', (e) => String(e.message)))).includes('开发者模式'));
await win.check('[data-testid="dev-mode-toggle"]');
await win.waitForFunction(() => !document.querySelector('[data-testid="dev-install"]').disabled);
await closeManager(win);
const st = await installDev(app, win, P_JSON, JV);
const dto = (await win.evaluate(() => window.kb.listAdapterPlugins())).find((p) => p.id === 'example.json-viewer');
check('开发者模式安装 SDK 文件适配器模板（JSON 查看器）：engines.workbench ^0.2.0 满足宿主 0.2.0，已启用、尚无授权', st === 'active' && dto?.errors.length === 0 && dto.grants.length === 0 && dto.manifest.engines.workbench === '^0.2.0', JSON.stringify({ st, errors: dto?.errors }));

// ---- 打开 .json → 授权对话框（带范围）
await openP(win, ra, 'data/config.json', 'right');
await win.waitForSelector('[data-testid="perm-dialog"]', { timeout: 10000 });
const dlgText = await win.innerText('[data-testid="perm-dialog"]');
const rootBoxes = await win.$$eval('[data-testid^="perm-root-"]', (els) => els.map((e) => [e.dataset.testid.replace('perm-root-', ''), e.checked]));
check(
  '首次打开时弹出授权对话框：插件名、理由、范围（仅 .json、按文件夹）、显示方式、按根勾选（默认只勾当前文件所在的根）',
  dlgText.includes('JSON 查看器（示例）') && dlgText.includes('读取你打开的 JSON 文件，以树形显示') && /\.json/.test(dlgText) && dlgText.includes('应用内阅读') && rootBoxes.length === 2 && rootBoxes.find(([id]) => id === ra)?.[1] === true && rootBoxes.find(([id]) => id === rb)?.[1] === false,
  JSON.stringify(rootBoxes),
);
await win.waitForTimeout(450); // 等淡入动画结束
await win.screenshot({ path: path.join(VERIFY, 'adapter-grant-dialog.png') });

// ---- 拒绝一次 → 占位，其他面板不受影响
await win.click('[data-testid="perm-deny"]');
await win.waitForSelector(`[data-testid="placeholder"][data-adapter-id="${JA}"][data-kind="permission-denied"]`);
const phText = await win.innerText(`[data-testid="placeholder"][data-adapter-id="${JA}"]`);
check('拒绝 → 面板显示“未授予权限”占位（含“查看权限”“从工作区移除”），Markdown 面板不受影响', /未授予权限/.test(phText) && phText.includes('查看权限') && phText.includes('从工作区移除') && (await mdOk(win)) === 1, phText.replace(/\s+/g, ' ').slice(0, 160));
await win.waitForTimeout(450); // 等淡入动画结束
await win.screenshot({ path: path.join(VERIFY, 'adapter-placeholder.png') });
const deniedItem = await itemOf(win, JA);
check('占位不改写条目：adapterId 仍为 JSON 查看器，面板参数只有 itemId', deniedItem?.sourceKind === 'file' && (await win.evaluate((id) => Object.keys(window.__dock.getPanel(id).params).join(), deniedItem.itemId)) === 'itemId');
await win.evaluate(() => window.__kb.flush());
await app.close();

// ============================================================ 启动 #2：拒绝已记住；其他面板正常恢复
({ app, win } = await launch());
await win.waitForSelector('[data-testid="reader-markdown"] h1');
await win.waitForSelector(`[data-testid="placeholder"][data-adapter-id="${JA}"][data-kind="permission-denied"]`);
await win.waitForTimeout(600);
check('重启：拒绝被记住（不再弹窗），JSON 面板为占位，Markdown 面板与分栏正常恢复', (await win.locator('[data-testid="perm-dialog"]').count()) === 0 && (await mdOk(win)) === 1 && (await win.evaluate(() => window.__dock.groups.length)) === 2);

// ---- 查看权限 → 改为允许
await win.click(`[data-testid="placeholder"][data-adapter-id="${JA}"] [data-testid="placeholder-action-review-permission"]`);
await win.waitForSelector(`[data-testid="pm-plugin-${JV}"].focused`);
check('“查看权限”打开插件管理并定位到该插件，显示“已拒绝”', (await win.getAttribute(`[data-testid="pm-perm-${JA}-read-json"]`, 'data-decision')) === 'denied');
await win.click(`[data-testid="perm-change-${JA}-read-json"]`);
await win.waitForSelector('[data-testid="perm-dialog"]');
if (!(await win.isChecked(`[data-testid="perm-root-${ra}"]`))) await win.check(`[data-testid="perm-root-${ra}"]`);
await win.click('[data-testid="perm-allow"]');
await win.waitForSelector('[data-testid="perm-dialog"]', { state: 'detached' });
await win.waitForFunction(([a]) => document.querySelector(`[data-testid="pm-perm-${a}-read-json"]`)?.dataset.decision === 'granted', [JA]);
const grants = await win.evaluate((p) => window.__kb.grants(p), JV);
check('授权记录是结构化的：按根范围 + 声明指纹（declHash）', grants.length === 1 && grants[0].decision === 'granted' && JSON.stringify(grants[0].rootIds) === JSON.stringify([ra]) && /^[0-9a-f]{8,}$/.test(grants[0].declHash), JSON.stringify(grants[0]));
await closeManager(win);
await waitTree(win);
check('授权后面板自动从占位变为 JSON 树（沙箱 iframe + UiNode 渲染）', (await treeLabels(win)).includes('$+'), JSON.stringify(await treeLabels(win)));

// 展开节点（状态由插件 getState → 宿主校验后写入条目）
const toggle = async (nodeId) => {
  await win.click(`[data-testid="sandbox-view"] [role="treeitem"][data-node-id="${nodeId}"] > .kb-ui-tree-row [data-testid="ui-tree-toggle"]`);
  await win.waitForFunction((n) => document.querySelector(`[data-testid="sandbox-view"] [role="treeitem"][data-node-id="${n}"]`)?.getAttribute('aria-expanded') === 'true', nodeId);
};
await toggle('$.items');
await toggle('$.items[0]');
await toggle('$.nested');
await win.click('[data-testid="sandbox-view"] [data-testid="ui-button"][data-action="toggle-types"]');
await win.waitForTimeout(400);
const labels1 = await treeLabels(win);
const item1 = await itemOf(win, JA);
check('JSON 树可展开；视图状态（v2：expanded/showTypes）写回工作区条目', item1?.state?.v === 2 && ['$', '$.items', '$.items[0]', '$.nested'].every((p) => item1.state.data.expanded.includes(p)) && item1.state.data.showTypes === true, JSON.stringify(item1?.state));
const noteText = await win.innerText('[data-testid="sandbox-view"] [data-node-id="$.nested"]');
check('文件中的 HTML 片段按纯文本显示', noteText.includes('deep') && (await win.locator('[data-testid="sandbox-view"] b').count()) === 0);
check('沙箱 iframe：sandbox="allow-scripts"（无 allow-same-origin），来源 kbplugin://', (await win.getAttribute('[data-testid="sandbox-frame"]', 'sandbox')) === 'allow-scripts' && (await win.getAttribute('[data-testid="sandbox-frame"]', 'src')) === `kbplugin://${JV}/__kb/frame.html`);
await win.waitForTimeout(450); // 等淡入动画结束
await win.screenshot({ path: path.join(VERIFY, 'adapter-json-viewer.png') });

// ---- 外观切换：状态与展开不变，界面跟随主题令牌
const colorOf = () => win.$eval('[data-testid="sandbox-view"] .kb-ui-tree-label', (e) => getComputedStyle(e).color);
const c1 = await colorOf();
await win.evaluate(() => window.__kb.setAppearance({ chrome: 'study', reading: 'bright', scheme: 'light' }));
await win.waitForTimeout(700);
const labels2 = await treeLabels(win);
const c2 = await colorOf();
const item2 = await itemOf(win, JA);
check('外观切换：JSON 树展开状态与条目状态不变，iframe 未重建，颜色跟随主题', JSON.stringify(labels1) === JSON.stringify(labels2) && JSON.stringify(item1.state) === JSON.stringify(item2.state) && c1 !== c2 && (await win.locator('[data-testid="sandbox-frame"]').count()) === 1, `${c1} → ${c2}`);
await win.waitForTimeout(450); // 等淡入动画结束
await win.screenshot({ path: path.join(VERIFY, 'adapter-json-viewer-light.png') });
await win.evaluate(() => window.__kb.setAppearance({ chrome: 'pro', reading: 'pro', scheme: 'dark' }));
await win.waitForTimeout(400);
await win.evaluate(() => window.__kb.flush());
await app.close();

// ============================================================ 启动 #3：重启恢复
({ app, win } = await launch());
await win.waitForSelector('[data-testid="reader-markdown"] h1');
await waitTree(win);
await win.waitForTimeout(500);
const labels3 = await treeLabels(win);
check('重启：不再询问，JSON 树按保存的状态恢复（展开节点、显示类型）', (await win.locator('[data-testid="perm-dialog"]').count()) === 0 && JSON.stringify(labels3) === JSON.stringify(labels1), JSON.stringify(labels3));

// ---- 撤销 → 占位
await openManager(win, JV);
await win.click(`[data-testid="perm-revoke-${JA}-read-json"]`);
await win.waitForFunction(([a]) => document.querySelector(`[data-testid="pm-perm-${a}-read-json"]`)?.dataset.decision === 'denied', [JA]);
await closeManager(win);
await win.waitForSelector(`[data-testid="placeholder"][data-adapter-id="${JA}"][data-kind="permission-denied"]`);
const tokAfterRevoke = await win.evaluate(async ([p, a, r]) => window.kb.pluginFile(p, a, { op: 'readText', resourceId: r }).then(() => 'read', (e) => String(e.message)), [JV, JA, await rid(win, ra, 'data/config.json')]);
check('撤销 → 面板立即变为占位；主进程也拒绝该插件读取', (await mdOk(win)) === 1 && /permission-denied/.test(tokAfterRevoke), tokAfterRevoke.slice(0, 80));
check('撤销后条目与视图状态仍保留（重新授权即恢复）', JSON.stringify((await itemOf(win, JA))?.state) === JSON.stringify(item1.state));
// 重新允许（后续卸载测试用）
await openManager(win, JV);
await win.click(`[data-testid="perm-change-${JA}-read-json"]`);
await win.waitForSelector('[data-testid="perm-dialog"]');
check('撤销后重新允许：不预选任何文件夹（需要用户重新勾选）', (await win.locator('[data-testid="perm-allow"]').isDisabled()) && !(await win.isChecked(`[data-testid="perm-root-${ra}"]`)));
await win.check(`[data-testid="perm-root-${ra}"]`);
await win.click('[data-testid="perm-allow"]');
await closeManager(win);
await waitTree(win);

// ============================================================ 恶意插件
const otherRid = await rid(win, rb, 'other.json');
const mdRid = await rid(win, ra, 'data/说明.md');
put(path.join(RA, 'probe.evil'), JSON.stringify({ targets: { otherRoot: otherRid, wrongExt: mdRid, otherRootUrl: `kbfile://res/${otherRid}/other.json` } }));
await installDev(app, win, P_EVIL, 'test.evil');
await win.waitForTimeout(800); // 等索引看到 probe.evil
let evilRid = null;
for (let i = 0; i < 40 && !evilRid; i++) {
  evilRid = await rid(win, ra, 'probe.evil');
  if (!evilRid) await win.waitForTimeout(250);
}
await openP(win, ra, 'probe.evil', 'below');
await win.waitForSelector('[data-testid="perm-dialog"]');
await win.click('[data-testid="perm-allow"]'); // 只勾选了 A 根
await win.waitForFunction(() => /RESULT: (ALL BLOCKED|LEAKED)/.test(document.querySelector('[data-testid="sandbox-view"][data-plugin-id="test.evil"]')?.innerText ?? ''), null, { timeout: 30000 });
const evil = await win.evaluate(() => {
  const v = document.querySelector('[data-testid="sandbox-view"][data-plugin-id="test.evil"]');
  const rows = [...v.querySelectorAll('.kb-ui-kv dt')].map((dt) => [dt.textContent, dt.nextElementSibling.textContent]);
  return {
    rows,
    text: v.innerText,
    injected: window.__evilInjected,
    evilB: !!document.getElementById('evil-b') || !!document.getElementById('evil-html'),
    imgs: document.querySelectorAll('img[src="x"]').length,
    heading: v.querySelector('.kb-ui-heading')?.textContent,
    notice: v.querySelector('[data-testid="sandbox-notice"]')?.textContent ?? '',
  };
});
const leaked = evil.rows.filter(([, v]) => !v.startsWith('blocked'));
check('恶意插件：越界读取（另一个根 / 同根其他扩展名 / stat / readBytes）全部被主进程拒绝', ['读另一个根的文件', '读同根其他扩展名', 'stat 另一个根', 'readBytes 另一个根'].every((k) => evil.rows.find(([n]) => n === k)?.[1].startsWith('blocked')), JSON.stringify(evil.rows.slice(0, 4)));
check('恶意插件：kbfile://res 与越界/伪造的 kbfile://plugin URL、外网 fetch 全部失败', ['fetch kbfile://res', 'fetch kbfile://plugin 越界', 'img kbfile://plugin 越界', 'img kbfile://res', '伪造令牌', 'fetch 外网'].every((k) => evil.rows.find(([n]) => n === k)?.[1].startsWith('blocked')), JSON.stringify(evil.rows.slice(4, 10)));
check('恶意插件：拿不到 parent.document / top.location / window.kb；伪造的消息身份被忽略', ['parent.document', 'top.location', 'window.kb', '伪造宿主消息'].every((k) => evil.rows.find(([n]) => n === k)?.[1].startsWith('blocked')), JSON.stringify(evil.rows.slice(10)));
check('恶意插件：14 项探测无一泄露，文件内容未出现在界面中', evil.rows.length === 14 && leaked.length === 0 && !evil.text.includes('SECRET-ROOT-B') && !evil.text.includes('SECRET-MD'), JSON.stringify(leaked));
check('恶意插件：HTML 字符串按文本显示，未知节点类型被替换为提示，宿主 DOM 中没有注入的元素', evil.heading?.includes('<img src=x') && evil.text.includes('不支持的界面节点') && !evil.evilB && evil.imgs === 0 && evil.injected === undefined, evil.heading);
check('越界读取被拒绝时面板显示提示', evil.notice.includes('已阻止一次越界读取'), evil.notice.slice(0, 80));
await win.waitForTimeout(450); // 等淡入动画结束
await win.screenshot({ path: path.join(VERIFY, 'adapter-evil-plugin.png') });
const evilItem = await itemOf(win, 'test.evil.reader');
await win.evaluate((id) => window.__dock.getPanel(id).api.close(), evilItem.itemId);

// ============================================================ 批量计划（H8）
await installDev(app, win, P_NOTES, 'test.notes');
await openP(win, ra, 'n/todo.note', 'below');
await win.waitForSelector('[data-testid="perm-dialog"]');
await win.click('[data-testid="perm-allow"]');
await win.waitForSelector('[data-testid="sandbox-view"][data-plugin-id="test.notes"] [data-testid="ui-button"][data-action="append"]');
await win.click('[data-testid="sandbox-view"][data-plugin-id="test.notes"] [data-testid="ui-button"][data-action="append"]');
await win.waitForSelector('[data-testid="perm-dialog"]'); // 首次修改：fileops.write 授权
check('首次提交批量修改时询问 fileops.write 授权', (await win.innerText('[data-testid="perm-dialog"]')).includes('修改文件'));
await win.click('[data-testid="perm-allow"]');
await win.waitForSelector('[data-testid="plan-dialog"]');
const planText = await win.innerText('[data-testid="plan-dialog"]');
check('批量计划对话框：列出每一步（操作、根/相对路径、说明）、执行引擎与操作者', planText.includes('写入') && planText.includes('n/todo.note') && planText.includes('插件 test.notes') && planText.includes('stub'), planText.replace(/\s+/g, ' ').slice(0, 200));
await win.waitForTimeout(450); // 等淡入动画结束
await win.screenshot({ path: path.join(VERIFY, 'adapter-plan-dialog.png') });
await win.click('[data-testid="plan-reject"]');
await win.waitForFunction(() => /user-rejected/.test(document.querySelector('[data-testid="sandbox-view"][data-plugin-id="test.notes"]')?.innerText ?? ''));
check('拒绝计划：文件不变，插件收到 user-rejected', fs.readFileSync(path.join(RA, 'n/todo.note'), 'utf8') === '- 第一行');
await win.click('[data-testid="sandbox-view"][data-plugin-id="test.notes"] [data-testid="ui-button"][data-action="append"]');
await win.waitForSelector('[data-testid="plan-dialog"]');
await win.click('[data-testid="plan-approve"]');
await win.waitForFunction(() => /已执行 1 步/.test(document.querySelector('[data-testid="sandbox-view"][data-plugin-id="test.notes"]')?.innerText ?? ''), null, { timeout: 10000 });
const ops = await win.evaluate(() => window.kb.listOps(3));
check('批准计划：文件被修改，操作记录的操作者为 plugin:test.notes（可撤销）', fs.readFileSync(path.join(RA, 'n/todo.note'), 'utf8').includes('由插件追加') && ops[0]?.actor === 'plugin:test.notes' && ops[0]?.op === 'write', JSON.stringify(ops[0] && { actor: ops[0].actor, op: ops[0].op }));
const notesItem = await itemOf(win, 'test.notes.reader');
await win.evaluate((id) => window.__dock.getPanel(id).api.close(), notesItem.itemId);

// ============================================================ 卸载（H7）
await openManager(win, JV);
await win.click(`[data-testid="pm-uninstall-${JV}"]`);
await win.waitForSelector('[data-testid="uninstall-dialog"]');
const unText = await win.innerText('[data-testid="uninstall-dialog"]');
check(
  '卸载对话框：保留/删除数据二选一（默认保留），列出插件存储、授权、网站数据（无网页面板 → 无），“同时移除条目”默认不勾选',
  (await win.isChecked('[data-testid="uninstall-keep"]')) && !(await win.isChecked('[data-testid="uninstall-remove-items"]')) && /插件存储：1 项/.test(unText) && /授权记录：1 条/.test(unText) && unText.includes('网站数据：无') && /1 个条目/.test(unText),
  unText.replace(/\s+/g, ' ').slice(0, 240),
);
await win.waitForTimeout(450); // 等淡入动画结束
await win.screenshot({ path: path.join(VERIFY, 'adapter-uninstall-dialog.png') });
await win.click('[data-testid="uninstall-confirm"]');
await win.waitForSelector('[data-testid="uninstall-dialog"]', { state: 'detached' });
await closeManager(win);
await win.waitForSelector(`[data-testid="placeholder"][data-adapter-id="${JA}"][data-kind="adapter-missing"]`);
const keptItem = await itemOf(win, JA);
check('卸载（保留数据）：面板变为“缺少适配器”占位，条目与状态保留，其他面板不受影响', JSON.stringify(keptItem?.state) === JSON.stringify(item1.state) && (await mdOk(win)) === 1);
check('“缺少适配器”占位提供“安装插件”“用内置阅读器打开（仅本次）”“从工作区移除”', (await win.locator(`[data-testid="placeholder"][data-adapter-id="${JA}"] [data-testid="placeholder-action-install-plugin"]`).count()) === 1 && (await win.locator(`[data-testid="placeholder"][data-adapter-id="${JA}"] [data-testid="placeholder-action-remove-item"]`).count()) === 1);
if (await win.locator(`[data-testid="placeholder"][data-adapter-id="${JA}"] [data-testid="placeholder-action-open-with-default"]`).count()) {
  await win.click(`[data-testid="placeholder"][data-adapter-id="${JA}"] [data-testid="placeholder-action-open-with-default"]`);
  await win.waitForSelector('[data-testid="override-notice"]');
  check('“用内置阅读器打开（仅本次）”不改写条目的 adapterId 与状态', JSON.stringify(await itemOf(win, JA)) === JSON.stringify(keptItem));
  await win.click('[data-testid="override-notice"] button');
} else check('“用内置阅读器打开（仅本次）”（无可用内置阅读器时不显示）', true);
await win.evaluate(() => window.__kb.flush());
await app.close();

// ============================================================ 启动 #4：重装恢复；删除数据 + 移除条目
({ app, win } = await launch());
await win.waitForSelector(`[data-testid="placeholder"][data-adapter-id="${JA}"][data-kind="adapter-missing"]`);
check('重启：卸载后的条目仍为占位', (await mdOk(win)) === 1);
await installDev(app, win, P_JSON, JV);
await waitTree(win);
await win.waitForTimeout(400);
check('重新安装（之前保留了数据）：授权与存储恢复，面板自动恢复到原来的展开状态', JSON.stringify(await treeLabels(win)) === JSON.stringify(labels1) && (await win.locator('[data-testid="perm-dialog"]').count()) === 0, JSON.stringify(await treeLabels(win)));
await openManager(win, JV);
await win.click(`[data-testid="pm-uninstall-${JV}"]`);
await win.waitForSelector('[data-testid="uninstall-dialog"]');
await win.check('[data-testid="uninstall-delete"]');
await win.check('[data-testid="uninstall-remove-items"]');
await win.click('[data-testid="uninstall-confirm"]');
await win.waitForSelector('[data-testid="uninstall-dialog"]', { state: 'detached' });
await closeManager(win);
await win.waitForFunction((a) => !Object.values(window.__kb.items()).some((i) => i.adapterId === a), JA);
await win.waitForTimeout(400);
const ws = await win.evaluate(async () => window.kb.getWorkspace(await window.kb.getCurrentWorkspaceId()));
check(
  '卸载（删除数据 + 移除条目）：面板与条目从工作区删除，存储/授权清空，其他面板保留',
  !ws.items.some((i) => i.adapterId === JA) && (await win.locator(`[data-testid="placeholder"][data-adapter-id="${JA}"]`).count()) === 0 && (await mdOk(win)) === 1 && !(await win.evaluate(() => window.kb.listAdapterPlugins())).some((p) => p.id === 'example.json-viewer'),
  ws.items.map((i) => i.adapterId).join(','),
);
check('全程渲染进程无未处理错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
await app.close();

fs.writeFileSync(path.join(VERIFY, 'e2e-adapters-result.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\nE2E（适配器宿主）: ${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
