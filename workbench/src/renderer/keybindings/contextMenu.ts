/**
 * 面板标签栏 / 资料行右键「设置快捷键…」：打开设置页并定位到相关命令。
 */
import { openKeybindingsPage } from './runtime';

export type KeybindContextKind = 'panel-tab' | 'tree-row' | 'workspace-ref' | 'unknown';

/** 根据右键上下文推断最相关命令 id */
export function inferCommandForContext(kind: KeybindContextKind, detail?: { isFile?: boolean; isWeb?: boolean; panelId?: string }): string {
  if (kind === 'panel-tab') return 'panel.close';
  if (kind === 'tree-row') {
    if (detail?.isWeb) return 'web.openUrl';
    return 'workbench.openResource';
  }
  if (kind === 'workspace-ref') return 'workbench.openResource';
  return 'keybindings.open';
}

export function openSetKeybindingFor(kind: KeybindContextKind, detail?: { isFile?: boolean; isWeb?: boolean }) {
  const id = inferCommandForContext(kind, detail);
  openKeybindingsPage(id);
}

/** 右键菜单项文案 */
export const SET_KEYBINDING_LABEL = '设置快捷键…';
