import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appExe,
  dirZipName,
  installPath,
  readCurrent,
  versionDir,
  writeCurrent,
  type AtomicIo,
  type CurrentPointer,
  type TreeCheck,
  type UpdateHandoff,
  type UpdaterState,
} from '../src/shared/layout';
import { rollbackToPrevious, runRecover, runSwitch, type SwitchIo } from '../src/updater/machine';

const sha = 'A'.repeat(88);
const root = 'D:\\kb-r13-work\\updater-0027\\app';
const userData = 'D:\\kb-r13-work\\updater-0027\\userdata';

function pointer(current = '0.2.4', previous: string | null = null, updatedAt = '2026-10-10T12:00:00.000Z'): CurrentPointer {
  return { schema: 1, current, previous, updatedAt };
}

function handoff(over: Partial<UpdateHandoff> = {}): UpdateHandoff {
  return {
    schema: 1,
    fromVersion: '0.2.4',
    toVersion: '0.2.5',
    candidateRel: 'versions/0.2.5',
    sha512: sha,
    size: 10,
    packageName: dirZipName('0.2.5'),
    userDataDir: userData,
    installRoot: root,
    backupId: 'b-1',
    createdAt: '2026-10-11T00:00:00.000Z',
    ...over,
  };
}

function norm(file: string): string {
  return path.win32.resolve(file).toLowerCase();
}

function memoryAtomic(files: Map<string, string>, removed: string[]): AtomicIo {
  return {
    mkdir: async () => undefined,
    readFile: async (file) => {
      const hit = files.get(norm(file));
      if (hit === undefined) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return hit;
    },
    writeFile: async (file, data) => {
      files.set(norm(file), data);
    },
    rename: async (from, to) => {
      const hit = files.get(norm(from));
      if (hit === undefined) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      files.set(norm(to), hit);
      files.delete(norm(from));
    },
    rm: async (target) => {
      removed.push(norm(target));
      files.delete(norm(target));
    },
    sleep: async () => undefined,
  };
}

function harness(options: {
  pids?: () => number[];
  verify?: TreeCheck;
  waitReady?: { ok: boolean; version?: string };
  handoff?: UpdateHandoff;
}) {
  const files = new Map<string, string>();
  const removed: string[] = [];
  const atomic = memoryAtomic(files, removed);
  const spec = options.handoff ?? handoff();
  let now = Date.parse('2026-10-11T00:00:00.000Z');
  let stateText: string | null = null;
  const logs: string[] = [];
  const killed: number[] = [];
  const spawned: { exe: string; env: NodeJS.ProcessEnv; pid: number }[] = [];
  const verified: string[] = [];
  let currentWrites = 0;
  let stateWrites = 0;
  let listed = 0;
  const io: SwitchIo = {
    installRoot: spec.installRoot,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    readCurrent: (installRoot) => readCurrent(installRoot, atomic.readFile),
    writeCurrent: async (installRoot, next) => {
      currentWrites += 1;
      await writeCurrent(installRoot, next, atomic);
    },
    readState: async () => stateText,
    writeState: async (_installRoot, state) => {
      stateWrites += 1;
      stateText = JSON.stringify(state);
    },
    appendLog: async (line) => {
      logs.push(line);
    },
    listAppPids: async (installRoot) => {
      listed += 1;
      expect(installRoot).toBe(spec.installRoot);
      return options.pids ? options.pids() : [];
    },
    verify: async (dir) => {
      verified.push(dir);
      return options.verify ?? { ok: true, missing: [] };
    },
    spawnApp: async (exe, env) => {
      const pid = 5151;
      spawned.push({ exe, env, pid });
      return { pid };
    },
    waitReady: async () => options.waitReady ?? { ok: true, version: spec.toVersion },
    killSpawned: async (pid) => {
      killed.push(pid);
    },
    readHandoff: async () => JSON.stringify(spec),
  };
  return {
    io,
    files,
    removed,
    logs,
    killed,
    spawned,
    verified,
    atomic,
    get currentWrites() {
      return currentWrites;
    },
    get stateWrites() {
      return stateWrites;
    },
    get listed() {
      return listed;
    },
    get stateText() {
      return stateText;
    },
  };
}

afterEach(() => {
  delete process.env.ELECTRON_RUN_AS_NODE;
});

describe('更新器切换', () => {
  it('进程退出后切换成功，current 变为目标，previous 为旧版', async () => {
    process.env.ELECTRON_RUN_AS_NODE = '1';
    let running = true;
    const box = harness({
      pids: () => {
        if (!running) return [];
        running = false;
        return [412];
      },
    });
    await writeCurrent(root, pointer(), box.atomic);
    const result = await runSwitch(box.io, handoff());
    const current = await readCurrent(root, box.atomic.readFile);
    expect(result.phase).toBe('done');
    expect(current.current).toBe('0.2.5');
    expect(current.previous).toBe('0.2.4');
    const rows = box.logs.map((line) => JSON.parse(line) as { phase: string; event: string; ms?: number });
    for (const phase of ['waiting-exit', 'switching', 'starting', 'verifying', 'done']) {
      const pair = rows.filter((row) => row.phase === phase);
      expect(pair.map((row) => row.event)).toEqual(['start', 'end']);
      expect(typeof pair[1]?.ms).toBe('number');
    }
    expect(box.verified).toEqual([versionDir(root, '0.2.5')]);
    expect(box.spawned).toHaveLength(1);
    expect(box.spawned[0]?.exe).toBe(appExe(root, '0.2.5'));
    expect(box.spawned[0]?.env.KB_USER_DATA).toBe(userData);
    expect(box.spawned[0]?.env.KB_INSTALL_ROOT).toBe(root);
    expect(box.spawned[0]?.env.KB_LAYOUT_VERSION).toBe('0.2.5');
    expect(box.spawned[0]?.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
    expect(box.killed).toEqual([]);
    expect(box.removed.filter((item) => item.includes('\\versions\\'))).toEqual([]);
  });

  it('进程一直在则不改 current，并报告 60 秒超时', async () => {
    const box = harness({ pids: () => [77] });
    await writeCurrent(root, pointer(), box.atomic);
    const before = await box.atomic.readFile!(path.win32.join(root, 'current.json'));
    const wall = Date.now();
    const result = await runSwitch(box.io, handoff());
    expect(Date.now() - wall).toBeLessThan(2000);
    expect(result.phase).toBe('failed');
    expect(result.error).toContain('工作台进程未在 60 秒内退出');
    expect(await box.atomic.readFile!(path.win32.join(root, 'current.json'))).toBe(before);
    expect(box.currentWrites).toBe(0);
    expect(box.spawned).toEqual([]);
    const waiting = box.logs.map((line) => JSON.parse(line) as { phase: string; event: string }).filter((row) => row.phase === 'waiting-exit');
    expect(waiting.map((row) => row.event)).toEqual(['start', 'fail']);
  });

  it('新版验证失败时指针回到旧版，并只结束自己拉起的进程', async () => {
    const box = harness({ waitReady: { ok: false } });
    await writeCurrent(root, pointer(), box.atomic);
    const order: string[] = [];
    const write = box.io.writeCurrent;
    box.io.writeCurrent = async (installRoot, next) => {
      order.push(`write:${next.current}`);
      await write(installRoot, next);
    };
    box.io.killSpawned = async (pid) => {
      order.push(`kill:${pid}`);
      box.killed.push(pid);
    };
    const result = await runSwitch(box.io, handoff());
    const current = await readCurrent(root, box.atomic.readFile);
    expect(result.phase).toBe('failed');
    expect(result.error).toContain(installPath(root, 'updater', 'phase.log'));
    expect(current.current).toBe('0.2.4');
    expect(current.previous).toBe('0.2.5');
    expect(box.killed).toEqual([5151]);
    expect(order.indexOf('kill:5151')).toBeGreaterThan(order.indexOf('write:0.2.5'));
    expect(order.indexOf('write:0.2.4')).toBeGreaterThan(order.indexOf('kill:5151'));
    expect(box.removed.filter((item) => item.includes('\\versions\\'))).toEqual([]);
  });

  it('版本目录检查失败时不切换指针', async () => {
    const box = harness({ verify: { ok: false, missing: ['resources/app.asar'] } });
    await writeCurrent(root, pointer(), box.atomic);
    const result = await runSwitch(box.io, handoff());
    const current = await readCurrent(root, box.atomic.readFile);
    expect(result.phase).toBe('failed');
    expect(current).toMatchObject({ current: '0.2.4', previous: null });
    expect(box.currentWrites).toBe(0);
    expect(box.spawned).toEqual([]);
    expect(box.killed).toEqual([]);
  });

  it('阶段停在 verifying 且新版未就绪时，runRecover 回退指针', async () => {
    const box = harness({});
    await writeCurrent(root, pointer('0.2.5', '0.2.4', '2026-10-11T00:01:00.000Z'), box.atomic);
    const state: UpdaterState = {
      schema: 1,
      phase: 'verifying',
      fromVersion: '0.2.4',
      toVersion: '0.2.5',
      candidateRel: 'versions/0.2.5',
      error: null,
      logFile: installPath(root, 'updater', 'phase.log'),
      attempt: 1,
      startedAt: '2026-10-11T00:00:00.000Z',
      updatedAt: '2026-10-11T00:01:00.000Z',
    };
    const result = await runRecover(box.io, state, pointer('0.2.5', '0.2.4', '2026-10-11T00:01:00.000Z'), null);
    const current = await readCurrent(root, box.atomic.readFile);
    expect(result.action).toEqual({ action: 'rollback-pointer' });
    expect(current.current).toBe('0.2.4');
    expect(current.previous).toBe('0.2.5');
    expect(box.removed.filter((item) => item.includes('\\versions\\'))).toEqual([]);
  });

  it('手点回退只换指针，不碰用户数据，也不删版本目录', async () => {
    const box = harness({});
    box.io.waitReady = async () => {
      throw new Error('不应读用户数据');
    };
    box.io.readHandoff = async () => {
      throw new Error('手点回退不读交接');
    };
    await writeCurrent(root, pointer('0.2.5', '0.2.4', '2026-10-11T00:02:00.000Z'), box.atomic);
    const result = await rollbackToPrevious(box.io);
    const current = await readCurrent(root, box.atomic.readFile);
    expect(result.phase).toBe('rolling-back');
    expect(current.current).toBe('0.2.4');
    expect(current.previous).toBe('0.2.5');
    expect(box.verified).toEqual([versionDir(root, '0.2.4')]);
    expect(box.logs.some((line) => line.includes('正在恢复上一版'))).toBe(true);
    expect(box.removed.filter((item) => item.includes('\\versions\\'))).toEqual([]);
    expect(box.stateWrites).toBe(0);
    expect(box.currentWrites).toBe(1);
    expect(box.spawned).toEqual([]);
    expect(box.listed).toBe(0);
  });

  it('上一版目录不完整或没有上一版时不写指针', async () => {
    const broken = harness({ verify: { ok: false, missing: ['resources/app.asar'] } });
    await writeCurrent(root, pointer('0.2.5', '0.2.4'), broken.atomic);
    await expect(rollbackToPrevious(broken.io)).rejects.toThrow(/未恢复指针/);
    expect((await readCurrent(root, broken.atomic.readFile)).current).toBe('0.2.5');
    expect(broken.currentWrites).toBe(0);

    const none = harness({});
    await writeCurrent(root, pointer('0.2.5', null), none.atomic);
    await expect(rollbackToPrevious(none.io)).rejects.toThrow('没有上一版可恢复');
    expect(none.currentWrites).toBe(0);
  });

  it('成功完成且 ready 时不会自动打回上一版', async () => {
    const box = harness({});
    const currentPointer = pointer('0.2.5', '0.2.4', '2026-10-11T00:02:00.000Z');
    await writeCurrent(root, currentPointer, box.atomic);
    const state: UpdaterState = {
      schema: 1,
      phase: 'done',
      fromVersion: '0.2.4',
      toVersion: '0.2.5',
      candidateRel: 'versions/0.2.5',
      error: null,
      logFile: installPath(root, 'updater', 'phase.log'),
      attempt: 1,
      startedAt: '2026-10-11T00:00:00.000Z',
      updatedAt: '2026-10-11T00:02:00.000Z',
    };
    const result = await runRecover(box.io, state, currentPointer, '0.2.5');
    const current = await readCurrent(root, box.atomic.readFile);
    expect(result.action).toEqual({ action: 'already-done' });
    expect(current.current).toBe('0.2.5');
    expect(current.previous).toBe('0.2.4');
    expect(box.currentWrites).toBe(0);
  });

  it('手点回退拒绝 study_dev', async () => {
    const box = harness({ handoff: handoff({ installRoot: 'D:\\study_dev\\LocalKnowledgeWorkbench' }) });
    await expect(rollbackToPrevious(box.io)).rejects.toThrow(/study_dev/);
    expect(box.currentWrites).toBe(0);
    expect(box.stateWrites).toBe(0);
    expect(box.listed).toBe(0);
  });

  it('study_dev 被拒绝', async () => {
    const devApp = harness({ handoff: handoff({ installRoot: 'D:\\study_dev\\LocalKnowledgeWorkbench' }) });
    const devData = harness({ handoff: handoff({ userDataDir: 'D:\\study_dev\\Amy' }) });
    const byRoot = await runSwitch(devApp.io, handoff({ installRoot: 'D:\\study_dev\\LocalKnowledgeWorkbench' }));
    const byData = await runSwitch(devData.io, handoff({ userDataDir: 'D:\\study_dev\\Amy' }));
    expect(byRoot.phase).toBe('failed');
    expect(byRoot.error).toContain('禁止');
    expect(byData.phase).toBe('failed');
    expect(byData.error).toContain('禁止');
    expect(devApp.currentWrites).toBe(0);
    expect(devData.currentWrites).toBe(0);
    expect(devApp.stateWrites).toBe(0);
    expect(devData.stateWrites).toBe(0);
    expect(devApp.listed).toBe(0);
    expect(devData.listed).toBe(0);
  });
});
