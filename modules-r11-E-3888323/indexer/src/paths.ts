import path from 'node:path';

export const DEFAULT_SKIP_DIR_NAMES = [
  '$RECYCLE.BIN',
  'System Volume Information',
  'node_modules',
] as const;

const INDEXABLE = new Set(['.txt', '.md', '.pdf']);

export function normalizeRel(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\/+/, '').normalize('NFC');
}

/** Windows 上比较用小写；存进展示路径仍保留原样。 */
export function relKey(relPath: string): string {
  const n = normalizeRel(relPath);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

export function toRelPath(root: string, absPath: string): string {
  const rel = path.relative(path.resolve(root), path.resolve(absPath));
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`路径超出资料根: ${absPath}`);
  }
  return rel.split(/[\\/]/).join('/').normalize('NFC');
}

export function toAbs(localPath: string, relPath: string): string {
  const rel = normalizeRel(relPath);
  const parts = rel.split('/');
  if (parts.includes('..') || parts.includes('.')) {
    throw new Error(`非法相对路径: ${relPath}`);
  }
  const abs = path.resolve(localPath, ...parts);
  const root = path.resolve(localPath);
  const back = path.relative(root, abs);
  if (back.startsWith('..') || path.isAbsolute(back)) {
    throw new Error(`路径超出资料根: ${abs}`);
  }
  return abs;
}

export function deriveLocalPath(absPath: string, relPath: string): string {
  const abs = path.resolve(absPath);
  const rel = normalizeRel(relPath);
  if (!rel) return abs;
  const relFs = rel.split('/').join(path.sep);
  const absCmp = process.platform === 'win32' ? abs.toLowerCase() : abs;
  const relCmp = process.platform === 'win32' ? relFs.toLowerCase() : relFs;
  if (!absCmp.endsWith(relCmp)) {
    throw new Error('absPath 与 relPath 不一致');
  }
  return abs.slice(0, abs.length - relFs.length).replace(/[\\/]+$/, '');
}

export function shouldSkipDirectory(name: string, extra: readonly string[] = []): boolean {
  if (name.startsWith('.')) return true;
  const lower = name.toLowerCase();
  for (const skip of DEFAULT_SKIP_DIR_NAMES) {
    if (skip.toLowerCase() === lower) return true;
  }
  for (const skip of extra) {
    if (skip.toLowerCase() === lower) return true;
  }
  return false;
}

export function isIndexableFile(name: string): boolean {
  if (name.startsWith('.')) return false;
  return INDEXABLE.has(path.extname(name).toLowerCase());
}

export function fileChanged(
  prev: { size: number; mtimeMs: number } | undefined,
  cur: { size: number; mtimeMs: number },
): boolean {
  if (!prev) return true;
  return prev.size !== cur.size || prev.mtimeMs !== cur.mtimeMs;
}
