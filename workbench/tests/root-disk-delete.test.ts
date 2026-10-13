import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runRootDiskDelete } from '../src/main/service/rootDiskDelete';
import type { RootDiskDeleteRequest } from '../src/shared/rootTask';

type Detail = Parameters<RootDiskDeleteRequest['record']>[0];

const kept: string[] = [];
const simAtStart = process.env.KB_ROOT_DELETE_FAIL;
const fsBaseline = {
  renameSync: fs.renameSync,
  cpSync: fs.cpSync,
  rmSync: fs.rmSync,
};

function fsApi(): { renameSync: typeof fs.renameSync; cpSync: typeof fs.cpSync; rmSync: typeof fs.rmSync } {
  return fs as unknown as { renameSync: typeof fs.renameSync; cpSync: typeof fs.cpSync; rmSync: typeof fs.rmSync };
}

afterEach(() => {
  const api = fsApi();
  api.renameSync = fsBaseline.renameSync;
  api.cpSync = fsBaseline.cpSync;
  api.rmSync = fsBaseline.rmSync;
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

describe('runRootDiskDelete', () => {
  it('成功后源消失且 record 被调用', async () => {
    delete process.env.KB_ROOT_DELETE_FAIL;
    const t = makeTree();
    const calls: Detail[] = [];
    const res = await runRootDiskDelete(request(t, (detail) => {
      calls.push(detail);
      return 42;
    }));
    expect(res).toEqual({ ok: true, opId: 42, error: null });
    expect(fs.existsSync(t.src)).toBe(false);
    expect(calls).toHaveLength(1);
    const detail = calls[0]!;
    expect(detail.kind).toBe('dir');
    expect(detail.rootDelete).toBe(true);
    expect(detail.fileCount).toBe(2);
    expect(detail.totalBytes).toBe(10);
    expect(detail.staging).toMatch(/^staging\/[0-9a-f-]{36}\/notes$/);
    expect(detail.staging.includes('\\')).toBe(false);
    const staged = path.join(t.dataDir, ...detail.staging.split('/'));
    expect(fs.readFileSync(path.join(staged, 'a.txt'), 'utf8')).toBe('hello');
    expect(fs.readFileSync(path.join(staged, 'sub', 'b.txt'), 'utf8')).toBe('world');
  });

  it('目标不存在时不移动也不记录', async () => {
    delete process.env.KB_ROOT_DELETE_FAIL;
    const t = makeTree();
    fs.rmSync(t.src, { recursive: true });
    const calls: Detail[] = [];
    const res = await runRootDiskDelete(request(t, (detail) => {
      calls.push(detail);
      return 1;
    }));
    expect(res).toEqual({ ok: false, opId: null, error: '文件夹不在原处' });
    expect(calls).toHaveLength(0);
    expect(fs.readdirSync(t.stagingDir)).toEqual([]);
  });

  it.each(['EPERM', 'EBUSY', 'EIO'])('模拟 %s 不移动且不调用 record', async (code) => {
    const t = makeTree();
    const before = fs.readFileSync(path.join(t.src, 'a.txt'));
    process.env.KB_ROOT_DELETE_FAIL = code;
    const calls: Detail[] = [];
    const res = await runRootDiskDelete(request(t, (detail) => {
      calls.push(detail);
      return 1;
    }));
    expect(res).toEqual({ ok: false, opId: null, error: '模拟失败 ' + code });
    expect(calls).toHaveLength(0);
    expect(fs.readFileSync(path.join(t.src, 'a.txt'))).toEqual(before);
    expect(fs.readdirSync(t.stagingDir)).toEqual([]);
  });

  it('只读占用时记下实际结果，模拟失败仍不删源', async () => {
    delete process.env.KB_ROOT_DELETE_FAIL;
    const t = makeTree();
    const file = path.join(t.src, 'a.txt');
    const fh = fs.openSync(file, 'r');
    const calls: Detail[] = [];
    try {
      const res = await runRootDiskDelete(request(t, (detail) => {
        calls.push(detail);
        return 7;
      }));
      if (res.ok) {
        expect(res).toEqual({ ok: true, opId: 7, error: null });
        expect(fs.existsSync(t.src)).toBe(false);
        expect(calls).toHaveLength(1);
      } else {
        expect(res.opId).toBeNull();
        expect(res.error ?? '').toMatch(/EPERM|EBUSY|EACCES/);
        expect(fs.existsSync(file)).toBe(true);
        expect(calls).toHaveLength(0);
      }
    } finally {
      try { fs.closeSync(fh); } catch { /* 目录被移走后句柄可能已经失效 */ }
    }

    const t2 = makeTree();
    process.env.KB_ROOT_DELETE_FAIL = 'EPERM';
    const simCalls: Detail[] = [];
    const sim = await runRootDiskDelete(request(t2, (detail) => {
      simCalls.push(detail);
      return 1;
    }));
    expect(sim).toEqual({ ok: false, opId: null, error: '模拟失败 EPERM' });
    expect(fs.existsSync(path.join(t2.src, 'a.txt'))).toBe(true);
    expect(simCalls).toHaveLength(0);
  });

  it('跨卷复制成功后再删源', async () => {
    delete process.env.KB_ROOT_DELETE_FAIL;
    const t = makeTree();
    fsApi().renameSync = () => {
      throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
    };
    const calls: Detail[] = [];
    const res = await runRootDiskDelete(request(t, (detail) => {
      calls.push(detail);
      return 9;
    }));
    expect(res).toEqual({ ok: true, opId: 9, error: null });
    expect(fs.existsSync(t.src)).toBe(false);
    expect(calls).toHaveLength(1);
    const staged = path.join(t.dataDir, ...calls[0]!.staging.split('/'));
    expect(fs.readFileSync(path.join(staged, 'a.txt'), 'utf8')).toBe('hello');
  });

  it('跨卷复制失败时删掉半成品且源还在', async () => {
    delete process.env.KB_ROOT_DELETE_FAIL;
    const t = makeTree();
    const before = fs.readFileSync(path.join(t.src, 'a.txt'));
    const api = fsApi();
    api.renameSync = () => {
      throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
    };
    api.cpSync = ((_src, dest) => {
      const dst = String(dest);
      fs.mkdirSync(dst, { recursive: true });
      fs.writeFileSync(path.join(dst, 'partial.txt'), 'x');
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    }) as typeof fs.cpSync;
    const calls: Detail[] = [];
    const res = await runRootDiskDelete(request(t, (detail) => {
      calls.push(detail);
      return 1;
    }));
    expect(res.ok).toBe(false);
    expect(res.opId).toBeNull();
    expect(res.error).toContain('EPERM');
    expect(res.error).toContain('权限不足');
    expect(calls).toHaveLength(0);
    expect(fs.readFileSync(path.join(t.src, 'a.txt'))).toEqual(before);
    expect(fs.readdirSync(t.stagingDir)).toEqual([]);
  });

  it.each([
    ['EPERM', '权限不足'],
    ['EBUSY', '文件占用'],
    ['EACCES', '权限不足'],
  ] as const)('移动遇到 %s 时不删源', async (code, reason) => {
    delete process.env.KB_ROOT_DELETE_FAIL;
    const t = makeTree();
    const before = fs.readFileSync(path.join(t.src, 'a.txt'));
    fsApi().renameSync = () => {
      throw Object.assign(new Error(code), { code });
    };
    const calls: Detail[] = [];
    const res = await runRootDiskDelete(request(t, (detail) => {
      calls.push(detail);
      return 1;
    }));
    expect(res).toEqual({ ok: false, opId: null, error: `${code} ${reason}` });
    expect(calls).toHaveLength(0);
    expect(fs.readFileSync(path.join(t.src, 'a.txt'))).toEqual(before);
    expect(fs.readdirSync(t.stagingDir)).toEqual([]);
  });

  it('跨卷删源失败时源还在且不记录', async () => {
    delete process.env.KB_ROOT_DELETE_FAIL;
    const t = makeTree();
    const before = fs.readFileSync(path.join(t.src, 'a.txt'));
    const api = fsApi();
    api.renameSync = () => {
      throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
    };
    api.rmSync = ((target: fs.PathLike, opts?: fs.RmOptions) => {
      if (String(target) === t.src) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return fsBaseline.rmSync(target, opts);
    }) as typeof fs.rmSync;
    const calls: Detail[] = [];
    const res = await runRootDiskDelete(request(t, (detail) => {
      calls.push(detail);
      return 1;
    }));
    expect(res).toEqual({ ok: false, opId: null, error: 'EBUSY 文件占用' });
    expect(calls).toHaveLength(0);
    expect(fs.readFileSync(path.join(t.src, 'a.txt'))).toEqual(before);
    expect(fs.readdirSync(t.stagingDir)).toEqual([]);
  });

  it('记录抛错时把文件夹移回，源还在', async () => {
    delete process.env.KB_ROOT_DELETE_FAIL;
    const t = makeTree();
    const res = await runRootDiskDelete(request(t, () => {
      throw new Error('op_log 写不进去');
    }));
    expect(res.ok).toBe(false);
    expect(res.opId).toBeNull();
    expect(res.error).toContain('op_log 写不进去');
    expect(fs.readFileSync(path.join(t.src, 'a.txt'), 'utf8')).toBe('hello');
    expect(fs.readdirSync(t.stagingDir)).toEqual([]);
  });
});
