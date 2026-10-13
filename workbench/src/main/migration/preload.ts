// 数据迁移窗口的 preload：只暴露 kb-migration 通道（主进程按发送方校验，只接受迁移窗口）
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('kbm', {
  call: (method: string, ...args: unknown[]) => ipcRenderer.invoke('kb-migration', method, ...args),
});
