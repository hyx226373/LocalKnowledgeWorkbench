import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PackageRejectedError, hashFileSha512 } from '../../shared/update/download';
import {
  assertVersionDirName,
  candidateRel,
  installPath,
  isUnderStudyDev,
  readCurrent,
  verifyVersionTree,
  versionDir,
  VERSIONS_DIR,
} from '../../shared/layout';
import { powershellExe } from './helperScript';

export interface PrepareDirpackRequest {
  zipPath: string;
  installRoot: string;
  version: string;
  expectedSize: number;
  expectedSha512: string;
  signal?: AbortSignal;
  onProgress?: (p: { transferred: number; total: number; stage: 'extract' | 'verify' }) => void;
  extract?: (zip: string, dest: string, signal?: AbortSignal) => Promise<void>;
}

function partialDir(installRoot: string, version: string): string {
  return installPath(installRoot, VERSIONS_DIR, `${assertVersionDirName(version)}.partial`);
}

function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** 默认解压。只调用 Expand-Archive，不使用 CIM / WMI。 */
async function defaultExtract(zip: string, dest: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new PackageRejectedError('下载已取消');
  await fs.mkdir(dest, { recursive: true });
  const command = `Expand-Archive -LiteralPath ${powershellQuote(zip)} -DestinationPath ${powershellQuote(dest)} -Force`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(powershellExe(), ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const errChunks: Buffer[] = [];
    let errBytes = 0;
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (errBytes < 4096) {
        errChunks.push(buf);
        errBytes += buf.length;
      }
    });
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve();
    };
    const onAbort = () => {
      child.kill();
      finish(new PackageRejectedError('下载已取消'));
    };
    if (signal) {
      if (signal.aborted) {
        child.kill();
        finish(new PackageRejectedError('下载已取消'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    child.once('error', (err) => finish(err));
    child.once('exit', (code) => {
      if (signal?.aborted) {
        finish(new PackageRejectedError('下载已取消'));
        return;
      }
      if (code === 0) {
        finish();
        return;
      }
      const detail = Buffer.concat(errChunks).toString('utf8').trim();
      finish(new Error(detail ? `解压失败：${detail}` : `解压失败，退出码 ${code ?? 'null'}`));
    });
  });
}

async function discardPartial(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PackageRejectedError('下载已取消');
}

/**
 * 校验 zip 后解到 versions/<版本>.partial，完整性通过才改名为 versions/<版本>。
 * 失败或取消时删掉 partial，不覆盖已有候选，也不动 current.json。
 */
export async function prepareDirpack(req: PrepareDirpackRequest): Promise<{ candidateRel: string; version: string }> {
  if (isUnderStudyDev(req.installRoot)) throw new Error('拒绝在 example_dev 下准备目录包');
  const version = assertVersionDirName(req.version);
  const partial = partialDir(req.installRoot, version);
  const finalDir = versionDir(req.installRoot, version);
  if (req.signal?.aborted) {
    await removePartial(req.installRoot, version);
    throw new PackageRejectedError('下载已取消');
  }
  if (!Number.isInteger(req.expectedSize) || req.expectedSize <= 0 || !req.expectedSha512) {
    throw new PackageRejectedError('安装包大小或 SHA512 无效');
  }
  const info = await fs.stat(req.zipPath);
  if (info.size !== req.expectedSize) {
    await removePartial(req.installRoot, version);
    throw new PackageRejectedError(`大小不一致：收到 ${info.size}，声明 ${req.expectedSize}`);
  }
  if (req.signal?.aborted) {
    await removePartial(req.installRoot, version);
    throw new PackageRejectedError('下载已取消');
  }
  const actual = await hashFileSha512(req.zipPath);
  if (actual !== req.expectedSha512) {
    await removePartial(req.installRoot, version);
    throw new PackageRejectedError('SHA512 不一致，安装包已丢弃');
  }
  if (req.signal?.aborted) {
    await removePartial(req.installRoot, version);
    throw new PackageRejectedError('下载已取消');
  }
  let occupied = false;
  try {
    await fs.stat(finalDir);
    occupied = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (occupied) {
    await removePartial(req.installRoot, version);
    throw new Error('候选版本目录已存在');
  }

  const extract = req.extract ?? defaultExtract;
  let renamed = false;
  try {
    await fs.mkdir(path.dirname(partial), { recursive: true });
    await fs.rm(partial, { recursive: true, force: true });
    await fs.mkdir(partial, { recursive: true });
    throwIfCancelled(req.signal);
    req.onProgress?.({ transferred: 0, total: req.expectedSize, stage: 'extract' });
    await extract(req.zipPath, partial, req.signal);
    throwIfCancelled(req.signal);
    req.onProgress?.({ transferred: req.expectedSize, total: req.expectedSize, stage: 'verify' });
    const checked = await verifyVersionTree(partial);
    if (!checked.ok) throw new Error(`版本目录不完整，缺少：${checked.missing.join('、')}`);
    try {
      await fs.stat(finalDir);
      throw new Error('候选版本目录已存在');
    } catch (err) {
      if ((err as Error).message === '候选版本目录已存在') throw err;
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await fs.rename(partial, finalDir);
    renamed = true;
  } catch (err) {
    if (!renamed) await discardPartial(partial);
    if (req.signal?.aborted) throw new PackageRejectedError('下载已取消');
    throw err;
  }
  return { candidateRel: candidateRel(version), version };
}

/** 只删除 versions/<版本>.partial。current / previous 指向的目录不动。 */
export async function removePartial(installRoot: string, version: string): Promise<void> {
  if (isUnderStudyDev(installRoot)) throw new Error('拒绝删除 example_dev 下的目录');
  const versionName = assertVersionDirName(version);
  const partial = partialDir(installRoot, versionName);
  const keep = new Set<string>();
  keep.add(path.win32.resolve(versionDir(installRoot, versionName)).toLowerCase());
  try {
    const pointer = await readCurrent(installRoot);
    keep.add(path.win32.resolve(versionDir(installRoot, pointer.current)).toLowerCase());
    if (pointer.previous) keep.add(path.win32.resolve(versionDir(installRoot, pointer.previous)).toLowerCase());
  } catch {
    // 没有可读指针时仍然只删 .partial
  }
  if (keep.has(path.win32.resolve(partial).toLowerCase())) return;
  await fs.rm(partial, { recursive: true, force: true });
}
