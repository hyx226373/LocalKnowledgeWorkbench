/**
 * desk-r1 命令 id（01 §7）。只登记命令，不重写快捷键引擎。
 */
export const DESKTOP_PANEL_COMMANDS = {
  open: 'desktopPanel.open',
  enterDesktopOp: 'desktopPanel.enterDesktopOp',
  exitDesktopOp: 'desktopPanel.exitDesktopOp',
  openLocalInput: 'desktopPanel.openLocalInput',
  submitLocalText: 'desktopPanel.submitLocalText',
  sendEnter: 'desktopPanel.sendEnter',
  toggleBubble: 'desktopPanel.toggleBubble',
  pickSource: 'desktopPanel.pickSource',
} as const;

export type DesktopPanelCommandId = (typeof DESKTOP_PANEL_COMMANDS)[keyof typeof DESKTOP_PANEL_COMMANDS];

export const DESKTOP_PANEL_COMMAND_META: Array<{
  id: DesktopPanelCommandId;
  title: string;
  category: string;
  keybinding?: string;
}> = [
  { id: DESKTOP_PANEL_COMMANDS.open, title: '打开桌面面板', category: '桌面面板' },
  { id: DESKTOP_PANEL_COMMANDS.enterDesktopOp, title: '进入桌面操作', category: '桌面面板', keybinding: 'F6' },
  { id: DESKTOP_PANEL_COMMANDS.exitDesktopOp, title: '退出桌面操作', category: '桌面面板', keybinding: 'Escape' },
  { id: DESKTOP_PANEL_COMMANDS.openLocalInput, title: '打开本地输入框', category: '桌面面板' },
  { id: DESKTOP_PANEL_COMMANDS.submitLocalText, title: '提交本地文字', category: '桌面面板', keybinding: 'Ctrl+Enter' },
  { id: DESKTOP_PANEL_COMMANDS.sendEnter, title: '向目标发送 Enter', category: '桌面面板' },
  { id: DESKTOP_PANEL_COMMANDS.toggleBubble, title: '气泡收起/恢复', category: '桌面面板' },
  { id: DESKTOP_PANEL_COMMANDS.pickSource, title: '选择捕获源', category: '桌面面板' },
];

export const DESKTOP_PANEL_ADAPTER_ID = 'desktop-panel';
export const DESKTOP_PANEL_VIEW_TYPE = 'desktop-panel';
/** 合成 app 条目 ref（sanitizeItem 允许 [\w.:-]） */
export const DESKTOP_PANEL_REF = 'desktop-panel.main';
