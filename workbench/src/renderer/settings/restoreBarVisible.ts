/**
 * 底部文件条是否显示。没有读到设置时按显示处理。本文件不碰 kb，恢复条测试不必有 window。
 */
export const RESTORE_BAR_VISIBLE_KEY = 'workspace.restoreBar.visible';

export const RESTORE_BAR_COMMAND = {
  id: 'workspace.restoreBar.toggle',
  title: '底部文件条（开/关）',
  category: '工作区',
} as const;

let visible = true;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

export function readRestoreBarVisible(): boolean {
  return visible;
}

export function subscribeRestoreBarVisible(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setRestoreBarVisible(next: boolean): void {
  visible = next;
  emit();
}

export function toggleRestoreBarVisible(): boolean {
  visible = !visible;
  emit();
  return visible;
}
