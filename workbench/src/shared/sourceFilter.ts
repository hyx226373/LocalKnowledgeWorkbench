/**
 * 文件夹来源的 extensions 是访问范围。空数组不限制扩展名。
 * 比较时小写、不带点。目录节点始终通过。单文件来源的那一条资料（rel_path 为空）始终通过。
 * 范围外统一文案是「不在访问范围」。DEFAULT_IGNORES 仍由索引单独生效。
 */

export const OUT_OF_SCOPE_MESSAGE = '不在访问范围';

export class OutOfScopeError extends Error {
  constructor(message = OUT_OF_SCOPE_MESSAGE) {
    super(message);
    this.name = 'OutOfScopeError';
  }
}

export interface AccessScope {
  /** folder = 文件夹来源；file = 单文件来源。 */
  sourceKind: 'folder' | 'file';
  /** 空数组表示不限制扩展名。元素可带点、可大小写，比较前会规范化。 */
  extensions: readonly string[];
}

export interface ScopeTarget {
  kind: 'file' | 'dir';
  /** 来源内相对路径。单文件来源的那一条是空字符串。 */
  relPath: string;
  /** 扩展名。可带点、可大小写；目录可省略。 */
  ext?: string;
  /** resources.out_of_scope = 1。目录与单文件来源的那一条资料不因该标记被排除。 */
  outOfScope?: boolean | number | null;
}

/** 去掉空白和前导点，再小写。空串表示没有扩展名。 */
export function normalizeExtension(raw: string): string {
  return raw.trim().toLowerCase().replace(/^\.+/, '');
}

/** 从文件名取扩展名（小写、不带点）。目录名或无点的名字得到空串。 */
export function extensionOfName(name: string): string {
  const base = name.split('/').pop() ?? name;
  const i = base.lastIndexOf('.');
  if (i <= 0) return '';
  return normalizeExtension(base.slice(i + 1));
}

/** 规范化扩展名列表。空、非法项被丢掉；结果为空表示不限制。 */
export function normalizeExtensions(extensions: readonly string[] | null | undefined): string[] {
  if (!extensions || extensions.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of extensions) {
    if (typeof item !== 'string') continue;
    const ext = normalizeExtension(item);
    if (!ext || seen.has(ext)) continue;
    seen.add(ext);
    out.push(ext);
  }
  return out;
}

/** 解析 roots.filter_json。缺失或损坏时当作不限制扩展名。 */
export function extensionsFromFilterJson(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as { extensions?: unknown };
    if (!v || typeof v !== 'object' || !Array.isArray(v.extensions)) return [];
    return normalizeExtensions(v.extensions.filter((x): x is string => typeof x === 'string'));
  } catch {
    return [];
  }
}

/**
 * 资料是否在访问范围内。
 * 单文件来源的空相对路径文件、以及任何目录节点，始终通过。
 * 其余文件：out_of_scope 为真则不通过；extensions 为空则通过；否则扩展名必须在列表里。
 */
export function inAccessScope(scope: AccessScope, target: ScopeTarget): boolean {
  if (scope.sourceKind === 'file' && target.kind === 'file' && target.relPath === '') return true;
  if (target.kind === 'dir') return true;
  if (target.outOfScope) return false;
  const extensions = normalizeExtensions(scope.extensions);
  if (extensions.length === 0) return true;
  return extensions.includes(normalizeExtension(target.ext ?? ''));
}

export function assertInAccessScope(scope: AccessScope, target: ScopeTarget): void {
  if (!inAccessScope(scope, target)) throw new OutOfScopeError();
}
