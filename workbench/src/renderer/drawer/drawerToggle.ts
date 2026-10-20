import { SIDEBAR_ID } from '../panel-manager/types';
import { DRAWER_WIDTH_MIN, RIBBON_STRIP_WIDTH, clampDrawerWidth } from './order';
import { getSidebarPrefs, updateSidebarPrefs, type SidebarPrefs } from './sidebarPrefs';

export interface DrawerToggleTarget {
  isCollapsed(id: string): boolean;
  restoreFromBubble(id: string): void;
  collapseToBubble(id: string): void;
}

/**
 * 顶栏与 ribbon 顶部按钮共用的「内容是否展开」。
 * list 看内容面板（整栏仍停靠时 ribbon 竖条留着）；grid 看整栏是否停靠。
 */
export function drawerContentOpen(
  sidebarCollapsed: boolean,
  prefs: Pick<SidebarPrefs, 'categoriesLayout' | 'ribbonCollapsed'>,
): boolean {
  if (prefs.categoriesLayout === 'list') return !sidebarCollapsed && !prefs.ribbonCollapsed;
  return !sidebarCollapsed;
}

/**
 * 大于竖条的宽度才算内容宽。44px 及更窄的值是收起条，不能当成展开宽度记下来。
 * 不足抽屉最小内容宽（300）时视为没有可用宽度。
 */
export function usableListContentWidth(width: number | undefined): number | undefined {
  if (width == null || !Number.isFinite(width) || width <= RIBBON_STRIP_WIDTH) return undefined;
  if (width < DRAWER_WIDTH_MIN) return undefined;
  return clampDrawerWidth(width);
}

/**
 * list 内容面板的实际宽度。展开用收起前记住的宽度，没有则用当前壳层宽度，再没有用 300。
 * 收起固定为竖条宽。展开结果永远大于竖条，避免「状态已展开、宽度仍是 44」。
 */
export function resolveListDrawerWidth(contentOpen: boolean, remembered: number | undefined, fallback?: number): number {
  if (!contentOpen) return RIBBON_STRIP_WIDTH;
  return usableListContentWidth(fallback) ?? usableListContentWidth(remembered) ?? DRAWER_WIDTH_MIN;
}

/**
 * 顶栏 data-testid="drawer-toggle" 与 ribbon 顶部按钮共用。
 * list：只切换内容面板（ribbonCollapsed），不把整栏收成 0。侧栏若已整栏收起，先停靠回来并展开内容。
 * grid：切换整栏停靠/收起，不写 ribbonCollapsed。
 */
export function toggleDockedDrawer(panelManager: DrawerToggleTarget): void {
  const prefs = getSidebarPrefs();
  if (prefs.categoriesLayout === 'list') {
    if (panelManager.isCollapsed(SIDEBAR_ID)) {
      panelManager.restoreFromBubble(SIDEBAR_ID);
      updateSidebarPrefs({ ribbonCollapsed: false });
      return;
    }
    updateSidebarPrefs({ ribbonCollapsed: !prefs.ribbonCollapsed });
    return;
  }
  if (panelManager.isCollapsed(SIDEBAR_ID)) panelManager.restoreFromBubble(SIDEBAR_ID);
  else panelManager.collapseToBubble(SIDEBAR_ID);
}

/** 同一开合状态在两处的图标和文案。pressed 与 aria-pressed 都表示内容面板展开。 */
export function dockedDrawerChrome(open: boolean) {
  return {
    pressed: open,
    drawerLabel: open ? '收起资料抽屉' : '展开资料抽屉',
    ribbonLabel: open ? '收起侧栏' : '展开侧栏',
    icon: (open ? 'panel-left-close' : 'panel-left-open') as 'panel-left-close' | 'panel-left-open',
  };
}
