/** 模拟宿主与核心 v0.2（kb-workbench f7020e7）行为对齐的用例 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockHost } from '../src/mock-host.js';
import type { AdapterPluginModule, FileHostApi, FileWorkspaceItem } from '../src/types.js';

function notesPlugin(optionalWrite: boolean, sink: { files?: FileHostApi }): AdapterPluginModule {
  return {
    manifest: {
      id: 'test.notes', name: '笔记', version: '0.1.0', engines: { workbench: '^0.2.0', adapterApi: '^0.1.0' }, sandbox: 'iframe',
      contributes: { adapters: [{
        id: 'test.notes.reader', title: '笔记', sourceKinds: ['file'], displayMode: 'in-app-reader', match: { file: { extensions: ['note'] } }, stateSchemaVersion: 1,
        permissions: [
          { id: 'read', kind: 'fs.read', scope: 'ask-per-root', extensions: ['note'], reason: '读取笔记' },
          { id: 'write', kind: 'fileops.write', operations: ['write'], reason: '追加一行', optional: optionalWrite },
        ],
      }] },
    },
    activate(api) {
      api.adapters.register({ id: 'test.notes.reader', open(_i, ctx) { sink.files = ctx.files; return { mount() {}, getState: () => undefined, dispose() {} }; } });
    },
  };
}
const res = [{ resourceId: 'n1', rootId: 'A', name: 'a.note', text: 'hi' }];
const item: FileWorkspaceItem = { itemId: 'i', sourceKind: 'file', adapterId: 'test.notes.reader', ref: 'n1', displayMode: 'in-app-reader' };

test('必需的 fileops.write 在打开时询问；optional:true 推迟到首次 requestFileops', async () => {
  for (const optional of [false, true]) {
    const sink: { files?: FileHostApi } = {};
    const host = createMockHost({ phase: 1, resources: res, approveFileops: () => true });
    await host.install(notesPlugin(optional, sink));
    host.addItem(item);
    await host.openItem('i');
    assert.deepEqual(host.prompts.map((p) => p.permission.id), optional ? ['read'] : ['read', 'write']);
    const r = await sink.files!.requestFileops!({ title: '追加', steps: [{ op: 'write', resourceId: 'n1', content: 'hi\nmore' }] });
    assert.equal(r.ok, true);
    assert.deepEqual(host.prompts.map((p) => p.permission.id), ['read', 'write']);
  }
});

test('optional fileops.write 首次写入时被拒 → permission-denied，面板不变成占位', async () => {
  const sink: { files?: FileHostApi } = {};
  const host = createMockHost({ phase: 1, resources: res, prompt: (q) => (q.permission.id === 'write' ? 'deny' : 'grant') });
  await host.install(notesPlugin(true, sink));
  host.addItem(item);
  const p = await host.openItem('i');
  assert.deepEqual(await sink.files!.requestFileops!({ title: 't', steps: [{ op: 'write', resourceId: 'n1', content: 'x' }] }), { ok: false, reason: 'permission-denied' });
  assert.equal(p.placeholder, null);
  assert.equal(p.deniedEvents[0]?.permissionId, 'write');
});

test('contentUrl 由宿主决定：kbfile://plugin/<面板令牌>/<resourceId>，不含文件名与路径', async () => {
  const sink: { files?: FileHostApi } = {};
  const host = createMockHost({ phase: 1, resources: res });
  await host.install(notesPlugin(true, sink));
  host.addItem(item);
  await host.openItem('i');
  assert.match(sink.files!.contentUrl('n1'), /^kbfile:\/\/plugin\/[a-z0-9]+\/n1$/);
});

test('文件不存在时不弹授权（与核心判定顺序一致）', async () => {
  const host = createMockHost({ phase: 1, resources: [] });
  await host.install(notesPlugin(true, {}));
  host.addItem(item);
  assert.equal((await host.openItem('i')).placeholder?.kind, 'resource-missing');
  assert.equal(host.prompts.length, 0);
});

test('卸载：保留数据 → 插件行保留并标记 uninstalledAt（source=adapter）；removeItems 移除条目', async () => {
  const host = createMockHost({ phase: 1, resources: res });
  const plugin = notesPlugin(true, {});
  await host.install(plugin);
  host.addItem(item);
  await host.openItem('i');
  await host.uninstall('test.notes', { keepData: true });
  const row = host.pluginRecord('test.notes');
  assert.equal(row?.source, 'adapter');
  assert.ok(row!.uninstalledAt! > 0);
  assert.equal(host.panels.get('i')!.placeholder?.kind, 'adapter-missing');
  await host.install(plugin);
  assert.equal(host.pluginRecord('test.notes')!.uninstalledAt, null);
  await host.uninstall('test.notes', { keepData: false, removeItems: true });
  assert.equal(host.pluginRecord('test.notes'), undefined);
  assert.equal(host.getItem('i'), undefined);
  assert.equal(host.panels.has('i'), false);
});

test('修订 5：导出迁移包时排除 nonMigratableKeys 与密钥样键（只列键名）', async () => {
  const host = createMockHost({ resources: res });
  const p = notesPlugin(true, {});
  const mod: AdapterPluginModule = {
    manifest: { ...p.manifest, storage: { nonMigratableKeys: ['deviceId', 'cache.*'] } },
    async activate(api) {
      await p.activate(api);
      await api.storage.set('deviceId', 'abc');
      await api.storage.set('cache.paths', ['C:/x']);
      await api.storage.set('apiToken', 't');
      await api.storage.set('prefs', { wrap: true });
    },
  };
  const r = await host.install(mod);
  assert.equal(r.ok, true, r.errors.join(';'));
  await new Promise((res) => setTimeout(res, 0));
  const out = host.migratableStorageOf('test.notes');
  assert.deepEqual(out.kept, { prefs: { wrap: true } });
  assert.deepEqual(out.excluded, ['apiToken', 'cache.paths', 'deviceId']);
  assert.deepEqual(Object.keys(host.storageOf('test.notes')!).sort(), ['apiToken', 'cache.paths', 'deviceId', 'prefs']);
});
