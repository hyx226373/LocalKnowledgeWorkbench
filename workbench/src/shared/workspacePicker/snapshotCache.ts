/**
 * 总览快照缓存的文件名规划。只由工作区 id 推导相对文件名，不扫描磁盘。
 */
import { normalizeCoverRef } from './normalize';

function tokenOf(workspaceId: string): string | null {
  const trimmed = workspaceId.trim();
  if (!trimmed) return null;
  let token = '';
  for (const ch of trimmed) {
    if (/[A-Za-z0-9_-]/.test(ch)) token += ch;
    else if (ch === '.') token += '.';
    else {
      const cp = ch.codePointAt(0);
      if (cp == null) return null;
      token += `u${cp.toString(16)}`;
    }
  }
  if (!token || token === '.' || token === '..' || token.includes('..') || token.startsWith('.')) return null;
  return token;
}

/** 相对文件名。无法变成合法封面文件名时返回 null。 */
export function snapshotCacheFileName(workspaceId: string): string | null {
  if (typeof workspaceId !== 'string') return null;
  const token = tokenOf(workspaceId);
  if (!token) return null;
  return normalizeCoverRef(`snap-${token}.png`);
}

/**
 * 清除计划：返回要删的相对文件名。不读目录、不删除文件。
 * 重复 id 只出现一次。
 */
export function planSnapshotCacheDelete(workspaceIds: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const list = Array.isArray(workspaceIds) ? workspaceIds : [];
  for (const id of list) {
    if (typeof id !== 'string') continue;
    const name = snapshotCacheFileName(id);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}
