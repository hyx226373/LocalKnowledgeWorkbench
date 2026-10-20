import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appExe,
  ATOMIC_RENAME_DELAYS_MS,
  candidateRel,
  decideRecovery,
  dirZipName,
  isUnderStudyDev,
  launcherExe,
  LayoutError,
  mayLauncherWritePointer,
  parseCurrent,
  parseDirpack,
  parseHandoff,
  parseUpdaterState,
  planLaunch,
  planMigration,
  pointAt,
  pointBack,
  RESTART_TO_UPDATE_BODY,
  RESTART_TO_UPDATE_TITLE,
  verifyVersionTree,
  versionDirName,
  writeAtomicJson,
  writeCurrent,
} from '../src/shared/layout';

const roots: string[] = [];
const sha = 'A'.repeat(88);

afterEach(async () => {
  while (roots.length) {
    const dir = roots.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function tmp(): string {
  const dir = path.join(os.tmpdir(), `kb-layout-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  roots.push(dir);
  return dir;
}

function errno(code: string): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function pointer(current = '0.2.4', previous: string | null = null) {
  return { schema: 1 as const, current, previous, updatedAt: '2026-10-10T12:00:00.000Z' };
}

describe('current.json', () => {
  it('拒绝非法 schema，并把合法指针原子写回', async () => {
    expect(() => parseCurrent('{"schema":2}')).toThrow(/schema 不是 1/);
    const root = tmp();
    await writeCurrent(root, pointer());
    const text = await fs.readFile(path.join(root, 'current.json'), 'utf8');
    expect(parseCurrent(text)).toMatchObject({ current: '0.2.4', previous: null });
    expect(pointAt(pointer(), '0.2.5', '2026-10-11T00:00:00.000Z')).toEqual({
      schema: 1,
      current: '0.2.5',
      previous: '0.2.4',
      updatedAt: '2026-10-11T00:00:00.000Z',
    });
    expect(pointBack(pointAt(pointer(), '0.2.5', '2026-10-11T00:00:00.000Z'), '2026-10-11T01:00:00.000Z').current).toBe('0.2.4');
  });

  it('占用时按 200/400 重试，最终失败会恢复原文', async () => {
    const sleeps: number[] = [];
    const removed: string[] = [];
    let stored = '{"schema":1,"current":"0.2.4","previous":null,"updatedAt":"2026-10-10T12:00:00.000Z"}';
    let fails = 0;
    await writeAtomicJson('/app/current.json', pointer('0.2.5', '0.2.4'), {
      mkdir: async () => undefined,
      readFile: async () => stored,
      writeFile: async (_file, data) => {
        stored = data;
      },
      rename: async () => {
        fails += 1;
        if (fails < 3) throw errno('EPERM');
        stored = JSON.stringify(pointer('0.2.5', '0.2.4'));
      },
      rm: async (target) => {
        removed.push(target);
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps).toEqual([ATOMIC_RENAME_DELAYS_MS[0], ATOMIC_RENAME_DELAYS_MS[1]]);
    expect(removed).toEqual(['/app/current.json', '/app/current.json']);
    expect(JSON.parse(stored).current).toBe('0.2.5');

    stored = '{"old":true}';
    let gone = false;
    await expect(
      writeAtomicJson('/app/current.json', pointer(), {
        mkdir: async () => undefined,
        readFile: async (file) => {
          if (file.endsWith('.tmp')) throw errno('ENOENT');
          if (gone) throw errno('ENOENT');
          return stored;
        },
        writeFile: async (file, data) => {
          if (file.endsWith('.tmp')) return;
          stored = data;
          gone = false;
        },
        rename: async () => {
          throw errno('EPERM');
        },
        rm: async (target) => {
          if (target === '/app/current.json') gone = true;
        },
        sleep: async () => undefined,
      }),
    ).rejects.toThrow('版本指针写入失败（EPERM）。current.json 被占用，没有切换版本。');
    expect(stored).toBe('{"old":true}');
  });

  it('非占用错误不重试', async () => {
    let sleeps = 0;
    await expect(
      writeAtomicJson('/app/current.json', pointer(), {
        mkdir: async () => undefined,
        readFile: async () => {
          throw errno('ENOENT');
        },
        writeFile: async () => undefined,
        rename: async () => {
          throw errno('ENOENT');
        },
        rm: async () => undefined,
        sleep: async () => {
          sleeps += 1;
        },
      }),
    ).rejects.toBeInstanceOf(LayoutError);
    expect(sleeps).toBe(0);
  });
});

describe('路径与清单', () => {
  it('启动器不跟版本目录抢 resources，且拒绝 example_dev', () => {
    expect(launcherExe('D:\\app')).toBe('D:\\app\\launcher\\kb-launch.exe');
    expect(appExe('D:\\app', '0.2.4')).toBe('D:\\app\\versions\\0.2.4\\LocalKnowledgeWorkbench.exe');
    expect(candidateRel('0.2.5')).toBe('versions/0.2.5');
    expect(isUnderStudyDev('D:\\example_dev\\LocalKnowledgeWorkbench')).toBe(true);
    expect(isUnderStudyDev('D:\\workspace\\kb-work\\updater-0027\\app')).toBe(false);
    expect(() => appExe('D:\\app', '..\\..\\Windows')).toThrow(/目录名/);
  });

  it('dirpack 与 handoff 只接受完整目录包文件名', () => {
    const manifest = {
      schema: 1,
      version: '0.2.5',
      file: dirZipName('0.2.5'),
      size: 10,
      sha512: sha,
      releaseDate: '2026-10-11T00:00:00.000Z',
      minBaseline: '0.2.2',
    };
    expect(parseDirpack(JSON.stringify(manifest)).file).toBe('LocalKnowledgeWorkbench-0.2.5-win-x64-dir.zip');
    expect(() => parseDirpack(JSON.stringify({ ...manifest, file: 'setup.exe' }))).toThrow(/file 与版本不一致/);
    const handoff = {
      schema: 1,
      fromVersion: '0.2.4',
      toVersion: '0.2.5',
      candidateRel: 'versions/0.2.5',
      sha512: sha,
      size: 10,
      packageName: dirZipName('0.2.5'),
      userDataDir: 'D:\\data',
      installRoot: 'D:\\app',
      backupId: 'b-1',
      createdAt: '2026-10-11T00:00:00.000Z',
    };
    expect(parseHandoff(JSON.stringify(handoff)).toVersion).toBe('0.2.5');
    expect(parseUpdaterState(JSON.stringify({
      schema: 1,
      phase: 'ready',
      fromVersion: '0.2.4',
      toVersion: '0.2.5',
      candidateRel: 'versions/0.2.5',
      error: null,
      logFile: null,
      attempt: 1,
      startedAt: null,
      updatedAt: '2026-10-11T00:00:00.000Z',
    })).phase).toBe('ready');
  });

  it('完整性缺文件即失败', async () => {
    const found = new Set(['LocalKnowledgeWorkbench.exe']);
    const result = await verifyVersionTree('D:\\ver', async (abs) => (found.has(path.win32.basename(abs)) ? 12 : null));
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('resources/app.asar');
  });
});

describe('启动、恢复、迁移', () => {
  it('切换进行中启动器让路，空闲时才允许自己改指针', () => {
    expect(planLaunch({
      lockHeldByOther: false,
      updatePhase: 'switching',
      pointerError: null,
      current: '0.2.4',
      previous: null,
      currentExeExists: true,
      previousExeExists: false,
    })).toEqual({ action: 'defer-to-updater', reason: '更新正在进行，请查看更新器窗口' });
    expect(mayLauncherWritePointer('switching')).toBe(false);
    expect(mayLauncherWritePointer('failed')).toBe(true);
    expect(planLaunch({
      lockHeldByOther: true,
      updatePhase: null,
      pointerError: null,
      current: '0.2.4',
      previous: null,
      currentExeExists: true,
      previousExeExists: false,
    }).action).toBe('second-instance');
    expect(planLaunch({
      lockHeldByOther: false,
      updatePhase: 'idle',
      pointerError: null,
      current: '0.2.4',
      previous: '0.2.3',
      currentExeExists: false,
      previousExeExists: true,
    })).toMatchObject({ action: 'offer-previous', previous: '0.2.3' });
  });

  it('断电时指针已切到未就绪的新版，必须回退指针', () => {
    expect(decideRecovery({
      phase: 'verifying',
      current: '0.2.5',
      fromVersion: '0.2.4',
      toVersion: '0.2.5',
      readyVersion: null,
    })).toEqual({ action: 'rollback-pointer' });
    expect(decideRecovery({
      phase: 'switching',
      current: '0.2.4',
      fromVersion: '0.2.4',
      toVersion: '0.2.5',
      readyVersion: null,
    })).toEqual({ action: 'retry-switch' });
    expect(decideRecovery({
      phase: 'ready',
      current: '0.2.4',
      fromVersion: '0.2.4',
      toVersion: '0.2.5',
      readyVersion: null,
    }).action).toBe('refuse');
    expect(decideRecovery({
      phase: 'verifying',
      current: '0.2.5',
      fromVersion: '0.2.4',
      toVersion: '0.2.5',
      readyVersion: '0.2.5',
    })).toEqual({ action: 'already-done' });
  });

  it('迁移拒绝 example_dev、过旧版本和已迁移布局', () => {
    expect(planMigration({
      hasCurrentJson: false,
      hasAppExe: true,
      hasAsar: true,
      fileVersion: '0.2.4.0',
      underStudyDev: true,
      allowStudyDev: false,
    })).toEqual({ action: 'refuse', reason: '禁止迁移 D:\\example_dev，除非 用户另批' });
    expect(versionDirName('0.2.4.0')).toBe('0.2.4');
    expect(planMigration({
      hasCurrentJson: false,
      hasAppExe: true,
      hasAsar: true,
      fileVersion: '0.2.1',
      underStudyDev: false,
      allowStudyDev: false,
    }).action).toBe('refuse');
    expect(planMigration({
      hasCurrentJson: false,
      hasAppExe: true,
      hasAsar: true,
      fileVersion: '0.2.4',
      underStudyDev: false,
      allowStudyDev: false,
    })).toEqual({ action: 'copy-then-point', version: '0.2.4' });
    const already = planMigration({
      hasCurrentJson: true,
      hasAppExe: true,
      hasAsar: true,
      fileVersion: '0.2.4',
      underStudyDev: false,
      allowStudyDev: false,
    });
    expect(already.action).toBe('refuse');
    if (already.action === 'refuse') expect(already.reason).toBe('已经是版本目录布局');
  });

  it('确认文案已冻结', () => {
    expect(RESTART_TO_UPDATE_TITLE).toBe('重启完成更新');
    expect(RESTART_TO_UPDATE_BODY).toContain('更新窗口会保持打开');
  });
});
