/**
 * 外链标签不写入工作区布局。关掉应用再打开时不恢复这些临时页。
 */
import { pruneDock, type SerializedDock } from '../../shared/items';

/** dockview 组件 id。面板 id 用 extbrowse- 前缀，params 里不放 itemId。 */
export const EXTERNAL_BROWSE_COMPONENT = 'external-browse';

export function isExternalBrowsePanelId(id: string): boolean {
  return id.startsWith('extbrowse-');
}

export function omitExternalBrowsePanels(dock: SerializedDock | null): SerializedDock | null {
  if (!dock?.panels) return dock;
  if (!Object.keys(dock.panels).some((id) => isExternalBrowsePanelId(id))) return dock;
  return pruneDock(dock, (itemId) => !isExternalBrowsePanelId(itemId));
}
