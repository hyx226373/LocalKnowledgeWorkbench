import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEST_RENAME_ATTEMPTS,
  DEST_RENAME_DELAYS_MS,
  downloadVerified,
  PackageRejectedError,
  replaceDestWithPart,
} from '../src/shared/update/download';

const roots: string[] = [];

afterEach(async () => {
  while (roots.length) {
    const dir = roots.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function tmp(): string {
  const dir = path.join(os.tmpdir(), `kb-update-rename-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  roots.push(dir);
  return dir;
}

function errno(code: string): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function renameFail(code: string): string {
  return `安装包改名失败（${code}）。下载目录里的同名文件被占用或无法覆盖，已取消这次下载。`;
}

describe('下载改名', () => {
  it('dest 已存在且内容不同时替换为源文件，不留 part', async () => {
    const dir = tmp();
    await fs.mkdir(dir, { recursive: true });
    const src = path.join(dir, 'pkg.bin');
    const dest = path.join(dir, 'out.bin');
    const body = Buffer.from('package-bytes-new');
    await fs.writeFile(src, body);
    await fs.writeFile(dest, Buffer.from('old-different-content'));
    await downloadVerified({
      source: src,
      dest,
      expectedSha512: createHash('sha512').update(body).digest('base64'),
      expectedSize: body.length,
      rateLimitBytesPerSec: null,
      onProgress: () => undefined,
    });
    expect(await fs.readFile(dest)).toEqual(body);
    await expect(fs.stat(`${dest}.part`)).rejects.toThrow();
  });

  it('注入的 rename 前两次 EPERM、第三次成功', async () => {
    expect(DEST_RENAME_ATTEMPTS).toBe(5);
    expect(DEST_RENAME_DELAYS_MS).toEqual([200, 400, 800, 1600]);
    const dir = tmp();
    await fs.mkdir(dir, { recursive: true });
    const part = path.join(dir, 'out.bin.part');
    const dest = path.join(dir, 'out.bin');
    const body = Buffer.from('renamed-bytes');
    await fs.writeFile(part, body);
    await fs.writeFile(dest, Buffer.from('old-dest'));
    const removed: string[] = [];
    const sleeps: number[] = [];
    let tries = 0;
    await replaceDestWithPart(part, dest, {
      rm: async (target) => {
        removed.push(target);
        await fs.rm(target, { force: true });
      },
      rename: async (from, to) => {
        tries += 1;
        if (tries < 3) throw errno('EPERM');
        await fs.rename(from, to);
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(tries).toBe(3);
    expect(sleeps).toEqual([200, 400]);
    expect(removed.filter((target) => target === dest)).toEqual([dest, dest, dest]);
    expect(removed).not.toContain(part);
    expect(await fs.readFile(dest)).toEqual(body);
    await expect(fs.stat(part)).rejects.toThrow();
  });

  it('注入的 rename 一直 EPERM 时抛中文错误并删除 part', async () => {
    const dir = tmp();
    await fs.mkdir(dir, { recursive: true });
    const part = path.join(dir, 'out.bin.part');
    const dest = path.join(dir, 'out.bin');
    await fs.writeFile(part, Buffer.from('part-bytes'));
    await fs.writeFile(dest, Buffer.from('locked-dest'));
    const sleeps: number[] = [];
    let tries = 0;
    const err = await replaceDestWithPart(part, dest, {
      rename: async () => {
        tries += 1;
        throw errno('EPERM');
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    }).then(() => {
      throw new Error('应该失败');
    }, (caught: unknown) => caught);
    expect(err).toBeInstanceOf(PackageRejectedError);
    expect((err as Error).message).toBe(renameFail('EPERM'));
    expect(tries).toBe(5);
    expect(sleeps).toEqual([200, 400, 800, 1600]);
    await expect(fs.stat(part)).rejects.toThrow();
  });

  it('ENOENT 不重试', async () => {
    const dir = tmp();
    await fs.mkdir(dir, { recursive: true });
    const part = path.join(dir, 'out.bin.part');
    const dest = path.join(dir, 'out.bin');
    await fs.writeFile(part, Buffer.from('part-bytes'));
    const sleeps: number[] = [];
    let tries = 0;
    const err = await replaceDestWithPart(part, dest, {
      rename: async () => {
        tries += 1;
        throw errno('ENOENT');
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    }).then(() => {
      throw new Error('应该失败');
    }, (caught: unknown) => caught);
    expect(err).toBeInstanceOf(PackageRejectedError);
    expect((err as Error).message).toBe(renameFail('ENOENT'));
    expect(tries).toBe(1);
    expect(sleeps).toEqual([]);
    await expect(fs.stat(part)).rejects.toThrow();
  });
});
