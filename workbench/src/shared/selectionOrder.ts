/**
 * 历史摘录的注入顺序。
 * 未手动拖动时：同一文件按段号（解析顺序），跨文件按对话开始时间从早到晚。
 */
export interface SelectionSortFile {
  file: string;
  started?: string;
  blockIds?: readonly string[];
}

export function blockPosition(blockId: string, blockIds?: readonly string[]): number {
  if (blockIds && blockIds.length) {
    const at = blockIds.indexOf(blockId);
    if (at >= 0) return at;
  }
  const matched = /^([UA])(\d+)$/.exec(blockId);
  if (!matched) return Number.MAX_SAFE_INTEGER;
  const n = Number(matched[2]);
  const role = matched[1] === 'U' ? 0 : 1;
  return n * 2 + role;
}

function startedMs(value: string | undefined): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
}

export function sortSelectionByConversation<T extends { file: string; blockId: string }>(
  items: readonly T[],
  files: readonly SelectionSortFile[],
): Array<T & { order: number }> {
  const byFile = new Map(files.map((row) => [row.file, row]));
  const sorted = [...items].sort((a, b) => {
    const at = startedMs(byFile.get(a.file)?.started);
    const bt = startedMs(byFile.get(b.file)?.started);
    if (at !== bt) return at - bt;
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    const ai = blockPosition(a.blockId, byFile.get(a.file)?.blockIds);
    const bi = blockPosition(b.blockId, byFile.get(b.file)?.blockIds);
    if (ai !== bi) return ai - bi;
    return a.blockId.localeCompare(b.blockId);
  });
  return sorted.map((item, order) => ({ ...item, order }));
}
