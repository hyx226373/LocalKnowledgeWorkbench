/**
 * 第 9 轮合并接线：外部程序项目的主进程宿主（src/main/adapters/appHost.ts）。
 * SDK 的 Notepad++ 模板 + 模拟外部程序（appHarness：找 exe / 签名 / spawn / 超限确认都是替身，其余走真实代码）。
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeService, tmpDir, write } from './helpers';
import { AppHost } from '../src/main/adapters/appHost';
import { AppBackupStore } from '../src/main/adapters/appBackup';
import { createAppHarness } from '../src/main/adapters/appHarness';
import { DEFAULT_APP_BACKUP_LIMITS } from '../src/shared/adapter-sdk/policy';
import type { AppChangesEvent } from '../src/shared/appIpc';

const SDK = process.env.KB_ADAPTER_SDK_DIR ?? path.resolve(__dirname, '../../kb-adapter-sdk');
const ROOT = path.resolve(__dirname, '..');
const PID = 'example.notepadpp';
const AID = 'example.notepadpp.app';
let built = '';
beforeAll(() => {
  built = path.join(tmpDir('kbplug-'), 'npp');
  execFileSync('node', [path.join(ROOT, 'scripts/build-adapter-plugin.mjs'), path.join(SDK, 'templates/app-adapter'), '--out', built], { stdio: 'pipe', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
});
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(limits = DEFAULT_APP_BACKUP_LIMITS) {
  const { svc, dataDir } = await makeService();
  cleanups.push(() => svc.close());
  const a = tmpDir('kbrootA-');
  write(path.join(a, '笔记/todo.txt'), '原始内容');
  write(path.join(a, '笔记/其他.txt'), '同文件夹的其他文件');
  write(path.join(a, '图片/x.png'), 'png');
  const ra = svc.addRoot(a, 'A');
  await svc.scanRoot(ra.id);
  expect(svc.plugins.installFromFolder(built).errors).toEqual([]);
  svc.plugins.setGrant({ pluginId: PID, adapterId: AID, permissionId: 'launch-notepadpp', decision: 'granted' });
  const { deps, harness } = createAppHarness();
  const host = new AppHost(svc, deps, { store: new AppBackupStore(dataDir, limits) });
  const events: AppChangesEvent[] = [];
  host.onChanges((e) => events.push(e));
  const todo = svc.resourceIdFor(ra.id, '笔记/todo.txt');
  const profile = host.createProfile({ adapterId: AID, programId: 'notepadpp', label: 'todo', launch: { templateId: 'open-file', slots: { file: { type: 'resource', resourceId: todo } } } });
  const req = { programId: 'notepadpp', templateId: 'open-file', slots: { file: { type: 'resource' as const, resourceId: todo } } };
  return { svc, dataDir, a, ra, host, harness, events, todo, profile, req, deps };
}
const tick = () => new Promise((r) => setTimeout(r, 20));

describe('应用档案与启动', () => {
  it('档案只接受声明过的程序/模板与允许的文件；启动只能按条目档案的组合', async () => {
    const { svc, ra, host, profile, req, harness } = await setup();
    const png = svc.resourceIdFor(ra.id, '图片/x.png');
    expect(() => host.createProfile({ adapterId: AID, programId: 'cmd', launch: { templateId: 'open-file', slots: {} } })).toThrow(/未声明的程序/);
    expect(() => host.createProfile({ adapterId: AID, programId: 'notepadpp', launch: { templateId: 'open-file', slots: { file: { type: 'resource', resourceId: png } } } })).toThrow(/应用档案不合法/);
    expect(() => host.createProfile({ adapterId: AID, programId: 'notepadpp', launch: { templateId: 'run-anything', slots: {} } })).toThrow(/应用档案不合法/);
    expect(host.getProfile(profile.appProfileId)).toEqual(profile);
    expect(host.getProfile('../evil')).toBeNull();
    // 插件想换文件 / 换模板 → 拒绝
    const other = svc.resourceIdFor(ra.id, '笔记/其他.txt');
    expect(await host.launch(PID, AID, 'i1', profile.appProfileId, { ...req, slots: { file: { type: 'resource', resourceId: other } } })).toMatchObject({ ok: false, reason: 'permission-denied' });
    expect(await host.launch(PID, AID, 'i1', profile.appProfileId, { ...req, templateId: 'blank', slots: {} })).toMatchObject({ ok: false, reason: 'permission-denied' });
    expect(await host.launch(PID, 'other.adapter', 'i1', profile.appProfileId, req)).toMatchObject({ ok: false, reason: 'permission-denied' });
    expect(harness.launches).toEqual([]);
    const r = await host.launch(PID, AID, 'i1', profile.appProfileId, req);
    expect(r).toMatchObject({ ok: true, handle: { status: 'running', backup: { files: 1 } } });
    expect(r.ok && r.handle.backup?.targetUnprotected).toBeFalsy();
    expect(harness.launches[0].argv.slice(0, 2)).toEqual(['-multiInst', '-nosession']);
    expect(harness.launches[0].argv[2]).toMatch(/^D:\\KB\\.*todo\.txt$/);
    expect(host.launcher.owner(r.ok ? r.handle.launchId : '')).toEqual({ pluginId: PID, adapterId: AID, itemId: 'i1' });
  });

  it('授权撤销后不能启动', async () => {
    const { svc, host, profile, req, harness } = await setup();
    svc.plugins.setGrant({ pluginId: PID, adapterId: AID, permissionId: 'launch-notepadpp', decision: 'denied' });
    expect(await host.launch(PID, AID, 'i1', profile.appProfileId, req)).toMatchObject({ ok: false, reason: 'permission-denied' });
    expect(harness.launches).toEqual([]);
  });

  it('目标文件超过备份上限：先问“不备份也启动？”，默认回答否 → 不启动；回答是 → 启动并标注未备份', async () => {
    const { host, profile, req, harness } = await setup({ ...DEFAULT_APP_BACKUP_LIMITS, maxBytesPerLaunch: 4 });
    expect(await host.launch(PID, AID, 'i1', profile.appProfileId, req)).toMatchObject({ ok: false, reason: 'backup-over-limit' });
    expect(harness.confirmPrompts).toHaveLength(1);
    expect(harness.launches).toEqual([]);
    harness.confirmAnswer = true;
    const r = await host.launch(PID, AID, 'i1', profile.appProfileId, req);
    expect(r).toMatchObject({ ok: true, handle: { backup: { targetUnprotected: true } } });
  });
});

describe('退出后记入操作记录，统一撤销', () => {
  it('外部修改 → 退出 → op_log 记一条 external-app 写入 → 撤销回启动前内容', async () => {
    const { svc, a, host, harness, events, profile, req, todo } = await setup();
    const r = await host.launch(PID, AID, 'item-1', profile.appProfileId, req);
    if (!r.ok) throw new Error(r.reason);
    const real = harness.realPath(harness.launches[0].argv[2])!;
    expect(real).toBe(path.join(a, '笔记/todo.txt'));
    fs.writeFileSync(real, 'Notepad++ 改过');
    harness.exit(harness.launches[0].pid, 0);
    await tick();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ itemId: 'item-1', programName: 'Notepad++', afterRestart: false, files: [{ relPath: '笔记/todo.txt', change: 'modified' }] });
    const op = svc.listOps(10).find((o) => o.id === events[0].files[0].opId)!;
    expect(op).toMatchObject({ op: 'write', actor: `app:${PID}` });
    expect(op.detail).toMatchObject({ via: 'external-app', program: 'Notepad++', launchId: r.handle.launchId });
    expect(svc.listOpsFor(todo).some((o) => o.id === op.id)).toBe(true);
    expect(host.pendingChanges('item-1')).toHaveLength(1);
    expect(host.pendingChanges('other')).toEqual([]);
    expect(host.undoExternal(r.handle.launchId)).toEqual({ status: 'undone', files: ['笔记/todo.txt'] });
    expect(fs.readFileSync(real, 'utf8')).toBe('原始内容');
    expect(host.undoExternal(r.handle.launchId)).toEqual({ status: 'nothing' });
    // 没改动的启动不产生操作记录
    const n = svc.listOps(100).length;
    const r2 = await host.launch(PID, AID, 'item-1', profile.appProfileId, req);
    if (!r2.ok) throw new Error(r2.reason);
    harness.exit(harness.launches[1].pid, 0);
    await tick();
    expect(svc.listOps(100).length).toBe(n);
  });

  it('退出后文件又被改过：撤销先返回冲突，确认后撤销（当前内容先进备份库）', async () => {
    const { svc, a, host, harness, profile, req } = await setup();
    const r = await host.launch(PID, AID, 'i', profile.appProfileId, req);
    if (!r.ok) throw new Error(r.reason);
    const real = path.join(a, '笔记/todo.txt');
    fs.writeFileSync(real, '外部 1');
    harness.exit(harness.launches[0].pid);
    await tick();
    fs.writeFileSync(real, '之后又改');
    const c = host.undoExternal(r.handle.launchId);
    expect(c.status).toBe('conflict');
    expect(host.undoExternal(r.handle.launchId, true)).toMatchObject({ status: 'undone' });
    expect(fs.readFileSync(real, 'utf8')).toBe('原始内容');
    const undoOp = svc.listOps(5).find((o) => o.detail.undoOf !== undefined)!;
    const blob = path.join(svc.dataDir, 'blobs', String(undoOp.detail.beforeHash).slice(0, 2), String(undoOp.detail.beforeHash));
    expect(fs.readFileSync(blob, 'utf8')).toBe('之后又改');
  });

  it('工作台在外部程序退出前关闭：下次启动 reconcileStartup 补做比较，提示回到原条目', async () => {
    const { svc, dataDir, a, host, harness, profile, req, deps } = await setup();
    const r = await host.launch(PID, AID, 'item-9', profile.appProfileId, req);
    if (!r.ok) throw new Error(r.reason);
    fs.writeFileSync(path.join(a, '笔记/todo.txt'), '关闭期间改的');
    // “重启”：新的 AppHost（没有内存中的进程表），同一备份区
    const host2 = new AppHost(svc, deps, { store: new AppBackupStore(dataDir) });
    const evs = host2.reconcileStartup();
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ itemId: 'item-9', afterRestart: true, programName: 'Notepad++', files: [{ relPath: '笔记/todo.txt' }] });
    expect(host2.reconcileStartup()).toEqual([]); // 只比较一次
    expect(host2.pendingChanges('item-9')).toHaveLength(1);
    expect(host2.undoExternal(r.handle.launchId)).toMatchObject({ status: 'undone' });
    expect(fs.readFileSync(path.join(a, '笔记/todo.txt'), 'utf8')).toBe('原始内容');
    void harness;
  });
});

describe('外部程序改动的备份保留 14 天（产品决定）', () => {
  it('到期：记录标“备份已过期，无法撤销”，撤销被拒；备份文件被清理，但与其他未过期记录共用的内容保留', async () => {
    const { svc, a, host, harness, profile, req, events } = await setup();
    const r = await host.launch(PID, AID, 'item-1', profile.appProfileId, req);
    if (!r.ok) throw new Error(r.reason);
    const real = harness.realPath(harness.launches[0].argv[2])!;
    fs.writeFileSync(real, '外部改过');
    harness.exit(harness.launches[0].pid, 0);
    await tick();
    const opId = events[0].files[0].opId;
    const op = svc.listOps(10).find((o) => o.id === opId)!;
    const blob = path.join(svc.blobDir, String(op.detail.beforeHash).slice(0, 2), String(op.detail.beforeHash));
    expect(fs.existsSync(blob)).toBe(true);
    expect(svc.opsView(10).find((o) => o.id === opId)!.undo).toEqual({ state: 'available' });
    // 13 天：不过期
    expect(svc.purgeExternalBackups(Date.now() + 13 * 86400_000).expired).toEqual([]);
    // 15 天：过期
    const res = svc.purgeExternalBackups(Date.now() + 15 * 86400_000);
    expect(res.expired).toEqual([opId]);
    expect(res.blobsRemoved).toBe(1);
    expect(fs.existsSync(blob)).toBe(false);
    expect(svc.opsView(10).find((o) => o.id === opId)!.undo).toEqual({ state: 'expired', reason: '备份已过期，无法撤销' });
    expect(svc.undoFromLog(opId, true)).toEqual({ status: 'unrecoverable', detail: ['备份已过期，无法撤销'] });
    expect(host.undoExternal(r.handle.launchId, true)).toMatchObject({ status: 'unrecoverable' });
    expect(fs.readFileSync(real, 'utf8')).toBe('外部改过');
    // 再清理一次不会重复处理
    expect(svc.purgeExternalBackups(Date.now() + 16 * 86400_000).expired).toEqual([]);
    void a;
  });

  it('原位编辑的保存记录共用同一份内容时，外部改动过期也不删除这份备份（编辑器的撤销不受影响）', async () => {
    const { svc, ra, host, harness, profile, req, events, todo } = await setup();
    // 先用编辑器式写入：写入前内容 = “原始内容”，进备份库
    svc.writeText(todo, '编辑器保存的内容');
    svc.writeText(todo, '原始内容'); // 改回，使外部程序启动前的内容与第一条写入的 beforeHash 相同
    const r = await host.launch(PID, AID, 'item-1', profile.appProfileId, req);
    if (!r.ok) throw new Error(r.reason);
    fs.writeFileSync(harness.realPath(harness.launches[0].argv[2])!, '外部改过');
    harness.exit(harness.launches[0].pid, 0);
    await tick();
    const ext = svc.listOps(10).find((o) => o.id === events[0].files[0].opId)!;
    const firstWrite = svc.listOps(10).filter((o) => o.op === 'write' && o.detail.via !== 'external-app').pop()!;
    expect(firstWrite.detail.beforeHash).toBe(ext.detail.beforeHash);
    // 只让外部改动这条过期（编辑器的写入用更新的时间戳不受影响：retention 设成刚好覆盖所有记录，但只处理 external-app）
    const res = svc.purgeExternalBackups(Date.now() + 15 * 86400_000);
    expect(res.expired).toEqual([ext.id]);
    expect(res.blobsRemoved).toBe(0);
    expect(svc.opsView(10).find((o) => o.id === firstWrite.id)!.undo.state).not.toBe('missing');
    void ra;
  });
});

describe('撤销冲突时备份下来的内容可以在操作记录里恢复', () => {
  it('写入 → 外部又改 → 强制撤销（当前内容进备份库）→ 操作记录“恢复撤销前的内容” → 再撤销这条恢复', async () => {
    const { svc, a, todo } = await setup();
    const abs = path.join(a, '笔记/todo.txt');
    const w = svc.writeText(todo, '编辑器保存的版本');
    fs.writeFileSync(abs, '之后外部又改了');
    expect(svc.undoFromLog(w.id)).toMatchObject({ status: 'conflict' });
    const u = svc.undoFromLog(w.id, true);
    if (u.status !== 'undone') throw new Error(u.status);
    expect(fs.readFileSync(abs, 'utf8')).toBe('原始内容');
    expect(u.op.detail.conflictBackup).toBe(true);
    let row = svc.opsView(20).find((o) => o.id === u.op.id)!;
    expect(row.restore).toEqual({ state: 'available' });
    expect(row.undo.state).toBe('unsupported');
    // 没有冲突的撤销不提供恢复
    const w2 = svc.writeText(todo, '第二版');
    const u2 = svc.undoFromLog(w2.id);
    if (u2.status !== 'undone') throw new Error(u2.status);
    expect(svc.opsView(20).find((o) => o.id === u2.op.id)!.restore).toBeUndefined();
    // 恢复：文件在那次撤销之后没再改（第二版已撤销回“原始内容”= 撤销后的内容）→ 直接恢复
    const r = svc.restoreUndoBackup(u.op.id);
    if (r.status !== 'undone') throw new Error(JSON.stringify(r));
    expect(fs.readFileSync(abs, 'utf8')).toBe('之后外部又改了');
    expect(r.op.detail).toMatchObject({ via: 'restore-backup', restoreOf: u.op.id });
    row = svc.opsView(20).find((o) => o.id === u.op.id)!;
    expect(row.restore).toEqual({ state: 'restored' });
    expect(svc.restoreUndoBackup(u.op.id)).toMatchObject({ status: 'unrecoverable' });
    // 恢复本身可以撤销
    expect(svc.undoFromLog(r.op.id)).toMatchObject({ status: 'undone' });
    expect(fs.readFileSync(abs, 'utf8')).toBe('原始内容');
  });

  it('恢复时文件又被改过：先要求确认；确认后现在的内容进备份库（撤销这条恢复即可找回）', async () => {
    const { svc, a, todo } = await setup();
    const abs = path.join(a, '笔记/todo.txt');
    const w = svc.writeText(todo, 'A');
    fs.writeFileSync(abs, 'B（外部）');
    const u = svc.undoFromLog(w.id, true);
    if (u.status !== 'undone') throw new Error(u.status);
    fs.writeFileSync(abs, 'C（撤销后又改）');
    expect(svc.restoreUndoBackup(u.op.id)).toMatchObject({ status: 'conflict' });
    expect(fs.readFileSync(abs, 'utf8')).toBe('C（撤销后又改）');
    const r = svc.restoreUndoBackup(u.op.id, true);
    if (r.status !== 'undone') throw new Error(r.status);
    expect(fs.readFileSync(abs, 'utf8')).toBe('B（外部）');
    expect(svc.undoFromLog(r.op.id)).toMatchObject({ status: 'undone' });
    expect(fs.readFileSync(abs, 'utf8')).toBe('C（撤销后又改）');
  });
});

describe('工作台关闭期间外部程序仍在运行（产品决定）', () => {
  /** 模拟“工作台重启”：同一个数据目录上新建 AppHost（新的模拟外部程序；aliveFile 里的 pid 视为仍在运行） */
  function restart(svc: ConstructorParameters<typeof AppHost>[0], dataDir: string, aliveFile: string) {
    const { deps, harness } = createAppHarness({ aliveFile });
    const host = new AppHost(svc, deps, { store: new AppBackupStore(dataDir) });
    cleanups.push(() => host.dispose());
    const events: AppChangesEvent[] = [];
    host.onChanges((e) => events.push(e));
    return { host, harness, events };
  }

  it('工作台运行中：程序没退出之前不记任何改动', async () => {
    const { svc, host, harness, profile, req } = await setup();
    const r = await host.launch(PID, AID, 'item-1', profile.appProfileId, req);
    if (!r.ok) throw new Error(r.reason);
    const n = svc.listOps(100).length;
    fs.writeFileSync(harness.realPath(harness.launches[0].argv[2])!, '运行中改的');
    await tick();
    expect(host.reconcileStartup()).toEqual([]); // 本次运行中启动的会话不在启动比较之列
    expect(host.pollSessions()).toEqual([]);
    expect(svc.listOps(100).length).toBe(n);
    harness.exit(harness.launches[0].pid, 0);
    await tick();
    expect(svc.listOps(100).length).toBe(n + 1);
  });

  it('关闭期间程序已退出：下次启动对比哈希，补记并标注「工作台关闭期间的外部修改」，会话结束', async () => {
    const { svc, dataDir, a, host, harness, profile, req } = await setup();
    const r = await host.launch(PID, AID, 'item-1', profile.appProfileId, req);
    if (!r.ok) throw new Error(r.reason);
    const abs = path.join(a, '笔记/todo.txt');
    fs.writeFileSync(abs, '关闭期间改的');
    host.dispose(); // “关闭工作台”：程序没退出
    const aliveFile = path.join(dataDir, 'alive.json');
    fs.writeFileSync(aliveFile, '[]'); // 下次启动时已不在运行
    const h2 = restart(svc, dataDir, aliveFile);
    const evs = h2.host.reconcileStartup();
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ launchId: r.handle.launchId, afterRestart: true, itemId: 'item-1', files: [{ relPath: '笔记/todo.txt', change: 'modified' }] });
    const op = svc.listOps(10).find((o) => o.id === evs[0].files[0].opId)!;
    expect(op.detail).toMatchObject({ via: 'external-app', afterRestart: true, label: '工作台关闭期间的外部修改' });
    expect(h2.host.watchingSessions()).toEqual([]);
    expect(h2.host.store.isReconciled(r.handle.launchId)).toBe(true);
    expect(h2.host.reconcileStartup()).toEqual([]); // 不重复补记
    expect(h2.host.undoExternal(r.handle.launchId)).toMatchObject({ status: 'undone' });
    expect(fs.readFileSync(abs, 'utf8')).toBe('原始内容');
    void harness;
  });

  it('重启时程序仍在运行：先补记关闭期间的修改；之后运行中的修改等程序退出才记（基准为重启时的内容），可逐条撤销', async () => {
    const { svc, dataDir, a, host, harness, profile, req } = await setup();
    const r = await host.launch(PID, AID, 'item-1', profile.appProfileId, req);
    if (!r.ok) throw new Error(r.reason);
    const pid = harness.launches[0].pid;
    const abs = path.join(a, '笔记/todo.txt');
    fs.writeFileSync(abs, 'v1 关闭前改的');
    host.dispose();
    fs.writeFileSync(abs, 'v2 关闭期间改的');
    const aliveFile = path.join(dataDir, 'alive.json');
    fs.writeFileSync(aliveFile, JSON.stringify([pid]));
    let h2 = restart(svc, dataDir, aliveFile);
    const evs = h2.host.reconcileStartup();
    expect(evs).toHaveLength(1);
    const closureOp = svc.listOps(10).find((o) => o.id === evs[0].files[0].opId)!;
    expect(closureOp.detail).toMatchObject({ afterRestart: true, label: '工作台关闭期间的外部修改' });
    expect(h2.host.watchingSessions()).toEqual([r.handle.launchId]);
    expect(h2.host.store.isReconciled(r.handle.launchId)).toBe(false);
    // 运行中又改：程序没退出 → 不记
    fs.writeFileSync(abs, 'v3 重启后运行中改的');
    const n = svc.listOps(100).length;
    expect(h2.host.pollSessions()).toEqual([]);
    expect(svc.listOps(100).length).toBe(n);
    // 再重启一次（程序仍在运行）：对比的是上次的基准（v2），只补记 v2→v3，不重复记 v1/v2
    h2.host.dispose();
    h2 = restart(svc, dataDir, aliveFile);
    const evs2 = h2.host.reconcileStartup();
    expect(evs2).toHaveLength(1);
    const second = svc.listOps(10).find((o) => o.id === evs2[0].files[0].opId)!;
    expect(second.detail.beforeHash).toBe(closureOp.detail.afterHash);
    fs.writeFileSync(abs, 'v4 程序退出前最后一次改');
    // 程序退出 → 轮询发现 → 只记基准（v3）之后的修改，不标注关闭期间
    expect(h2.harness.exit(pid)).toBe(true);
    const evs3 = h2.host.pollSessions();
    expect(evs3).toHaveLength(1);
    expect(evs3[0].afterRestart).toBe(false);
    const exitOp = svc.listOps(10).find((o) => o.id === evs3[0].files[0].opId)!;
    expect(exitOp.detail.afterRestart).toBeUndefined();
    expect(exitOp.detail.beforeHash).toBe(second.detail.afterHash);
    expect(h2.host.watchingSessions()).toEqual([]);
    expect(h2.host.store.isReconciled(r.handle.launchId)).toBe(true);
    // 逐条撤销回到启动前
    expect(svc.undoFromLog(exitOp.id)).toMatchObject({ status: 'undone' });
    expect(fs.readFileSync(abs, 'utf8')).toBe('v3 重启后运行中改的');
    expect(svc.undoFromLog(second.id)).toMatchObject({ status: 'undone' });
    expect(svc.undoFromLog(closureOp.id)).toMatchObject({ status: 'undone' });
    expect(fs.readFileSync(abs, 'utf8')).toBe('原始内容');
  });

  it('重启时没有改动且程序仍在运行：不记，只等它退出', async () => {
    const { svc, dataDir, host, harness, profile, req } = await setup();
    const r = await host.launch(PID, AID, 'item-1', profile.appProfileId, req);
    if (!r.ok) throw new Error(r.reason);
    host.dispose();
    const aliveFile = path.join(dataDir, 'alive.json');
    fs.writeFileSync(aliveFile, JSON.stringify([harness.launches[0].pid]));
    const n = svc.listOps(100).length;
    const h2 = restart(svc, dataDir, aliveFile);
    expect(h2.host.reconcileStartup()).toEqual([]);
    expect(svc.listOps(100).length).toBe(n);
    expect(h2.host.watchingSessions()).toEqual([r.handle.launchId]);
  });
});
