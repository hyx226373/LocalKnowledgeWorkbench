/**
 * 可编辑区右键菜单。
 *
 * 主进程只在 webContents `context-menu` 且 `params.isEditable` 时弹出。
 * 预览标红、目录树、标签都在不可编辑节点上，并且已经 preventDefault。
 * 渲染进程若已经 preventDefault，会经 `kb:context-menu-handled` 同步打标；
 * 同一手势里主进程看到标记就不再弹。标记只活到这次菜单事件或当前回合结束，避免误伤下一次右键。
 *
 * 编辑器是受控 textarea，不是 CodeMirror。菜单 role undo/redo 走 webContents.undo/redo。
 * Chromium 对 textarea、input、contenteditable 会先派发 beforeinput（inputType 为 historyUndo / historyRedo），
 * 再派发 input。React 的 onChange 听的就是 input，所以草稿会跟着原生历史走。
 * CodeMirror 6 若以后接进来，要听 beforeinput 的 historyUndo，或在渲染进程直接调编辑器命令。
 */
export const CONTEXT_MENU_HANDLED_CHANNEL = 'kb:context-menu-handled';

export const EDIT_UNDO_ROUTE = 'textarea-native' as const;

export type EditRole = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll';

export interface EditFlags {
  canUndo?: boolean;
  canRedo?: boolean;
  canCut?: boolean;
  canCopy?: boolean;
  canPaste?: boolean;
  canSelectAll?: boolean;
}

export interface EditMenuItem {
  label: string;
  role: EditRole;
  enabled: boolean;
}

export type EditMenuEntry =
  | { type: 'separator' }
  | { type: 'item'; label: string; role: EditRole; enabled: boolean };

const ITEMS: readonly { label: string; role: EditRole; flag: keyof EditFlags }[] = [
  { label: '撤销', role: 'undo', flag: 'canUndo' },
  { label: '重做', role: 'redo', flag: 'canRedo' },
  { label: '剪切', role: 'cut', flag: 'canCut' },
  { label: '复制', role: 'copy', flag: 'canCopy' },
  { label: '粘贴', role: 'paste', flag: 'canPaste' },
  { label: '全选', role: 'selectAll', flag: 'canSelectAll' },
];

export function shouldShowEditContextMenu(input: { isEditable: boolean; rendererHandled: boolean }): boolean {
  return input.isEditable && !input.rendererHandled;
}

export function editContextMenuItems(flags: EditFlags): EditMenuItem[] {
  return ITEMS.map((item) => ({
    label: item.label,
    role: item.role,
    enabled: flags[item.flag] === true,
  }));
}

export function editContextMenuTemplate(flags: EditFlags): EditMenuEntry[] {
  const template: EditMenuEntry[] = [];
  for (const item of editContextMenuItems(flags)) {
    if (item.role === 'cut') template.push({ type: 'separator' });
    template.push({ type: 'item', label: item.label, role: item.role, enabled: item.enabled });
  }
  return template;
}

/** 渲染进程 preventDefault 后打的标。按 webContents id 区分，过期标记不能清掉更新的一次。 */
export class ContextMenuClaims {
  private claimed = new Map<number, number>();
  private ticket = 0;

  note(webContentsId: number): number {
    const token = ++this.ticket;
    this.claimed.set(webContentsId, token);
    return token;
  }

  take(webContentsId: number): boolean {
    if (!this.claimed.has(webContentsId)) return false;
    this.claimed.delete(webContentsId);
    return true;
  }

  forget(webContentsId: number, token: number): void {
    if (this.claimed.get(webContentsId) === token) this.claimed.delete(webContentsId);
  }
}
