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
import { parseLatestYml, parseUpdateSignal } from '../src/shared/update/latestYml';
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

/** 简化更新夹具：信号内带绝对 https 下载链接，不落地安装包。 */
async function writeSignalFeed(dir: string, version: string, downloadUrl: string, kind: 'yml' | 'json' = 'yml') {
  await fs.mkdir(dir, { recursive: true });
  const name = `LocalKnowledgeWorkbench-${version}-win-x64-setup.exe`;
  if (kind === 'json') {
    const body = {
      version,
      downloadUrl,
      notes: '测试说明',
      path: name,
    };
    await fs.writeFile(path.join(dir, 'latest.json'), JSON.stringify(body, null, 2), 'utf8');
    return { name, downloadUrl };
  }
  const yml = [
    `version: ${version}`,
    'files:',
    `  - url: ${downloadUrl}`,
    `    sha512: 'dGVzdA=='`,
    `    size: 1`,
    `path: ${downloadUrl}`,
    `sha512: 'dGVzdA=='`,
    'releaseNotes: |',
    '  测试说明',
    '',
  ].join('\n');
  await fs.writeFile(path.join(dir, 'latest.yml'), yml, 'utf8');
  return { name, downloadUrl };
}

function hooks(dir: string, extra: Partial<UpdateHooks> = {}): { hooks: UpdateHooks; spawned: { file: string; args: string[]; env: NodeJS.ProcessEnv }[]; exited: boolean; opened: string[] } {
  const spawned: { file: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const opened: string[] = [];
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
    openExternal: async (url) => {
      opened.push(url);
    },
    ...extra,
  };
  return { hooks: base, spawned, opened, get exited() { return state.exited; } } as { hooks: UpdateHooks; spawned: typeof spawned; exited: boolean; opened: string[] };
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
  it('检查 yml 信号有新版时写入 downloadUrl，且不写 update-downloads', async () => {
    const dir = tmp();
    await fs.mkdir(dir, { recursive: true });
    const url = 'https://example.com/releases/LocalKnowledgeWorkbench-0.2.1-test-win-x64-setup.exe';
    await writeSignalFeed(path.join(dir, 'feed'), '0.2.1-test', url, 'yml');
    const box = hooks(dir);
    const svc = new UpdateService(box.hooks);
    await svc.init();
    const snap = await svc.check();
    expect(snap.phase).toBe('ready');
    expect(snap.downloaded).toBe(true);
    expect(snap.available?.version).toBe('0.2.1-test');
    expect(snap.available?.downloadUrl).toBe(url);
    expect(snap.info).toMatch(/可下载/);
    await expect(fs.stat(path.join(dir, 'user', 'update-downloads'))).rejects.toThrow();
    expect(box.spawned).toEqual([]);
    expect(box.exited).toBe(false);
  });

  it('检查 JSON 信号并在 installNow 时调用 openExternal', async () => {
    const dir = tmp();
    await fs.mkdir(dir, { recursive: true });
    const url = 'https://cdn.example.com/kb/LocalKnowledgeWorkbench-0.3.0-win-x64-setup.exe';
    await writeSignalFeed(path.join(dir, 'feed'), '0.3.0', url, 'json');
    // resolveFeed 本地目录默认读 latest.yml；json 夹具走 latest.json 回退
    const box = hooks(dir);
    const svc = new UpdateService(box.hooks);
    await svc.init();
    const snap = await svc.check();
    expect(snap.available?.downloadUrl).toBe(url);
    expect(snap.downloaded).toBe(true);
    await svc.installNow();
    expect(box.opened).toEqual([url]);
    expect(box.spawned).toEqual([]);
    expect(box.exited).toBe(false);
    expect(svc.snapshot().info).toMatch(/浏览器打开下载链接/);
  });

  it('本地相对路径信号没有 https 时检查失败', async () => {
    const dir = tmp();
    await fs.mkdir(dir, { recursive: true });
    const body = Buffer.alloc(64, 1);
    await writeFeed(path.join(dir, 'feed'), '0.2.1-test', body);
    const box = hooks(dir);
    const svc = new UpdateService(box.hooks);
    await svc.init();
    const snap = await svc.check();
    expect(snap.phase).toBe('failed');
    expect(snap.error).toMatch(/公开 https/);
    expect(snap.downloaded).toBe(false);
    await expect(fs.stat(path.join(dir, 'user', 'update-downloads'))).rejects.toThrow();
  });

  it('已是最新时不打开下载', async () => {
    const dir = tmp();
    await fs.mkdir(dir, { recursive: true });
    const url = 'https://example.com/releases/LocalKnowledgeWorkbench-0.2.0-win-x64-setup.exe';
    await writeSignalFeed(path.join(dir, 'feed'), '0.2.0', url, 'yml');
    const box = hooks(dir);
    const svc = new UpdateService(box.hooks);
    await svc.init();
    const snap = await svc.check();
    expect(snap.phase).toBe('idle');
    expect(snap.info).toBe('已是最新');
    expect(snap.available).toBeNull();
    await expect(svc.installNow()).rejects.toThrow(/没有可打开的下载链接/);
    expect(box.opened).toEqual([]);
  });

  it('下次退出升级与手动回滚改为提示自行覆盖安装', async () => {
    const dir = tmp();
    await fs.mkdir(dir, { recursive: true });
    const url = 'https://example.com/r/setup.exe';
    await writeSignalFeed(path.join(dir, 'feed'), '0.9.0', url, 'yml');
    const reasons: string[] = [];
    const box = hooks(dir, {
      showReason: async (_t, detail) => {
        reasons.push(detail);
      },
    });
    const svc = new UpdateService(box.hooks);
    await svc.init();
    await svc.check();
    const quit = await svc.installOnQuit();
    expect(quit.installOnQuit).toBe(false);
    expect(quit.info).toMatch(/自行.*覆盖安装/);
    expect(await svc.prepareQuitInstall()).toBe(false);
    await svc.rollback('manual', '用户点了回滚');
    expect(reasons.join('\n')).toMatch(/自行覆盖安装/);
    expect(box.spawned).toEqual([]);
    expect(box.exited).toBe(false);
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

describe('更新信号解析', () => {
  it('解析 yml 与 JSON 信号并抽出 downloadUrl 提示', () => {
    const yml = [
      'version: 1.2.3',
      'path: https://dl.example.com/a.exe',
      "sha512: 'abc'",
      'files:',
      '  - url: https://dl.example.com/a.exe',
      "    sha512: 'abc'",
      '    size: 12',
      '',
    ].join('\n');
    const fromYml = parseUpdateSignal(yml);
    expect(fromYml.version).toBe('1.2.3');
    expect(fromYml.downloadHint).toBe('https://dl.example.com/a.exe');
    expect(fromYml.fileName).toBe('a.exe');

    const fromJson = parseUpdateSignal(JSON.stringify({
      version: '2.0.0',
      downloadUrl: 'https://dl.example.com/b.exe',
      releaseNotes: '你好',
    }), 'application/json');
    expect(fromJson.version).toBe('2.0.0');
    expect(fromJson.downloadHint).toBe('https://dl.example.com/b.exe');
    expect(fromJson.notes).toBe('你好');

    const loose = parseUpdateSignal('version: 9.0.0\npath: https://x.test/c.exe\n');
    expect(loose.version).toBe('9.0.0');
    expect(loose.downloadHint).toBe('https://x.test/c.exe');
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
