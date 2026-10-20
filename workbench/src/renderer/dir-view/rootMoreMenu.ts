import { updateSidebarPrefs, type SidebarPrefs } from '../drawer/sidebarPrefs';

export interface RootMoreItem {
  id: string;
  label: string;
  onClick: () => void;
  testId?: string;
  checked?: boolean;
  /** 没有可恢复项时为 true。点击不再往下走。 */
  disabled?: boolean;
}

export const RESTORE_ALL_REMOVED_LABEL = '恢复全部已移除项';

/** 单个根的「⋯」里那一项。removedCount 是这一根的隐藏条数，不是磁盘上的文件数。 */
export function rootRestoreAllItem(removedCount: number, onRestoreAll: () => void): RootMoreItem {
  const disabled = removedCount <= 0;
  return {
    id: 'restore-all-removed',
    label: RESTORE_ALL_REMOVED_LABEL,
    testId: 'root-restore-all-removed',
    disabled,
    onClick: () => {
      if (disabled) return;
      onRestoreAll();
    },
  };
}

/** 每个根自己的「⋯」。和整段「根目录」菜单分开，只作用于传入的这一根。 */
export function rootRowMoreItems(removedCount: number, onRestoreAll: () => void): RootMoreItem[] {
  return [rootRestoreAllItem(removedCount, onRestoreAll)];
}

/** 根目录「⋯」菜单。拖出两项与「隐藏无法打开的文件」同为可勾选条目。 */
export function rootMoreMenuItems(
  prefs: SidebarPrefs,
  showIgnored: boolean,
  setShowIgnored: (on: boolean) => void,
  onHiddenItems?: () => void,
): RootMoreItem[] {
  return [
    {
      id: 'hide-unopenable',
      label: '隐藏无法打开的文件',
      checked: prefs.hideUnopenableFiles,
      testId: 'toggle-hide-unopenable',
      onClick: () => updateSidebarPrefs({ hideUnopenableFiles: !prefs.hideUnopenableFiles }),
    },
    {
      id: 'drag-out-file',
      label: '拖出为：文件',
      checked: prefs.dragOutMode !== 'path',
      testId: 'toggle-drag-out-file',
      onClick: () => updateSidebarPrefs({ dragOutMode: 'file' }),
    },
    {
      id: 'drag-out-path',
      label: '拖出为：路径',
      checked: prefs.dragOutMode === 'path',
      testId: 'toggle-drag-out-path',
      onClick: () => updateSidebarPrefs({ dragOutMode: 'path' }),
    },
    {
      id: 'show-ignored',
      label: showIgnored ? '隐藏被忽略的项' : '显示被忽略的项',
      testId: 'toggle-show-ignored-menu',
      onClick: () => setShowIgnored(!showIgnored),
    },
    {
      id: 'hidden-items',
      label: '已隐藏项…',
      testId: 'menu-hidden-items',
      onClick: () => onHiddenItems?.(),
    },
  ];
}
