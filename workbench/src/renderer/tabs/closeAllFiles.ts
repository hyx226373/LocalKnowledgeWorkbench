/**
 * 关闭阅读区全部打开的标签。
 * 有未保存修改时必须先问：保存 / 不保存 / 取消。取消则一个都不关。
 */
import { emptyStore, findConflict } from '../keybindings/store';
import { isReservedKey } from '../keybindings/reserved';
import type { KeybindingWhen, KeybindingsStoreV1 } from '../keybindings/types';

export const CLOSE_ALL_FILES_ID = 'tabs.closeAll';
export const CLOSE_ALL_FILES_TITLE = '关闭全部已打开文件';
export const CLOSE_ALL_FILES_KEY = 'Ctrl+Shift+W';

export interface CloseAllKeyCommand {
  id: string;
  title: string;
  keybinding?: string;
  when?: KeybindingWhen;
  trigger?: 'key' | 'wheel';
}

/** 与现有命令或保留键冲突时不绑默认键，命令仍留在命令面板。 */
export function closeAllFilesKeybinding(
  commands: readonly CloseAllKeyCommand[],
  store: KeybindingsStoreV1 = emptyStore(),
): string | undefined {
  if (isReservedKey(CLOSE_ALL_FILES_KEY)) return undefined;
  const other = findConflict(store, [...commands], CLOSE_ALL_FILES_ID, CLOSE_ALL_FILES_KEY, 'global');
  if (other) return undefined;
  return CLOSE_ALL_FILES_KEY;
}

export type CloseAllChoice = 'save' | 'discard' | 'cancel';

export interface OpenFileTab {
  panelId: string;
  title: string;
  resourceId: string | null;
  dirty: boolean;
}

export interface CloseAllResult {
  /** clean：没有未保存，直接关。 */
  choice: CloseAllChoice | 'clean';
  closed: string[];
  saved: string[];
  discarded: string[];
}

export async function runCloseAll(
  tabs: readonly OpenFileTab[],
  deps: {
    ask(dirty: readonly OpenFileTab[]): Promise<CloseAllChoice>;
    save(resourceId: string): Promise<boolean>;
    discard(resourceId: string): void | Promise<void>;
    close(tab: OpenFileTab): void;
  },
): Promise<CloseAllResult> {
  const dirty = tabs.filter((tab) => tab.dirty && tab.resourceId);
  const dirtyIds = [...new Set(dirty.map((tab) => tab.resourceId).filter((id): id is string => !!id))];
  if (!dirtyIds.length) {
    for (const tab of tabs) deps.close(tab);
    return { choice: 'clean', closed: tabs.map((tab) => tab.panelId), saved: [], discarded: [] };
  }
  const choice = await deps.ask(dirty);
  if (choice === 'cancel') return { choice, closed: [], saved: [], discarded: [] };
  if (choice === 'save') {
    const saved: string[] = [];
    for (const id of dirtyIds) {
      const ok = await deps.save(id);
      if (!ok) return { choice, closed: [], saved, discarded: [] };
      saved.push(id);
    }
    for (const tab of tabs) deps.close(tab);
    return { choice, closed: tabs.map((tab) => tab.panelId), saved, discarded: [] };
  }
  for (const id of dirtyIds) await deps.discard(id);
  for (const tab of tabs) deps.close(tab);
  return { choice: 'discard', closed: tabs.map((tab) => tab.panelId), saved: [], discarded: dirtyIds };
}

export function collectOpenFileTabs(
  panels: readonly { id: string; title?: string; params?: { itemId?: string } }[],
  items: Readonly<Record<string, { sourceKind?: string; ref?: string; title?: string } | undefined>>,
  isDirty: (resourceId: string) => boolean,
): OpenFileTab[] {
  const out: OpenFileTab[] = [];
  for (const panel of panels) {
    if (panel.id === 'kb.sidebar') continue;
    const itemId = panel.params?.itemId || panel.id;
    const item = items[itemId];
    const resourceId = item?.sourceKind === 'file' && item.ref ? item.ref : null;
    out.push({
      panelId: panel.id,
      title: panel.title || item?.title || resourceId || panel.id,
      resourceId,
      dirty: !!(resourceId && isDirty(resourceId)),
    });
  }
  return out;
}
