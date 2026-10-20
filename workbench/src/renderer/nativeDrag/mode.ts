/**
 * 拖出模式。文件：dragstart 里 preventDefault 后异步 startDrag，不写 dataTransfer。
 * 路径：把绝对路径写入 text/plain，不发 IPC、不调用 startDrag。
 * 多选时每行一个路径。这里不碰偏好和 IPC，方便单测。
 */
import type { DragOutMode } from '../drawer/sidebarPrefs';

export type { DragOutMode };

export function normalizeDragOutMode(value: unknown): DragOutMode {
  return value === 'path' ? 'path' : 'file';
}

/** 去掉空白和重复。保持调用方给出的顺序。 */
export function dragOutPlainText(paths: readonly string[]): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const item of paths) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    lines.push(trimmed);
  }
  return lines.join('\n');
}

export interface FileDragOutPlan {
  mode: DragOutMode;
  paths: string[];
  /** 路径模式要覆盖 text/plain。文件模式不改应用内已经写入的类型。 */
  textPlain: string | null;
  arm: boolean;
}

export function planFileDragOut(mode: unknown, paths: readonly string[]): FileDragOutPlan {
  const normalized = normalizeDragOutMode(mode);
  const text = dragOutPlainText(paths);
  const list = text ? text.split('\n') : [];
  if (!list.length) return { mode: normalized, paths: [], textPlain: null, arm: false };
  if (normalized === 'path') return { mode: 'path', paths: list, textPlain: text, arm: false };
  return { mode: 'file', paths: list, textPlain: null, arm: true };
}

export interface DragOutTransfer {
  setData(type: string, value: string): void;
}

export function applyFileDragOut(
  transfer: DragOutTransfer | null,
  paths: readonly string[],
  mode: unknown,
  effects: {
    armNative(paths: readonly string[]): void;
    notePath(paths: readonly string[]): void;
  },
): FileDragOutPlan {
  const plan = planFileDragOut(mode, paths);
  if (!plan.paths.length) return plan;
  if (plan.mode === 'path') {
    if (plan.textPlain) {
      try { transfer?.setData('text/plain', plan.textPlain); } catch { /* dragstart 之外 dataTransfer 可能拒绝写入 */ }
    }
    effects.notePath(plan.paths);
    return plan;
  }
  effects.armNative(plan.paths);
  return plan;
}


