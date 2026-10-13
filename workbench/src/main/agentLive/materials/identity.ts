import path from 'node:path';

/** 文本副本与粗估的读取上限。超过的文件仍计算完整 sha256，但差异标为不支持。 */
export const TEXT_SAMPLE_MAX = 2 * 1024 * 1024;

const TEXT_EXT = new Set([
  'md', 'txt', 'tex', 'text', 'log', 'csv', 'tsv', 'json', 'jsonl', 'xml', 'html', 'htm',
  'css', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'java', 'c', 'h', 'cpp', 'hpp',
  'cs', 'go', 'rs', 'yml', 'yaml', 'toml', 'ini', 'sh', 'ps1', 'bat', 'sql', 'r', 'vue',
  'svelte', 'rb', 'php', 'swift', 'kt', 'scala', 'lua', 'pl', 'markdown',
]);

const OFFICE_EXT = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp']);

const BINARY_EXT = new Set([
  'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tif', 'tiff',
  'zip', 'gz', 'tgz', '7z', 'rar', 'wasm', 'exe', 'dll',
  'mp3', 'mp4', 'mov', 'avi', 'mkv', 'woff', 'woff2', 'ttf', 'eot',
  ...OFFICE_EXT,
]);

export function extensionOf(filePath: string): string {
  return path.extname(filePath).replace(/^\./, '').toLowerCase();
}

/** 大小写不敏感，去掉末尾分隔符。盘符根保留尾部分隔符。 */
export function pathKey(absPath: string): string {
  let resolved = path.resolve(absPath).replace(/\//g, '\\');
  if (!/^[a-zA-Z]:\\?$/.test(resolved)) resolved = resolved.replace(/\\+$/, '');
  return resolved.toLowerCase();
}

export function displayPath(absPath: string): string {
  const resolved = path.resolve(absPath);
  if (/^[a-zA-Z]:\\?$/.test(resolved)) return resolved.endsWith('\\') ? resolved : `${resolved}\\`;
  return resolved.replace(/[\\/]+$/, '');
}

export function normalizeRel(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

export function isInsideDir(dir: string, file: string): boolean {
  const parent = pathKey(dir);
  const child = pathKey(file);
  if (child === parent) return true;
  const prefix = parent.endsWith('\\') ? parent : `${parent}\\`;
  return child.startsWith(prefix);
}

export function baseName(filePath: string): string {
  const base = path.win32.basename(filePath.replace(/\//g, '\\'));
  return base || filePath;
}

export function isTransientPath(filePath: string | undefined): boolean {
  if (!filePath) return false;
  const base = filePath.split(/[/\\]/).pop() ?? filePath;
  const lower = base.toLowerCase();
  if (lower.endsWith('.tmp') || lower.endsWith('.temp')) return true;
  if (lower.endsWith('~') || lower.endsWith('.swp') || lower.endsWith('.swx')) return true;
  if (lower.startsWith('.#') || lower.startsWith('~$')) return true;
  return /\.kbtmp-\d+$/i.test(base);
}

export function isSecretPath(filePath: string | undefined): boolean {
  if (!filePath) return false;
  const base = filePath.split(/[/\\]/).pop()?.toLowerCase() ?? '';
  return base === 'agent-token.json';
}

export function isUrlPath(filePath: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(filePath);
}

export function preliminaryHasText(filePath: string): boolean {
  const ext = extensionOf(filePath);
  if (ext === 'pdf' || OFFICE_EXT.has(ext) || TEXT_EXT.has(ext)) return true;
  return false;
}

/** 汉字、假名、谚文、中日韩标点、全角字符各计 1，其余字符各计 0.25，向上取整。 */
export function estimateTokens(text: string, fullBytes = 0, sampleBytes = 0): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isCjk(cp)) cjk += 1;
    else other += 1;
  }
  let est = cjk + other / 4;
  if (fullBytes > sampleBytes && sampleBytes > 0) est *= fullBytes / sampleBytes;
  return Math.ceil(est);
}

function isCjk(cp: number): boolean {
  return (
    (cp >= 0x3400 && cp <= 0x9fff) ||
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0x31f0 && cp <= 0x31ff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0xff00 && cp <= 0xffef) ||
    (cp >= 0x20000 && cp <= 0x3ffff)
  );
}

/**
 * 只扫 PDF 源码里的页数，不跑 pdf.js。
 * 优先取 /Type /Pages 附近的 /Count；没有则数 /Type /Page。扫不到返回 null。
 */
export function countPdfPages(buf: Buffer): number | null {
  const text = buf.subarray(0, Math.min(buf.length, TEXT_SAMPLE_MAX)).toString('latin1');
  const counts: number[] = [];
  const re = /\/Type\s*\/Pages\b[^]{0,300}?\/Count\s+(\d+)/g;
  for (let match = re.exec(text); match; match = re.exec(text)) {
    const n = Number(match[1]);
    if (Number.isFinite(n)) counts.push(n);
  }
  if (counts.length) return Math.max(...counts);
  const pages = text.match(/\/Type\s*\/Page(?!s)\b/g);
  if (!pages?.length) return null;
  return pages.length;
}

export interface TextProbe {
  kind: 'text' | 'pdf' | 'binary';
  hasText: boolean;
  decoded: string;
}

export function probeContent(filePath: string, sample: Buffer, fullSize: number): TextProbe {
  const ext = extensionOf(filePath);
  if (ext === 'pdf') return { kind: 'pdf', hasText: true, decoded: '' };
  if (OFFICE_EXT.has(ext)) return { kind: 'binary', hasText: true, decoded: '' };
  if (BINARY_EXT.has(ext) || sample.includes(0)) return { kind: 'binary', hasText: false, decoded: '' };
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(sample);
    if (fullSize > TEXT_SAMPLE_MAX) return { kind: 'binary', hasText: true, decoded };
    return { kind: 'text', hasText: true, decoded };
  } catch {
    return { kind: 'binary', hasText: false, decoded: '' };
  }
}
