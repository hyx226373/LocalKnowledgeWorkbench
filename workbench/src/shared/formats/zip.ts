import { unzipSync, zipSync } from 'fflate';
import { FormatFail } from './types';
import { MSG } from './messages';
import { MAX_COMPRESSION_RATIO, MAX_UNCOMPRESSED_BYTES, MAX_ZIP_ENTRIES } from './limits';

function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

/** 中央目录记录。先看声明的尺寸，再决定要不要解压。 */
export function assertZipSafe(bytes: Uint8Array): void {
  const eocd = findEocd(bytes);
  if (eocd < 0) throw new FormatFail('corrupt', MSG.corrupt);
  const entries = u16(bytes, eocd + 10);
  const cdSize = u32(bytes, eocd + 12);
  const cdOffset = u32(bytes, eocd + 16);
  if (entries === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new FormatFail('too-large', MSG.zipLimit);
  if (entries > MAX_ZIP_ENTRIES) throw new FormatFail('too-large', MSG.zipLimit);
  if (cdOffset + cdSize > bytes.length) throw new FormatFail('corrupt', MSG.corrupt);

  let offset = cdOffset;
  let totalUncompressed = 0;
  let seen = 0;
  while (seen < entries) {
    if (offset + 46 > bytes.length || u32(bytes, offset) !== 0x02014b50) throw new FormatFail('corrupt', MSG.corrupt);
    const flags = u16(bytes, offset + 8);
    const method = u16(bytes, offset + 10);
    const compressed = u32(bytes, offset + 20);
    const uncompressed = u32(bytes, offset + 24);
    const nameLen = u16(bytes, offset + 28);
    const extraLen = u16(bytes, offset + 30);
    const commentLen = u16(bytes, offset + 32);
    if (flags & 1) throw new FormatFail('encrypted', MSG.encrypted);
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) throw new FormatFail('too-large', MSG.zipLimit);
    if (method !== 0 && method !== 8) throw new FormatFail('unsupported-variant', MSG.unsupported);
    if (uncompressed > MAX_UNCOMPRESSED_BYTES || compressed > MAX_UNCOMPRESSED_BYTES) throw new FormatFail('too-large', MSG.zipLimit);
    if (compressed > 0 && uncompressed / compressed > MAX_COMPRESSION_RATIO) throw new FormatFail('too-large', MSG.zipLimit);
    totalUncompressed += uncompressed;
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) throw new FormatFail('too-large', MSG.zipLimit);
    offset += 46 + nameLen + extraLen + commentLen;
    seen++;
  }
}

function findEocd(bytes: Uint8Array): number {
  const min = Math.max(0, bytes.length - 22 - 65535);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) return i;
  }
  return -1;
}

export function unzipOffice(bytes: Uint8Array): Map<string, Uint8Array> {
  assertZipSafe(bytes);
  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(bytes);
  } catch {
    throw new FormatFail('corrupt', MSG.corrupt);
  }
  const files = new Map<string, Uint8Array>();
  let total = 0;
  const names = Object.keys(raw);
  if (names.length > MAX_ZIP_ENTRIES) throw new FormatFail('too-large', MSG.zipLimit);
  for (const name of names) {
    const norm = name.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!norm || norm.split('/').includes('..')) throw new FormatFail('corrupt', MSG.corrupt);
    const data = raw[name];
    total += data.byteLength;
    if (total > MAX_UNCOMPRESSED_BYTES) throw new FormatFail('too-large', MSG.zipLimit);
    files.set(norm, data);
  }
  return files;
}

export function repackOffice(files: Map<string, Uint8Array>): Uint8Array {
  const obj: Record<string, Uint8Array> = {};
  for (const [name, data] of files) obj[name] = data;
  return zipSync(obj, { level: 0 });
}
