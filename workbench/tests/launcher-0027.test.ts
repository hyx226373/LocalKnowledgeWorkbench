import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireLauncherLock } from '../src/launcher/lock';
import { runLauncher, type LauncherSpawn } from '../src/launcher/main';
import { planLauncherRuntime } from '../src/launcher/runtimePlan';
import { LAUNCHER_EXE, UPDATER_PHASES, appExe, mayLauncherWritePointer, type UpdaterPhase } from '../src/shared/layout';

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeExe(root: string, version: string): void {
  const exe = appExe(root, version);
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, '');
}

function makeLayout(opts: {
  current?: string;
  previous?: string | null;
  phase?: UpdaterPhase | null;
  currentExe?: boolean;
  previousExe?: boolean;
} = {}): string {
  const root = tmp('kb-launch-');
  const current = opts.current ?? '0.2.4';
  const previous = opts.previous === undefined ? '0.2.3' : opts.previous;
  fs.writeFileSync(path.join(root, 'current.json'), JSON.stringify({
    schema: 1,
    current,
    previous,
    updatedAt: '2026-10-10T00:00:00.000Z',
  }));
  if (opts.phase) {
    fs.mkdirSync(path.join(root, 'updater'), { recursive: true });
    fs.writeFileSync(path.join(root, 'updater', 'state.json'), JSON.stringify({
      schema: 1,
      phase: opts.phase,
      fromVersion: '0.2.3',
      toVersion: null,
      candidateRel: null,
      error: null,
      logFile: null,
      attempt: 0,
      startedAt: null,
      updatedAt: '2026-10-10T00:00:00.000Z',
    }));
  }
  if (opts.currentExe !== false) writeExe(root, current);
  if (previous && opts.previousExe !== false) writeExe(root, previous);
  return root;
}

async function run(opts: {
  root: string;
  env?: NodeJS.ProcessEnv;
  isAlive?: (pid: number) => boolean;
  choose?: number;
  now?: string;
}) {
  const dialogs: { message: string; buttons: string[] }[] = [];
  const spawned: LauncherSpawn[] = [];
  const codes: number[] = [];
  const env = opts.env ?? { KB_USER_DATA: 'D:\\kb-data', ELECTRON_RUN_AS_NODE: '1' };
  await runLauncher({
    installRoot: opts.root,
    selfPid: 4242,
    env,
    now: () => opts.now ?? '2026-10-11T03:04:05.000Z',
    isAlive: opts.isAlive ?? (() => false),
    showDialog: async (message, buttons) => {
      dialogs.push({ message, buttons: [...buttons] });
      return opts.choose ?? 0;
    },
    spawnApp: (spec) => { spawned.push(spec); },
    exit: (code) => { codes.push(code); },
  });
  return { dialogs, spawned, codes, env };
}

function expectSpawn(spec: LauncherSpawn, exe: string, version: string, root: string, env: NodeJS.ProcessEnv): void {
  expect(spec.exe).toBe(exe);
  expect(spec.args).toEqual([]);
  expect(spec.detached).toBe(true);
  expect(spec.stdio).toBe('ignore');
  expect(spec.windowsHide).toBe(false);
  expect(spec.shell).toBe(false);
  expect(spec.cwd).toBe(path.win32.dirname(exe));
  expect(spec.env.KB_USER_DATA).toBe(env.KB_USER_DATA);
  expect(spec.env.KB_INSTALL_ROOT).toBe(root);
  expect(spec.env.KB_LAYOUT_VERSION).toBe(version);
  expect(spec.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  expect(spec.args.join(' ')).not.toMatch(/\/MIN|\/S|--updated/);
}

describe('启动器锁', () => {
  it('活着的 pid 占着锁时返回 held，不覆盖', async () => {
    const file = path.join(tmp('kb-lock-'), 'updater', 'launcher.lock');
    expect(await acquireLauncherLock(file, 11, () => false)).toBe('acquired');
    const held = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid: number; at: string };
    expect(held.pid).toBe(11);
    expect(held.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await acquireLauncherLock(file, 22, (pid) => pid === 11)).toBe('held');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).pid).toBe(11);
  });

  it('死 pid 可以抢锁并覆盖', async () => {
    const file = path.join(tmp('kb-lock-'), 'updater', 'launcher.lock');
    expect(await acquireLauncherLock(file, 11, () => false)).toBe('acquired');
    expect(await acquireLauncherLock(file, 22, () => false)).toBe('acquired');
    const body = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid: number; at: string };
    expect(body.pid).toBe(22);
    expect(body.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('锁被占用时启动器退出码 0，不拉起主程序', async () => {
    const root = makeLayout({ previous: null });
    fs.mkdirSync(path.join(root, 'updater'), { recursive: true });
    fs.writeFileSync(path.join(root, 'updater', 'launcher.lock'), JSON.stringify({ pid: 77, at: '2026-10-10T00:00:00.000Z' }));
    const before = fs.readFileSync(path.join(root, 'current.json'), 'utf8');
    const { dialogs, spawned, codes } = await run({ root, isAlive: (pid) => pid === 77 });
    expect(codes).toEqual([0]);
    expect(spawned).toEqual([]);
    expect(dialogs).toEqual([]);
    expect(fs.readFileSync(path.join(root, 'current.json'), 'utf8')).toBe(before);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'updater', 'launcher.lock'), 'utf8')).pid).toBe(77);
  });
});

describe('启动决定', () => {
  it('当前版本在则 detached 拉起，并带上安装根与版本', async () => {
    const root = makeLayout({ previous: null, phase: null });
    const { dialogs, spawned, codes, env } = await run({ root });
    expect(dialogs).toEqual([]);
    expect(codes).toEqual([0]);
    expect(spawned).toHaveLength(1);
    expectSpawn(spawned[0], appExe(root, '0.2.4'), '0.2.4', root, env);
  });

  it('切换中让路，不拉起也不改指针', async () => {
    const root = makeLayout({ phase: 'switching', previous: '0.2.3' });
    const before = fs.readFileSync(path.join(root, 'current.json'), 'utf8');
    const { dialogs, spawned, codes } = await run({ root });
    expect(dialogs).toEqual([{ message: '更新正在进行，请查看更新器窗口', buttons: ['确定'] }]);
    expect(spawned).toEqual([]);
    expect(codes).toEqual([0]);
    expect(fs.readFileSync(path.join(root, 'current.json'), 'utf8')).toBe(before);
  });

  it.each([null, ...UPDATER_PHASES] as (UpdaterPhase | null)[])('主程序缺失 phase=%s 只在允许的阶段回退指针', async (phase) => {
    const root = makeLayout({ phase, currentExe: false, previous: '0.2.3', previousExe: true });
    const before = fs.readFileSync(path.join(root, 'current.json'), 'utf8');
    const { dialogs, spawned, codes, env } = await run({ root, now: '2026-10-11T03:04:05.000Z' });
    if (!mayLauncherWritePointer(phase)) {
      expect(dialogs.map((d) => d.message)).toEqual(['更新正在进行，请查看更新器窗口']);
      expect(spawned).toEqual([]);
      expect(codes).toEqual([0]);
      expect(fs.readFileSync(path.join(root, 'current.json'), 'utf8')).toBe(before);
      return;
    }
    expect(dialogs[0]?.buttons).toEqual(['启动上一版', '退出']);
    expect(codes).toEqual([0]);
    expect(spawned).toHaveLength(1);
    expectSpawn(spawned[0], appExe(root, '0.2.3'), '0.2.3', root, env);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8'))).toEqual({
      schema: 1,
      current: '0.2.3',
      previous: '0.2.4',
      updatedAt: '2026-10-11T03:04:05.000Z',
    });
  });

  it('选退出时不回退指针', async () => {
    const root = makeLayout({ phase: 'failed', currentExe: false });
    const before = fs.readFileSync(path.join(root, 'current.json'), 'utf8');
    const { dialogs, spawned, codes } = await run({ root, choose: 1 });
    expect(dialogs[0]?.buttons).toEqual(['启动上一版', '退出']);
    expect(spawned).toEqual([]);
    expect(codes).toEqual([0]);
    expect(fs.readFileSync(path.join(root, 'current.json'), 'utf8')).toBe(before);
  });

  it('没有上一版时失败并退出码 1', async () => {
    const root = makeLayout({ previous: null, currentExe: false });
    const { dialogs, spawned, codes } = await run({ root });
    expect(spawned).toEqual([]);
    expect(codes).toEqual([1]);
    expect(dialogs[0]?.message).toBe('当前版本无法启动，也没有上一版');
  });
});

describe('运行时布局', () => {
  it('runtimePlan 把 electron.exe 改名为 kb-launch.exe', () => {
    const dist = tmp('kb-edist-');
    fs.writeFileSync(path.join(dist, 'electron.exe'), 'MZ');
    fs.writeFileSync(path.join(dist, 'debug.log'), 'log');
    fs.writeFileSync(path.join(dist, 'icudtl.dat'), 'x');
    fs.mkdirSync(path.join(dist, 'locales'));
    fs.writeFileSync(path.join(dist, 'locales', 'zh-CN.pak'), 'x');
    fs.mkdirSync(path.join(dist, 'resources'));
    fs.writeFileSync(path.join(dist, 'resources', 'default_app.asar'), 'x');
    const plan = planLauncherRuntime(dist);
    expect(plan.packageMain).toBe('main.js');
    expect(plan.renameExe).toEqual({ from: 'electron.exe', to: LAUNCHER_EXE });
    expect(plan.copies).toContainEqual({ from: 'electron.exe', to: 'kb-launch.exe' });
    expect(plan.copies.some((item) => item.to === 'electron.exe' || item.from === 'debug.log')).toBe(false);
    expect(plan.copies).toContainEqual({ from: path.join('locales', 'zh-CN.pak'), to: path.join('locales', 'zh-CN.pak') });
    expect(plan.copies).toContainEqual({
      from: path.join('resources', 'default_app.asar'),
      to: path.join('resources', 'default_app.asar'),
    });
  });
});
