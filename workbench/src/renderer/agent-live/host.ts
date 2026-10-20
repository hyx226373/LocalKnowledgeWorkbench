import type { MaterialRef } from '../../shared/agentLive/types';
import type { AgentLiveChromeState } from './collapse';
import type { NativeCopyDrag } from './dragPolicy';

export interface AgentLiveHost {
  workspaceId(): string;
  currentReading(): MaterialRef | null;
  /** 阅读窗口标题栏按钮用。没有文件时返回 null，按钮不显示。 */
  readingForPanel(panelId: string): MaterialRef | null;
  /** 目录栏或搜索结果里当前选中的文件。 */
  selection(): MaterialRef[];
  /** 托管的外部应用正处于前台。此时 Ctrl+Shift+A 必须让给它。 */
  hostedForeground(): boolean;
  notify(message: string): void;
  confirm(spec: { title: string; body: string; ok: string; cancel?: string }): Promise<boolean>;
  writeClipboard(text: string): Promise<void>;
  bridgeEntryPath(): Promise<string>;
  workspaceEntryPath(workspaceId: string): Promise<string>;
  /**
   * 已选 activeAgent 时返回常驻规则全文。
   * 未选或接口未接上时返回 null，复制入口仍写入原来的路径。
   */
  residentRules?(entryPath: string): Promise<string | null>;
  /** dialogKey 区分入口。选择文件加入资料、重新定位各用各的键，不和注册来源混用。 */
  pickFile(dialogKey?: string): Promise<string | null>;
  /**
   * 文件模式拖出真实文件。deleteSource 固定为 false。
   * 调用方已在 dragstart 里 preventDefault，并记下应用内会话。这里只发异步 IPC。
   */
  startDragCopy?(request: NativeCopyDrag): void;
  /** 目录拖拽通常只有 resourceId。集成组补上真实路径。补不上就不要加入。 */
  resolve?(ref: MaterialRef): Promise<MaterialRef | null>;
  loadChrome?(workspaceId: string): Promise<unknown>;
  saveChrome?(workspaceId: string, state: AgentLiveChromeState): Promise<void>;
}

/** live/current/ENTRY.md 与 live/ws/<id>/ENTRY.md。bridgeDir 是 agent-bridge 目录。 */
export function entryPaths(bridgeDir: string, workspaceId: string): { current: string; workspace: string } {
  const root = bridgeDir.replace(/[\\/]+$/, '');
  const sep = root.includes('/') && !root.includes('\\') ? '/' : '\\';
  return {
    current: `${root}${sep}live${sep}current${sep}ENTRY.md`,
    workspace: `${root}${sep}live${sep}ws${sep}${workspaceId}${sep}ENTRY.md`,
  };
}
