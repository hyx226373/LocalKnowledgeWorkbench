import type { BackupRecord } from './types';

/** 保留最近 keep 份，按创建时间从新到旧。 */
export function rotateBackups(existing: readonly BackupRecord[], next: BackupRecord, keep = 3): { keep: BackupRecord[]; remove: BackupRecord[] } {
  const all = [...existing.filter((item) => item.id !== next.id), next];
  all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1));
  return { keep: all.slice(0, keep), remove: all.slice(keep) };
}
