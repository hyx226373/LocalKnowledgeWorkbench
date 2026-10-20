// 全局 Agent 库窗口的 preload：只暴露 kb-agent-picker 通道（主进程按发送方校验）。
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('kbp', {
  call: (method: string, ...args: unknown[]) => ipcRenderer.invoke('kb-agent-picker', method, ...args),
});
