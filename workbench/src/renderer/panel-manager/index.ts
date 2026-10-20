/** 统一面板管理层（docs/11-自由窗口布局.md）。App 只需：attach(api)、SidebarSlot、SidebarPanel、PanelHeaderActions、BubbleTray、保存/恢复时的 serialize/restoreLayout。 */
import './panel-manager.css';
export { panelManager } from './instance';
export { PanelManager, SNAP_DISTANCE, type PanelManagerHost } from './PanelManager';
export { hideDockedTabs, showDocumentTabs } from './tabVisibility';
export { BubbleTray, DragShield, PanelHeaderActions, SidebarPanel, SidebarSlot, WindowButtons, usePanelManagerVersion } from './react';
export { FloatResizeGrips } from './resizeGrip';
export { migratePanelLayout, defaultPanelLayout, finalizePanelLayout } from './serialize';
export { rescueBox, snapBox, maximizedBox, cascadeBox, resizeDelta, MIN_FLOAT, PREVIEW_MIN_FLOAT } from './geometry';
export { coveringWindows, dragShieldActive } from './webOcclusion';
export * from './types';
export * from './viewContract';
