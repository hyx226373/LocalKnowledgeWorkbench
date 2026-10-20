import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { disk } from '../src/main/service/disk';
import { runRootDiskDelete } from '../src/main/service/rootDiskDelete';
import type { RootDiskDeleteRequest } from '../src/shared/rootTask';

const kept: string[] = [];
const simAtStart = process.env.KB_ROOT_DELETE_FAIL;

afterEach(() => {
  if (simAtStart === undefined) delete process.env.KB_ROOT_DELETE_FAIL;
  else process.env.KB_ROOT_DELETE_FAIL = simAtStart;
  while (kept.length) fs.rmSync(kept.pop()!, { recursive: true, force: true });
});

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-root-del-'));
  kept.push(root);
  const dataDir = path.join(root, 'data');
  const stagingDir = path.join(dataDir, 'staging');
  const src = path.join(root, 'notes');
  fs.mkdirSync(stagingDir, { recursive: true });
  fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(src, 'a.txt'), 'hello');
  fs.writeFileSync(path.join(src, 'sub', 'b.txt'), 'world');
  return { root, dataDir, stagingDir, src };
}

function request(t: { dataDir: string; stagingDir: string; src: string }, record: RootDiskDeleteRequest['record'], absPath = t.src): RootDiskDeleteRequest {
  return { rootId: 'root-1', absPath, stagingDir: t.stagingDir, dataDir: t.dataDir, record };
}

function installDeleteSpies() {
  const spies = [
    vi.spyOn(fs, 'rmSync'),
    vi.spyOn(fs, 'unlinkSync'),
    vi.spyOn(fs.promises, 'rm'),
    vi.spyOn(fs.promises, 'unlink'),
  ];
  if (disk.rmSync !== fs.rmSync) spies.push(vi.spyOn(disk, 'rmSync'));
  if (disk.unlinkSync !== fs.unlinkSync) spies.push(vi.spyOn(disk, 'unlinkSync'));
  if (disk.promises.rm !== fs.promises.rm) spies.push(vi.spyOn(disk.promises, 'rm'));
  if (disk.promises.unlink !== fs.promises.unlink) spies.push(vi.spyOn(disk.promises, 'unlink'));
  return {
    calls() {
      return spies.flatMap((spy) => spy.mock.calls.map((args) => String(args[0] ?? '')));
    },
    restore() {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

describe('runRootDiskDelete', () => {
  it('只调用 trashItem，不记录暂存，也不永久删除', async () => {
    delete process.env.KB_ROOT_DELETE_FAIL;
    const t = makeTree();
    const record = vi.fn(() => 42);
    const trash = vi.fn(async () => undefined);
    const spies = installDeleteSpies();
    try {
      const res = await runRootDiskDelete(request(t, record), trash);
      expect(res).toEqual({ ok: true, opId: null, error: null });
      expect(trash).toHaveBeenCalledTimes(1);
      expect(trash).toHaveBeenCalledWith(t.src);
      expect(record).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(t.src, 'a.txt'))).toBe(true);
      expect(spies.calls()).toEqual([]);
    } finally {
      spies.restore();
    }
  });

  it('trashItem 失败时文件还在，不回退到 rm', async () => {
    delete process.env.KB_ROOT_DELETE_FAIL;
    const t = makeTree();
    const record = vi.fn(() => 1);
    const trash = vi.fn(async () => {
      throw new Error('回收站忙');
    });
    const spies = installDeleteSpies();
    try {
      const res = await runRootDiskDelete(request(t, record), trash);
      expect(res.ok).toBe(false);
      expect(res.opId).toBeNull();
      expect(res.error).toBe('回收站忙');
      expect(record).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(t.src, 'a.txt'))).toBe(true);
      expect(spies.calls()).toEqual([]);
    } finally {
      spies.restore();
    }
  });

  it('没有 trashItem 时拒绝，文件还在', async () => {
    delete process.env.KB_ROOT_DELETE_FAIL;
    const t = makeTree();
    const record = vi.fn(() => 1);
    const res = await runRootDiskDelete(request(t, record));
    expect(res).toEqual({ ok: false, opId: null, error: '无法移到回收站' });
    expect(record).not.toHaveBeenCalled();
    expect(fs.existsSync(t.src)).toBe(true);
  });

  it('路径不存在时不调用 trashItem', async () => {
    delete process.env.KB_ROOT_DELETE_FAIL;
    const t = makeTree();
    fs.rmSync(t.src, { recursive: true });
    const trash = vi.fn(async () => undefined);
    const res = await runRootDiskDelete(request(t, () => 1), trash);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('文件夹不在原处');
    expect(trash).not.toHaveBeenCalled();
  });

  it('模拟失败发生在回收站之前', async () => {
    const t = makeTree();
    process.env.KB_ROOT_DELETE_FAIL = 'EBUSY';
    const trash = vi.fn(async () => undefined);
    const res = await runRootDiskDelete(request(t, () => 1), trash);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('EBUSY');
    expect(trash).not.toHaveBeenCalled();
    expect(fs.existsSync(t.src)).toBe(true);
  });

  it('实现里没有 rm / unlink', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/main/service/rootDiskDelete.ts'), 'utf8');
    expect(src).not.toMatch(/\.rm\(|\.rmSync\(|\.unlink\(|\.unlinkSync\(/);
    expect(src).not.toMatch(/\brenameSync\(|\bcpSync\(/);
    const main = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    expect(main).toContain("method === 'trashItem'");
    expect(main).toContain('shell.trashItem');
    const entry = fs.readFileSync(path.join(process.cwd(), 'src/main/data/entry.ts'), 'utf8');
    expect(entry).toContain("ask('trashItem'");
  });
});
