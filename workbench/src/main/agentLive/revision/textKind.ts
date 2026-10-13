import path from 'node:path';

/** 文本副本上限。超过的文件不做差异、不留文本副本。 */
export const TEXT_COPY_MAX = 2 * 1024 * 1024;

const BINARY_EXT = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tif', 'tiff',
  'zip', 'gz', 'tgz', '7z', 'rar', 'wasm', 'exe', 'dll',
  'mp3', 'mp4', 'mov', 'avi', 'mkv', 'woff', 'woff2', 'ttf', 'eot',
]);

export function isTransientPath(filePath: string | undefined): boolean {
  if (!filePath) return false;
  const base = filePath.split(/[/\\]/).pop() ?? filePath;
  const lower = base.toLowerCase();
  if (lower.endsWith('.tmp') || lower.endsWith('.temp')) return true;
  if (lower.endsWith('~') || lower.endsWith('.swp') || lower.endsWith('.swx')) return true;
  if (lower.startsWith('.#') || lower.startsWith('~$')) return true;
  return /\.kbtmp-\d+$/i.test(base);
}

/** PDF、Office 等为 binary。其余在 2MB 内且是合法 UTF-8 的视为文本。 */
export function textKind(filePath: string, buf: Buffer): 'text' | 'binary' {
  const ext = path.extname(filePath).replace(/^\./, '').toLowerCase();
  if (BINARY_EXT.has(ext)) return 'binary';
  if (buf.length > TEXT_COPY_MAX) return 'binary';
  if (buf.includes(0)) return 'binary';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return 'binary';
  }
  return 'text';
}
