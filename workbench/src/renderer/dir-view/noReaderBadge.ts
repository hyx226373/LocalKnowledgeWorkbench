import { adapters } from '../plugin-host/registry';
import type { ResourceInfo } from '../../shared/types';

export interface ReaderBadgeEntry {
  reader?: string;
  ext?: string;
  missing?: boolean;
  sourceKind?: string;
}

function fileTarget(ext: string): { sourceKind: 'file'; resource: ResourceInfo } {
  const name = ext ? `f.${ext}` : 'f';
  return {
    sourceKind: 'file',
    resource: {
      resourceId: 'badge',
      rootId: '',
      relPath: name,
      name,
      kind: 'file',
      size: 0,
      mtimeMs: 0,
      ext,
      exists: true,
      readerType: 'unsupported',
    },
  };
}

/**
 * 主进程仍用 readerTypeOf 标 unsupported。这里再问适配器表：
 * 最佳适配器不是 builtin.unsupported 时，不画「暂无阅读器」。
 */
export function showNoReaderBadge(entry: ReaderBadgeEntry): boolean {
  if (entry.missing || entry.reader !== 'unsupported') return false;
  if (entry.sourceKind === 'web') return true;
  const ext = (entry.ext ?? '').toLowerCase().replace(/^\./, '');
  const best = adapters.best(fileTarget(ext));
  return !best || best.id === 'builtin.unsupported';
}
