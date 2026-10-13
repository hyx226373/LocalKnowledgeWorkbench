import { createContext } from 'react';
import type { FsChangeEvent } from '../../shared/types';

export type OpenMode = 'tab' | 'right' | 'below';

export interface Ctx {
  open: (resourceId: string, title: string, mode?: OpenMode, adapterId?: string) => void;
  favIds: Set<string>;
  toggleFav: (resourceId: string) => void;
  expanded: Set<string>;
  setExpanded: (id: string, on: boolean) => void;
  fsVersion: number;
  /** 最近一批文件变化。目录树只刷新被这批事件碰到的层。 */
  fsEvents: FsChangeEvent[];
  activeResourceId: string | null;
  /** 目录树显示被忽略的项（node_modules、.git 等） */
  showIgnored: boolean;
  setShowIgnored: (on: boolean) => void;
  /** 当前工作的资料（集合）中引用的资源 ID */
  refIds: Set<string>;
  toggleRef: (resourceId: string) => void;
  /** 再开一个面板，不复用已经打开的（第 11 轮 C） */
  openCopy?: (resourceId: string, title: string) => void;
  notify?: (message: string) => void;
  openWeb?: (adapterId: string, url?: string) => Promise<unknown> | void;
  /** 未设置拖拽组挂钩时，「从本工作区移除」走这条现有流程 */
  removeWorkspaceRef?: (resourceId: string) => void;
  workspaceId?: string;
  /** 自建目录变更计数，双栏用来刷新 */
  vfolderVersion?: number;
}

/** 双栏每一侧自己的展开/选中。没有这个上下文时，树仍用全局 ui.expanded（单栏零行为变化）。 */
export interface PaneScope {
  side: 'left' | 'right';
  expanded: Set<string>;
  setExpanded: (id: string, on: boolean) => void;
  selected: Set<string>;
  select: (id: string) => void;
}

export const PaneCtx = createContext<PaneScope | null>(null);

export const AppCtx = createContext<Ctx>(null as unknown as Ctx);
