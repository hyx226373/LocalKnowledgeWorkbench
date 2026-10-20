/**
 * 全文索引范围。存在 layout 键 settings.contentIndexScope。
 * 默认只索引阅读器认作文字的扩展名；pdf / Office 等需在设置里打开。
 * 单文件只准备前 maxBytes 字节（默认 1 MiB）。文件夹规则是根内相对路径前缀。
 */
import { readerTypeOf } from './types';

export const CONTENT_INDEX_SCOPE_KEY = 'settings.contentIndexScope';

/**
 * 正文索引总闸。false：不建实时正文索引、不写正文、content 搜索返回空，文件名仍走 resources_fts。
 * 旧键 settings.contentIndexScope、旧类型和解析函数都保留，宿主不再用它们驱动索引。改回 true 即可回退。
 */
export const CONTENT_BODY_INDEX_ENABLED = false;

/** 测试替身。生产路径读常量；单测可临时改成 true，测完传 undefined 恢复。 */
let contentBodyIndexOverride: boolean | undefined;

export function isContentBodyIndexEnabled(): boolean {
  return contentBodyIndexOverride ?? CONTENT_BODY_INDEX_ENABLED;
}

export function setContentBodyIndexEnabledForTests(value: boolean | undefined): void {
  contentBodyIndexOverride = value;
}

/** 正文搜索在索引不可用时的提示。不要把文件名结果当成正文结果。 */
export const CONTENT_SEARCH_UNAVAILABLE_NOTICE = '全文索引不可用，无法搜索正文';

/** 总闸关闭且没有真实后端故障时，文件名搜索是正常状态，不当成「全文索引坏了」。 */
export function contentSearchDegraded(health: { engine?: string; contentSearch?: boolean; reason?: string } | null | undefined): boolean {
  if (!health) return false;
  if (!isContentBodyIndexEnabled()) return health.engine === 'local-fallback' && !!health.reason;
  return health.engine === 'local-fallback' || (!health.contentSearch && health.engine !== 'starting');
}

export const DEFAULT_CONTENT_INDEX_MAX_BYTES = 1024 * 1024;

/** 防止手误把上限写成极大值，把全文库再次撑满。 */
export const MAX_CONTENT_INDEX_BYTES = DEFAULT_CONTENT_INDEX_MAX_BYTES;

export const OPTIONAL_CONTENT_TYPES: readonly { ext: string; label: string }[] = [
  { ext: 'pdf', label: 'PDF' },
  { ext: 'doc', label: 'Word（.doc）' },
  { ext: 'docx', label: 'Word（.docx）' },
  { ext: 'xls', label: 'Excel（.xls）' },
  { ext: 'xlsx', label: 'Excel（.xlsx）' },
  { ext: 'ppt', label: 'PowerPoint（.ppt）' },
  { ext: 'pptx', label: 'PowerPoint（.pptx）' },
];

const OPTIONAL_EXT = new Set(OPTIONAL_CONTENT_TYPES.map((item) => item.ext));

export interface ContentIndexScope {
  v: 1;
  /** 在默认文字类型之外勾选的扩展名，不含点。 */
  extraExtensions: string[];
  maxBytes: number;
  /** 非空时，只有落在这些前缀下的文件才索引。 */
  includePrefixes: string[];
  /** 始终排除。优先于包含。 */
  excludePrefixes: string[];
}

export interface ContentIndexDecision {
  index: boolean;
  /** 准备写入索引的字节数。不索引时为 0。未知大小时等于上限。 */
  bytes: number;
  maxBytes: number;
  reason?: 'extension' | 'excluded' | 'not-included';
}

export function defaultContentIndexScope(): ContentIndexScope {
  return {
    v: 1,
    extraExtensions: [],
    maxBytes: DEFAULT_CONTENT_INDEX_MAX_BYTES,
    includePrefixes: [],
    excludePrefixes: [],
  };
}

export function isDefaultTextExtension(ext: string): boolean {
  const clean = ext.replace(/^\./, '').toLowerCase();
  const kind = readerTypeOf(clean, 'file');
  return kind === 'text' || kind === 'markdown';
}

export function clampContentIndexMaxBytes(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value.trim()) : Number.NaN;
  if (!Number.isFinite(n)) return DEFAULT_CONTENT_INDEX_MAX_BYTES;
  const rounded = Math.floor(n);
  if (rounded < 1) return DEFAULT_CONTENT_INDEX_MAX_BYTES;
  return Math.min(rounded, MAX_CONTENT_INDEX_BYTES);
}

/** 含 `..`、盘符或绝对路径的前缀丢掉，避免写进 layout。 */
export function normalizeFolderPrefix(raw: string): string | null {
  const text = String(raw ?? '').trim().replace(/\\/g, '/');
  if (!text || text === '.') return null;
  if (/^[a-zA-Z]:/.test(text) || text.startsWith('/') || text.startsWith('~')) return null;
  if (text.split('/').some((part) => part === '..')) return null;
  const parts = text.split('/').filter((part) => part && part !== '.');
  if (!parts.length) return null;
  return parts.join('/');
}

export function parsePrefixList(value: unknown): string[] {
  const lines = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\r?\n/) : [];
  const out: string[] = [];
  for (const line of lines) {
    if (typeof line !== 'string') continue;
    const norm = normalizeFolderPrefix(line);
    if (!norm || out.includes(norm)) continue;
    out.push(norm);
  }
  return out;
}

export function parseContentIndexScope(raw: unknown): ContentIndexScope {
  const base = defaultContentIndexScope();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const record = raw as Record<string, unknown>;
  if (record.v !== undefined && record.v !== 1) return base;
  const extraExtensions: string[] = [];
  if (Array.isArray(record.extraExtensions)) {
    for (const item of record.extraExtensions) {
      if (typeof item !== 'string') continue;
      const ext = item.trim().replace(/^\./, '').toLowerCase();
      if (!OPTIONAL_EXT.has(ext) || extraExtensions.includes(ext)) continue;
      extraExtensions.push(ext);
    }
  }
  return {
    v: 1,
    extraExtensions,
    maxBytes: clampContentIndexMaxBytes(record.maxBytes),
    includePrefixes: parsePrefixList(record.includePrefixes),
    excludePrefixes: parsePrefixList(record.excludePrefixes),
  };
}

export function readContentIndexScope(getLayout: (key: string) => unknown): ContentIndexScope {
  try {
    return parseContentIndexScope(getLayout(CONTENT_INDEX_SCOPE_KEY));
  } catch {
    return parseContentIndexScope(null);
  }
}

export function extensionOfRel(relPath: string): string {
  const base = String(relPath ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

export function contentExtensionAllowed(ext: string, scope: ContentIndexScope): boolean {
  const clean = ext.replace(/^\./, '').toLowerCase();
  if (isDefaultTextExtension(clean)) return true;
  return scope.extraExtensions.includes(clean);
}

export function folderPrefixMatches(relPath: string, prefix: string): boolean {
  const rel = String(relPath ?? '').replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
  const pre = String(prefix ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
  if (!pre) return false;
  return rel === pre || rel.startsWith(`${pre}/`);
}

export function truncatedIndexBytes(size: number, maxBytes: number): number {
  const cap = clampContentIndexMaxBytes(maxBytes);
  if (!Number.isFinite(size) || size <= 0) return 0;
  return Math.min(Math.floor(size), cap);
}

export function decideContentIndex(relPath: string, scope: ContentIndexScope, size?: number): ContentIndexDecision {
  const maxBytes = scope.maxBytes;
  if (!contentExtensionAllowed(extensionOfRel(relPath), scope)) {
    return { index: false, bytes: 0, maxBytes, reason: 'extension' };
  }
  if (scope.excludePrefixes.some((prefix) => folderPrefixMatches(relPath, prefix))) {
    return { index: false, bytes: 0, maxBytes, reason: 'excluded' };
  }
  if (scope.includePrefixes.length > 0 && !scope.includePrefixes.some((prefix) => folderPrefixMatches(relPath, prefix))) {
    return { index: false, bytes: 0, maxBytes, reason: 'not-included' };
  }
  const bytes = size == null ? maxBytes : truncatedIndexBytes(size, maxBytes);
  return { index: true, bytes, maxBytes };
}
