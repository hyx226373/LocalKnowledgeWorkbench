import path from 'node:path';
import { PathEscapeError } from './errors.ts';

const MISSING_MARK = '//missing/';

/** 旧库才有的占位前缀。migrate 把它改回原 rel_path；新写入不再使用。 */
export function isTombstone(relPath: string): boolean {
  return relPath.startsWith(MISSING_MARK);
}

export function logicalRelPath(relPath: string): string {
  if (!isTombstone(relPath)) return relPath;
  const rest = relPath.slice(MISSING_MARK.length);
  const slash = rest.indexOf('/');
  return slash === -1 ? '' : rest.slice(slash + 1);
}

/**
 * `\` → `/`，NFC，去掉 `.` 和重复斜杠。
 * 拒绝绝对路径、盘符、UNC、空字节和 `..`（含大小写、反斜杠伪装）。
 * 空字符串表示根目录本身。
 */
export function normalizeRelPath(input: string): string {
  if (typeof input !== 'string') throw new PathEscapeError('path must be a string');
  if (input.includes('\0')) throw new PathEscapeError('NUL byte');
  const unified = input.replace(/\\/g, '/').normalize('NFC');
  if (/^[a-zA-Z]:/.test(unified) || unified.startsWith('//') || unified.startsWith('/')) {
    throw new PathEscapeError('absolute path');
  }
  if (path.win32.isAbsolute(input) || path.posix.isAbsolute(unified)) {
    throw new PathEscapeError('absolute path');
  }
  const parts = unified.split('/').filter((part) => part.length > 0 && part !== '.');
  if (parts.some((part) => part === '..')) throw new PathEscapeError('path traversal');
  return parts.map((part) => part.normalize('NFC')).join('/');
}

/** Windows 上唯一性比较用小写；库里的 rel_path 仍保留规范后的大小写。 */
export function pathKey(relPath: string): string {
  const normalized = relPath.normalize('NFC');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function isInsideRoot(rootReal: string, candidate: string): boolean {
  const norm = (value: string) => {
    let n = path.normalize(value).normalize('NFC');
    if (!/^[A-Za-z]:\\$/.test(n)) n = n.replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? n.toLowerCase() : n;
  };
  const rel = path.relative(norm(rootReal), norm(candidate));
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return !rel.split(/[\\/]/).includes('..');
}

export function joinRel(rootAbs: string, relPath: string): string {
  if (relPath === '') return rootAbs;
  return path.join(rootAbs, ...relPath.split('/'));
}
