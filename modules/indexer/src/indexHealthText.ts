export type IndexEngine = 'kb-indexer' | 'local-fallback' | 'starting';

export const FALLBACK_INDEX_LABEL = '全文索引不可用 · 仅文件名/路径搜索';

export function indexStatusLabel(input: {
  engine: IndexEngine;
  contentSearch: boolean;
  scanned: number;
  indexed: number;
  state: 'scanning' | 'idle' | 'error';
  progress?: number;
  lastError?: string | null;
}): string {
  if (input.state === 'scanning') return `扫描中… ${input.progress ?? 0}`;
  if (input.state === 'error') return `错误：${input.lastError ?? ''}`;
  const counts = `已扫描 ${input.scanned} 个文件 · 正文索引 ${input.indexed} 个`;
  if (input.engine === 'kb-indexer' && input.contentSearch) return counts;
  return `${FALLBACK_INDEX_LABEL} · ${counts}`;
}
