import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { UpdateService, type UpdateHooks } from '../src/main/update/service';

const ENV_KEYS = ['KB_UPDATE_INSTALL_SILENT', 'KB_UPDATE_INSTALL_LOG'] as const;
const envBackup = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
const roots: string[] = [];

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const prev = envBackup.get(key);
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

afterEach(async () => {
  restoreEnv();
  while (roots.length) {
    const dir = roots.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function tmp(): string {
  const dir = path.join(os.tmpdir(), `kb-update-0026-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  roots.push(dir);
  return dir;
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
    applyMode: 'nsis',
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

async function writeHttpsFeed(dir: string, version: string, downloadUrl: string) {
  await fs.mkdir(dir, { recursive: true });
  const yml = [
    `version: ${version}`,
    'files:',
    `  - url: ${downloadUrl}`,
    `    sha512: 'dGVzdA=='`,
    `    size: 1`,
    `path: ${downloadUrl}`,
    `sha512: 'dGVzdA=='`,
    '',
  ].join('\n');
  await fs.writeFile(path.join(dir, 'latest.yml'), yml, 'utf8');
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

describe('nsis 升级拉起', () => {
  it('本地相对路径不拉起安装程序', async () => {
    const dir = tmp();
    delete process.env.KB_UPDATE_INSTALL_SILENT;
    delete process.env.KB_UPDATE_INSTALL_LOG;
    try {
      await fs.mkdir(dir, { recursive: true });
      await seedUser(dir);
      await writeFeed(path.join(dir, 'feed'), '0.2.1-test', Buffer.alloc(32 * 1024, 9));
      const box = hooks(dir);
      const svc = new UpdateService(box.hooks);
      await svc.init();
      const snap = await svc.check();
      expect(snap.phase).toBe('failed');
      expect(snap.error).toMatch(/公开 https/);
      expect(snap.downloaded).toBe(false);
      await expect(svc.installNow()).rejects.toThrow(/没有可打开的下载链接/);
      expect(box.spawned).toEqual([]);
      expect(box.opened).toEqual([]);
      expect(box.exited).toBe(false);
    } finally {
      restoreEnv();
    }
  });

  it('有公开 https 时只打开链接，静默开关也不再拼安装参数', async () => {
    const dir = tmp();
    delete process.env.KB_UPDATE_INSTALL_LOG;
    process.env.KB_UPDATE_INSTALL_SILENT = '1';
    try {
      await fs.mkdir(dir, { recursive: true });
      await seedUser(dir);
      const url = 'https://example.com/releases/LocalKnowledgeWorkbench-0.2.1-test-win-x64-setup.exe';
      await writeHttpsFeed(path.join(dir, 'feed'), '0.2.1-test', url);
      const box = hooks(dir);
      const svc = new UpdateService(box.hooks);
      await svc.init();
      const snap = await svc.check();
      expect(snap.phase).toBe('ready');
      expect(snap.downloaded).toBe(true);
      expect(snap.available?.downloadUrl).toBe(url);
      await svc.installNow();
      expect(box.opened).toEqual([url]);
      expect(box.spawned).toEqual([]);
      expect(box.exited).toBe(false);
      expect(svc.snapshot().info).toMatch(/浏览器打开下载链接/);
    } finally {
      restoreEnv();
    }
  });

  it('confirmQuit 返回 false 时不拉起也不退出', async () => {
    const dir = tmp();
    delete process.env.KB_UPDATE_INSTALL_SILENT;
    delete process.env.KB_UPDATE_INSTALL_LOG;
    try {
      await fs.mkdir(dir, { recursive: true });
      await seedUser(dir);
      const url = 'https://example.com/releases/LocalKnowledgeWorkbench-0.2.1-test-win-x64-setup.exe';
      await writeHttpsFeed(path.join(dir, 'feed'), '0.2.1-test', url);
      let asked = false;
      const box = hooks(dir, {
        confirmQuit: async () => {
          asked = true;
          return false;
        },
      });
      const svc = new UpdateService(box.hooks);
      await svc.init();
      const snap = await svc.check();
      expect(snap.phase).toBe('ready');
      await svc.installNow();
      expect(asked).toBe(false);
      expect(box.opened).toEqual([url]);
      expect(box.spawned).toEqual([]);
      expect(box.exited).toBe(false);
      expect(svc.snapshot().phase).toBe('ready');
    } finally {
      restoreEnv();
    }
  });
});
