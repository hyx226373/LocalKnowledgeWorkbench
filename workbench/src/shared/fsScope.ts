import type { FsChangeEvent } from './types';

export function parentRel(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

/** 这条变化是否落在正在显示的这一层目录上。空相对路径表示整根，仍要刷新。 */
export function affectsDir(rootId: string, dirRel: string, event: Pick<FsChangeEvent, 'rootId' | 'relPath'>): boolean {
  if (event.rootId !== rootId) return false;
  if (event.relPath === '') return true;
  if (event.relPath === dirRel) return true;
  if (parentRel(event.relPath) === dirRel) return true;
  return dirRel.startsWith(event.relPath + '/');
}

export function dirRefreshKey(rootId: string, dirRel: string, epoch: number, events: readonly FsChangeEvent[]): string {
  if (!events.some((event) => affectsDir(rootId, dirRel, event))) return `${rootId}|${dirRel}|0`;
  return `${rootId}|${dirRel}|${epoch}`;
}
