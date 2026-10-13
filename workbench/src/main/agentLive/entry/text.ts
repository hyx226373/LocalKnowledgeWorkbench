import path from 'node:path';

export class EntryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'EntryError';
  }
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertSafeId(value: string, label: string): void {
  if (!ID_RE.test(value)) throw new EntryError('bad_id', `${label} 不能作为目录名`);
}

export function isSafeId(value: string): boolean {
  return ID_RE.test(value);
}

/** 用户资料里的换行不能打断入口的六块结构。 */
export function oneLine(value: string | null | undefined, max = 1024): string {
  if (!value) return '';
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}…`;
}

export function hashHex(value: string | null | undefined): string | null {
  if (!value) return null;
  const hex = value.trim().toLowerCase().replace(/^sha256:/, '');
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

export function isSecretPath(filePath: string | null | undefined): boolean {
  if (!filePath) return false;
  const base = filePath.split(/[/\\]/).pop()?.toLowerCase() ?? '';
  return base === 'agent-token.json';
}

export function extOf(filePath: string): string {
  return path.extname(filePath).replace(/^\./, '').toLowerCase();
}

const EXTRACT_EXT = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp']);
const NO_TEXT_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tif', 'tiff',
  'zip', 'gz', 'tgz', '7z', 'rar', 'wasm', 'exe', 'dll',
  'mp3', 'mp4', 'mov', 'avi', 'mkv', 'woff', 'woff2', 'ttf', 'eot',
]);

export type BodyKind = 'extract' | 'no-text' | 'text';

export function bodyKind(filePath: string): BodyKind {
  const ext = extOf(filePath);
  if (EXTRACT_EXT.has(ext)) return 'extract';
  if (NO_TEXT_EXT.has(ext)) return 'no-text';
  return 'text';
}

export function isPdf(filePath: string): boolean {
  return extOf(filePath) === 'pdf';
}
