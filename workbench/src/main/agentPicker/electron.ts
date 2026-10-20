/**
 * 全局 Agent 库小窗口。独立 BrowserWindow，preload 只暴露本窗口通道。
 * 打开时冻结 targetId：主窗口之后换区不改变这次落点。
 */
import { BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { sourceGroups, type LibraryFile, type LibraryPreview } from '../../shared/rebirthMembership';
import { PICKER_HTML } from './ui';

export interface PickerSnapshot {
  targetId: string;
  targetName: string;
  workspaces: { id: string; name: string }[];
  files: LibraryFile[];
  groups: { key: string; label: string; ids: string[] }[];
}

interface PickerLoad {
  targetId: string;
  targetName: string;
  workspaces: { id: string; name: string }[];
  files: LibraryFile[];
}

export interface PickerDeps {
  getMainWindow: () => BrowserWindow | null;
  load: () => Promise<PickerLoad>;
  preview: (id: string) => LibraryPreview;
  apply: (targetId: string, checkedIds: string[]) => { added: string[]; removed: string[] };
}

let deps: PickerDeps | null = null;
let pwin: BrowserWindow | null = null;
let frozen: PickerSnapshot | null = null;
let ipcReady = false;

function clean(err: unknown): string {
  return String((err as Error)?.message ?? err);
}

export function registerAgentPicker(d: PickerDeps) {
  deps = d;
  if (ipcReady) return;
  ipcReady = true;
  ipcMain.handle('kb-agent-picker', async (event, method: string, ...args: unknown[]) => {
    if (!pwin || event.sender !== pwin.webContents) throw new Error('只接受全局 Agent 库窗口的调用');
    if (!deps || !frozen) throw new Error('全局 Agent 库还没打开');
    try {
      if (method === 'snapshot') return frozen;
      if (method === 'preview') {
        const id = String(args[0] ?? '');
        if (!frozen.files.some((file) => file.id === id)) throw new Error('重生文件不存在');
        return deps.preview(id);
      }
      if (method === 'apply') {
        if (!frozen.targetId) throw new Error('没有当前工作区');
        const ids = Array.isArray(args[0]) ? args[0].filter((id): id is string => typeof id === 'string') : [];
        return deps.apply(frozen.targetId, ids);
      }
      throw new Error(`未知方法: ${method}`);
    } catch (err) {
      throw new Error(clean(err));
    }
  });
}

export async function openAgentPickerWindow(): Promise<void> {
  if (!deps) return;
  if (pwin && !pwin.isDestroyed()) {
    pwin.focus();
    return;
  }
  const loaded = await deps.load();
  frozen = { ...loaded, groups: sourceGroups(loaded.files, loaded.workspaces) };
  const parent = deps.getMainWindow() ?? undefined;
  pwin = new BrowserWindow({
    width: 1040,
    height: 700,
    minWidth: 860,
    minHeight: 560,
    parent,
    title: '全局 Agent 库',
    autoHideMenuBar: true,
    backgroundColor: '#eef1f6',
    webPreferences: {
      preload: path.join(__dirname, 'agentPickerPreload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  pwin.setMenu(null);
  pwin.webContents.on('will-navigate', (event) => event.preventDefault());
  pwin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  pwin.on('closed', () => {
    pwin = null;
    frozen = null;
  });
  await pwin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PICKER_HTML));
}
