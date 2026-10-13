/**
 * 阅读器报告内容已画好时通知恢复条。不持久化。
 */
const ready = new Set<string>();
const listeners = new Map<string, Set<() => void>>();

export function markRestoreContentReady(panelId: string): void {
  if (!panelId || ready.has(panelId)) {
    if (panelId) ready.add(panelId);
    return;
  }
  ready.add(panelId);
  const set = listeners.get(panelId);
  if (!set) return;
  for (const fn of [...set]) fn();
}

export function subscribeRestoreContentReady(panelId: string, cb: () => void): () => void {
  if (ready.has(panelId)) cb();
  let set = listeners.get(panelId);
  if (!set) {
    set = new Set();
    listeners.set(panelId, set);
  }
  set.add(cb);
  return () => {
    set?.delete(cb);
    if (set && set.size === 0) listeners.delete(panelId);
  };
}

export function resetRestoreContentReady(): void {
  ready.clear();
  listeners.clear();
}
