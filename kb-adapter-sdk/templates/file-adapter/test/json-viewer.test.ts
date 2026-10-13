/**
 * 文件适配器模板单测（node:test + 模拟宿主）。运行：npm test（仓库根目录）
 * 对应 docs/验收示例.md 中「A. 文件适配器」各条。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockHost, makeStubTextPlugin, DARK_THEME, type MockResource } from '@kb-workbench/adapter-sdk/mock-host';
import { validateAdapterManifest } from '@kb-workbench/adapter-sdk/policy';
import type { FileWorkspaceItem } from '@kb-workbench/adapter-sdk';
import plugin, { ADAPTER_ID, buildTree, restoreJsonViewerState, manifest } from '../src/index.js';

const resources: MockResource[] = [
  { resourceId: 'r-json', rootId: 'rootA', name: 'config.json', text: JSON.stringify({ name: 'kb', items: [1, 2, { deep: true }], meta: { v: 2 } }) },
  { resourceId: 'r-json-b', rootId: 'rootB', name: 'other.json', text: '{"x":1}' },
  { resourceId: 'r-bad', rootId: 'rootA', name: 'broken.json', text: '{"x": ' },
  { resourceId: 'r-txt', rootId: 'rootA', name: 'readme.txt', text: 'hello' },
];
const jsonItem = (id: string, ref: string, state?: FileWorkspaceItem['state']): FileWorkspaceItem => ({ itemId: id, sourceKind: 'file', adapterId: ADAPTER_ID, ref, displayMode: 'in-app-reader', state });
const txtItem: FileWorkspaceItem = { itemId: 'i-txt', sourceKind: 'file', adapterId: 'stub.text.reader', ref: 'r-txt', displayMode: 'in-app-reader' };

test('manifest 通过校验，displayMode 诚实', () => {
  assert.deepEqual(validateAdapterManifest(manifest), []);
});

test('授权提示：展示且范围限定（只读、扩展名、文件夹）', async () => {
  const host = createMockHost({ resources, phase: 1 });
  await host.install(plugin);
  host.addItem(jsonItem('i1', 'r-json'));
  const p = await host.openItem('i1');
  assert.equal(host.prompts.length, 1);
  const pr = host.prompts[0]!;
  assert.equal(pr.permission.kind, 'fs.read');
  assert.ok(pr.scopeLines.some((l) => l.includes('勾选的已注册文件夹')));
  assert.ok(pr.scopeLines.some((l) => l.includes('仅限扩展名：json')));
  assert.equal(p.displayModeLabel, '内嵌渲染 · 应用内阅读（沙箱）');
  assert.equal(p.title, 'config.json');
  assert.match(p.text(), /items \[3\]/);
});

test('ask-per-root：只授权 rootA 时，rootB 的文件显示权限占位，rootA 正常', async () => {
  const host = createMockHost({ resources, phase: 1, prompt: () => ({ grant: true, rootIds: ['rootA'] }) });
  await host.install(plugin);
  host.addItem(jsonItem('a', 'r-json'));
  host.addItem(jsonItem('b', 'r-json-b'));
  const [a, b] = await host.openWorkspace();
  assert.equal(a!.placeholder, null);
  assert.equal(b!.placeholder?.kind, 'permission-denied');
  assert.match(b!.placeholder!.message, /文件夹未授权/);
});

test('拒绝权限 → 占位；同一工作区的其他面板照常恢复', async () => {
  const host = createMockHost({ resources, phase: 1, prompt: (r) => (r.pluginId === manifest.id ? 'deny' : 'grant') });
  await host.install(plugin);
  await host.install(makeStubTextPlugin());
  host.addItem(jsonItem('i1', 'r-json'));
  host.addItem(txtItem);
  const [j, t] = await host.openWorkspace();
  assert.equal(j!.placeholder?.kind, 'permission-denied');
  assert.deepEqual(j!.placeholder?.actions, ['review-permission', 'remove-item']);
  assert.equal(t!.placeholder, null);
  assert.equal(t!.text(), 'hello');
  // 拒绝被记住：重启后不再反复弹窗，仍是占位
  const { host: h2, panels } = await host.restart();
  assert.equal(h2.prompts.length, 0);
  assert.equal(panels.find((p) => p.itemId === 'i1')!.placeholder?.kind, 'permission-denied');
});

test('状态在重启后恢复；主题切换不丢状态', async () => {
  const host = createMockHost({ resources, phase: 1 });
  await host.install(plugin);
  host.addItem(jsonItem('i1', 'r-json'));
  const p = await host.openItem('i1');
  p.click('toggle', '$.items');
  p.click('toggle', '$.items[2]');
  assert.ok(p.saveRequests >= 2);
  assert.match(p.text(), /deep true/);

  host.setTheme(DARK_THEME);
  assert.deepEqual(p.instance!.getState(), { expanded: ['$', '$.items', '$.items[2]'], showTypes: false });
  assert.match(p.text(), /deep true/);

  const { host: h2, panels } = await host.restart();
  assert.equal(h2.prompts.length, 0, '已授权，重启不再询问');
  const p2 = panels[0]!;
  assert.equal(p2.stateResetNotice, false);
  assert.deepEqual(p2.instance!.getState(), { expanded: ['$', '$.items', '$.items[2]'], showTypes: false });
  assert.match(p2.text(), /deep true/);
  assert.deepEqual(h2.getItem('i1')!.state, { v: 2, data: { expanded: ['$', '$.items', '$.items[2]'], showTypes: false } });
});

test('状态迁移 v1→v2；改坏的状态原样保留（不丢数据）；过新的状态由宿主重置', async () => {
  assert.deepEqual(restoreJsonViewerState({ open: ['$', '$.meta'] }, 1), { expanded: ['$', '$.meta'], showTypes: false });
  assert.deepEqual(restoreJsonViewerState({ expanded: 'oops', showTypes: false }, 2), { expanded: ['$'], showTypes: false, legacy: { v: 2, data: { expanded: 'oops', showTypes: false }, error: '状态格式无法识别' } });

  const host = createMockHost({ resources, phase: 1 });
  await host.install(plugin);
  host.addItem(jsonItem('old', 'r-json', { v: 1, data: { open: ['$', '$.meta'] } }));
  host.addItem(jsonItem('bad', 'r-json', { v: 2, data: { expanded: 42 } }));
  host.addItem(jsonItem('future', 'r-json', { v: 9, data: {} }));
  const [o, b, f] = await host.openWorkspace();
  assert.deepEqual(o!.instance!.getState(), { expanded: ['$', '$.meta'], showTypes: false });
  assert.equal(o!.stateResetNotice, false);
  assert.equal(b!.stateResetNotice, false);
  assert.deepEqual(b!.instance!.getState().legacy?.data, { expanded: 42 });
  assert.match(b!.text(), /旧版本的视图状态无法迁移，已原样保留/);
  assert.equal(f!.stateResetNotice, true);
  assert.equal(f!.placeholder, null);
  assert.deepEqual(f!.instance!.getState(), { expanded: ['$'], showTypes: false });
});

test('升级：新版本缺少迁移步骤 → 保留原状态并提示；保存时旧数据一并写回；可丢弃', async () => {
  // 模拟“插件升级到 stateSchemaVersion 3，但没写 v2→v3 迁移”
  const { migrateOrPreserve } = await import('@kb-workbench/adapter-sdk/policy');
  const r = migrateOrPreserve({ expanded: ['$', '$.items'], showTypes: true }, 2, 3, {}, () => ({ expanded: ['$'], showTypes: false }));
  assert.deepEqual(r.preserved, { v: 2, data: { expanded: ['$', '$.items'], showTypes: true }, error: '缺少 v2→v3 的迁移步骤' });
  // 模板自身：带 legacy 的状态再次打开时保留 legacy；点击后保存仍含 legacy；“丢弃旧状态”后才去掉
  const host = createMockHost({ resources, phase: 1 });
  await host.install(plugin);
  const legacy = { v: 1, data: { open: 5 }, error: '状态格式无法识别' };
  host.addItem(jsonItem('i1', 'r-json', { v: 2, data: { expanded: ['$'], showTypes: false, legacy } }));
  const p = await host.openItem('i1');
  assert.match(p.text(), /已原样保留/);
  p.click('toggle', '$.meta');
  host.flush();
  assert.deepEqual((host.getItem('i1')!.state!.data as { legacy?: unknown }).legacy, legacy);
  p.click('discard-legacy');
  host.flush();
  assert.equal((host.getItem('i1')!.state!.data as { legacy?: unknown }).legacy, undefined);
  assert.doesNotMatch(p.text(), /已原样保留/);
});

test('禁用 → 占位（可改用默认视图）；启用 → 回到原状态', async () => {
  const host = createMockHost({ resources, phase: 1 });
  await host.install(plugin);
  host.addItem(jsonItem('i1', 'r-json'));
  let p = await host.openItem('i1');
  p.click('toggle', '$.meta');
  host.flush();
  await host.setEnabled(manifest.id, false);
  p = host.panels.get('i1')!;
  assert.equal(p.placeholder?.kind, 'adapter-disabled');
  assert.ok(p.placeholder?.actions.includes('open-with-default'));
  assert.deepEqual(host.getItem('i1')!.state?.data, { expanded: ['$', '$.meta'], showTypes: false }, '禁用不改写项目状态');
  await host.setEnabled(manifest.id, true);
  p = host.panels.get('i1')!;
  assert.equal(p.placeholder, null);
  assert.deepEqual(p.instance!.getState(), { expanded: ['$', '$.meta'], showTypes: false });
});

for (const keepData of [true, false]) {
  test(`卸载（keepData=${keepData}）：项目保留为“缺少适配器”；插件数据按用户选择保留/删除`, async () => {
    const host = createMockHost({ resources, phase: 1 });
    await host.install(plugin);
    host.addItem(jsonItem('i1', 'r-json'));
    const p = await host.openItem('i1');
    p.click('toggle-types');
    host.flush();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(host.storageOf(manifest.id), { prefs: { showTypes: true } });

    await host.uninstall(manifest.id, { keepData });
    assert.equal(host.panels.get('i1')!.placeholder?.kind, 'adapter-missing');
    assert.ok(host.getItem('i1')!.state, '布局中的项目状态不随插件删除');
    assert.deepEqual(host.storageOf(manifest.id), keepData ? { prefs: { showTypes: true } } : undefined);
    assert.equal(host.grantsOf(manifest.id).length, keepData ? 1 : 0);

    await host.install(plugin);
    const again = await host.openItem('i1');
    assert.equal(again.placeholder, null);
    assert.equal(host.prompts.length, keepData ? 1 : 2, '删除数据后重新安装需要重新授权');
  });
}

test('坏 JSON 显示错误提示；文件被删除 → “文件不可用”占位', async () => {
  const host = createMockHost({ resources, phase: 1 });
  await host.install(plugin);
  host.addItem(jsonItem('bad', 'r-bad'));
  host.addItem(jsonItem('gone', 'r-json'));
  const [bad] = await host.openWorkspace();
  assert.match(bad!.text(), /JSON 解析失败/);
  host.fileChanged('r-json', 'deleted');
  const gone = await host.openItem('gone');
  assert.equal(gone.placeholder?.kind, 'resource-missing');
});

test('buildTree：大数组截断到 200 项', () => {
  const arr = Array.from({ length: 250 }, (_, i) => i);
  const t = buildTree(arr, { expanded: ['$'], showTypes: true });
  assert.equal(t.children!.length, 201);
  assert.equal(t.children!.at(-1)!.label, '…还有 50 项');
  assert.equal(t.detail, 'array [250]');
});

test('宿主调用超时（code timeout）→ 面板内“读取失败/读取超时”，点“重新读取”恢复，不变成占位', async () => {
  const host = createMockHost({ resources, phase: 1 });
  await host.install(plugin);
  host.addItem(jsonItem('i1', 'r-json'));
  // 让 stat 成功、readText 超时：先打开一次拿到实例，再在重新读取前注入失败
  const p = await host.openItem('i1');
  host.failNextFileCalls('timeout', 1);
  p.click('reload');
  await new Promise((r) => setImmediate(r));
  assert.match(p.text(), /读取失败\n读取超时/);
  assert.equal(p.placeholder, null);
  p.click('reload');
  await new Promise((r) => setImmediate(r));
  assert.match(p.text(), /items \[3\]/);
});
