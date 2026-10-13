/**
 * 快速切换的渲染状态。搜索词和选中项只留在这次打开里，关闭即弃。
 */
import { overviewMatchesQuery } from '../../shared/workspacePicker/overview';
import { TEMPORARY_WORKSPACE_ID } from './mount';

export interface QuickSwitchEntry {
  id: string;
  name: string;
  purpose: string;
  tags: readonly string[];
}

export interface QuickSwitchUi {
  query: string;
  selectedIndex: number;
}

type EntrySource = {
  temporary?: boolean;
  summary: { id: string; name: string; purpose: string; tags: readonly string[] };
};

export function quickSwitchEntries(entries: readonly EntrySource[]): QuickSwitchEntry[] {
  const out: QuickSwitchEntry[] = [];
  for (const entry of entries) {
    if (entry.temporary === true) continue;
    if (entry.summary.id === TEMPORARY_WORKSPACE_ID) continue;
    out.push({
      id: entry.summary.id,
      name: entry.summary.name,
      purpose: entry.summary.purpose,
      tags: entry.summary.tags,
    });
  }
  return out;
}

export function filterQuickSwitch(entries: readonly QuickSwitchEntry[], query: string): QuickSwitchEntry[] {
  return entries.filter((entry) => overviewMatchesQuery({ name: entry.name, purpose: entry.purpose, tags: [...entry.tags] }, query));
}

export function initialQuickSwitchUi(entries: readonly QuickSwitchEntry[], currentId: string | null): QuickSwitchUi {
  const index = currentId ? entries.findIndex((entry) => entry.id === currentId) : -1;
  return { query: '', selectedIndex: index >= 0 ? index : 0 };
}

export function clampQuickSwitchIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  const value = Math.trunc(index);
  if (!Number.isFinite(value) || value < 0) return 0;
  if (value >= count) return count - 1;
  return value;
}

export function quickSwitchQuery(ui: QuickSwitchUi, query: string): QuickSwitchUi {
  return { query, selectedIndex: 0 };
}

export function quickSwitchKeyIntent(key: string): { type: 'move'; delta: number } | { type: 'enter' } | { type: 'escape' } | null {
  if (key === 'ArrowUp' || key === 'ArrowLeft') return { type: 'move', delta: -1 };
  if (key === 'ArrowDown' || key === 'ArrowRight') return { type: 'move', delta: 1 };
  if (key === 'Enter') return { type: 'enter' };
  if (key === 'Escape') return { type: 'escape' };
  return null;
}

/** Esc 只关闭。Enter 走进入回调，不在这里关闭。方向键只改选中。 */
export function reduceQuickSwitchKey(input: {
  ui: QuickSwitchUi;
  entries: readonly QuickSwitchEntry[];
  key: string;
  onEnter?: (id: string) => void;
  onClose?: () => void;
}): QuickSwitchUi {
  const visible = filterQuickSwitch(input.entries, input.ui.query);
  const intent = quickSwitchKeyIntent(input.key);
  if (!intent) return input.ui;
  if (intent.type === 'escape') {
    input.onClose?.();
    return input.ui;
  }
  if (intent.type === 'enter') {
    if (visible.length === 0) return input.ui;
    const index = clampQuickSwitchIndex(input.ui.selectedIndex, visible.length);
    const id = visible[index]?.id;
    if (id) input.onEnter?.(id);
    return input.ui;
  }
  if (visible.length === 0) return input.ui;
  const current = clampQuickSwitchIndex(input.ui.selectedIndex, visible.length);
  const next = (current + intent.delta + visible.length) % visible.length;
  return { ...input.ui, selectedIndex: next };
}