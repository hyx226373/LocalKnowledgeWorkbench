import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeHelperScript } from '../src/main/update/helperScript';
import { UpdateService, type UpdateHooks } from '../src/main/update/service';
import { updaterExe, writeCurrent, type CurrentPointer } from '../src/shared/layout';

const roots: string[] = [];

afterEach(async () => {
  while (roots.length) {
    const dir = roots.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function tmp(): string {
  const dir = path.join(os.tmpdir(), `kb-g36-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  roots.push(dir);
  return dir;
}

function pointer(previous: string | null): CurrentPointer {
  return {
    schema: 1,
    current: '0.2.5',
    previous,
    updatedAt: '2026-10-11T00:00:00.000Z',
  };
}

function boxOf(dir: string, extra: Partial<UpdateHooks> = {}) {
  const spawned: { file: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const order: string[] = [];
  const state = { exited: false };
  const hooks: UpdateHooks = {
    currentVersion: '0.2.5',
    userDataDir: path.join(dir, 'user'),
    roamingDir: path.join(dir, 'roam'),
    installDir: path.join(dir, 'install'),
    defaultFeed: path.join(dir, 'feed'),
    backupSqlite: async (src, dest) => {
      await fs.copyFile(src, dest);
    },
    prepareShutdown: async () => {
      order.push('shutdown');
      return 'closed';
    },
    closeDatabase: async () => {
      order.push('close');
    },
    spawnDetached: (file, args, env) => {
      order.push('spawn');
      spawned.push({ file, args, env });
    },
    requestExit: () => {
      order.push('exit');
      state.exited = true;
    },
    showReason: async () => undefined,
    applyMode: 'dirpack',
    noRelaunch: true,
    helperDone: path.join(dir, 'helper-done.txt'),
    relaunchPath: null,
    ...extra,
  };
  return { hooks, spawned, order, get exited() { return state.exited; } };
}

async function seedMarker(dir: string): Promise<{ marker: string; bytes: Buffer }> {
  const user = path.join(dir, 'user');
  await fs.mkdir(user, { recursive: true });
  await fs.mkdir(path.join(dir, 'roam'), { recursive: true });
  const marker = path.join(user, 'kb-g36-marker.txt');
  const bytes = Buffer.from('user-marker-keep-0036');
  await fs.writeFile(marker, bytes);
  await fs.writeFile(path.join(user, 'kb-g36.db-wal'), Buffer.from('wal-keep'));
  const backupLocal = path.join(user, 'update-backups', 'b-old', 'local');
  await fs.mkdir(backupLocal, { recursive: true });
  await fs.writeFile(path.join(backupLocal, 'kb-g36-marker.txt'), 'backup-overwrite-0036');
  await fs.writeFile(
    path.join(user, 'update-journal.json'),
    JSON.stringify({
      backups: [{ id: 'b-old', createdAt: '2026-10-01T00:00:00.000Z', version: '0.2.4', dir: path.join(user, 'update-backups', 'b-old') }],
    }),
    'utf8',
  );
  return { marker, bytes };
}

describe('回滚不覆盖用户数据', () => {
  it('helper 回滚脚本不删 wal，也不复制 local／roaming', async () => {
    const file = await writeHelperScript();
    const text = await fs.readFile(file, 'utf8');
    expect(text).not.toMatch(/Remove-Wal/);
    expect(text).not.toMatch(/Copy-Tree \$env:KB_HELPER_LOCAL/);
    expect(text).not.toMatch(/Copy-Tree \$env:KB_HELPER_ROAM/);
    expect(text).toMatch(/Copy-Tree \$env:KB_HELPER_INSTALL_SRC \$env:KB_HELPER_INSTALL_DST/);
    expect(text).toMatch(/if \(-not \$src -or \$src -eq '-' -or -not \(Test-Path -LiteralPath \$src\)\) \{ return \}/);
  });

  it('dirpack 拉起更新器 --rollback，不把用户目录交给 helper', async () => {
    const dir = tmp();
    const { marker, bytes } = await seedMarker(dir);
    const install = path.join(dir, 'install');
    await writeCurrent(install, pointer('0.2.4'));
    const beforePointer = await fs.readFile(path.join(install, 'current.json'));
    const box = boxOf(dir);
    const svc = new UpdateService(box.hooks);
    await svc.init();
    expect(svc.snapshot().previousVersion).toBe('0.2.4');
    expect(svc.snapshot().backups).toHaveLength(1);
    await svc.rollback('manual', '手动回滚到上一版');
    expect(box.order).toEqual(['spawn', 'shutdown', 'close', 'exit']);
    expect(box.exited).toBe(true);
    expect(box.spawned).toHaveLength(1);
    expect(box.spawned[0]?.file).toBe(updaterExe(install));
    expect(box.spawned[0]?.args).toEqual(['--rollback']);
    const user = path.join(dir, 'user');
    const roam = path.join(dir, 'roam');
    for (const row of box.spawned) {
      expect(row.env.KB_HELPER_LOCAL_DST).not.toBe(user);
      expect(row.env.KB_HELPER_LOCAL_SRC).not.toBe(user);
      expect(row.env.KB_HELPER_ROAM_DST).not.toBe(roam);
      expect(row.env.KB_HELPER_ROAM_SRC).not.toBe(roam);
      expect(row.env.KB_HELPER_MODE).toBeUndefined();
    }
    expect(Buffer.compare(await fs.readFile(marker), bytes)).toBe(0);
    expect(await fs.readFile(path.join(user, 'kb-g36.db-wal'), 'utf8')).toBe('wal-keep');
    expect(Buffer.compare(await fs.readFile(path.join(install, 'current.json')), beforePointer)).toBe(0);
  });

  it('没有 previous 时抛出，用户标记字节不变', async () => {
    const dir = tmp();
    const { marker, bytes } = await seedMarker(dir);
    const install = path.join(dir, 'install');
    await writeCurrent(install, pointer(null));
    const beforePointer = await fs.readFile(path.join(install, 'current.json'));
    const box = boxOf(dir);
    const svc = new UpdateService(box.hooks);
    await svc.init();
    expect(svc.snapshot().previousVersion).toBeNull();
    await expect(svc.rollback('manual', '手动回滚到上一版')).rejects.toThrow('没有上一版可恢复');
    expect(box.spawned).toEqual([]);
    expect(box.exited).toBe(false);
    expect(box.order).toEqual([]);
    expect(Buffer.compare(await fs.readFile(marker), bytes)).toBe(0);
    expect(await fs.readFile(path.join(dir, 'user', 'kb-g36.db-wal'), 'utf8')).toBe('wal-keep');
    await expect(fs.stat(path.join(dir, 'user', 'update-rollback-reason.txt'))).rejects.toThrow();
    expect(Buffer.compare(await fs.readFile(path.join(install, 'current.json')), beforePointer)).toBe(0);
  });

  it('安装根在 study_dev 下手动回滚只提示覆盖安装，且不改用户标记', async () => {
    const dir = tmp();
    const { marker, bytes } = await seedMarker(dir);
    const reasons: string[] = [];
    const box = boxOf(dir, {
      installDir: 'D:\\study_dev\\kb-g36-not-real',
      showReason: async (_title, detail) => {
        reasons.push(detail);
      },
    });
    const svc = new UpdateService(box.hooks);
    await svc.init();
    await svc.rollback('manual', '手动回滚到上一版');
    expect(reasons.join('\n')).toMatch(/自行覆盖安装/);
    expect(svc.snapshot().phase).toBe('idle');
    expect(box.spawned).toEqual([]);
    expect(box.exited).toBe(false);
    expect(box.order).toEqual([]);
    expect(Buffer.compare(await fs.readFile(marker), bytes)).toBe(0);
  });
});
