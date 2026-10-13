/**
 * 第五轮（T13 剩余）：审计记录（拒绝、越界、计划、授权；合并与上限；卸载时的保留/删除）、
 * 工作区导出中的插件清单（不含存储与授权）与导入时的缺失插件提示、备份包含插件数据、心跳协议。
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { makeService, tmpDir, write } from './helpers';
import { parseAccessError, AUDIT_KINDS, RENDERER_AUDIT_KINDS, PLUGIN_ACCESS_CODES, isPluginAccessCode, hostTimeoutMessage } from '../src/shared/pluginIpc';
import { BUSY_MS, FLOOD_MAX_PER_SEC, HEARTBEAT_MS, LIFECYCLE_TIMEOUT_MS, RPC_TIMEOUT_MS, parseFrameMessage } from '../src/shared/sandboxProtocol';

const SDK = process.env.KB_ADAPTER_SDK_DIR ?? path.resolve(__dirname, '../../kb-adapter-sdk');
const ROOT = path.resolve(__dirname, '..');
const built: Record<string, string> = {};
function buildPlugin(name: string, src: string) {
  const out = path.join(tmpDir('kbplug-'), name);
  execFileSync('node', [path.join(ROOT, 'scripts/build-adapter-plugin.mjs'), src, '--out', out], { stdio: 'pipe', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  return out;
}
beforeAll(() => {
  built.json = buildPlugin('json', path.join(SDK, 'templates/file-adapter'));
  built.notes = buildPlugin('notes', path.join(ROOT, 'e2e/fixtures/plugins/notes'));
  built.loop = buildPlugin('loop', path.join(ROOT, 'e2e/fixtures/plugins/loop'));
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
  write(path.join(a, 'data/config.json'), '{"a":1}');
  write(path.join(a, 'n/todo.note'), 'line 1');
  write(path.join(b, 'other.json'), '{"secret":"B"}');
  const ra = svc.addRoot(a, 'A');
  const rb = svc.addRoot(b, 'B');
  await svc.scanRoot(ra.id);
  await svc.scanRoot(rb.id);
  return { svc, dataDir, ra, rb, rid: (r: string, rel: string) => svc.resourceIdFor(r, rel), a, b };
}
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return parseAccessError(e).code;
  }
  return 'ok';
};
const JV = 'example.json-viewer';
const JA = 'example.json-viewer.reader';

describe('审计记录', () => {
  it('越界/未授权读取、授权变更、计划提交/拦截/拒绝/批准都记入；不含绝对路径；2 秒内重复合并；每插件最多 500 条', async () => {
    const { svc, ra, rb, rid, b } = await setup();
    svc.plugins.installFromFolder(built.json);
    const own = rid(ra.id, 'data/config.json');
    const other = rid(rb.id, 'other.json');
    const read = (r: string) => () => svc.plugins.file(JV, JA, { op: 'readText', resourceId: r });
    expect(code(read(own))).toBe('permission-denied');
    svc.plugins.setGrant({ pluginId: JV, adapterId: JA, permissionId: 'read-json', decision: 'granted', rootIds: [ra.id] });
    for (let i = 0; i < 5; i++) expect(code(read(other))).toBe('out-of-scope');
    read(own)(); // 成功的读取不记
    const log = svc.plugins.listAudit(JV);
    expect(log.map((e) => e.kind)).toEqual(['denied', 'grant', 'denied']);
    expect(log[0]).toMatchObject({ kind: 'denied', code: 'out-of-scope', count: 5, adapterId: JA });
    expect(log[0].detail).toContain('files.readText B/other.json');
    expect(log[2]).toMatchObject({ code: 'permission-denied' });
    expect(JSON.stringify(log)).not.toContain(b); // 不含绝对路径
    // kbfile 令牌越界也记
    const tok = svc.plugins.mintFileToken(JV, JA);
    expect(() => svc.plugins.resolvePluginFileUrl(`kbfile://plugin/${tok}/${other}`)).toThrow();
    expect(svc.plugins.listAudit(JV, 1)[0].detail).toMatch(/^kbfile B\/other\.json/);
    svc.plugins.revoke(JV, JA, 'read-json');
    expect(svc.plugins.listAudit(JV, 1)[0]).toMatchObject({ kind: 'grant', detail: 'read-json：撤销' });
    expect(() => svc.plugins.audit(JV, null, 'bogus' as never, 'x')).toThrow(/未知审计类型/);
    expect(RENDERER_AUDIT_KINDS.every((k) => (AUDIT_KINDS as readonly string[]).includes(k))).toBe(true);

    // 计划
    svc.plugins.installFromFolder(built.notes);
    const id = 'test.notes';
    const note = rid(ra.id, 'n/todo.note');
    const plan = { title: '追加', steps: [{ op: 'write' as const, resourceId: note, content: 'line 1\nline 2' }] };
    expect(code(() => svc.plugins.planPreview(id, 'test.notes.reader', plan))).toBe('permission-denied');
    svc.plugins.setGrant({ pluginId: id, adapterId: 'test.notes.reader', permissionId: 'write', decision: 'granted' });
    svc.plugins.setGrant({ pluginId: id, adapterId: 'test.notes.reader', permissionId: 'read', decision: 'granted', rootIds: [ra.id] });
    const pv = svc.plugins.planPreview(id, 'test.notes.reader', plan);
    svc.plugins.planDiscard(pv.planId);
    const ok = svc.plugins.planPreview(id, 'test.notes.reader', plan);
    const r = svc.plugins.planExecute(ok.planId);
    expect(r.ok).toBe(true);
    const kinds = svc.plugins.listAudit(id).map((e) => e.kind).reverse();
    expect(kinds).toEqual(['plan-blocked', 'grant', 'grant', 'plan-submitted', 'plan-rejected', 'plan-submitted', 'plan-approved']);
    expect(svc.plugins.listAudit(id, 1)[0].detail).toMatch(/「追加」已批准并执行 1 步（操作记录 #\d+）/);
    expect(svc.plugins.listAudit(id).find((e) => e.kind === 'plan-submitted')!.detail).toContain('write A/n/todo.note');

    // 上限：不同内容的记录只保留最近 500 条（按插件）
    for (let i = 0; i < 520; i++) svc.plugins.audit(id, null, 'watchdog', `第 ${i} 次`);
    const all = svc.plugins.listAudit(id, 1000);
    expect(all.length).toBe(500);
    expect(all[0].detail).toBe('第 519 次');
    expect(svc.plugins.listAudit(JV, 1000).length).toBeGreaterThan(0); // 其他插件不受影响
    expect(svc.plugins.listAudit(null, 5).length).toBe(5);
  });

  it('卸载：保留数据时审计保留（重装可见）；删除数据时一并删除；卸载对话框信息包含条数', async () => {
    const { svc, ra, rid } = await setup();
    svc.plugins.installFromFolder(built.json);
    svc.plugins.setGrant({ pluginId: JV, adapterId: JA, permissionId: 'read-json', decision: 'denied' });
    expect(code(() => svc.plugins.file(JV, JA, { op: 'stat', resourceId: rid(ra.id, 'data/config.json') }))).toBe('permission-denied');
    expect(svc.plugins.uninstallInfo(JV).auditEntries).toBe(2);
    svc.plugins.uninstall(JV, { keepData: true });
    svc.plugins.installFromFolder(built.json);
    expect(svc.plugins.listAudit(JV).length).toBe(2);
    svc.plugins.uninstall(JV, { keepData: false });
    expect(svc.plugins.listAudit(JV).length).toBe(0);
  });
});

describe('导出/导入与备份中的插件数据', () => {
  it('工作区导出只列出所需第三方插件（不含存储与授权）；导入到没装插件的电脑时报告缺失插件，条目原样保留', async () => {
    const { svc, ra, rid } = await setup();
    svc.plugins.installFromFolder(built.json);
    svc.plugins.setGrant({ pluginId: JV, adapterId: JA, permissionId: 'read-json', decision: 'granted', rootIds: [ra.id] });
    svc.plugins.storageSet(JV, 'secret-setting', { v: 'S3CRET' });
    const own = rid(ra.id, 'data/config.json');
    const items = [
      { itemId: 'j1', sourceKind: 'file', adapterId: JA, ref: own, displayMode: 'in-app-reader', state: { v: 2, data: { expanded: ['$'] } } },
      { itemId: 'm1', sourceKind: 'file', adapterId: 'builtin.text', ref: own, displayMode: 'in-app-reader' },
    ];
    const layout = { schema: 4, dock: { grid: { root: { type: 'branch', data: [{ type: 'leaf', data: { views: ['j1', 'm1'], activeView: 'j1', id: 'g1' }, size: 100 }], size: 100 }, width: 100, height: 100, orientation: 'HORIZONTAL' }, panels: { j1: { id: 'j1', contentComponent: 'view', params: { itemId: 'j1' }, title: 'config.json' }, m1: { id: 'm1', contentComponent: 'view', params: { itemId: 'm1' }, title: 'config.json' } }, activeGroup: 'g1' }, shell: { sidebarWidth: 260 } };
    const ws = svc.createWorkspace('带插件', '', layout, items);
    const file = svc.exportWorkspace(ws.id);
    expect(file.plugins).toEqual([{ id: JV, name: 'JSON 查看器（示例）', version: expect.any(String), adapterIds: [JA] }]);
    const text = JSON.stringify(file);
    expect(text).not.toContain('S3CRET');
    expect(text).not.toContain('declHash');
    expect(text).not.toContain('rootIds');

    // 本机已安装 → 不缺
    expect(svc.importWorkspace(file).missingPlugins).toEqual([]);
    // “另一台电脑”：插件未安装
    const other = await setup();
    const r = other.svc.importWorkspace(file);
    expect(r.missingPlugins).toEqual([{ id: JV, name: 'JSON 查看器（示例）', version: expect.any(String) }]);
    const imported = other.svc.getWorkspace(r.workspace.id);
    expect(imported.items.find((i) => i.itemId === 'j1')).toMatchObject({ adapterId: JA, state: { v: 2, data: { expanded: ['$'] } } });
    expect(other.svc.plugins.grants(JV)).toEqual([]); // 导入不会授予任何权限
  });

  it('元数据库备份包含插件行（授权）、插件存储与审计记录', async () => {
    const { svc, ra } = await setup();
    svc.plugins.installFromFolder(built.json);
    svc.plugins.setGrant({ pluginId: JV, adapterId: JA, permissionId: 'read-json', decision: 'granted', rootIds: [ra.id] });
    svc.plugins.storageSet(JV, 'k', 1);
    const f = path.join(tmpDir('kbbak-'), 'b.db');
    await svc.backupTo(f);
    const db = new Database(f, { readonly: true });
    expect(JSON.parse((db.prepare('SELECT granted_json FROM plugins WHERE id=?').get(JV) as { granted_json: string }).granted_json)[0]).toMatchObject({ decision: 'granted' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM plugin_kv WHERE plugin_id=?').get(JV)).toEqual({ n: 1 });
    expect((db.prepare('SELECT COUNT(*) AS n FROM plugin_audit WHERE plugin_id=?').get(JV) as { n: number }).n).toBeGreaterThan(0);
    db.close();
    // 插件包本体不在数据库里（在 userData/plugins/<id>/），恢复备份后需重新安装
    expect(fs.existsSync(path.join(svc.plugins.dir, JV, 'manifest.json'))).toBe(true);
  });
});

describe('心跳与超时协议', () => {
  it('pong 消息通过白名单；参数关系合理（心跳间隔 < 卡死阈值 < 生命周期超时 ≤ RPC 超时）', () => {
    expect(parseFrameMessage({ kb: 'kb-frame', type: 'pong', seq: 3 })).toEqual({ type: 'pong', seq: 3 });
    expect(parseFrameMessage({ kb: 'kb-frame', type: 'pong', seq: 'x' })).toBeNull();
    expect(HEARTBEAT_MS * 4).toBeLessThanOrEqual(BUSY_MS);
    expect(BUSY_MS).toBeLessThan(LIFECYCLE_TIMEOUT_MS);
    expect(LIFECYCLE_TIMEOUT_MS).toBeLessThanOrEqual(RPC_TIMEOUT_MS);
    expect(FLOOD_MAX_PER_SEC).toBeGreaterThan(100);
  });
  it('timeout 是宿主错误码（SDK HostErrorCode），超时错误经该类型传递', () => {
    expect(PLUGIN_ACCESS_CODES).toContain('timeout');
    expect(isPluginAccessCode('timeout')).toBe(true);
    expect(isPluginAccessCode('error')).toBe(false);
    expect(parseAccessError(new Error(`[timeout] ${hostTimeoutMessage('files.readText', RPC_TIMEOUT_MS)}`))).toEqual({ code: 'timeout', message: '宿主调用 files.readText 超时（15 秒）' });
    expect(parseAccessError(new Error('boom')).code).toBe('error');
  });
  it('卡死测试插件能安装（manifest 合法）', async () => {
    const { svc } = await setup();
    expect(svc.plugins.installFromFolder(built.loop)).toMatchObject({ id: 'test.loop', errors: [] });
  });
});
