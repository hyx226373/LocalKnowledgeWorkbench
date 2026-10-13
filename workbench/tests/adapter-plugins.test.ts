/**
 * P1 适配器宿主（H1–H8）主进程部分：开发者模式安装、结构化授权（scope + declHash）、files.* 范围检查、
 * kbfile://plugin 令牌、存储配额、卸载（保留/删除数据、移除条目）、批量计划（桩引擎）以及 DB v3→v4 迁移。
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { makeService, tmpDir, write } from './helpers';
import { WorkbenchService } from '../src/main/service/WorkbenchService';
import { openDb } from '../src/main/service/db';
import { parseAccessError } from '../src/shared/pluginIpc';
import { HOST_API_VERSION } from '../src/shared/hostApi';
import { ADAPTER_SDK_COMMIT, permissionDeclHash, satisfies } from '../src/shared/adapter-sdk';
import { parseFrameMessage, sanitizeUiNode } from '../src/shared/sandboxProtocol';

const SDK = process.env.KB_ADAPTER_SDK_DIR ?? path.resolve(__dirname, '../../kb-adapter-sdk');
const TEMPLATE = path.join(SDK, 'templates/file-adapter');
const ROOT = path.resolve(__dirname, '..');
const built: Record<string, string> = {};
function buildPlugin(name: string, src: string) {
  const out = path.join(tmpDir('kbplug-'), name);
  execFileSync('node', [path.join(ROOT, 'scripts/build-adapter-plugin.mjs'), src, '--out', out], { stdio: 'pipe', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  return out;
}
beforeAll(() => {
  built.json = buildPlugin('json', TEMPLATE);
  built.evil = buildPlugin('evil', path.join(ROOT, 'e2e/fixtures/plugins/evil'));
  built.notes = buildPlugin('notes', path.join(ROOT, 'e2e/fixtures/plugins/notes'));
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup() {
  const { svc, dataDir } = await makeService();
  cleanups.push(() => svc.close());
  const a = tmpDir('kbrootA-');
  const b = tmpDir('kbrootB-');
  write(path.join(a, 'data/config.json'), '{"name":"A","items":[1,2]}');
  write(path.join(a, 'data/notes.md'), '# secret md');
  write(path.join(b, 'other.json'), '{"secret":"B"}');
  write(path.join(a, 'n/todo.note'), 'line 1');
  const ra = svc.addRoot(a, 'A');
  const rb = svc.addRoot(b, 'B');
  await svc.scanRoot(ra.id);
  await svc.scanRoot(rb.id);
  const rid = (root: string, rel: string) => svc.resourceIdFor(root, rel);
  return { svc, dataDir, ra, rb, rid, a, b };
}
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return parseAccessError(e).code;
  }
  return 'ok';
};
const JSON_ADAPTER = 'example.json-viewer.reader';

describe('宿主 API 版本与 SDK 来源', () => {
  it('宿主 API 0.2.0 满足模板的 engines.workbench；SDK 副本来自 050df08', () => {
    const m = JSON.parse(fs.readFileSync(path.join(TEMPLATE, 'manifest.json'), 'utf8'));
    expect(HOST_API_VERSION).toBe('0.2.0');
    expect(satisfies(HOST_API_VERSION, m.engines.workbench)).toBe(true);
    expect(ADAPTER_SDK_COMMIT).toBe('8b7011f');
    const strip = (s: string) => s.replace(/\r\n/g, '\n').replace(/^\/\* 来自 kb-adapter-sdk.*\*\/\n/m, '').replace(/'\.\/types(\.js)?'/g, "'./types'");
    for (const f of ['policy', 'types']) {
      const vendored = fs.readFileSync(path.join(ROOT, `src/shared/adapter-sdk/${f}.ts`), 'utf8');
      const upstream = fs.readFileSync(path.join(SDK, `src/${f}.ts`), 'utf8');
      expect(vendored.startsWith(`/* 来自 kb-adapter-sdk@${ADAPTER_SDK_COMMIT} src/${f}.ts`)).toBe(true);
      expect(strip(vendored).trim(), f).toBe(strip(upstream).trim());
    }
    // SDK 050df08：UninstallOptions.removeItems 可选，核心 IPC 直接用 SDK 类型
    const opts: import('../src/shared/pluginIpc').UninstallOptionsDto = { keepData: true };
    expect(opts.removeItems).toBeUndefined();
  });
});

describe('开发者模式安装（H2）', () => {
  it('安装 SDK 文件适配器模板：校验 manifest、复制包、登记；拒绝保留前缀、缺少 main、不满足 engines', async () => {
    const { svc } = await setup();
    const d = svc.plugins.installFromFolder(built.json);
    expect(d).toMatchObject({ id: 'example.json-viewer', source: 'dev', enabled: true, errors: [], grants: [], mainUrl: 'kbplugin://example.json-viewer/dist/index.js' });
    expect(svc.plugins.list().map((p) => p.id)).toEqual(['example.json-viewer']);
    expect(svc.listPlugins().find((p) => p.id === 'example.json-viewer')?.source).toBe('adapter');

    const bad = tmpDir('kbbad-');
    const m = JSON.parse(fs.readFileSync(path.join(built.json, 'manifest.json'), 'utf8'));
    write(path.join(bad, 'manifest.json'), JSON.stringify({ ...m, id: 'kb.evil', contributes: { adapters: [{ ...m.contributes.adapters[0], id: 'kb.evil.reader' }] } }));
    expect(() => svc.plugins.installFromFolder(bad)).toThrow(/保留|builtin/);
    write(path.join(bad, 'manifest.json'), JSON.stringify(m));
    const noMain = svc.plugins.installFromFolder(bad); // 复制成功但不兼容：显示原因，不激活
    expect(noMain.errors.join()).toMatch(/main 指向的文件不存在/);
    write(path.join(bad, 'dist/index.js'), 'export default {}');
    write(path.join(bad, 'manifest.json'), JSON.stringify({ ...m, engines: { ...m.engines, workbench: '^0.3.0' } }));
    expect(svc.plugins.installFromFolder(bad).errors.join()).toMatch(/需要宿主 API \^0\.3\.0/);
    expect(() => svc.plugins.file('example.json-viewer', JSON_ADAPTER, { op: 'stat', resourceId: 'x' })).toThrow(/plugin-unavailable/);
  });
});

describe('结构化授权 + files.* 范围（H2/H3/H5）', () => {
  it('未授权/拒绝 → permission-denied；按根授权；扩展名限制；declHash 变化后失效；撤销', async () => {
    const { svc, ra, rb, rid } = await setup();
    svc.plugins.installFromFolder(built.json);
    const own = rid(ra.id, 'data/config.json');
    const other = rid(rb.id, 'other.json');
    const md = rid(ra.id, 'data/notes.md');
    const read = (r: string) => () => svc.plugins.file('example.json-viewer', JSON_ADAPTER, { op: 'readText', resourceId: r });
    expect(code(read(own))).toBe('permission-denied'); // 尚未询问
    svc.plugins.setGrant({ pluginId: 'example.json-viewer', adapterId: JSON_ADAPTER, permissionId: 'read-json', decision: 'denied' });
    expect(code(read(own))).toBe('permission-denied');
    expect(() => svc.plugins.setGrant({ pluginId: 'example.json-viewer', adapterId: JSON_ADAPTER, permissionId: 'read-json', decision: 'granted' })).toThrow(/至少勾选/);
    const g = svc.plugins.setGrant({ pluginId: 'example.json-viewer', adapterId: JSON_ADAPTER, permissionId: 'read-json', decision: 'granted', rootIds: [ra.id, 'nope'] });
    expect(g).toMatchObject({ decision: 'granted', rootIds: [ra.id] });
    expect(g.declHash).toBe(permissionDeclHash(JSON.parse(fs.readFileSync(path.join(built.json, 'manifest.json'), 'utf8')).contributes.adapters[0].permissions[0]));
    expect(read(own)()).toMatchObject({ text: '{"name":"A","items":[1,2]}', truncated: false });
    expect(svc.plugins.file('example.json-viewer', JSON_ADAPTER, { op: 'stat', resourceId: own })).toMatchObject({ name: 'config.json', ext: 'json', mimeType: 'application/json' });
    expect(Buffer.from(svc.plugins.file('example.json-viewer', JSON_ADAPTER, { op: 'readBytes', resourceId: own, offset: 1, length: 6 }) as Uint8Array).toString()).toBe('"name"');
    expect(code(read(other))).toBe('out-of-scope'); // 另一个根
    expect(code(read(md))).toBe('out-of-scope'); // 扩展名不在声明里
    expect(code(read('../../etc/passwd'))).toBe('invalid-request');
    expect(code(() => svc.plugins.file('example.json-viewer', 'example.json-viewer.other', { op: 'stat', resourceId: own }))).toBe('invalid-request');

    // 声明变化（例如升级后扩展名变多）→ 旧授权失效，需重新询问
    const dir = path.join(svc.plugins.dir, 'example.json-viewer');
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    m.contributes.adapters[0].permissions[0].extensions = ['json', 'md'];
    const upgraded = tmpDir('kbup-');
    fs.cpSync(built.json, upgraded, { recursive: true });
    write(path.join(upgraded, 'manifest.json'), JSON.stringify(m));
    svc.plugins.installFromFolder(upgraded);
    expect(code(read(own))).toBe('permission-denied');
    svc.plugins.setGrant({ pluginId: 'example.json-viewer', adapterId: JSON_ADAPTER, permissionId: 'read-json', decision: 'granted', rootIds: [ra.id] });
    expect(read(md)()).toMatchObject({ text: '# secret md' });
    // 撤销
    expect(svc.plugins.revoke('example.json-viewer', JSON_ADAPTER, 'read-json')).toMatchObject({ decision: 'denied', declHash: '*' });
    expect(code(read(own))).toBe('permission-denied');
    // 禁用插件 → 不可用
    svc.plugins.setGrant({ pluginId: 'example.json-viewer', adapterId: JSON_ADAPTER, permissionId: 'read-json', decision: 'granted', rootIds: [ra.id] });
    svc.plugins.setEnabled('example.json-viewer', false);
    expect(code(read(own))).toBe('plugin-unavailable');
  });

  it('kbfile://plugin/<token>/<rid>：令牌绑定插件+适配器，每次按当前授权检查；伪造/释放的令牌无效；包资源不能越出包目录', async () => {
    const { svc, ra, rb, rid } = await setup();
    svc.plugins.installFromFolder(built.json);
    svc.plugins.installFromFolder(built.evil);
    svc.plugins.setGrant({ pluginId: 'example.json-viewer', adapterId: JSON_ADAPTER, permissionId: 'read-json', decision: 'granted', rootIds: [ra.id] });
    const own = rid(ra.id, 'data/config.json');
    const tok = svc.plugins.mintFileToken('example.json-viewer', JSON_ADAPTER);
    const url = (t: string, r: string) => `kbfile://plugin/${t}/${encodeURIComponent(r)}`;
    expect(svc.plugins.resolvePluginFileUrl(url(tok, own))).toMatch(/config\.json$/);
    expect(code(() => svc.plugins.resolvePluginFileUrl(url(tok, rid(rb.id, 'other.json'))))).toBe('out-of-scope');
    expect(code(() => svc.plugins.resolvePluginFileUrl(url('forged', own)))).toBe('permission-denied');
    // 恶意插件拿到自己的令牌，也读不到别的插件授权的文件
    const evilTok = svc.plugins.mintFileToken('test.evil', 'test.evil.reader');
    expect(code(() => svc.plugins.resolvePluginFileUrl(url(evilTok, own)))).toBe('permission-denied');
    svc.plugins.revoke('example.json-viewer', JSON_ADAPTER, 'read-json');
    expect(code(() => svc.plugins.resolvePluginFileUrl(url(tok, own)))).toBe('permission-denied');
    svc.plugins.releaseFileToken(tok);
    expect(code(() => svc.plugins.resolvePluginFileUrl(url(tok, own)))).toBe('permission-denied');
    expect(svc.plugins.resolveAsset('example.json-viewer', 'dist/index.js')).toMatch(/index\.js$/);
    expect(() => svc.plugins.resolveAsset('example.json-viewer', '../../layout.db')).toThrow();
    expect(() => svc.plugins.resolveAsset('example.json-viewer', '__kb/runtime.js')).toThrow(/reserved/);
  });
});

describe('插件存储与卸载（H7）', () => {
  it('get/set/delete/keys；单值 1 MB、总量 10 MB；卸载保留数据 → 重装恢复；删除数据 → 清空；条目默认保留为占位，可选移除', async () => {
    const { svc, ra, rid } = await setup();
    const id = 'example.json-viewer';
    svc.plugins.installFromFolder(built.json);
    svc.plugins.storageSet(id, 'prefs', { showTypes: true });
    svc.plugins.storageSet(id, 'b', 1);
    expect(svc.plugins.storageKeys(id)).toEqual(['b', 'prefs']);
    svc.plugins.storageDelete(id, 'b');
    expect(svc.plugins.storageKeys(id)).toEqual(['prefs']);
    expect(code(() => svc.plugins.storageSet(id, 'big', 'x'.repeat(1024 * 1024 + 1)))).toBe('quota-exceeded');
    for (let i = 0; i < 10; i++) svc.plugins.storageSet(id, `k${i}`, 'x'.repeat(1000 * 1000));
    expect(code(() => svc.plugins.storageSet(id, 'k10', 'x'.repeat(1000 * 1000)))).toBe('quota-exceeded');
    for (let i = 0; i < 10; i++) svc.plugins.storageDelete(id, `k${i}`);
    expect(code(() => svc.plugins.storageGet(id, ''))).toBe('invalid-request');
    svc.plugins.setGrant({ pluginId: id, adapterId: JSON_ADAPTER, permissionId: 'read-json', decision: 'granted', rootIds: [ra.id] });

    // 两个工作区引用它的条目
    const own = rid(ra.id, 'data/config.json');
    const mk = (itemId: string) => ({
      layout: { schema: 4, shell: { sidebarWidth: 280 }, dock: { grid: { root: { type: 'branch', size: 800, data: [{ type: 'leaf', size: 800, data: { views: [itemId, 'keep'], activeView: itemId, id: '1' } }] }, width: 800, height: 600, orientation: 'HORIZONTAL' }, panels: { [itemId]: { id: itemId, contentComponent: 'view', params: { itemId } }, keep: { id: 'keep', contentComponent: 'view', params: { itemId: 'keep' } } } } },
      items: [
        { itemId, sourceKind: 'file', adapterId: JSON_ADAPTER, ref: own, displayMode: 'in-app-reader', state: { v: 2, data: { expanded: ['$'], showTypes: false } } },
        { itemId: 'keep', sourceKind: 'file', adapterId: 'builtin.text', ref: own, displayMode: 'in-app-reader' },
      ],
    });
    const w1 = svc.createWorkspace('W1', '', mk('j1').layout, mk('j1').items);
    const w2 = svc.createWorkspace('W2', '', mk('j2').layout, mk('j2').items);
    expect(svc.plugins.uninstallInfo(id)).toMatchObject({ storageKeys: 1, grants: 1, siteDataBytes: null, items: 2, workspaces: 2 });

    // 保留数据：存储/授权留着；条目保留
    expect(svc.plugins.uninstall(id, { keepData: true, removeItems: false })).toEqual({ removedItems: 0, adapterIds: [JSON_ADAPTER] });
    expect(svc.plugins.list()).toEqual([]);
    expect(fs.existsSync(path.join(svc.plugins.dir, id))).toBe(false);
    expect(svc.getWorkspace(w1.id).items.map((i) => i.itemId).sort()).toEqual(['j1', 'keep']);
    svc.plugins.installFromFolder(built.json);
    expect(svc.plugins.storageGet(id, 'prefs')).toEqual({ showTypes: true });
    expect(svc.plugins.grants(id)).toHaveLength(1);

    // 删除数据 + 移除条目：所有工作区里该适配器的条目和面板被移除，其他条目不动
    expect(svc.plugins.uninstall(id, { keepData: false, removeItems: true }).removedItems).toBe(2);
    for (const w of [w1, w2]) {
      const ws = svc.getWorkspace(w.id);
      expect(ws.items.map((i) => i.itemId)).toEqual(['keep']);
      expect(Object.keys((ws.layout as any).dock.panels)).toEqual(['keep']);
    }
    svc.plugins.installFromFolder(built.json);
    expect(svc.plugins.storageGet(id, 'prefs')).toBeNull();
    expect(svc.plugins.grants(id)).toEqual([]);
  });
});

describe('批量计划（H8，桩引擎）', () => {
  it('需要 fileops.write 授权；每步在读取范围内；预览列出冲突；批准后执行并以 plugin:<id> 记入操作日志；拒绝/过期', async () => {
    const { svc, ra, rb, rid } = await setup();
    const id = 'test.notes';
    svc.plugins.installFromFolder(built.notes);
    const note = rid(ra.id, 'n/todo.note');
    const plan = { title: '追加', steps: [{ op: 'write' as const, resourceId: note, content: 'line 1\nline 2' }] };
    expect(code(() => svc.plugins.planPreview(id, 'test.notes.reader', plan))).toBe('permission-denied');
    svc.plugins.setGrant({ pluginId: id, adapterId: 'test.notes.reader', permissionId: 'write', decision: 'granted' });
    expect(code(() => svc.plugins.planPreview(id, 'test.notes.reader', plan))).toBe('permission-denied'); // 还没有读取授权
    svc.plugins.setGrant({ pluginId: id, adapterId: 'test.notes.reader', permissionId: 'read', decision: 'granted', rootIds: [ra.id] });
    expect(code(() => svc.plugins.planPreview(id, 'test.notes.reader', { title: 'x', steps: [{ op: 'trash', resourceId: note }] }))).toBe('out-of-scope'); // 未声明的操作
    expect(code(() => svc.plugins.planPreview(id, 'test.notes.reader', { title: 'x', steps: [{ op: 'write', resourceId: rid(rb.id, 'other.json'), content: '' }] }))).toBe('out-of-scope');
    const pv = svc.plugins.planPreview(id, 'test.notes.reader', plan);
    expect(pv).toMatchObject({ pluginId: id, engine: 'stub', blocked: false, steps: [{ op: 'write', rootName: 'A', relPath: 'n/todo.note', conflicts: [] }] });
    expect(svc.plugins.planDiscard(pv.planId)).toEqual({ ok: false, reason: 'user-rejected' });
    expect(svc.plugins.planExecute(pv.planId)).toMatchObject({ ok: false, reason: 'conflict' }); // 已丢弃
    const stale = svc.plugins.planPreview(id, 'test.notes.reader', { ...plan, steps: [{ ...plan.steps[0], expectedHash: 'deadbeef' }] });
    expect(stale.blocked).toBe(true);
    const ok = svc.plugins.planPreview(id, 'test.notes.reader', plan);
    const r = svc.plugins.planExecute(ok.planId);
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(svc.resolveResourcePath(note), 'utf8')).toBe('line 1\nline 2');
    expect(svc.listOps(5)[0]).toMatchObject({ actor: 'plugin:test.notes', op: 'write' });
  });
});

describe('沙箱协议（H4）', () => {
  it('只接受白名单消息；UiNode 在宿主侧重建：未知节点变提示、字段不透传、限制深度', () => {
    expect(parseFrameMessage({ kb: 'kb-frame', type: 'rpc', id: 1, method: 'files.readText', params: { resourceId: 'r', pluginId: 'spoof' } })).toEqual({ type: 'rpc', id: 1, method: 'files.readText', params: { resourceId: 'r', pluginId: 'spoof' } });
    expect(parseFrameMessage({ kb: 'kb-frame', type: 'rpc', id: 1, method: 'shell.exec', params: {} })).toBeNull();
    expect(parseFrameMessage({ kb: 'other', type: 'ready' })).toBeNull();
    expect(parseFrameMessage({ kb: 'kb-frame', type: 'eval' })).toBeNull();
    const n = sanitizeUiNode({ type: 'stack', children: [{ type: 'html', html: '<b>x</b>' }, { type: 'text', text: '<img src=x onerror=alert(1)>', onclick: 'x', style: 'color:red' }, { type: 'button', label: 'b', action: 'a', href: 'javascript:1' }] });
    expect(n).toEqual({ type: 'stack', direction: 'column', children: [{ type: 'notice', tone: 'warning', title: '不支持的界面节点', message: '类型 html 已被宿主忽略' }, { type: 'text', text: '<img src=x onerror=alert(1)>' }, { type: 'button', label: 'b', action: 'a', variant: 'secondary' }] });
    let deep: any = { type: 'text', text: 'x' };
    for (let i = 0; i < 40; i++) deep = { type: 'stack', children: [deep] };
    expect(() => sanitizeUiNode(deep)).toThrow(/嵌套过深/);
  });
});

describe('数据库 v3 → v4 迁移（H1）', () => {
  it('schema 3 工作区的内联条目拆进 workspace_items；旧的字符串授权作废；plugins 支持 adapter 来源与 uninstalled_at', () => {
    const dir = tmpDir('kbmig-');
    const f = path.join(dir, 'workbench.db');
    // 用 v3 结构手工建库
    const db = openDb(f);
    db.close();
    const raw = new Database(f);
    raw.exec('DROP TABLE workspace_items; DROP TABLE plugins; DROP TABLE plugin_audit;');
    raw.exec(`CREATE TABLE plugins (id TEXT PRIMARY KEY, version TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('builtin','user')), enabled INTEGER NOT NULL DEFAULT 1, granted_json TEXT NOT NULL DEFAULT '[]', installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    raw.prepare("INSERT INTO plugins VALUES ('demo.csv-table','0.1.0','user',1,'[\"fs:roots\"]',1,1)").run();
    const v3 = { schema: 3, shell: { sidebarWidth: 280 }, items: { p: { itemId: 'p', sourceKind: 'file', adapterId: 'builtin.pdf', ref: 'r1', displayMode: 'in-app-reader', state: { v: 1, data: { page: 9 } } } }, dock: { grid: {}, panels: { p: { id: 'p', params: { itemId: 'p' } } } } };
    raw.prepare('INSERT INTO workspaces(id,name,project,layout_json,layout_schema,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('w', 'W', '', JSON.stringify(v3), 3, 1, 1);
    raw.pragma('user_version = 3');
    raw.close();
    const svc = new WorkbenchService({ dataDir: dir });
    cleanups.push(() => svc.close());
    expect(svc.db.pragma('user_version', { simple: true })).toBe(5);
    const ws = svc.getWorkspace('w');
    expect(ws.layoutSchema).toBe(4);
    expect((ws.layout as any).items).toBeUndefined();
    expect(ws.items).toEqual([{ itemId: 'p', sourceKind: 'file', adapterId: 'builtin.pdf', ref: 'r1', displayMode: 'in-app-reader', state: { v: 1, data: { page: 9 } } }]);
    expect(svc.listPlugins()[0]).toMatchObject({ id: 'demo.csv-table', granted: [] });
    svc.db.prepare("INSERT INTO plugins(id,version,source,enabled,installed_at,updated_at,uninstalled_at) VALUES ('a.b','1.0.0','adapter',1,0,0,5)").run();
  });
});
