/**
 * 主进程：可编辑区右键弹出中文编辑菜单。不可编辑区不弹，留给预览标红、目录树和标签。
 */
import { app, BrowserWindow, ipcMain, Menu, type MenuItemConstructorOptions, type WebContents } from 'electron';
import {
  CONTEXT_MENU_HANDLED_CHANNEL,
  ContextMenuClaims,
  editContextMenuTemplate,
  shouldShowEditContextMenu,
  type EditFlags,
  type EditMenuEntry,
} from '../shared/editContextMenu';

const claims = new ContextMenuClaims();

function toElectronTemplate(entries: readonly EditMenuEntry[]): MenuItemConstructorOptions[] {
  return entries.map((entry) => {
    if (entry.type === 'separator') return { type: 'separator' };
    return { label: entry.label, role: entry.role, enabled: entry.enabled };
  });
}

function attach(wc: WebContents): void {
  wc.on('context-menu', (_event, params) => {
    let url = '';
    try {
      url = wc.getURL();
    } catch {
      url = '';
    }
    if (url.startsWith('devtools://')) return;
    const rendererHandled = claims.take(wc.id);
    const flags = (params.editFlags ?? {}) as EditFlags;
    if (!shouldShowEditContextMenu({ isEditable: params.isEditable === true, rendererHandled })) return;
    const menu = Menu.buildFromTemplate(toElectronTemplate(editContextMenuTemplate(flags)));
    const owner = BrowserWindow.fromWebContents(wc);
    if (owner && !owner.isDestroyed()) menu.popup({ window: owner });
    else menu.popup();
  });
}

export function installEditContextMenu(): void {
  ipcMain.on(CONTEXT_MENU_HANDLED_CHANNEL, (event) => {
    const token = claims.note(event.sender.id);
    event.returnValue = true;
    setImmediate(() => claims.forget(event.sender.id, token));
  });
  app.on('web-contents-created', (_event, wc) => attach(wc));
}
