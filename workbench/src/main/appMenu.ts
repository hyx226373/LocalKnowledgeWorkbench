/**
 * 应用菜单（docs/07 §6）：替换 Electron 默认的英文菜单。菜单栏默认隐藏（工作台有自己的顶栏），按 Alt 显示。
 * 菜单项只做“入口”：工作台命令（命令面板、插件管理…）发给渲染进程执行（kb:menu-command），快捷键由渲染进程处理（registerAccelerator:false 只显示）。
 */
import { app, dialog, Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';

export const APP_DISPLAY_NAME = '本地知识工作台';

export function buildAppMenu(getWin: () => BrowserWindow | null, opts: { dev: boolean; dataDir: () => string; migration?: (tab: 'export' | 'import' | 'repair' | 'backups') => void }) {
  const cmd = (id: string) => () => getWin()?.webContents.send('kb:menu-command', id);
  const template: MenuItemConstructorOptions[] = [
    {
      label: '文件(&F)',
      submenu: [
        { label: '插件管理…', click: cmd('plugins.manage') },
        { label: '安装主题包（文件夹）…', click: cmd('appearance.installPack') },
        { type: 'separator' },
        { label: '导出数据迁移包…', click: () => opts.migration?.('export') },
        { label: '导入数据迁移包…', click: () => opts.migration?.('import') },
        { label: '根目录与缺失文件…', click: () => opts.migration?.('repair') },
        { label: '备份与回退（立即备份）…', click: () => opts.migration?.('backups') },
        { type: 'separator' },
        { label: '退出', role: 'quit', accelerator: 'Alt+F4' },
      ],
    },
    {
      label: '编辑(&E)',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' },
      ],
    },
    {
      label: '视图(&V)',
      submenu: [
        { label: '命令面板…', accelerator: 'Ctrl+Shift+P', registerAccelerator: false, click: cmd('workbench.commandPalette') },
        { label: '自定义快捷键…', registerAccelerator: false, click: cmd('keybindings.open') },
        { label: '网页外部资源授权…', click: cmd('web.siteGrants.open') },
        { label: '操作记录（撤销）…', click: cmd('workbench.opLog') },
        { label: '关闭所有标签', click: cmd('workbench.layout.closeAll') },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' },
        ...(opts.dev
          ? ([
              { type: 'separator' },
              { label: '重新载入（开发）', role: 'reload' },
              { label: '开发者工具（开发）', role: 'toggleDevTools' },
            ] as MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      label: '帮助(&H)',
      submenu: [
        { label: '更新…', click: cmd('app.update.open') },
        {
          label: `关于${APP_DISPLAY_NAME}`,
          click: () => {
            const w = getWin();
            const o = { type: 'info' as const, title: `关于${APP_DISPLAY_NAME}`, message: `${APP_DISPLAY_NAME} ${app.getVersion()}`, detail: `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}\n数据目录：${opts.dataDir()}`, buttons: ['确定'] };
            void (w ? dialog.showMessageBox(w, o) : dialog.showMessageBox(o));
          },
        },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}
