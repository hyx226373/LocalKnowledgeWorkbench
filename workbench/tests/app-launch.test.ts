/**
 * 第 9 轮：外部程序启动前备份（D6 收紧版）与进程代理（src/main/adapters）。
 * 用 SDK 的 Notepad++ 应用适配器模板（开发者模式安装）+ 模拟的外部程序（spawn / 签名校验均为替身）。
 * 关键断言：启动 Notepad++ 只备份目标文件，不复制整个已注册根。
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeService, tmpDir, write } from './helpers';
import { AppBackupStore, AppLaunchService, defaultFindExe, describeAdapterDisplay, describePluginDisplays, parseSignatureJson, verifyExeWindows, type AppLaunchDeps, type SpawnedProcess } from '../src/main/adapters';
import { DEFAULT_APP_BACKUP_LIMITS, describeAppRecovery, describePermission, type AppBackupLimits } from '../src/shared/adapter-sdk/policy';
import type { ProcessLaunchPermission, ProgramSpec } from '../src/shared/adapter-sdk/types';

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

function dirSize(d: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (x: string) => {
    for (const e of fs.readdirSync(x, { withFileTypes: true })) {
      const p = path.join(x, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name !== 'record.json' && e.name !== 'session.json') (files++, (bytes += fs.statSync(p).size)); // session.json：pid（判断程序是否仍在运行），不是备份内容
    }
  };
  if (fs.existsSync(d)) walk(d);
  return { files, bytes };
}

async function setup(opts: { manifestPatch?: (m: any) => void; deps?: Partial<AppLaunchDeps>; limits?: AppBackupLimits; now?: () => number } = {}) {
  const { svc, dataDir } = await makeService();
  cleanups.push(() => svc.close());
  const a = tmpDir('kbrootA-');
  write(path.join(a, '笔记/todo.txt'), '原始内容');
  write(path.join(a, '笔记/todo.bak'), '伴随文件');
  write(path.join(a, '笔记/其他.txt'), '同文件夹的其他文件');
  for (let i = 0; i < 120; i++) write(path.join(a, `资料/批量/${i}.md`), 'x'.repeat(2000));
  write(path.join(a, '资料/大文件.bin'), Buffer.alloc(3 * 1024 * 1024, 1));
  const ra = svc.addRoot(a, 'A');
  await svc.scanRoot(ra.id);
  let pkg = built;
  if (opts.manifestPatch) {
    pkg = path.join(tmpDir('kbplug-'), 'npp');
    fs.cpSync(built, pkg, { recursive: true });
    const m = JSON.parse(fs.readFileSync(path.join(pkg, 'manifest.json'), 'utf8'));
    opts.manifestPatch(m);
    fs.writeFileSync(path.join(pkg, 'manifest.json'), JSON.stringify(m));
  }
  const dto = svc.plugins.installFromFolder(pkg);
  expect(dto.errors).toEqual([]);
  svc.plugins.setGrant({ pluginId: PID, adapterId: AID, permissionId: 'launch-notepadpp', decision: 'granted' });
  const spawned: Array<{ exe: string; argv: string[]; exit: (code: number) => void }> = [];
  const audits: string[] = [];
  const deps: AppLaunchDeps = {
    plugins: () => svc.plugins.list(),
    resolveResource: (rid) => {
      const r = svc.getResource(rid);
      if (!r || !r.exists || r.kind !== 'file') return null;
      const root = svc.listRoots().find((x) => x.id === r.rootId)!;
      return { rootId: r.rootId, rootPath: root.path, relPath: r.relPath, abs: svc.resolveResourcePath(rid), ext: r.ext };
    },
    rootPathOf: (id) => svc.listRoots().find((x) => x.id === id)?.path ?? null,
    findExe: () => 'C:\\Program Files\\Notepad++\\notepad++.exe',
    verifyExe: async () => ({ ok: true, publisher: 'Notepad++', version: '8.9.0.0' }),
    spawn: (exe, argv): SpawnedProcess => {
      let cb: (c: number | null) => void = () => {};
      spawned.push({ exe, argv, exit: (c) => cb(c) });
      return { pid: 4242, onExit: (f) => (cb = f) };
    },
    argvPath: (abs) => 'D:\\A\\' + path.relative(a, abs).split(path.sep).join('\\'),
    audit: (_p, _a, kind, detail) => audits.push(`${kind}: ${detail}`),
    ...(opts.now ? { now: opts.now } : {}),
    ...opts.deps,
  };
  const store = new AppBackupStore(dataDir, opts.limits ?? DEFAULT_APP_BACKUP_LIMITS, opts.now);
  const svcLaunch = new AppLaunchService(deps, store);
  const rid = (rel: string) => svc.resourceIdFor(ra.id, rel);
  const fileReq = (rel: string) => ({ programId: 'notepadpp', templateId: 'open-file', slots: { file: { type: 'resource' as const, resourceId: rid(rel) } } });
  return { svc, dataDir, a, ra, rid, store, launcher: svcLaunch, spawned, audits, fileReq };
}

describe('外部程序启动前备份（D6 收紧版）', () => {
  it('启动 Notepad++ 适配器只备份目标文件，不复制整个已注册根', async () => {
    const { launcher, store, spawned, fileReq, a, audits } = await setup();
    const r = await launcher.launch(PID, AID, 'item-1', fileReq('笔记/todo.txt'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.argv).toEqual(['-multiInst', '-nosession', 'D:\\A\\笔记\\todo.txt']);
    expect(r.handle.backup).toEqual({ files: 1, bytes: Buffer.byteLength('原始内容'), skipped: 0 });
    const rec = store.get(r.handle.launchId)!;
    expect(rec.files.map((f) => [f.relPath, f.why])).toEqual([['笔记/todo.txt', 'target']]);
    // 备份区里只有 1 个文件，而根里有 120+ 个文件、3 MB 以上
    const backupDir = dirSize(store.dir);
    const rootDir = dirSize(a);
    expect(backupDir).toEqual({ files: 1, bytes: Buffer.byteLength('原始内容') });
    expect(rootDir.files).toBeGreaterThan(120);
    expect(JSON.stringify(rec)).not.toContain(a); // 记录里没有绝对路径
    expect(audits.some((x) => x.includes('启动前备份 1 个文件'))).toBe(true);
  });

  it('程序退出后比较哈希；备份范围内的修改可恢复，恢复前的内容也另存（恢复可撤销）', async () => {
    const { launcher, store, spawned, fileReq, a, svc } = await setup();
    const r = await launcher.launch(PID, AID, 'item-1', fileReq('笔记/todo.txt'));
    if (!r.ok) throw new Error(r.reason);
    fs.writeFileSync(path.join(a, '笔记/todo.txt'), '被外部程序改过');
    fs.writeFileSync(path.join(a, '笔记/其他.txt'), '范围外也被改了');
    spawned[0]!.exit(0);
    expect(launcher.changes(r.handle.launchId)).toEqual([{ rootId: svc.listRoots()[0]!.id, relPath: '笔记/todo.txt', change: 'modified' }]);
    expect(launcher.list(PID)[0]!.status).toBe('exited');
    const rootPathOf = (id: string) => svc.listRoots().find((x) => x.id === id)?.path ?? null;
    const out = store.restore(r.handle.launchId, rootPathOf);
    expect(out.restored).toEqual(['笔记/todo.txt']);
    expect(fs.readFileSync(path.join(a, '笔记/todo.txt'), 'utf8')).toBe('原始内容');
    expect(fs.readFileSync(path.join(a, '笔记/其他.txt'), 'utf8')).toBe('范围外也被改了'); // 范围外：不可恢复
    store.restore(out.undoId!, rootPathOf);
    expect(fs.readFileSync(path.join(a, '笔记/todo.txt'), 'utf8')).toBe('被外部程序改过');
  });

  it('清单声明 backup.include 时才备份附加文件；改动 backup 需要重新授权', async () => {
    const patch = (m: any) => (m.contributes.adapters[0].permissions[0].programs[0].backup = { include: ['{stem}.*'] });
    const { launcher, store, fileReq, svc } = await setup({ manifestPatch: patch });
    const r = await launcher.launch(PID, AID, 'item-1', fileReq('笔记/todo.txt'));
    if (!r.ok) throw new Error(r.reason);
    expect(store.get(r.handle.launchId)!.files.map((f) => f.relPath)).toEqual(['笔记/todo.txt', '笔记/todo.bak']);
    // 旧授权的 declHash 与新声明不一致 → 拒绝启动，需要重新授权
    const old = svc.plugins.grants(PID)[0]!;
    svc.db.prepare('UPDATE plugins SET granted_json=? WHERE id=?').run(JSON.stringify([{ ...old, declHash: 'deadbeef' }]), PID);
    const r2 = await launcher.launch(PID, AID, 'item-2', fileReq('笔记/todo.txt'));
    expect(r2).toMatchObject({ ok: false, reason: 'permission-denied' });
  });

  it('上限：附加文件超出数量上限的跳过并计数，不阻止启动', async () => {
    const patch = (m: any) => (m.contributes.adapters[0].permissions[0].programs[0].backup = { include: ['**/*.md'] });
    const limits = { ...DEFAULT_APP_BACKUP_LIMITS, maxFilesPerLaunch: 10, maxBytesPerLaunch: 1024 * 1024 };
    const { launcher, store, spawned, fileReq } = await setup({ manifestPatch: patch, limits });
    const r = await launcher.launch(PID, AID, 'i1', fileReq('资料/批量/0.md'));
    if (!r.ok) throw new Error(r.reason);
    expect(r.handle.backup).toMatchObject({ files: 10, skipped: 110 });
    const rec = store.get(r.handle.launchId)!;
    expect(rec.files[0]).toMatchObject({ relPath: '资料/批量/0.md', why: 'target' });
    expect(rec.files.every((f) => f.relPath.startsWith('资料/批量/'))).toBe(true); // 只在目标文件夹之下
    expect(spawned).toHaveLength(1);
  });

  it('目标文件超过上限：默认 backup-over-limit 不启动；confirmUnprotected 同意后启动并标注', async () => {
    let asked = 0;
    const limits = { ...DEFAULT_APP_BACKUP_LIMITS, maxBytesPerLaunch: 4 };
    const s1 = await setup({ limits });
    const r1 = await s1.launcher.launch(PID, AID, 'i1', s1.fileReq('笔记/todo.txt'));
    expect(r1).toMatchObject({ ok: false, reason: 'backup-over-limit' });
    expect(s1.spawned).toHaveLength(0);
    const s2 = await setup({ limits, deps: { confirmUnprotected: async () => (asked++, true) } });
    const r2 = await s2.launcher.launch(PID, AID, 'i1', s2.fileReq('笔记/todo.txt'));
    expect(asked).toBe(1);
    expect(r2.ok && r2.handle.backup).toEqual({ files: 0, bytes: 0, skipped: 0, targetUnprotected: true });
  });

  it('保留期与总量上限：过期记录与最旧记录被清理', async () => {
    let t = 1_000_000_000_000;
    const limits = { ...DEFAULT_APP_BACKUP_LIMITS, retentionDays: 14, maxStoreBytes: 30 };
    const s = await setup({ limits, now: () => t });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      t += 60_000;
      const r = await s.launcher.launch(PID, AID, `i${i}`, s.fileReq('笔记/todo.txt'));
      if (!r.ok) throw new Error(r.reason);
      ids.push(r.handle.launchId);
    }
    // 每条 12 字节，总量上限 30 → 只保留最新的 2 条
    expect(s.store.list().map((r) => r.launchId)).toEqual([ids[2], ids[1]]);
    t += 15 * 24 * 3600 * 1000;
    expect(s.store.prune().sort()).toEqual([ids[1], ids[2]].sort());
    expect(s.store.list()).toEqual([]);
  });
});

describe('进程代理：权限边界不变', () => {
  it('未授权 / 已停用 / 未声明的程序 / 签名校验失败 / 参数注入 → 不启动', async () => {
    const s = await setup();
    s.svc.plugins.revoke(PID, AID, 'launch-notepadpp');
    expect(await s.launcher.launch(PID, AID, 'i', s.fileReq('笔记/todo.txt'))).toMatchObject({ ok: false, reason: 'permission-denied' });
    s.svc.plugins.setGrant({ pluginId: PID, adapterId: AID, permissionId: 'launch-notepadpp', decision: 'granted' });
    expect(await s.launcher.launch(PID, AID, 'i', { programId: 'calc', templateId: 'open-file' })).toMatchObject({ ok: false, reason: 'unknown-program' });
    expect(await s.launcher.launch(PID, AID, 'i', { programId: 'notepadpp', templateId: 'open-file', slots: { file: { type: 'resource', resourceId: s.rid('资料/大文件.bin') } } })).toMatchObject({ ok: false, reason: 'resource-out-of-scope' });
    expect(await s.launcher.launch(PID, AID, 'i', { programId: 'notepadpp', templateId: 'blank', slots: { extra: { type: 'enum', value: '-pluginsDir=x' } } } as any)).toMatchObject({ ok: false, reason: 'invalid-slot' });
    s.svc.plugins.setEnabled(PID, false);
    expect(await s.launcher.launch(PID, AID, 'i', s.fileReq('笔记/todo.txt'))).toMatchObject({ ok: false, reason: 'permission-denied', detail: '插件已停用' });
    s.svc.plugins.setEnabled(PID, true);
    const bad = await setup({ deps: { verifyExe: async () => ({ ok: false, reason: 'publisher-mismatch' }) } });
    expect(await bad.launcher.launch(PID, AID, 'i', bad.fileReq('笔记/todo.txt'))).toMatchObject({ ok: false, reason: 'verification-failed' });
    const old = await setup({ deps: { verifyExe: async () => ({ ok: true, version: '8.6.0.0' }) } });
    expect(await old.launcher.launch(PID, AID, 'i', old.fileReq('笔记/todo.txt'))).toMatchObject({ ok: false, reason: 'verification-failed', detail: 'version-out-of-range' });
    expect(s.spawned.length + bad.spawned.length + old.spawned.length).toBe(0);
    expect(fs.readdirSync(s.store.dir)).toEqual([]); // 被拒绝的启动不产生备份
  });

  it('单实例与频率限制；空白模板不备份', async () => {
    const s = await setup();
    const r = await s.launcher.launch(PID, AID, 'i', s.fileReq('笔记/todo.txt'));
    expect(r.ok).toBe(true);
    expect(await s.launcher.launch(PID, AID, 'i', s.fileReq('笔记/todo.txt'))).toMatchObject({ ok: false, reason: 'already-running' });
    const b = await s.launcher.launch(PID, AID, 'j', { programId: 'notepadpp', templateId: 'blank' });
    expect(b.ok && b.handle.backup).toBe(undefined);
    expect(s.store.list()).toHaveLength(1);
  });

  it('exe 查找只展开白名单环境变量；非 Windows 上缺省校验返回 unsupported-os；签名输出解析', async () => {
    const spec = { exeCandidates: ['%ProgramFiles%\\Notepad++\\notepad++.exe', '%ProgramFiles(x86)%\\Notepad++\\notepad++.exe'] } as ProgramSpec;
    expect(defaultFindExe(spec, { 'ProgramFiles(x86)': 'C:\\PF86' }, (p) => p === 'C:\\PF86\\Notepad++\\notepad++.exe')).toBe('C:\\PF86\\Notepad++\\notepad++.exe');
    expect(defaultFindExe(spec, {}, () => true)).toBe(null);
    expect(await verifyExeWindows('x', { verify: { publisher: 'Notepad++' } } as ProgramSpec, 'linux')).toEqual({ ok: false, reason: 'unsupported-os' });
    expect(parseSignatureJson('{"status":"Valid","subject":"CN=Notepad++, O=Notepad++, L=Saint Cloud, C=FR","version":"8.9.0.0"}')).toEqual({ status: 'Valid', cn: 'Notepad++', version: '8.9.0.0' });
    expect(parseSignatureJson('{"status":"NotSigned","subject":"","version":""}')).toEqual({ status: 'NotSigned', cn: null, version: null });
  });
});

describe('显示方式与可恢复说明（授权框/适配器详情通过 describePermission 显示）', () => {
  it('Notepad++ 适配器如实标注为外部窗口启动；授权说明列出备份范围、可恢复、不可恢复', async () => {
    const m = JSON.parse(fs.readFileSync(path.join(built, 'manifest.json'), 'utf8'));
    const [info] = describePluginDisplays(m);
    expect(info).toMatchObject({ displayMode: 'external-managed', short: '外部窗口启动', mismatch: null });
    expect(info!.label).toContain('不是内嵌窗口');
    const lines = describePermission(m.contributes.adapters[0].permissions[0] as ProcessLaunchPermission);
    const spec = (m.contributes.adapters[0].permissions[0] as ProcessLaunchPermission).programs[0]!;
    expect(lines).toContain('启动前备份：只备份要用 Notepad++ 打开的那个文件；不会复制整个文件夹');
    expect(lines.find((l) => l.startsWith('可恢复：'))).toMatch(/记入操作记录，可撤销回启动前的内容/);
    expect(lines.find((l) => l.startsWith('不可恢复：'))).toMatch(/另存为.*设置.*注册表/);
    // 产品决定 7：可恢复说明的全部条目都显示（不只第一条）
    expect(lines.filter((l) => l.startsWith('可恢复：')).map((l) => l.slice(4))).toEqual(describeAppRecovery(spec).recoverable);
    expect(lines.find((l) => l.startsWith('不可恢复：'))).toBe(`不可恢复：${describeAppRecovery(spec).notRecoverable.join('；')}`);
    expect(describeAdapterDisplay({ id: 'x', title: 'x', sourceKinds: ['web'], displayMode: 'in-app-reader', permissions: [] }).mismatch).toMatch(/必须声明为 in-app-web/);
  });
});
