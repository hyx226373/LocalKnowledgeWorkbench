/** 停靠标签条开关。壳层命令 `workbench.showDocumentTabs` 应调用 showDocumentTabs。 */
import { panelManager } from './instance';

/** 只藏停靠组的标签条。不关闭面板，不改活动项，浮动窗口仍保留标题。 */
export function hideDockedTabs(): void {
  panelManager.hideDockedTabs();
}

/** 显示停靠组的文档标签。 */
export function showDocumentTabs(): void {
  panelManager.showDocumentTabs();
}
