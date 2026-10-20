import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareDirpack, removePartial } from '../src/main/update/prepareDirpack';
import { UpdateService, type UpdateHooks } from '../src/main/update/service';
import { PackageRejectedError } from '../src/shared/update/download';
import { dirpackSource, loadDirpack } from '../src/shared/update/dirpack';
import {
  dirZipName,
  handoffFile,
  parseHandoff,
  parseUpdaterState,
  RESTART_TO_UPDATE_BODY,
  RESTART_TO_UPDATE_TITLE,
  stateFile,
  updaterExe,
  VERSION_TREE_REQUIRED,
} from '../src/shared/layout';

const roots: string[] = [];

afterEach(async () => {
  while (roots.length) {
    const dir = roots.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function tmp(): string {
  const dir = path.join(os.tmpdir(), `kb27-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  roots.push(dir);
  return dir;
}

function sha512(body: Buffer): string {
  return createHash('sha512').update(body).digest('base64');
}

async function writeRequired(dir: string, skip: readonly string[] = []): Promise<void> {
  const skipped = new Set(skip);
  for (const rel of VERSION_TREE_REQUIRED) {
    if (skipped.has(rel)) continue;
    const file = path.join(dir, ...rel.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'ok');
  }
}

async function writeDirpack(feed: string, version: string, body: Buffer) {
  await fs.mkdir(feed, { recursive: true });
  const name = dirZipName(version);
  const sha = sha512(body);
  const setupName = `LocalKnowledgeWorkbench-${version}-win-x64-setup.exe`;
  await fs.writeFile(path.join(feed, name), body);
  await fs.writeFile(path.join(feed, setupName), Buffer.from('nsis-setup-not-dirpack'));
  await fs.writeFile(
    path.join(feed, 'dirpack.json'),
    JSON.stringify({
      schema: 1,
      version,
      file: name,
      size: body.length,
      sha512: sha,
      releaseDate: '2026-10-11T00:00:00.000Z',
      minBaseline: '0.2.2',
      notes: '目录包说明',
    }),
    'utf8',
  );
  const yml = [
    `version: ${version}`,
    'files:',
    `  - url: ${setupName}`,
    `    sha512: '${sha}'`,
    `    size: 24`,
    `path: ${setupName}`,
    `sha512: '${sha}'`,
    '',
  ].join('\n');
  await fs.writeFile(path.join(feed, 'latest.yml'), yml, 'utf8');
  return { name, sha, setupName };
}

function hooks(dir: string, extra: Partial<UpdateHooks> = {}): { hooks: UpdateHooks; spawned: { file: string; args: string[]; env: NodeJS.ProcessEnv }[]; exited: boolean } {
  const spawned: { file: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const state = { exited: false };
  const base: UpdateHooks = {
    currentVersion: '0.2.4',
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
    applyMode: 'dirpack',
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
  await fs.writeFile(path.join(install, 'version.txt'), '0.2.4', 'utf8');
}

async function readyDirpack(dir: string, extra: Partial<UpdateHooks> = {}) {
  await fs.mkdir(dir, { recursive: true });
  await seedUser(dir);
  const body = Buffer.alloc(4096, 6);
  const packed = await writeDirpack(path.join(dir, 'feed'), '0.2.5', body);
  const ymlPath = path.join(dir, 'feed', 'latest.yml');
  const ymlBefore = await fs.readFile(ymlPath, 'utf8');
  const box = hooks(dir, {
    extractDirpack: async (_zip, dest) => {
      await writeRequired(dest);
    },
    ...extra,
  });
  const svc = new UpdateService(box.hooks);
  await svc.init();
  const snap = await svc.check();
  expect(snap.phase).toBe('ready');
  expect(snap.layout).toBe('dirpack');
  expect(snap.downloaded).toBe(true);
  expect(snap.available?.fileName).toBe(packed.name);
  expect(snap.available?.sha512).toBe(packed.sha);
  expect(snap.available?.size).toBe(body.length);
  expect(await fs.readFile(ymlPath, 'utf8')).toBe(ymlBefore);
  const install = path.join(dir, 'install');
  await expect(fs.stat(path.join(install, 'versions', '0.2.5', 'LocalKnowledgeWorkbench.exe'))).resolves.toBeTruthy();
  await expect(fs.stat(path.join(install, 'versions', '0.2.5.partial'))).rejects.toThrow();
  await expect(fs.stat(path.join(dir, 'user', 'update-downloads', packed.name))).resolves.toBeTruthy();
  await expect(fs.stat(path.join(dir, 'user', 'update-downloads', packed.setupName))).rejects.toThrow();
  return { box, svc, packed };
}

describe('目录包准备', () => {
  it('sha 不一致不产生 partial 或版本目录', async () => {
    const root = tmp();
    await fs.mkdir(root, { recursive: true });
    const body = Buffer.from('dirpack-bytes');
    const zipPath = path.join(root, 'pack.zip');
    await fs.writeFile(zipPath, body);
    const partial = path.join(root, 'versions', '0.2.5.partial');
    await fs.mkdir(partial, { recursive: true });
    await fs.writeFile(path.join(partial, 'stale.txt'), 'stale');
    let extracted = false;
    await expect(
      prepareDirpack({
        zipPath,
        installRoot: root,
        version: '0.2.5',
        expectedSize: body.length,
        expectedSha512: 'A'.repeat(88),
        extract: async () => {
          extracted = true;
        },
      }),
    ).rejects.toBeInstanceOf(PackageRejectedError);
    expect(extracted).toBe(false);
    await expect(fs.stat(partial)).rejects.toThrow();
    await expect(fs.stat(path.join(root, 'versions', '0.2.5'))).rejects.toThrow();
  });

  it('注入的 extract 写出必需文件后留下候选目录', async () => {
    const root = tmp();
    await fs.mkdir(root, { recursive: true });
    const body = Buffer.from('dirpack-ok');
    const zipPath = path.join(root, 'pack.zip');
    await fs.writeFile(zipPath, body);
    const stages: string[] = [];
    const result = await prepareDirpack({
      zipPath,
      installRoot: root,
      version: '0.2.5',
      expectedSize: body.length,
      expectedSha512: sha512(body),
      onProgress: (progress) => stages.push(progress.stage),
      extract: async (_zip, dest) => {
        await writeRequired(dest);
      },
    });
    expect(result).toEqual({ candidateRel: 'versions/0.2.5', version: '0.2.5' });
    expect(stages).toEqual(['extract', 'verify']);
    const exe = path.join(root, 'versions', '0.2.5', 'LocalKnowledgeWorkbench.exe');
    expect(await fs.readFile(exe, 'utf8')).toBe('ok');
    await expect(fs.stat(path.join(root, 'versions', '0.2.5.partial'))).rejects.toThrow();
    await fs.writeFile(exe, 'first');
    await expect(
      prepareDirpack({
        zipPath,
        installRoot: root,
        version: '0.2.5',
        expectedSize: body.length,
        expectedSha512: sha512(body),
        extract: async () => {
          throw new Error('不应覆盖已有候选');
        },
      }),
    ).rejects.toThrow('候选版本目录已存在');
    expect(await fs.readFile(exe, 'utf8')).toBe('first');
  });

  it('缺文件时删掉 partial', async () => {
    const root = tmp();
    await fs.mkdir(root, { recursive: true });
    const body = Buffer.from('dirpack-missing');
    const zipPath = path.join(root, 'pack.zip');
    await fs.writeFile(zipPath, body);
    await expect(
      prepareDirpack({
        zipPath,
        installRoot: root,
        version: '0.2.5',
        expectedSize: body.length,
        expectedSha512: sha512(body),
        extract: async (_zip, dest) => {
          await writeRequired(dest, ['resources/app.asar']);
        },
      }),
    ).rejects.toThrow(/resources\/app\.asar/);
    await expect(fs.stat(path.join(root, 'versions', '0.2.5.partial'))).rejects.toThrow();
    await expect(fs.stat(path.join(root, 'versions', '0.2.5'))).rejects.toThrow();
  });

  it('安装根在 study_dev 下被拒绝', async () => {
    const root = tmp();
    await fs.mkdir(root, { recursive: true });
    await expect(
      prepareDirpack({
        zipPath: path.join(root, 'missing.zip'),
        installRoot: 'D:\\study_dev\\kb-r14-027-b-not-amy',
        version: '0.2.5',
        expectedSize: 4,
        expectedSha512: 'B'.repeat(88),
        extract: async () => {
          throw new Error('不应解压');
        },
      }),
    ).rejects.toThrow(/study_dev/);
  });

  it('已取消时删掉 partial', async () => {
    const root = tmp();
    const partial = path.join(root, 'versions', '0.2.5.partial');
    await fs.mkdir(partial, { recursive: true });
    await fs.writeFile(path.join(partial, 'x.txt'), 'x');
    const signal = new AbortController();
    signal.abort();
    await expect(
      prepareDirpack({
        zipPath: path.join(root, 'missing.zip'),
        installRoot: root,
        version: '0.2.5',
        expectedSize: 4,
        expectedSha512: 'C'.repeat(88),
        signal: signal.signal,
      }),
    ).rejects.toThrow('下载已取消');
    await expect(fs.stat(partial)).rejects.toThrow();
  });

  it('removePartial 不删除 current 和 previous', async () => {
    const root = tmp();
    await fs.mkdir(path.join(root, 'versions', '0.2.4'), { recursive: true });
    await fs.mkdir(path.join(root, 'versions', '0.2.3'), { recursive: true });
    await fs.mkdir(path.join(root, 'versions', '0.2.4.partial'), { recursive: true });
    await fs.mkdir(path.join(root, 'versions', '0.2.5.partial'), { recursive: true });
    await fs.writeFile(path.join(root, 'versions', '0.2.4', 'keep.txt'), 'current');
    await fs.writeFile(path.join(root, 'versions', '0.2.3', 'keep.txt'), 'previous');
    await fs.writeFile(path.join(root, 'versions', '0.2.4.partial', 'junk.txt'), 'junk');
    await fs.writeFile(path.join(root, 'versions', '0.2.5.partial', 'junk.txt'), 'junk');
    await fs.writeFile(
      path.join(root, 'current.json'),
      JSON.stringify({ schema: 1, current: '0.2.4', previous: '0.2.3', updatedAt: '2026-10-11T00:00:00.000Z' }),
      'utf8',
    );
    await removePartial(root, '0.2.4');
    await removePartial(root, '0.2.3');
    await removePartial(root, '0.2.5');
    expect(await fs.readFile(path.join(root, 'versions', '0.2.4', 'keep.txt'), 'utf8')).toBe('current');
    expect(await fs.readFile(path.join(root, 'versions', '0.2.3', 'keep.txt'), 'utf8')).toBe('previous');
    await expect(fs.stat(path.join(root, 'versions', '0.2.4.partial'))).rejects.toThrow();
    await expect(fs.stat(path.join(root, 'versions', '0.2.5.partial'))).rejects.toThrow();
  });

  it('loadDirpack 只读清单，dirpackSource 取文件名', async () => {
    const root = tmp();
    const feed = path.join(root, 'feed');
    const body = Buffer.from('zip');
    const packed = await writeDirpack(feed, '0.2.5', body);
    const before = await fs.readFile(path.join(feed, 'latest.yml'), 'utf8');
    const manifest = await loadDirpack(feed);
    expect(manifest.file).toBe(packed.name);
    expect(dirpackSource(feed, manifest)).toBe(path.join(feed, packed.name));
    expect(dirpackSource(feed, { ...manifest, file: `nested/${packed.name}` })).toBe(path.join(feed, packed.name));
    expect(await fs.readFile(path.join(feed, 'latest.yml'), 'utf8')).toBe(before);
  });
});

describe('目录包交接', () => {
  it('没有 dirpack.json 时不下载 NSIS setup', async () => {
    const dir = tmp();
    await fs.mkdir(path.join(dir, 'feed'), { recursive: true });
    await fs.writeFile(path.join(dir, 'feed', 'latest.yml'), 'version: 0.2.5\n', 'utf8');
    await fs.writeFile(path.join(dir, 'feed', 'LocalKnowledgeWorkbench-0.2.5-win-x64-setup.exe'), Buffer.from('setup'));
    const box = hooks(dir);
    const svc = new UpdateService(box.hooks);
    await svc.init();
    const snap = await svc.check();
    expect(snap.phase).toBe('failed');
    expect(snap.error).toMatch(/latest\.yml 缺少/);
    expect(snap.layout).toBe('dirpack');
    expect(snap.downloaded).toBe(false);
    await expect(fs.stat(path.join(dir, 'user', 'update-downloads'))).rejects.toThrow();
    await expect(fs.stat(path.join(dir, 'install', 'versions'))).rejects.toThrow();
  });

  it('nsis 模式仍读 latest.yml，不把目录包当安装包', async () => {
    const dir = tmp();
    await fs.mkdir(dir, { recursive: true });
    const feed = path.join(dir, 'feed');
    await writeDirpack(feed, '0.2.5', Buffer.from('zip-body'));
    const body = Buffer.alloc(2048, 4);
    const name = 'LocalKnowledgeWorkbench-0.2.5-win-x64-setup.exe';
    const sha = sha512(body);
    await fs.writeFile(path.join(feed, name), body);
    await fs.writeFile(
      path.join(feed, 'latest.yml'),
      [`version: 0.2.5`, 'files:', `  - url: ${name}`, `    sha512: '${sha}'`, `    size: ${body.length}`, `path: ${name}`, `sha512: '${sha}'`, ''].join('\n'),
      'utf8',
    );
    const box = hooks(dir, {
      applyMode: 'nsis',
      extractDirpack: async () => {
        throw new Error('nsis 模式不应解压目录包');
      },
    });
    const svc = new UpdateService(box.hooks);
    await svc.init();
    expect(svc.snapshot().layout).toBe('nsis');
    const snap = await svc.check();
    expect(snap.phase).toBe('failed');
    expect(snap.error).toMatch(/公开 https/);
    expect(snap.layout).toBe('nsis');
    expect(snap.available).toBeNull();
    await expect(fs.stat(path.join(dir, 'install', 'versions', '0.2.5'))).rejects.toThrow();
  });

  it('本地目录包没有 https 时不留下 partial', async () => {
    const dir = tmp();
    await fs.mkdir(dir, { recursive: true });
    await seedUser(dir);
    await writeDirpack(path.join(dir, 'feed'), '0.2.5', Buffer.alloc(1024, 8));
    let extracted = false;
    const box = hooks(dir, {
      extractDirpack: async (_zip, dest) => {
        extracted = true;
        await writeRequired(dest);
      },
    });
    const svc = new UpdateService(box.hooks);
    await svc.init();
    const snap = await svc.check();
    expect(snap.phase).toBe('failed');
    expect(snap.error).toMatch(/公开 https/);
    expect(extracted).toBe(false);
    await expect(fs.stat(path.join(dir, 'install', 'versions', '0.2.5.partial'))).rejects.toThrow();
    await expect(fs.stat(path.join(dir, 'install', 'versions', '0.2.5'))).rejects.toThrow();
  });

  it('confirmQuit 返回 false 时不备份、不拉起、不退出', async () => {
    const dir = tmp();
    let accept = false;
    const seen: { title: string; body: string }[] = [];
    const { box, svc } = await readyDirpack(dir, {
      confirmQuit: async (title, body) => {
        seen.push({ title, body });
        return accept;
      },
    });
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map((item) => String(item)).join(' '));
    };
    try {
      await svc.installNow();
      expect(seen[0]).toEqual({ title: RESTART_TO_UPDATE_TITLE, body: RESTART_TO_UPDATE_BODY });
      expect(logs.some((line) => line.includes(RESTART_TO_UPDATE_BODY))).toBe(true);
      expect(box.spawned).toEqual([]);
      expect(box.exited).toBe(false);
      expect(svc.snapshot().phase).toBe('ready');
      expect(svc.snapshot().backups).toEqual([]);
      await expect(fs.stat(handoffFile(path.join(dir, 'install')))).rejects.toThrow();
      accept = true;
      await svc.installNow();
      expect(box.spawned).toHaveLength(1);
      expect(box.exited).toBe(true);
      expect(path.basename(box.spawned[0]?.file ?? '')).toBe('kb-updater.exe');
    } finally {
      console.log = orig;
    }
  });

  it('confirmQuit 返回 true 时交接给 kb-updater.exe', async () => {
    const dir = tmp();
    const seen: { title: string; body: string }[] = [];
    const { box, svc } = await readyDirpack(dir, {
      confirmQuit: async (title, body) => {
        seen.push({ title, body });
        return true;
      },
    });
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map((item) => String(item)).join(' '));
    };
    try {
      await svc.installNow();
    } finally {
      console.log = orig;
    }
    const install = path.join(dir, 'install');
    expect(seen[0]).toEqual({ title: RESTART_TO_UPDATE_TITLE, body: RESTART_TO_UPDATE_BODY });
    expect(logs.some((line) => line.includes(RESTART_TO_UPDATE_BODY))).toBe(true);
    expect(box.spawned).toHaveLength(1);
    expect(box.spawned[0]?.file).toBe(updaterExe(install));
    expect(box.spawned[0]?.args).toEqual(['--handoff', handoffFile(install)]);
    expect(box.spawned[0]?.args).not.toContain('/S');
    expect(box.spawned[0]?.args).not.toContain('--updated');
    expect(box.exited).toBe(true);
    const handoff = parseHandoff(await fs.readFile(handoffFile(install), 'utf8'));
    expect(handoff.fromVersion).toBe('0.2.4');
    expect(handoff.toVersion).toBe('0.2.5');
    expect(handoff.candidateRel).toBe('versions/0.2.5');
    expect(handoff.packageName).toBe(dirZipName('0.2.5'));
    expect(handoff.installRoot).toBe(install);
    expect(handoff.userDataDir).toBe(path.join(dir, 'user'));
    expect(handoff.backupId).toBe(svc.snapshot().backups[0]?.id);
    const state = parseUpdaterState(await fs.readFile(stateFile(install), 'utf8'));
    expect(state.phase).toBe('ready');
    expect(state.candidateRel).toBe('versions/0.2.5');
    expect(state.toVersion).toBe('0.2.5');
  });

  it('窗口加载后写下就绪标记', async () => {
    const dir = tmp();
    await fs.mkdir(dir, { recursive: true });
    const box = hooks(dir);
    const svc = new UpdateService(box.hooks);
    await svc.init();
    svc.noteWindowLoaded();
    const file = path.join(dir, 'user', 'update-ready.json');
    let text = '';
    for (let i = 0; i < 50 && !text; i += 1) {
      try {
        text = await fs.readFile(file, 'utf8');
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    const marker = JSON.parse(text) as { schema: number; version: string; at: string };
    expect(marker.schema).toBe(1);
    expect(marker.version).toBe('0.2.4');
    expect(marker.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
