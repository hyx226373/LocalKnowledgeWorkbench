import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { ByteProgress } from './types';

export class PackageRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackageRejectedError';
  }
}

export function sha512Equals(actual: string, expected: string): boolean {
  const a = Buffer.from(actual, 'base64');
  const b = Buffer.from(expected, 'base64');
  if (a.length !== 64 || b.length !== 64) return false;
  return timingSafeEqual(a, b);
}

export async function hashFileSha512(file: string): Promise<string> {
  const hash = createHash('sha512');
  const input = createReadStream(file, { highWaterMark: 64 * 1024 });
  for await (const chunk of input) hash.update(chunk as Buffer);
  return hash.digest('base64');
}

export async function readGzipMagic(file: string): Promise<boolean> {
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(2);
    const read = await fh.read(buf, 0, 2, 0);
    return read.bytesRead === 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  } finally {
    await fh.close();
  }
}

async function writeAll(fh: fs.FileHandle, buf: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buf.length) {
    const wrote = await fh.write(buf, offset, buf.length - offset);
    if (wrote.bytesWritten <= 0) throw new PackageRejectedError('写入下载文件失败');
    offset += wrote.bytesWritten;
  }
}

function httpGet(url: string, signal: AbortSignal | undefined, redirects: number): Promise<Readable> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, (res) => {
      const code = res.statusCode ?? 0;
      if (code >= 300 && code < 400 && res.headers.location && redirects < 3) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        if (!/^https?:\/\//i.test(next)) {
          reject(new PackageRejectedError('下载重定向不合法'));
          return;
        }
        httpGet(next, signal, redirects + 1).then(resolve, reject);
        return;
      }
      if (code !== 200) {
        res.resume();
        reject(new PackageRejectedError(`下载失败 HTTP ${code}`));
        return;
      }
      resolve(res);
    });
    req.on('error', reject);
    if (signal) {
      const abort = () => req.destroy(new PackageRejectedError('下载已取消'));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
  });
}

async function openSource(source: string, signal?: AbortSignal): Promise<Readable> {
  if (/^https?:\/\//i.test(source)) return httpGet(source, signal, 0);
  const filePath = source.startsWith('file:') ? fileURLToPath(source) : source;
  return createReadStream(filePath, { highWaterMark: 64 * 1024 });
}

export interface DownloadRequest {
  source: string;
  dest: string;
  expectedSha512: string;
  expectedSize: number;
  rateLimitBytesPerSec: number | null;
  signal?: AbortSignal;
  onProgress: (progress: ByteProgress) => void;
}

const RETRYABLE_DEST_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST']);

export const DEST_RENAME_ATTEMPTS = 5;
export const DEST_RENAME_DELAYS_MS = [200, 400, 800, 1600];

function renameErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object' || !('code' in err)) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && code ? code : undefined;
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 先删目标再改名。仅 EPERM / EACCES / EBUSY / EEXIST 重试，最多 5 次。 */
export async function replaceDestWithPart(
  part: string,
  dest: string,
  io?: {
    rm?: (target: string) => Promise<void>;
    rename?: (from: string, to: string) => Promise<void>;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<void> {
  const rm = io?.rm ?? ((target: string) => fs.rm(target, { force: true }));
  const rename = io?.rename ?? fs.rename;
  const sleep = io?.sleep ?? delayMs;
  let last: unknown;
  for (let attempt = 0; attempt < DEST_RENAME_ATTEMPTS; attempt += 1) {
    try {
      await rm(dest);
    } catch {
      /* 目标被占用时删不掉，继续尝试改名 */
    }
    try {
      await rename(part, dest);
      return;
    } catch (err) {
      last = err;
      const code = renameErrorCode(err);
      if (!code || !RETRYABLE_DEST_RENAME.has(code) || attempt + 1 >= DEST_RENAME_ATTEMPTS) break;
      await sleep(DEST_RENAME_DELAYS_MS[attempt]);
    }
  }
  try {
    await rm(part);
  } catch {
    /* 删不掉 part 仍抛中文错误，外层还会再删一次 */
  }
  const code = renameErrorCode(last) ?? 'UNKNOWN';
  throw new PackageRejectedError(`安装包改名失败（${code}）。下载目录里的同名文件被占用或无法覆盖，已取消这次下载。`);
}

/** 边写边计字节。校验失败时删除半成品和目标文件，不留下可安装的包。 */
export async function downloadVerified(req: DownloadRequest): Promise<void> {
  if (!Number.isInteger(req.expectedSize) || req.expectedSize <= 0) throw new PackageRejectedError('安装包大小无效');
  if (!req.expectedSha512) throw new PackageRejectedError('缺少 SHA512');
  await fs.mkdir(path.dirname(req.dest), { recursive: true });
  const part = `${req.dest}.part`;
  await fs.rm(part, { force: true }).catch(() => undefined);
  const hash = createHash('sha512');
  let transferred = 0;
  const total = req.expectedSize;
  const started = Date.now();
  let input: Readable | null = null;
  let fh: fs.FileHandle | null = null;
  try {
    input = await openSource(req.source, req.signal);
    fh = await fs.open(part, 'w');
    for await (const chunk of input) {
      if (req.signal?.aborted) throw new PackageRejectedError('下载已取消');
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      hash.update(buf);
      if (transferred + buf.length > total) throw new PackageRejectedError(`下载超过声明大小：${transferred + buf.length} > ${total}`);
      await writeAll(fh, buf);
      transferred += buf.length;
      req.onProgress({ transferred, total });
      const limit = req.rateLimitBytesPerSec;
      if (limit && limit > 0) {
        const ahead = (transferred / limit) * 1000 - (Date.now() - started);
        if (ahead > 15) await new Promise((resolve) => setTimeout(resolve, ahead));
      }
    }
    const digest = hash.digest('base64');
    if (transferred !== total || !sha512Equals(digest, req.expectedSha512)) {
      throw new PackageRejectedError(transferred !== total ? `大小不一致：收到 ${transferred}，声明 ${total}` : 'SHA512 不一致，安装包已丢弃');
    }
    await fh.close();
    fh = null;
    await replaceDestWithPart(part, req.dest);
  } catch (err) {
    if (fh) await fh.close().catch(() => undefined);
    await fs.rm(part, { force: true }).catch(() => undefined);
    await fs.rm(req.dest, { force: true }).catch(() => undefined);
    throw err;
  }
}
