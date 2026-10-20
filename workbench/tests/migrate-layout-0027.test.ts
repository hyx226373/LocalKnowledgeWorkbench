import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateLayout } from '../src/migrate/runMigrate';
import { APP_EXE, VERSION_TREE_REQUIRED, isUnderStudyDev, parseCurrent } from '../src/shared/layout';
import { parseLatestYml } from '../src/shared/update/latestYml';

const roots: string[] = [];
const NOW = '2026-10-10T08:00:00.000Z';

afterEach(async () => {
  while (roots.length) {
    const dir = roots.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function tmp(): string {
  const dir = path.join(os.tmpdir(), `kb-migrate-0027-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  roots.push(dir);
  return dir;
}

async function writeRequired(root: string, asarBytes = 8): Promise<void> {
  for (const rel of VERSION_TREE_REQUIRED) {
    const file = path.join(root, ...rel.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    const size = rel === 'resources/app.asar' ? asarBytes : 4;
    await fs.writeFile(file, Buffer.alloc(size, 0x61));
  }
}

describe('migrateLayout', () => {
  it('假树迁移成功：版本目录有 exe，current 为 0.2.4，根 exe 已改名', async () => {
    const root = tmp();
    await writeRequired(root);
    await fs.writeFile(path.join(root, 'keep.txt'), 'keep');
    await fs.mkdir(path.join(root, 'launcher'), { recursive: true });
    await fs.writeFile(path.join(root, 'launcher', 'kb-launch.exe'), 'launch');
    await fs.mkdir(path.join(root, 'updater'), { recursive: true });
    await fs.writeFile(path.join(root, 'updater', 'state.json'), '{}');
    await fs.mkdir(path.join(root, 'versions'), { recursive: true });
    await fs.writeFile(path.join(root, 'versions', 'junk.txt'), 'junk');

    const result = await migrateLayout({ installRoot: root, fileVersion: '0.2.4', now: NOW });
    expect(result).toEqual({ ok: true, version: '0.2.4' });

    const copiedExe = path.join(root, 'versions', '0.2.4', APP_EXE);
    expect((await fs.stat(copiedExe)).size).toBeGreaterThan(0);
    expect(await fs.readFile(path.join(root, 'versions', '0.2.4', 'keep.txt'), 'utf8')).toBe('keep');
    await expect(fs.stat(path.join(root, 'versions', '0.2.4', 'launcher'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(root, 'versions', '0.2.4', 'updater'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(root, 'versions', '0.2.4', 'versions'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(root, 'versions', 'junk.txt'), 'utf8')).toBe('junk');

    const pointer = parseCurrent(await fs.readFile(path.join(root, 'current.json'), 'utf8'));
    expect(pointer).toMatchObject({ schema: 1, current: '0.2.4', previous: null, updatedAt: NOW });
    await expect(fs.stat(path.join(root, APP_EXE))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.stat(path.join(root, `${APP_EXE}.pre-layout`))).isFile()).toBe(true);
  });

  it('D:\\example_dev 即使像旧安装也拒绝，且不写 current.json', async () => {
    const installRoot = 'D:\\example_dev\\kb-r14-027-D-do-not-create';
    expect(isUnderStudyDev(installRoot)).toBe(true);
    const result = await migrateLayout({ installRoot, fileVersion: '0.2.4', now: NOW });
    expect(result).toEqual({ ok: false, reason: '禁止迁移 D:\\example_dev，除非 用户另批' });
    await expect(fs.stat(installRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(installRoot, 'current.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(installRoot, 'versions'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('缺 app.asar 的副本校验失败时不写 current.json，根 exe 仍在', async () => {
    const root = tmp();
    await writeRequired(root, 0);
    const result = await migrateLayout({ installRoot: root, fileVersion: '0.2.4', now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('resources/app.asar');
    await expect(fs.stat(path.join(root, 'current.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(root, 'versions', '0.2.4'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.stat(path.join(root, APP_EXE))).isFile()).toBe(true);
    await expect(fs.stat(path.join(root, `${APP_EXE}.pre-layout`))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fileVersion 0.2.1 拒绝', async () => {
    const root = tmp();
    await writeRequired(root);
    const result = await migrateLayout({ installRoot: root, fileVersion: '0.2.1', now: NOW });
    expect(result).toEqual({ ok: false, reason: '版本 0.2.1 低于最低可迁基线 0.2.2' });
    await expect(fs.stat(path.join(root, 'current.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(root, 'versions'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.stat(path.join(root, APP_EXE))).isFile()).toBe(true);
    await expect(fs.stat(path.join(root, `${APP_EXE}.pre-layout`))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('parseLatestYml 双轨', () => {
  it('0.2.4 样例的 path 仍是 setup.exe', () => {
    const yml = [
      'version: 0.2.4',
      'files:',
      '  - url: LocalKnowledgeWorkbench-0.2.4-win-x64-setup.exe',
      "    sha512: 'abc'",
      '    size: 4',
      'path: LocalKnowledgeWorkbench-0.2.4-win-x64-setup.exe',
      "sha512: 'abc'",
      "releaseDate: '2026-10-10T00:00:00.000Z'",
      '',
    ].join('\n');
    const dirpack = '{"schema":1,"version":"0.2.5","file":"LocalKnowledgeWorkbench-0.2.5-win-x64-dir.zip"}\n';
    const parsed = parseLatestYml(yml);
    expect(parsed.version).toBe('0.2.4');
    expect(parsed.path).toBe('LocalKnowledgeWorkbench-0.2.4-win-x64-setup.exe');
    expect(parsed.path.endsWith('-setup.exe')).toBe(true);
    expect(parseLatestYml(`${yml}\n${dirpack}`)).toEqual(parsed);
  });
});
