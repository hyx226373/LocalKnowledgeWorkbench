/** 打开中的文本编辑器登记保存和丢弃。关闭全部时按资源 id 调用，不直接写盘。 */
const savers = new Map<string, Map<symbol, () => Promise<boolean>>>();
const discards = new Map<string, Map<symbol, () => void>>();

function take<T>(map: Map<string, Map<symbol, T>>, resourceId: string): Map<symbol, T> {
  let found = map.get(resourceId);
  if (!found) {
    found = new Map();
    map.set(resourceId, found);
  }
  return found;
}

function drop<T>(map: Map<string, Map<symbol, T>>, resourceId: string, key: symbol) {
  const found = map.get(resourceId);
  if (!found?.delete(key)) return;
  if (!found.size) map.delete(resourceId);
}

export function registerEditorSaver(resourceId: string, key: symbol, save: () => Promise<boolean>): () => void {
  take(savers, resourceId).set(key, save);
  return () => drop(savers, resourceId, key);
}

export function registerEditorDiscard(resourceId: string, key: symbol, discard: () => void): () => void {
  take(discards, resourceId).set(key, discard);
  return () => drop(discards, resourceId, key);
}

/** 没有登记的保存函数时返回 false，调用方不得关掉这份稿。 */
export async function saveOpenEditor(resourceId: string): Promise<boolean> {
  const found = savers.get(resourceId);
  if (!found?.size) return false;
  for (const save of [...found.values()]) {
    try {
      if (!(await save())) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function discardOpenEditor(resourceId: string): void {
  const found = discards.get(resourceId);
  if (!found) return;
  for (const discard of [...found.values()]) {
    try { discard(); } catch { /* 一个面板丢弃失败时继续处理同文件的其他面板 */ }
  }
}
