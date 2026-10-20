/** 目录树磁盘删除与「从根目录移除」。确认框在调用方弹，这里不碰文件系统。 */

export const TRASH_MENU_ID = 'tree.trashDisk';
export const HIDE_MENU_ID = 'tree.hideFromRoot';
export const TRASH_SEP_ID = 'tree.trashSep';

export const HIDE_MENU_LABEL = '从根目录移除（不删除磁盘文件）';
export const TRASH_MENU_LABEL = '移到回收站';

export interface DiskMenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
  run: () => void;
}

export interface ConfirmSpec {
  title: string;
  body: string;
  ok: string;
  danger: true;
}

export function isPaletteDirectDelete(id: string): boolean {
  return id === 'disk.trash';
}

export function paletteSourceActions<T extends { actionId?: string }>(actions: readonly T[]): T[] {
  return actions.filter((action) => !isPaletteDirectDelete(action.actionId ?? ''));
}

export function trashConfirmSpec(absPath: string): ConfirmSpec {
  return {
    title: '移到回收站？',
    body: `将把「${absPath}」移到回收站。`,
    ok: '移到回收站',
    danger: true,
  };
}

export function hideConfirmSpec(absPath: string): ConfirmSpec {
  return {
    title: '从根目录移除？',
    body: `「${absPath}」将不再显示、不再索引。不删除磁盘文件。`,
    ok: '从根目录移除',
    danger: true,
  };
}

export async function runConfirmedAction(
  confirm: (spec: ConfirmSpec) => Promise<boolean>,
  spec: ConfirmSpec,
  act: () => Promise<unknown>,
): Promise<'cancelled' | 'done'> {
  const ok = await confirm(spec);
  if (!ok) return 'cancelled';
  await act();
  return 'done';
}

export type TreeKeyIntent = 'open' | 'hide-from-root' | 'ignore';

function normalizeTreeKey(key: string): string {
  if (key === 'Delete' || key === 'Del') return 'Delete';
  return key;
}

/** Delete 只打开「从根目录移除」。空路径（根行）无动作。不会产生回收站意图。 */
export function treeKeyIntent(key: string, relPath: string): TreeKeyIntent {
  const name = normalizeTreeKey(key);
  if (name === 'Enter') return 'open';
  if (name === 'Delete') return relPath ? 'hide-from-root' : 'ignore';
  return 'ignore';
}

export function dispatchTreeKey(
  key: string,
  relPath: string,
  handlers: { open: () => void; hideFromRoot: () => void },
): TreeKeyIntent {
  const intent = treeKeyIntent(key, relPath);
  if (intent === 'open') handlers.open();
  else if (intent === 'hide-from-root') handlers.hideFromRoot();
  return intent;
}

export function appendRootDiskItems(
  items: DiskMenuItem[],
  o: { showHide: boolean; showTrash: boolean; onHide?: () => void; onTrash?: () => void },
): void {
  if (o.showHide) {
    items.push({
      id: HIDE_MENU_ID,
      label: HIDE_MENU_LABEL,
      danger: true,
      run: () => o.onHide?.(),
    });
  }
  if (!o.showTrash) return;
  items.push({
    id: TRASH_SEP_ID,
    label: '',
    separator: true,
    run: () => undefined,
  });
  items.push({
    id: TRASH_MENU_ID,
    label: TRASH_MENU_LABEL,
    danger: true,
    run: () => o.onTrash?.(),
  });
}
