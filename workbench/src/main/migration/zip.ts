/**
 * 最小 zip 读写（迁移包用，不引入新依赖）。
 * - 写：每个条目 deflate（压缩无收益时 store），文件名 UTF-8（通用位 11），无 zip64（单包 < 4 GB、条目 < 65535）。
 * - 读：只信任中央目录；校验 CRC32 与大小；拒绝加密条目、zip64、绝对路径/盘符/“..”、重复条目名；限制解压后总大小（防 zip 炸弹）。
 */
import zlib from 'node:zlib';

export interface ZipEntry {
  name: string;
  data: Buffer;
}

export class ZipFormatError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ZipFormatError';
  }
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const MAX_U32 = 0xffffffff;

function dosTime(d: Date) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** 条目名：'/' 分隔、相对、无 '..'、无盘符、无 NUL、无反斜杠 */
export function checkEntryName(name: string): string {
  if (typeof name !== 'string' || !name || name.length > 1024) throw new ZipFormatError('条目名不合法');
  if (name.includes('\0') || name.includes('\\')) throw new ZipFormatError(`条目名不合法：${name}`);
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw new ZipFormatError(`条目名不能是绝对路径：${name}`);
  const parts = name.split('/');
  if (parts.some((p) => p === '..' || p === '.' || p === '')) throw new ZipFormatError(`条目名不合法：${name}`);
  return name;
}

export function writeZip(entries: ZipEntry[], now = new Date()): Buffer {
  if (entries.length > 65000) throw new ZipFormatError('条目过多');
  const { time, date } = dosTime(now);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const seen = new Set<string>();
  for (const e of entries) {
    checkEntryName(e.name);
    if (seen.has(e.name)) throw new ZipFormatError(`重复的条目：${e.name}`);
    seen.add(e.name);
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = zlib.crc32(e.data) >>> 0;
    const deflated = zlib.deflateRawSync(e.data, { level: 6 });
    const useDeflate = deflated.length < e.data.length;
    const body = useDeflate ? deflated : e.data;
    const method = useDeflate ? 8 : 0;
    if (e.data.length >= MAX_U32 || body.length >= MAX_U32 || offset >= MAX_U32) throw new ZipFormatError('迁移包超过 4 GB（不支持 zip64）');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(SIG_LOCAL, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0x0800, 6); // UTF-8 名称
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(SIG_CENTRAL, 0);
    ch.writeUInt16LE(0x031e, 4); // made by: unix, 3.0
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30); // extra
    ch.writeUInt16LE(0, 32); // comment
    ch.writeUInt16LE(0, 34); // disk
    ch.writeUInt16LE(0, 36); // internal attrs
    ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs: regular file 0644
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + body.length;
  }
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_END, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}

export interface ReadZipOptions {
  /** 解压后总大小上限（默认 2 GB） */
  maxTotalBytes?: number;
  maxEntries?: number;
}

export function readZip(buf: Buffer, opts: ReadZipOptions = {}): Map<string, Buffer> {
  const maxTotal = opts.maxTotalBytes ?? 2 * 1024 * 1024 * 1024;
  const maxEntries = opts.maxEntries ?? 65000;
  // 找 EOCD（末尾 22 字节 + 最多 65535 字节注释）
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === SIG_END) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipFormatError('不是 zip 文件（找不到中央目录）');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOff === MAX_U32) throw new ZipFormatError('不支持 zip64');
  if (count > maxEntries) throw new ZipFormatError('条目过多');
  if (cdOff + cdSize > eocd) throw new ZipFormatError('中央目录越界');
  const out = new Map<string, Buffer>();
  let p = cdOff;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipFormatError('中央目录损坏');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString(flags & 0x0800 ? 'utf8' : 'latin1');
    p += 46 + nlen + xlen + clen;
    if (flags & 0x0001) throw new ZipFormatError(`不支持加密条目：${name}`);
    if (name.endsWith('/')) continue; // 目录条目
    checkEntryName(name);
    if (out.has(name)) throw new ZipFormatError(`重复的条目：${name}`);
    total += usize;
    if (total > maxTotal) throw new ZipFormatError('解压后大小超过上限');
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== SIG_LOCAL) throw new ZipFormatError(`本地头损坏：${name}`);
    const dataStart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    if (dataStart + csize > buf.length) throw new ZipFormatError(`条目越界：${name}`);
    const raw = buf.subarray(dataStart, dataStart + csize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) });
    else throw new ZipFormatError(`不支持的压缩方法 ${method}：${name}`);
    if (data.length !== usize) throw new ZipFormatError(`大小不符：${name}`);
    if ((zlib.crc32(data) >>> 0) !== crc) throw new ZipFormatError(`CRC 校验失败：${name}`);
    out.set(name, data);
  }
  return out;
}
