/** 用已登记根的本机路径拼出文件绝对路径。不碰 node:path，渲染进程包里没有它。 */

export interface NativeDragRoot {
  id: string;
  path: string;
  kind: string;
}

let roots = new Map<string, NativeDragRoot>();

export function setNativeDragRootIndex(list: readonly NativeDragRoot[]): void {
  const next = new Map<string, NativeDragRoot>();
  for (const root of list) {
    if (root?.id && typeof root.path === 'string' && root.path.trim()) next.set(root.id, { ...root, path: root.path.trim() });
  }
  roots = next;
}

export function rootPathOf(id: string): NativeDragRoot | undefined {
  return roots.get(id);
}

export function toWindowsPath(p: string): string {
  let s = p.trim().replace(/\//g, '\\');
  if (!/^[a-zA-Z]:\\?$/.test(s)) {
    s = s.replace(/\\+$/, '');
  }
  return s;
}

/** 目录根拼接相对路径。单文件来源直接用根路径。`..` 与空相对路径（目录本身）不产生文件路径。 */
export function absPathFromRoot(rootPath: string, rootKind: string, relPath: string): string | null {
  const root = rootPath.trim();
  if (!root) return null;
  if (rootKind === 'file') return root;
  const rel = relPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!rel) return null;
  const parts = rel.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  const sep = root.includes('\\') ? '\\' : '/';
  const base = root.replace(/[\\/]+$/, '');
  return `${base}${sep}${parts.join(sep)}`;
}

/** 去掉末尾分隔符。裸盘符和单独的 `/` 保持原样。 */
function directoryRootPath(rootPath: string): string | null {
  const root = rootPath.trim();
  if (!root) return null;
  const stripped = root.replace(/[\\/]+$/, '');
  if (!stripped || /^[A-Za-z]:$/.test(stripped)) return root;
  return stripped;
}

/** 文件夹绝对路径。空相对路径是根目录本身。`..` 拒绝。 */
export function absDirFromRoot(rootPath: string, relPath: string): string | null {
  const root = rootPath.trim();
  if (!root) return null;
  const rel = relPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!rel) return directoryRootPath(root);
  return absPathFromRoot(root, 'folder', rel);
}

export function nativeFilePath(rootId: string, relPath: string, kind: string): string | null {
  if (kind !== 'file') return null;
  const root = rootPathOf(rootId);
  if (!root) return null;
  return absPathFromRoot(root.path, root.kind, relPath);
}

/** 目录节点的绝对路径。单文件来源不是目录。空相对路径是根目录本身。 */
export function nativeDirPath(rootId: string, relPath: string): string | null {
  const root = rootPathOf(rootId);
  if (!root || root.kind === 'file') return null;
  return absDirFromRoot(root.path, relPath);
}

/** 树节点拖出用的绝对路径。文件、根目录、子文件夹都能拼；虚拟节点不能。 */
export function nativeTreeDragPath(rootId: string, relPath: string, kind: string): string | null {
  if (kind === 'dir' || kind === 'folder') return nativeDirPath(rootId, relPath);
  if (kind === 'file') return nativeFilePath(rootId, relPath, 'file');
  return null;
}

/** 无论文件还是目录节点（含根目录），拼出其本地绝对路径 */
export function nativeNodePath(rootId: string, relPath: string, kind?: string): string | null {
  const root = rootPathOf(rootId);
  if (!root) return null;
  if (root.kind === 'file') return root.path;
  const cleanRel = (relPath ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!cleanRel || cleanRel === '.') return root.path;
  return absPathFromRoot(root.path, root.kind, cleanRel) ?? `${root.path.replace(/[\\/]+$/, '')}\\${cleanRel.split('/').join('\\')}`;
}

/** 文档标签：已有绝对路径优先。否则用阅读信息里的根和相对路径拼，拼不出再留给异步查询。 */
export function docTabNativePath(source: { absPath?: string; sourceId?: string | null; relPath?: string }): string | null {
  const abs = source.absPath?.trim();
  if (abs) return abs;
  const rootId = source.sourceId?.trim();
  if (!rootId) return null;
  return nativeFilePath(rootId, source.relPath ?? '', 'file');
}
