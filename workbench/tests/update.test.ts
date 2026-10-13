import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { handleRequest } from '../src/main/agent-bridge/handlers';
import type { BridgeHost } from '../src/main/agent-bridge/types';
import { UpdateService, type UpdateHooks } from '../src/main/update/service';
import { setAppUpdateChecker } from '../src/shared/actions/packages/appUpdate';
import { actionGate, getInvokeExecutor } from '../src/shared/actions/registry';
import { downloadVerified, hashFileSha512 } from '../src/shared/update/download';
import { parseLatestYml } from '../src/shared/update/latestYml';
import { assertRealProgress, formatByteProgress } from '../src/shared/update/progress';
import { rotateBackups } from '../src/shared/update/rotate';
import { decideAfterSelfCheck, judgeSelfCheck } from '../src/shared/update/selfCheck';
import type { BackupRecord } from '../src/shared/update/types';
import { compareVersions, isNewer, parseVersion } from '../src/shared/update/version';

const nodeRequire = createRequire(import.meta.url);

/** Electron 打过补丁的 fs 会把 .asar 当目录。比对备份字节必须走 original-fs。 */
async function readRaw(file: string): Promise<Buffer> {
  try {
    const raw = nodeRequire('original-fs') as typeof import('node:fs');
    return raw.promises.readFile(file);
  } catch {
    return fs.readFile(file);
  }
}

const ENV_KEYS = ['KB_UPDATE_FEED', 'KB_UPDATE_AUTO_CHECK', 'KB_UPDATE_RATE_LIMIT', 'KB_UPDATE_TEST_HOOK'] as const;
const envBackup = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
const roots: string[] = [];

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const prev = envBackup.get(key);
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
  setAppUpdateChecker(null);
  while (roots.length) {
    const dir = roots.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function tmp(): string {
  const dir = path.join(os.tmpdir(), `kb-update-unit-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  roots.push(dir);
  return dir;
}

function rec(id: string, createdAt: string): BackupRecord {
  return { id, createdAt, version: '0.2.0', dir: id };
}

async function writeFeed(dir: string, version: string, body: Buffer, sha = createHash('sha512').update(body).digest('base64')) {
  await fs.mkdir(dir, { recursive: true });
  const name = `LocalKnowledgeWorkbench-${version}-win-x64-setup.exe`;
  const block = zlib.gzipSync(Buffer.from(`{"version":"${version}"}`));
  await fs.writeFile(path.join(dir, name), body);
  await fs.writeFile(path.join(dir, `${name}.blockmap`), block);
  const yml = [
    `version: ${version}`,
    'files:',
    `  - url: ${name}`,
    `    sha512: '${sha}'`,
    `    size: ${body.length}`,
    `    blockMapSize: ${block.length}`,
    `path: ${name}`,
    `sha512: '${sha}'`,
    'releaseNotes: |',
    '  测试说明',
    '',
  ].join('\n');
  await fs.writeFile(path.join(dir, 'latest.yml'), yml, 'utf8');
  return { name, sha, blockSize: block.length };
}

function hooks(dir: string, extra: Partial<UpdateHooks> = {}): { hooks: UpdateHooks; spawned: { file: string; args: string[]; env: NodeJS.ProcessEnv }[]; exited: boolean } {
  const spawned: { file: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const state = { exited: false };
  const base: UpdateHooks = {
    currentVersion: '0.2.0',
    userDataDir: path.join(dir, 'user'),
    roamingDir: path.join(dir, 'roam'),
    installDir: path.join(dir, 'install'),
    defaultFeed: path.join(dir, 'feed'),
    backupSqlite: async (src, dest) => {
      await fs.copyFile(src, dest);
    },
    prepareShutdown: async () => 'closed',
    closeDatabase: async () => undefined,
    spawnDetached: (file, args, env) => {
      spawned.push({ file, args, env });
    },
    requestExit: () => {
      state.exited = true;
    },
    showReason: async () => undefined,
    applyMode: 'copy',
    noRelaunch: true,
    helperDone: path.join(dir, 'helper-done.txt'),
    relaunchPath: null,
    ...extra,
  };
  return { hooks: base, spawned, get exited() { return state.exited; } } as { hooks: UpdateHooks; spawned: typeof spawned; exited: boolean };
}

async function seedUser(dir: string) {
  const user = path.join(dir, 'user');
  const install = path.join(dir, 'install');
  await fs.mkdir(user, { recursive: true });
  await fs.mkdir(path.join(dir, 'roam'), { recursive: true });
  await fs.mkdir(install, { recursive: true });
  const db = Buffer.alloc(8192);
  Buffer.from('SQLite format 3\0').copy(db);
  await fs.writeFile(path.join(user, 'workbench.db'), db);
  await fs.writeFile(path.join(user, 'canary.json'), 'keep-me', 'utf8');
  await fs.writeFile(path.join(install, 'version.txt'), '0.2.0', 'utf8');
}

describe('版本比较', () => {
  it('按主版本、预发布和构建号比较', () => {
    expect(compareVersions('0.2.0', '0.2.1-test')).toBeLessThan(0);
    expect(compareVersions('0.2.1-test', '0.2.1')).toBeLessThan(0);
    expect(compareVersions('0.2.0-test', '0.2.0')).toBeLessThan(0);
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(isNewer('0.2.1-test', '0.2.0')).toBe(true);
    expect(isNewer('0.2.0', '0.2.0')).toBe(false);
    expect(isNewer('0.2.0', '0.2.1')).toBe(false);
    expect(parseVersion('v0.2.0+build.1').core).toEqual([0, 2, 0]);
    expect(parseVersion('0.2.1-test').pre).toEqual(['test']);
    expect(() => parseVersion('0.01.0')).toThrow(/不合法/);
    expect(() => parseVersion('1.2.junk')).toThrow(/不合法/);
  });
});

describe('进度与备份轮换', () => {
  it('只输出真实字节，拒绝回退的进度', () => {
    expect(formatByteProgress(null)).toBe('');
    expect(formatByteProgress({ transferred: 3, total: 9 })).toBe('已下载 3 字节 / 共 9 字节');
    expect(() => formatByteProgress({ transferred: 4, total: 3 })).toThrow(/不合法/);
    expect(() => formatByteProgress({ transferred: 1.5, total: 2 })).toThrow(/整数/);
    assertRealProgress([{ transferred: 1, total: 4 }, { transferred: 4, total: 4 }], 4);
    expect(() => assertRealProgress([{ transferred: 3, total: 4 }, { transferred: 2, total: 4 }], 4)).toThrow(/回退/);
  });

  it('只保留最近 3 份备份', () => {
    const existing = [rec('a', '2020-01-01T00:00:00.000Z'), rec('b', '2020-01-03T00:00:00.000Z'), rec('c', '2020-01-02T00:00:00.000Z')];
    const rotated = rotateBackups(existing, rec('d', '2020-01-04T00:00:00.000Z'), 3);
    expect(rotated.keep.map((item) => item.id)).toEqual(['d', 'b', 'c']);
    expect(rotated.remove.map((item) => item.id)).toEqual(['a']);
  });
});

describe('自检决定', () => {
  it('没有待升级记录时不动，失败时回到备份', () => {
    expect(decideAfterSelfCheck(undefined, { ok: true })).toEqual({ action: 'none' });
    const pending = { fromVersion: '0.2.0', toVersion: '0.2.1-test', backupId: 'b1' };
    expect(decideAfterSelfCheck(pending, { ok: true })).toEqual({ action: 'clear' });
    const failed = judgeSelfCheck({ dbOpened: false, migrationOk: true, windowLoaded: true, dbError: '数据库打不开' });
    expect(decideAfterSelfCheck(pending, failed)).toEqual({
      action: 'rollback',
      backupId: 'b1',
      previousVersion: '0.2.0',
      reason: '数据库打不开',
    });
    const migration = judgeSelfCheck({ dbOpened: true, migrationOk: false, windowLoaded: true });
    const window = judgeSelfCheck({ dbOpened: true, migrationOk: true, windowLoaded: false });
    expect(migration.ok).toBe(false);
    expect(window.ok).toBe(false);
    if (!migration.ok) expect(migration.reason).toBe('数据库迁移失败');
    if (!window.ok) expect(window.reason).toBe('主窗口没有加载完成');
  });
});

describe('更新服务', () => {
  it('校验失败时丢弃安装包并且不安装', async () => {
    const dir = tmp();
    await fs.mkdir(dir, { recursive: true });
    const body = Buffer.alloc(64 * 1024, 4);
    const feed = path.join(dir, 'feed');
    const good = createHash('sha512').update(Buffer.alloc(64 * 1024, 5)).digest('base64');
    const packed = await writeFeed(feed, '0.2.1-test', body, good);
    const box = hooks(dir);
    const svc = new UpdateService(box.hooks);
    await svc.init();
    const snap = await svc.check();
    expect(snap.phase).toBe('failed');
    expect(snap.downloaded).toBe(false);
    expect(snap.error).toMatch(/丢弃|不一致/);
    await expect(fs.stat(path.join(dir, 'user', 'update-downloads', packed.name))).rejects.toThrow();
    expect(box.spawned).toEqual([]);
    expect(box.exited).toBe(false);
    await expect(svc.installNow()).rejects.toThrow(/还没有校验通过的安装包/);
    expect(box.spawned).toEqual([]);
  });

  it('下载校验通过后才会安装，改过的包在安装前被拒绝', async () => {
    const dir = tmp();
    await fs.mkdir(dir, { recursive: true });
    await seedUser(dir);
    const body = Buffer.alloc(256 * 1024, 7);
    const feed = path.join(dir, 'feed');
    const packed = await writeFeed(feed, '0.2.1-test', body);
    process.env.KB_UPDATE_RATE_LIMIT = '8000000';
    const box = hooks(dir);
    const svc = new UpdateService(box.hooks);
    await svc.init();
    const snap = await svc.check();
    expect(snap.phase).toBe('ready');
    expect(snap.downloaded).toBe(true);
    expect(snap.unsignedNotice).toBe('未签名');
    expect(snap.available?.version).toBe('0.2.1-test');
    expect(snap.available?.unsigned).toBe(true);
    const dest = path.join(dir, 'user', 'update-downloads', packed.name);
    const hash = await hashFileSha512(dest);
    expect(hash).toBe(packed.sha);
    const flipped = Buffer.from(body);
    flipped[0] = flipped[0] === 7 ? 8 : 7;
    await fs.writeFile(dest, flipped);
    await expect(svc.installNow()).rejects.toThrow(/丢弃/);
    expect(box.spawned).toEqual([]);
    expect(box.exited).toBe(false);
  });

  it('安装前备份只留 3 份，自检失败会启动回滚', async () => {
    const dir = tmp();
    await fs.mkdir(dir, { recursive: true });
    await seedUser(dir);
    const body = Buffer.alloc(32 * 1024, 9);
    await writeFeed(path.join(dir, 'feed'), '0.2.1-test', body);
    const oldIds = ['old-a', 'old-b', 'old-c'];
    const backups = oldIds.map((id, index) => {
      const folder = path.join(dir, 'user', 'update-backups', id);
      return { id, createdAt: new Date(Date.UTC(2020, 0, index + 1)).toISOString(), version: '0.1.0', dir: folder };
    });
    for (const item of backups) {
      await fs.mkdir(item.dir, { recursive: true });
      await fs.writeFile(path.join(item.dir, 'marker.txt'), item.id, 'utf8');
    }
    await fs.writeFile(path.join(dir, 'user', 'update-journal.json'), JSON.stringify({ backups }), 'utf8');
    process.env.KB_UPDATE_TEST_HOOK = '1';
    const box = hooks(dir);
    const svc = new UpdateService(box.hooks);
    await svc.init();
    await svc.check();
    await svc.installNow();
    expect(box.exited).toBe(true);
    expect(box.spawned).toHaveLength(1);
    expect(box.spawned[0]?.env.KB_HELPER_MODE).toBe('apply');
    expect(box.spawned[0]?.env.KB_HELPER_VERSION).toBe('0.2.1-test');
    const journal = JSON.parse(await fs.readFile(path.join(dir, 'user', 'update-journal.json'), 'utf8')) as { backups: BackupRecord[]; pending?: { backupId: string; fromVersion: string } };
    expect(journal.backups).toHaveLength(3);
    expect(journal.backups.map((item) => item.id)).not.toContain('old-a');
    expect(journal.pending?.fromVersion).toBe('0.2.0');
    await expect(fs.stat(path.join(dir, 'user', 'update-backups', 'old-a'))).rejects.toThrow();
    const backupDir = journal.backups.find((item) => item.id === journal.pending?.backupId)?.dir;
    expect(backupDir).toBeTruthy();
    expect(await fs.readFile(path.join(backupDir!, 'local', 'canary.json'), 'utf8')).toBe('keep-me');

    let damaged = false;
    const next = hooks(dir, {
      currentVersion: '0.2.1-test',
      selfCheckOverride: () => ({ windowLoaded: false, windowError: '自检被测试钩子标为失败' }),
      damageBeforeRollback: async () => {
        damaged = true;
        await fs.writeFile(path.join(dir, 'user', 'canary.json'), 'damaged', 'utf8');
      },
    });
    const again = new UpdateService(next.hooks);
    await again.init();
    again.armStartup({ dbOpened: true, migrationOk: true, windowLoaded: false });
    again.noteWindowLoaded();
    const started = Date.now();
    while (!next.exited && Date.now() - started < 5000) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(next.exited).toBe(true);
    expect(damaged).toBe(true);
    expect(next.spawned[0]?.env.KB_HELPER_MODE).toBe('rollback');
    expect(next.spawned[0]?.env.KB_HELPER_LOCAL_SRC).toBe('-');
    expect(next.spawned[0]?.env.KB_HELPER_LOCAL_DST).toBe('-');
    expect(next.spawned[0]?.env.KB_HELPER_ROAM_SRC).toBe('-');
    expect(next.spawned[0]?.env.KB_HELPER_ROAM_DST).toBe('-');
    expect(next.spawned[0]?.env.KB_HELPER_LOCAL_DST).not.toBe(path.join(dir, 'user'));
    expect(next.spawned[0]?.env.KB_HELPER_ROAM_DST).not.toBe(path.join(dir, 'roam'));
    expect(next.spawned[0]?.env.KB_HELPER_INSTALL_DST).toBe(path.join(dir, 'install'));
    const reason = await fs.readFile(path.join(dir, 'user', 'update-rollback-reason.txt'), 'utf8');
    expect(reason).toContain('自检被测试钩子标为失败');
    expect(await fs.readFile(path.join(dir, 'user', 'canary.json'), 'utf8')).toBe('damaged');
  });

  it('备份失败时不关机，清掉半成品，还可以再检查和重试', async () => {
    const dir = tmp();
    await fs.mkdir(dir, { recursive: true });
    await seedUser(dir);
    const asar = Buffer.from('fake-asar-bytes-not-a-real-archive');
    await fs.writeFile(path.join(dir, 'install', 'app.asar'), asar);
    const body = Buffer.alloc(32 * 1024, 3);
    await writeFeed(path.join(dir, 'feed'), '0.2.1-test', body);
    const calls: string[] = [];
    const reasons: string[] = [];
    const box = hooks(dir, {
      installDir: path.join(dir, 'user', 'canary.json'),
      prepareShutdown: async () => {
        calls.push('shutdown');
        return 'closed';
      },
      showReason: async (_title, detail) => {
        reasons.push(detail);
      },
    });
    const svc = new UpdateService(box.hooks);
    await svc.init();
    await svc.check();
    await expect(svc.installNow()).rejects.toThrow(/ENOTDIR|EPERM|EINVAL|不是|备份|cp/i);
    expect(calls).toEqual([]);
    expect(box.exited).toBe(false);
    expect(reasons.join('\n')).toMatch(/备份失败，没有开始升级/);
    expect(svc.snapshot().phase).toBe('ready');
    expect(svc.snapshot().downloaded).toBe(true);
    const leftovers = await fs.readdir(path.join(dir, 'user', 'update-backups')).catch(() => [] as string[]);
    expect(leftovers).toEqual([]);
    const journal = JSON.parse(await fs.readFile(path.join(dir, 'user', 'update-journal.json'), 'utf8')) as { backups: BackupRecord[] };
    expect(journal.backups).toEqual([]);
    const again = await svc.check();
    expect(again.phase).toBe('ready');
    expect(again.downloaded).toBe(true);
    box.hooks.installDir = path.join(dir, 'install');
    let sawBackup = false;
    box.hooks.prepareShutdown = async () => {
      calls.push('shutdown');
      const saved = JSON.parse(await fs.readFile(path.join(dir, 'user', 'update-journal.json'), 'utf8')) as { backups: BackupRecord[] };
      const rec = saved.backups[0];
      expect(rec?.dir).toBeTruthy();
      const copied = await readRaw(path.join(rec!.dir, 'install', 'app.asar'));
      expect(Buffer.compare(copied, asar)).toBe(0);
      sawBackup = true;
      return 'closed';
    };
    await svc.installNow();
    expect(sawBackup).toBe(true);
    expect(calls).toEqual(['shutdown']);
    expect(box.exited).toBe(true);
    expect(svc.snapshot().backups).toHaveLength(1);
  });

  it('退出时备份失败不标记离开，修好目录后可以再备份', async () => {
    const dir = tmp();
    await fs.mkdir(dir, { recursive: true });
    await seedUser(dir);
    const body = Buffer.alloc(16 * 1024, 8);
    await writeFeed(path.join(dir, 'feed'), '0.2.1-test', body);
    const calls: string[] = [];
    const box = hooks(dir, {
      installDir: path.join(dir, 'user', 'canary.json'),
      prepareShutdown: async () => {
        calls.push('shutdown');
        return 'closed';
      },
      showReason: async () => undefined,
    });
    const svc = new UpdateService(box.hooks);
    await svc.init();
    await svc.check();
    await svc.installOnQuit();
    expect(await svc.prepareQuitInstall()).toBe(false);
    expect(calls).toEqual([]);
    expect(box.exited).toBe(false);
    expect(svc.snapshot().error).toMatch(/退出时备份失败/);
    expect(svc.snapshot().installOnQuit).toBe(true);
    box.hooks.installDir = path.join(dir, 'install');
    expect(await svc.prepareQuitInstall()).toBe(true);
    expect(calls).toEqual([]);
    expect(box.exited).toBe(false);
    expect(svc.snapshot().backups).toHaveLength(1);
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'user', 'update-journal.json'), 'utf8')) as { backups: BackupRecord[]; pending?: { backupId: string } };
    expect(saved.pending?.backupId).toBe(saved.backups[0]?.id);
    await expect(fs.stat(path.join(saved.backups[0]!.dir, 'install', 'version.txt'))).resolves.toBeTruthy();
  });

  it('没有 latest.yml 时显示已是最新，并记下检查时间', async () => {
    const dir = tmp();
    await fs.mkdir(path.join(dir, 'user'), { recursive: true });
    const box = hooks(dir);
    const svc = new UpdateService(box.hooks);
    await svc.init();
    const snap = await svc.check();
    expect(snap.phase).toBe('idle');
    expect(snap.info).toBe('已是最新');
    expect(snap.error).toBeNull();
    expect(snap.lastCheckAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('空的 latest.yml 也显示已是最新', async () => {
    const dir = tmp();
    const feed = path.join(dir, 'feed');
    await fs.mkdir(feed, { recursive: true });
    await fs.writeFile(path.join(feed, 'latest.yml'), '  \n', 'utf8');
    await fs.mkdir(path.join(dir, 'user'), { recursive: true });
    const box = hooks(dir);
    const svc = new UpdateService(box.hooks);
    await svc.init();
    const snap = await svc.check();
    expect(snap.phase).toBe('idle');
    expect(snap.info).toBe('已是最新');
    expect(snap.error).toBeNull();
  });

  it('HTTP 404 显示已是最新，没有配置更新源仍失败', async () => {
    const dir = tmp();
    await fs.mkdir(path.join(dir, 'user'), { recursive: true });
    const box = hooks(dir, { defaultFeed: 'https://feed.invalid/app/' });
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => new Response('missing', { status: 404 })) as typeof fetch;
    try {
      const svc = new UpdateService(box.hooks);
      await svc.init();
      const snap = await svc.check();
      expect(snap.phase).toBe('idle');
      expect(snap.info).toBe('已是最新');
      expect(snap.lastCheckAt).toBeTruthy();
    } finally {
      globalThis.fetch = orig;
    }
    const empty = hooks(dir, { defaultFeed: '   ' });
    const failed = new UpdateService(empty.hooks);
    await failed.init();
    const bad = await failed.check();
    expect(bad.phase).toBe('failed');
    expect(bad.error).toMatch(/没有配置更新源/);
    expect(bad.lastCheckAt).toBeTruthy();
  });
});

describe('下载校验', () => {
  it('哈希不一致时删除目标文件', async () => {
    const dir = tmp();
    await fs.mkdir(dir, { recursive: true });
    const src = path.join(dir, 'pkg.bin');
    const dest = path.join(dir, 'out.bin');
    const body = Buffer.from('package-bytes');
    await fs.writeFile(src, body);
    const wrong = createHash('sha512').update('other').digest('base64');
    await expect(downloadVerified({
      source: src,
      dest,
      expectedSha512: wrong,
      expectedSize: body.length,
      rateLimitBytesPerSec: null,
      onProgress: () => undefined,
    })).rejects.toThrow(/丢弃/);
    await expect(fs.stat(dest)).rejects.toThrow();
    await expect(fs.stat(`${dest}.part`)).rejects.toThrow();
  });
});

describe('latest.yml', () => {
  it('发布脚本写出 SHA512 和 blockmap，缺文件时失败', async () => {
    const dir = tmp();
    const release = path.join(dir, 'release');
    await fs.mkdir(release, { recursive: true });
    const scriptUrl = new URL('../scripts/write-latest-yml.mjs', import.meta.url);
    const mod = await import(scriptUrl.href) as {
      writeLatestYml: (dir: string, opts?: { notes?: string }) => { written: boolean };
    };
    expect(mod.writeLatestYml(release).written).toBe(false);
    await expect(fs.stat(path.join(release, 'latest.yml'))).rejects.toThrow();

    const name = 'LocalKnowledgeWorkbench-0.2.0-win-x64-setup.exe';
    const body = Buffer.from('installer-bytes');
    await fs.writeFile(path.join(release, name), body);
    expect(() => mod.writeLatestYml(release)).toThrow(/blockmap/);

    await fs.writeFile(path.join(release, `${name}.blockmap`), zlib.gzipSync(Buffer.from('{"block":1}')));
    const previous = process.env.KB_RELEASE_NOTES;
    process.env.KB_RELEASE_NOTES = '第一行\n第二行';
    try {
      expect(mod.writeLatestYml(release).written).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.KB_RELEASE_NOTES;
      else process.env.KB_RELEASE_NOTES = previous;
    }
    const text = await fs.readFile(path.join(release, 'latest.yml'), 'utf8');
    const parsed = parseLatestYml(text);
    expect(parsed.version).toBe('0.2.0');
    expect(parsed.path).toBe(name);
    expect(parsed.sha512).toBe(createHash('sha512').update(body).digest('base64'));
    expect(parsed.files[0]?.size).toBe(body.length);
    expect(parsed.files[0]?.blockMapSize).toBeGreaterThan(0);
    expect(parsed.releaseNotes).toContain('第一行');
    expect(text).toMatch(/^sha512: /m);
    expect(text).toMatch(/^path: /m);
  });
});

describe('ActionId', () => {
  it('检查可执行，安装和回滚在桥上等待批准', async () => {
    expect(actionGate('app.installUpdate').approvalRequired).toBe(true);
    expect(getInvokeExecutor('app.rollbackUpdate')).toBeUndefined();
    const dir = tmp();
    await fs.mkdir(dir, { recursive: true });
    const install = await handleRequest({
      requestId: '00000000-0000-4000-8000-0000000000a1',
      type: 'invoke',
      agentName: 'test',
      snapshot: false,
      actionId: 'app.installUpdate',
      invokeArgs: { when: 'now' },
      ignoredFields: ['approved'],
    }, {} as BridgeHost, dir, () => null);
    expect(install.status).toBe('awaiting_approval');
    const rollback = await handleRequest({
      requestId: '00000000-0000-4000-8000-0000000000a2',
      type: 'invoke',
      agentName: 'test',
      snapshot: false,
      actionId: 'app.rollbackUpdate',
      ignoredFields: [],
    }, {} as BridgeHost, dir, () => null);
    expect(rollback.status).toBe('awaiting_approval');
    setAppUpdateChecker(async () => ({ phase: 'idle', unsignedNotice: '未签名' }));
    const check = await handleRequest({
      requestId: '00000000-0000-4000-8000-0000000000a3',
      type: 'invoke',
      agentName: 'test',
      snapshot: false,
      actionId: 'app.checkUpdate',
      ignoredFields: [],
    }, {} as BridgeHost, dir, () => null);
    expect(check.status).toBe('success');
    expect((check.result as { update?: { unsignedNotice?: string } }).update?.unsignedNotice).toBe('未签名');
  });
});
