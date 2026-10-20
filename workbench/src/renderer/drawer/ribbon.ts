import { type DrawerModuleId, normalizeDrawerSelection, toggleDrawerSelection } from './order';

/**
 * 选择变化只走网格大图标的 toggleDrawerSelection。
 * 窄栏收起时这一下是显示：勾选函数若会拿掉被点的项，则保留它并展开。
 * 内容已展开时，再点当前项或其它项都只切换这一块，不把内容面板收成窄条。
 * 全部隐藏后选择为空，侧栏保持展开。
 */
export function ribbonClick(selection: readonly DrawerModuleId[], _active: DrawerModuleId | null, collapsed: boolean, id: DrawerModuleId) {
  const toggled = toggleDrawerSelection(selection, id);
  const visible = collapsed && !toggled.includes(id) ? normalizeDrawerSelection(selection) : toggled;
  return { selection: visible, active: id, collapsed: false };
}

export function ribbonActive(active: DrawerModuleId | null, available: readonly DrawerModuleId[]): DrawerModuleId | null {
  return active && available.includes(active) ? active : null;
}
