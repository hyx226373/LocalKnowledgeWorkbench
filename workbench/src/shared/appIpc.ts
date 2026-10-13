/** 外部程序项目的 IPC 类型（主进程 adapters/appHost.ts ⇄ 渲染进程），第 9 轮接线 */
import type { AppProfile, LaunchRequest, LaunchResult, ProcessHandleInfo, ProgramDetection, SlotValue } from './adapter-sdk/types';
export type { AppProfile, LaunchRequest, LaunchResult, ProcessHandleInfo, ProgramDetection, SlotValue };

export interface AppProfileInput {
  adapterId: string;
  programId: string;
  label?: string;
  launch: { templateId: string; slots: Record<string, SlotValue> };
}

/** 退出后记入操作记录的改动（渲染进程显示“撤销外部修改”） */
export interface AppChangesEvent {
  launchId: string;
  pluginId: string;
  adapterId: string;
  itemId: string;
  programName: string;
  /** true = 工作台下次启动时才比较的（当时工作台已关闭） */
  afterRestart: boolean;
  files: Array<{ rootId: string; relPath: string; change: 'modified' | 'missing'; opId: number }>;
}

export type AppUndoOutcome = { status: 'undone'; files: string[] } | { status: 'conflict'; detail: string[] } | { status: 'nothing' } | { status: 'unrecoverable'; detail: string[] };

export type AppEvent = ({ type: 'status'; pluginId: string; itemId: string; handle: ProcessHandleInfo }) | ({ type: 'changes' } & AppChangesEvent);
