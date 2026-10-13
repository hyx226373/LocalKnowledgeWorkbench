import path from 'node:path';
import fs from 'node:fs';

export class PathEscapeError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'PathEscapeError';
  }
}

type PathLib = typeof path.posix | typeof path.win32;

/**
 * 规范化根相对路径：统一 '/' 分隔，去掉首尾 '/'，拒绝 '..'、绝对路径、盘符、UNC、NUL。
 * 返回 '' 表示根本身。
 */
export function normalizeRelPath(rel: string): string {
  if (typeof rel !== 'string') throw new PathEscapeError('relPath 必须是字符串');
  if (rel.includes('\0')) throw new PathEscapeError('路径包含 NUL 字符');
  const s = rel.replace(/\\/g, '/');
  if (/^[a-zA-Z]:/.test(s)) throw new PathEscapeError('相对路径不能包含盘符');
  if (s.startsWith('//')) throw new PathEscapeError('相对路径不能是 UNC 路径');
  const parts = s.split('/').filter((p) => p !== '' && p !== '.');
  for (const p of parts) {
    if (p === '..') throw new PathEscapeError('相对路径不能包含 ..');
    // Windows 会把 "a." / "a " 当成 "a"；冒号可用于 NTFS ADS（file.txt:stream）
    if (p.includes(':')) throw new PathEscapeError('路径段不能包含冒号');
  }
  return parts.join('/');
}

function isInside(rootAbs: string, target: string, p: PathLib, caseInsensitive: boolean): boolean {
  const norm = (x: string) => (caseInsensitive ? x.toLowerCase() : x);
  const rel = p.relative(norm(rootAbs), norm(target));
  return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
}

/**
 * 纯字符串层面的解析（不碰文件系统），可用 path.win32 测 Windows 语义。
 */
export function resolveInRootLexical(
  rootAbs: string,
  rel: string,
  p: PathLib = path,
  caseInsensitive = p === path.win32,
): string {
  const n = normalizeRelPath(rel);
  const target = n === '' ? p.resolve(rootAbs) : p.resolve(rootAbs, ...n.split('/'));
  if (!isInside(p.resolve(rootAbs), target, p, caseInsensitive)) {
    throw new PathEscapeError(`路径越出根目录: ${rel}`);
  }
  return target;
}

/**
 * 解析并做 realpath 校验（防止根内符号链接/junction 指向根外）。
 * 目标不存在时校验其最近存在的祖先。
 */
export function resolveInRoot(rootAbs: string, rel: string): string {
  const target = resolveInRootLexical(rootAbs, rel);
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
  let rootReal: string;
  try {
    rootReal = fs.realpathSync.native(rootAbs);
  } catch {
    return target; // 根不存在（离线），交由调用方处理
  }
  let probe = target;
  while (true) {
    try {
      const real = fs.realpathSync.native(probe);
      if (!isInside(rootReal, real, path, caseInsensitive)) {
        throw new PathEscapeError(`路径经链接越出根目录: ${rel}`);
      }
      return target;
    } catch (e) {
      if (e instanceof PathEscapeError) throw e;
      const parent = path.dirname(probe);
      if (parent === probe) return target;
      probe = parent;
    }
  }
}

/** 把绝对路径转成根相对路径（'/' 分隔）。不在根内返回 null。 */
export function toRelPath(rootAbs: string, abs: string): string | null {
  const caseInsensitive = process.platform === 'win32';
  if (!isInside(path.resolve(rootAbs), path.resolve(abs), path, caseInsensitive)) return null;
  return path.relative(path.resolve(rootAbs), path.resolve(abs)).split(path.sep).join('/');
}

export type KbfileTarget =
  | { type: 'res'; resourceId: string }
  | { type: 'root'; rootId: string; relPath: string };

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 解析 kbfile://res/<resourceId>/<name> 或 kbfile://root/<rootId>/<rel/path> */
export function parseKbfileUrl(url: string): KbfileTarget {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new PathEscapeError('无效的 kbfile URL');
  }
  if (u.protocol !== 'kbfile:') throw new PathEscapeError('协议必须是 kbfile:');
  const segs = u.pathname.split('/').filter(Boolean);
  let decoded: string[];
  try {
    decoded = segs.map((s) => decodeURIComponent(s));
  } catch {
    throw new PathEscapeError('URL 编码错误');
  }
  if (u.hostname === 'res') {
    const id = decoded[0] ?? '';
    if (!ID_RE.test(id)) throw new PathEscapeError('无效的 resourceId');
    return { type: 'res', resourceId: id.toLowerCase() };
  }
  if (u.hostname === 'root') {
    const id = decoded.shift() ?? '';
    if (!ID_RE.test(id)) throw new PathEscapeError('无效的 rootId');
    // 解码后的段里再出现分隔符（%2F / %5C）一律拒绝，避免二次解释
    for (const d of decoded) {
      if (d.includes('/') || d.includes('\\')) throw new PathEscapeError('路径段包含编码的分隔符');
    }
    return { type: 'root', rootId: id.toLowerCase(), relPath: normalizeRelPath(decoded.join('/')) };
  }
  throw new PathEscapeError('未知的 kbfile 主机');
}

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}
