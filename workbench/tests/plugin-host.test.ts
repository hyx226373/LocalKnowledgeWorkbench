import { describe, expect, it } from 'vitest';
import { AdapterRegistry, Registry } from '../src/renderer/plugin-host/registry';
import {
  AUTO_ADAPTER,
  LAYOUT_SCHEMA_VERSION,
  MAX_VIEW_STATE_BYTES,
  applyPreset,
  leafOrder,
  makeFileItem,
  migrateLayout,
  resolveItemAdapter,
  restoreItemState,
  sanitizeItem,
  sanitizeWebRef,
  toStoredLayout,
  validatePreset,
  type SerializedDock,
  type WorkspaceItem,
} from '../src/renderer/plugin-host/layoutModel';
import { satisfies } from '../src/renderer/plugin-host/semver';
import { validateManifest } from '../src/renderer/plugin-host/manifest';
import { pruneDock, splitLegacyItems } from '../src/shared/items';
import csvPlugin, { parseCsv } from '../src/renderer/plugins/demo-csv-table';
import type { ResourceInfo } from '../src/shared/types';
import type { AdapterContribution, AdapterTarget, PluginApi } from '../src/renderer/plugin-host/types';

const res = (name: string): ResourceInfo => {
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  return { resourceId: 'r-' + name, rootId: 'root', relPath: name, name, kind: 'file', size: 1, mtimeMs: 1, ext, exists: true, readerType: 'unsupported' };
};
const file = (name: string): AdapterTarget => ({ sourceKind: 'file', resource: res(name) });
const C = () => null;
const fileAdapter = (id: string, match: (r: ResourceInfo) => number, extra: Partial<AdapterContribution> = {}): AdapterContribution => ({
  id,
  title: id,
  sourceKinds: ['file'],
  displayMode: 'in-app-reader',
  match: (t) => (t.sourceKind === 'file' ? match(t.resource) : 0),
  component: C,
  ...extra,
});

function fakeApi(reg: AdapterRegistry, owner: string): PluginApi {
  return { pluginId: owner, adapters: { register: (v: AdapterContribution<any>) => reg.register(owner, v) } } as unknown as PluginApi;
}

describe('AdapterRegistry', () => {
  it('按优先级挑选适配器；插件可用更高优先级覆盖内置；异常的 match 不影响其他；只匹配声明的来源类型', () => {
    const reg = new AdapterRegistry();
    reg.register('builtin.readers', fileAdapter('builtin.text', (r) => (['txt', 'csv'].includes(r.ext) ? 100 : 0)));
    reg.register('builtin.readers', fileAdapter('builtin.unsupported', () => 1));
    reg.register('bad.plugin', fileAdapter('bad.view', () => {
      throw new Error('boom');
    }));
    expect(reg.best(file('a.csv'))?.id).toBe('builtin.text');
    void csvPlugin.activate(fakeApi(reg, 'demo.csv-table'));
    expect(reg.resolve(file('a.csv')).map((v) => v.id)).toEqual(['demo.csv-table', 'builtin.text', 'builtin.unsupported']);
    expect(reg.best(file('a.docx'))?.id).toBe('builtin.unsupported');
    expect(reg.best({ sourceKind: 'web', url: 'https://example.com/' })).toBeUndefined();
    reg.unregisterOwner('demo.csv-table');
    expect(reg.best(file('a.csv'))?.id).toBe('builtin.text');
  });
  it('重复 id 报错并指出已注册者；dispose 可注销；订阅者收到变化', () => {
    const reg = new Registry<{ id: string }>();
    let n = 0;
    reg.subscribe(() => n++);
    const d = reg.register('p1', { id: 'x' });
    expect(() => reg.register('p2', { id: 'x' })).toThrow(/p1/);
    d.dispose();
    expect(reg.get('x')).toBeUndefined();
    expect(n).toBe(2);
  });
});

const grid2 = (a: string, b: string) => ({
  root: {
    type: 'branch' as const,
    size: 800,
    data: [
      { type: 'leaf' as const, size: 400, data: { views: [a], activeView: a, id: '1' } },
      { type: 'leaf' as const, size: 600, data: { views: [b], activeView: b, id: '2' } },
    ],
  },
  width: 1000,
  height: 800,
  orientation: 'HORIZONTAL' as const,
});
const legacyV1 = {
  grid: grid2('res:a', 'res:b'),
  panels: {
    'res:a': { id: 'res:a', contentComponent: 'file', title: 'a.md', params: { resourceId: 'a' } },
    'res:b': { id: 'res:b', contentComponent: 'file', title: 'b.pdf', params: { resourceId: 'b' } },
  },
  activeGroup: '1',
};
const legacyV2 = {
  schema: 2,
  dock: {
    grid: grid2('builtin.markdown|a', 'builtin.pdf|b'),
    panels: {
      'builtin.markdown|a': { id: 'builtin.markdown|a', contentComponent: 'view', title: 'a.md', params: { viewType: 'builtin.markdown', resourceId: 'a', state: { scroll: 0.5 } } },
      'builtin.pdf|b': { id: 'builtin.pdf|b', contentComponent: 'view', title: 'b.pdf', params: { viewType: 'builtin.pdf', resourceId: 'b', state: { page: 2, scale: 1.2 } } },
    },
  },
};

describe('工作区布局模型 v4：条目表 + 面板只引用 itemId', () => {
  it('迁移 v1（component=file）→ v3：file 条目 + auto 适配器，网格不变', () => {
    const m = migrateLayout(legacyV1, { sidebarWidth: 333 });
    expect(m.ok && m.migratedFrom).toBe(1);
    if (!m.ok) throw new Error();
    expect(m.layout.schema).toBe(LAYOUT_SCHEMA_VERSION);
    expect(m.layout.items['res:a']).toEqual({ itemId: 'res:a', sourceKind: 'file', adapterId: AUTO_ADAPTER, ref: 'a', displayMode: 'in-app-reader' });
    expect(m.layout.dock!.panels['res:a']).toMatchObject({ contentComponent: 'view', params: { itemId: 'res:a' } });
    expect(m.layout.dock!.grid).toEqual(legacyV1.grid);
    expect(m.layout.shell.sidebarWidth).toBe(333);
  });
  it('迁移 v2（params 内联 viewType/resourceId/state）→ v3：状态带版本号 v=1', () => {
    const m = migrateLayout(legacyV2);
    if (!m.ok) throw new Error();
    expect(m.migratedFrom).toBe(2);
    expect(m.layout.items['builtin.pdf|b']).toMatchObject({ adapterId: 'builtin.pdf', ref: 'b', state: { v: 1, data: { page: 2, scale: 1.2 } } });
    expect(Object.values(m.layout.dock!.panels).every((p) => Object.keys(p.params!).join() === 'itemId')).toBe(true);
  });
  it('更新版本的布局拒绝打开（不覆盖），损坏的布局报告 invalid', () => {
    expect(migrateLayout({ schema: 99, items: {}, dock: null })).toEqual({ ok: false, reason: 'newer', schema: 99 });
    expect(migrateLayout({ schema: 3, items: {}, dock: { nope: 1 } }).ok).toBe(false);
    expect(migrateLayout('x').ok).toBe(false);
  });
  it('保存：面板 params 只剩 itemId；丢弃未被任何面板引用的条目；剔除密钥字段；过大的状态被丢弃', () => {
    const items: Record<string, WorkspaceItem> = {
      p: { ...makeFileItem('b', 'builtin.pdf', 'p'), state: { v: 1, data: { page: 3, scale: 1.4, apiToken: 'xyz', nested: { password: 'p', ok: 1 } } } },
      big: { ...makeFileItem('c', 'builtin.text', 'big'), state: { v: 1, data: { text: 'x'.repeat(MAX_VIEW_STATE_BYTES + 10) } } },
      orphan: makeFileItem('z', 'builtin.text', 'orphan'),
    };
    const dock: SerializedDock = {
      grid: grid2('p', 'big'),
      panels: {
        p: { id: 'p', contentComponent: 'view', params: { itemId: 'p', component: 'PdfView', path: 'C:\\x.pdf' } },
        big: { id: 'big', contentComponent: 'view', params: { itemId: 'big' } },
      },
    };
    const stored = toStoredLayout(dock, items, { sidebarWidth: 300 });
    expect(stored.layout.schema).toBe(4);
    expect('items' in stored.layout).toBe(false); // 条目存进 workspace_items 表，布局 JSON 不再内联
    expect(stored.layout.dock!.panels.p.params).toEqual({ itemId: 'p' });
    const byId = Object.fromEntries(stored.items.map((i) => [i.itemId, i]));
    expect(Object.keys(byId).sort()).toEqual(['big', 'p']);
    expect(byId.p.state).toEqual({ v: 1, data: { page: 3, scale: 1.4, nested: { ok: 1 } } });
    expect(byId.big.state).toBeUndefined();
    expect(JSON.stringify(stored)).not.toMatch(/PdfView|C:\\\\|xyz/);
    const back = migrateLayout(JSON.parse(JSON.stringify(stored.layout)), {}, JSON.parse(JSON.stringify(stored.items)));
    expect(back.ok && back.migratedFrom).toBe(4);
    expect(back.ok && back.layout.items.p).toEqual(byId.p);
  });
  it('v3 → v4：内联条目拆出；悬空面板（条目缺失）被剪掉，空分组一并移除', () => {
    const v3 = { schema: 3, shell: { sidebarWidth: 280 }, items: { a: makeFileItem('ra', 'builtin.text', 'a') }, dock: { grid: grid2('a', 'gone'), panels: { a: { id: 'a', params: { itemId: 'a' } }, gone: { id: 'gone', params: { itemId: 'gone' } } } } };
    const sp = splitLegacyItems(v3) as { layout: any; items: WorkspaceItem[] };
    expect(sp.layout.schema).toBe(4);
    expect(sp.layout.items).toBeUndefined();
    expect(sp.items.map((i) => i.itemId)).toEqual(['a']);
    const m = migrateLayout(JSON.parse(JSON.stringify(v3)));
    if (!m.ok) throw new Error();
    expect(m.migratedFrom).toBe(3);
    expect(Object.keys(m.layout.dock!.panels)).toEqual(['a']);
    expect(leafOrder(m.layout.dock!.grid.root as any).map((l) => l.data.views)).toEqual([['a']]);
    expect(pruneDock(m.layout.dock, () => false)).toBeNull();
  });
  it('web 条目引用只允许 http(s)；按 SDK sanitizeUrlForState 去掉账号密码与整个查询串（保留片段）', () => {
    expect(sanitizeWebRef('https://user:pw@example.com/a?q=1&access_token=abc#x')).toBe('https://example.com/a#x');
    expect(sanitizeWebRef('file:///etc/passwd')).toBeNull();
    expect(sanitizeItem({ itemId: 'w', sourceKind: 'web', adapterId: 'x', ref: 'javascript:alert(1)', displayMode: 'in-app-web' })).toBeNull();
  });
});

describe('条目恢复：file 条目精确恢复，web/app 桩条目与缺失适配器显示占位', () => {
  const reg = new AdapterRegistry();
  reg.register('builtin.readers', fileAdapter('builtin.markdown', (r) => (r.ext === 'md' ? 100 : 0)));
  reg.register('builtin.readers', fileAdapter('builtin.pdf', (r) => (r.ext === 'pdf' ? 100 : 0), { stateSchemaVersion: 1 }));
  const owners: Record<string, 'disabled' | 'denied'> = { 'demo.csv-table': 'disabled', 'x.secret-viewer': 'denied' };
  const layout = {
    schema: 3,
    shell: { sidebarWidth: 280 },
    items: {
      f1: { itemId: 'f1', sourceKind: 'file', adapterId: 'builtin.pdf', ref: 'b', displayMode: 'in-app-reader', state: { v: 1, data: { page: 4, scale: 1.1 } } },
      w1: { itemId: 'w1', sourceKind: 'web', adapterId: 'web.generic', ref: 'https://example.com/docs', displayMode: 'in-app-web', state: { v: 1, data: { scrollY: 120 } } },
      a1: { itemId: 'a1', sourceKind: 'app', adapterId: 'app.zotero', ref: 'profile-zotero', displayMode: 'external-managed' },
      c1: { itemId: 'c1', sourceKind: 'file', adapterId: 'demo.csv-table', ref: 'c', displayMode: 'in-app-reader' },
      s1: { itemId: 's1', sourceKind: 'file', adapterId: 'x.secret-viewer', ref: 'd', displayMode: 'in-app-reader' },
      m1: { itemId: 'm1', sourceKind: 'file', adapterId: 'never.installed', ref: 'e', displayMode: 'in-app-reader' },
    },
    dock: {
      grid: grid2('f1', 'w1'),
      panels: Object.fromEntries(['f1', 'w1', 'a1', 'c1', 's1', 'm1'].map((id) => [id, { id, contentComponent: 'view', params: { itemId: id } }])),
    },
  };
  it('恢复后每个面板的结果', () => {
    const m = migrateLayout(JSON.parse(JSON.stringify(layout)));
    if (!m.ok) throw new Error('migrate failed');
    expect(Object.keys(m.layout.items)).toHaveLength(6); // 桩条目原样保留
    const out = Object.values(m.layout.items).map((it) => {
      const r = resolveItemAdapter(it, (id) => reg.get(id), () => undefined, (id) => owners[id]);
      return [it.itemId, r.kind === 'adapter' ? r.adapter.id : r.reason];
    });
    expect(Object.fromEntries(out)).toEqual({
      f1: 'builtin.pdf',
      w1: 'adapter-missing', // P2（H9）起 web 条目已开放：没有安装对应网页适配器 → 缺少适配器
      a1: 'adapter-missing', // P3（第 9 轮接线）起 app 条目已开放：没有安装对应外部程序适配器 → 缺少适配器
      c1: 'adapter-disabled',
      s1: 'adapter-missing', // 权限在适配器解析之后由 ViewHost/沙箱闸门判定（SDK §5.1）
      m1: 'adapter-missing',
    });
    // file 条目状态精确恢复
    expect(restoreItemState(m.layout.items.f1.state, reg.get('builtin.pdf')!)).toEqual({ page: 4, scale: 1.1 });
    // 再保存一次：占位条目不会被改写或丢弃
    const again = toStoredLayout(m.layout.dock, m.layout.items, m.layout.shell);
    expect(Object.fromEntries(again.items.map((i) => [i.itemId, i]))).toEqual(m.layout.items);
  });
  it('状态版本：同版本直接用；旧版本交给适配器迁移；没有迁移函数或版本更新时丢弃', () => {
    const a = { stateSchemaVersion: 2, migrateState: (d: any, v: number) => (v === 1 ? { page: d.p } : undefined) };
    expect(restoreItemState({ v: 1, data: { p: 7 } }, a)).toEqual({ page: 7 });
    expect(restoreItemState({ v: 2, data: { page: 3 } }, a)).toEqual({ page: 3 });
    expect(restoreItemState({ v: 3, data: { page: 3 } }, a)).toBeUndefined();
    expect(restoreItemState({ v: 1, data: { p: 7 } }, { stateSchemaVersion: 2 })).toBeUndefined();
  });
});

describe('布局预设（只改分栏排列，不改条目与状态）', () => {
  const three = { id: 't', label: '三栏', grid: { split: 'row' as const, children: [{ slot: 1, size: 1 }, { slot: 2, size: 1 }, { slot: 3, size: 2 }] } };
  const dock: SerializedDock = { grid: grid2('a', 'b'), panels: { a: { id: 'a', params: { itemId: 'a' } }, b: { id: 'b', params: { itemId: 'b' } } } };
  it('校验', () => {
    expect(validatePreset(three)).toBeNull();
    expect(validatePreset({ id: 'x', label: 'x', grid: { split: 'row', children: [{ split: 'row', children: [{ slot: 1 }] }] } })).toMatch(/交替/);
    expect(validatePreset({ id: 'x', label: 'x', grid: { split: 'row', children: [{ slot: 2 }] } })).toMatch(/连续/);
  });
  it('分组少于 slot 时裁掉多余 slot；分组多于 slot 时并入最后一个；面板与条目不变', () => {
    const out = applyPreset(dock, three, 1000, 600)!;
    const leaves = leafOrder(out.grid.root);
    expect(leaves.map((l) => l.data.views)).toEqual([['a'], ['b']]);
    expect(leaves.map((l) => l.size)).toEqual([500, 500]);
    expect(out.panels).toEqual(dock.panels);
    const one = applyPreset(dock, { id: 's', label: 's', grid: { split: 'row', children: [{ slot: 1 }] } }, 1000, 600)!;
    expect(leafOrder(one.grid.root).map((l) => l.data.views)).toEqual([['a', 'b']]);
    const nested = applyPreset(dock, { id: 'n', label: 'n', grid: { split: 'column', children: [{ slot: 1, size: 3 }, { slot: 2, size: 1 }] } }, 1000, 800)!;
    expect(nested.grid.orientation).toBe('VERTICAL');
    expect(leafOrder(nested.grid.root).map((l) => l.size)).toEqual([600, 200]);
  });
});

describe('插件 manifest、带范围的权限与版本兼容', () => {
  it('semver 范围', () => {
    expect(satisfies('0.2.0', '^0.2.0')).toBe(true);
    expect(satisfies('0.2.0', '^0.1.0')).toBe(false); // 0.x 的次版本视为破坏性
    expect(satisfies('1.4.2', '^1.2.0')).toBe(true);
    expect(satisfies('2.0.0', '^1.2.0')).toBe(false);
    expect(satisfies('1.0.0', '>=0.1.0 <2.0.0')).toBe(true);
    expect(satisfies('0.1.5', '~0.1.0 || ^2.0.0')).toBe(true);
  });
  it('内置插件 manifest：权限必须是 SDK 结构化声明（T22：不再接受字符串权限）；第三方插件不走这里', () => {
    const m = { id: 'x.y', name: 'X', version: '1.0.0', engines: { workbench: '^0.2.0' } };
    expect(validateManifest(m, '0.2.0')).toBeNull();
    expect(validateManifest({ ...m, engines: { workbench: '^1.0.0' } }, '0.2.0')).toMatch(/需要宿主 API/);
    expect(validateManifest({ ...m, id: '../x' }, '0.2.0')).toMatch(/非法 id/);
    const web = { ...m, contributes: { adapters: [{ id: 'w', sourceKinds: ['web' as const], displayMode: 'in-app-web' as const, permissions: [{ id: 'n', kind: 'net' as const, domains: ['example.com'], reason: '访问文档站' }] }] } };
    expect(validateManifest(web, '0.2.0', 'builtin')).toBeNull();
    expect(validateManifest(web, '0.2.0', 'user')).toMatch(/沙箱适配器插件/);
    expect(validateManifest(m, '0.2.0', 'user', 'code')).toMatch(/沙箱适配器插件/);
    expect(validateManifest(m, '0.2.0', 'user', 'theme')).toBeNull();
    const str = { ...m, contributes: { adapters: [{ id: 'w', sourceKinds: ['web' as const], displayMode: 'in-app-web' as const, permissions: ['net:domains:example.com'] as any }] } };
    expect(validateManifest(str, '0.2.0')).toMatch(/结构化/);
    const wrongKind = { ...m, contributes: { adapters: [{ id: 'f', sourceKinds: ['file' as const], displayMode: 'in-app-reader' as const, permissions: [{ id: 'n', kind: 'net' as const, domains: ['a.com'], reason: 'x' }] }] } };
    expect(validateManifest(wrongKind, '0.2.0')).toMatch(/不能申请 net/);
    expect(validateManifest({ ...m, contributes: { adapters: [{ id: 'z', sourceKinds: ['fax' as any], displayMode: 'in-app-web' as const }] } }, '0.2.0')).toMatch(/sourceKinds/);
    // 诚实的显示方式：app 只能 external-managed（不能声称嵌入应用内）；一个适配器只对应一种来源
    const ad = (sourceKinds: any[], displayMode: any) => ({ ...m, contributes: { adapters: [{ id: 'q', sourceKinds, displayMode }] } });
    expect(validateManifest(ad(['app'], 'in-app-reader'), '0.2.0')).toMatch(/只能声明 external-managed/);
    expect(validateManifest(ad(['web'], 'in-app-reader'), '0.2.0')).toMatch(/只能声明 in-app-web/);
    expect(validateManifest(ad(['file', 'web'], 'in-app-reader'), '0.2.0')).toMatch(/恰好声明一种/);
    expect(validateManifest(ad(['app'], 'external-managed'), '0.2.0')).toBeNull();
    expect(validateManifest(csvPlugin.manifest, '0.2.0')).toBeNull();
    expect(csvPlugin.manifest.contributes!.adapters![0].permissions![0]).toMatchObject({ kind: 'fs.read', scope: 'all-registered-roots' });
  });
});

describe('演示插件 csv-table', () => {
  it('CSV 解析（引号、转义、CRLF）', () => {
    expect(parseCsv('a,b\r\n"x,1","he said ""hi"""\n3,4')).toEqual([['a', 'b'], ['x,1', 'he said "hi"'], ['3', '4']]);
  });
});
