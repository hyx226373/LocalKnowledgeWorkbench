/**
 * 工作区选择器契约类型（草案 §1–§4）。不改旧 WorkspaceSummary。
 */
import type { SerializedDock } from '../items';

export interface WorkspaceCounts {
  files: number;
  webs: number;
  apps: number;
  panels: number;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  /** 一句话，≤80 个 Unicode 码位，默认 "" */
  purpose: string;
  /** 每项 ≤16 码位，最多 8 个，默认 [] */
  tags: string[];
  project: string;
  favorite: boolean;
  /** 只映射已有 last_opened_at，不用 updated_at */
  lastUsedAt: number | null;
  counts: WorkspaceCounts;
  icon: string | null;
  /** 仅 #RRGGBB，否则 null */
  accent: string | null;
  /** 封面文件名，无盘符、无路径 */
  coverRef: string | null;
  thumbVersion: number;
}

export interface LayoutThumbNode {
  id: string;
  rect: { x: number; y: number; w: number; h: number };
  kind: 'file' | 'web' | 'app' | 'native-host' | 'unknown';
  iconKey: string;
  /** ≤8 个 Unicode 码位 */
  shortName: string;
  flags: { collapsed?: boolean; hidden?: boolean; maximized?: boolean };
  unknown: boolean;
}

export interface LayoutThumbModel {
  cacheKey: string;
  aspect: number;
  nodes: LayoutThumbNode[];
}

export interface WorkspaceDetail {
  summary: WorkspaceSummary;
  files: { resourceId: string; title: string; missing: boolean }[];
  webs: { ref: string; title: string }[];
  apps: { ref: string; title: string; configured: true }[];
  nativeHosts: { panelId: string; hostPath: string; titleHint: string }[];
  agents: {
    roomId: string;
    title: string;
    roles: { id: string; name: string; configured: true }[];
    running: 'running' | 'stopped' | 'unknown';
  }[];
  savedAt: number;
  restorePolicy: 'manual-open-apps';
  recentResults: { at: number; title: string; ref: string }[];
  problems: { code: string; panelId?: string; message: string; retryable: boolean }[];
}

export type RestorePhase = 'preparing' | 'loading' | 'restored' | 'failed' | 'unavailable' | 'unknown';

export interface RestoreEvent {
  workspaceId: string;
  panelId: string;
  phase: RestorePhase;
  reason?: string;
  retryable: boolean;
  host?: { layout: RestorePhase; attach: RestorePhase; document: RestorePhase };
}

export interface CountInput {
  items: readonly { itemId: string; sourceKind: 'file' | 'web' | 'app'; ref: string }[];
  panels: readonly { id: string; itemId?: string; viewType?: string; hostPath?: string }[];
  /** 工作资料引用。计数时绝不计入 files。 */
  workspaceRefs?: readonly string[];
}

export interface ThumbItem {
  itemId: string;
  sourceKind?: 'file' | 'web' | 'app';
  title?: string;
  adapterId?: string;
  adapterKnown?: boolean;
  iconKey?: string;
}

export interface ThumbWindows {
  viewport?: { width?: number; height?: number };
  collapsed?: Record<string, { seq?: number } | null>;
  gridMaximized?: string;
  floats?: Record<string, { maximized?: unknown } | null>;
  sidebar?: unknown;
}

export interface ThumbLayout {
  schema?: number;
  dock?: SerializedDock | null;
  windows?: ThumbWindows | null;
}

export interface WebPhaseEvent {
  type?: string;
  state?: string;
  navigationId?: string;
  error?: string;
  reason?: string;
}

export type RestoreSource =
  | { kind: 'none' }
  | {
      kind: 'file';
      armed?: boolean;
      resource?: { missing?: boolean } | null;
      reportsReady?: boolean;
      contentReady?: boolean;
      readyOnMount?: boolean;
    }
  | { kind: 'web'; hasView?: boolean; events?: readonly WebPhaseEvent[] }
  | {
      kind: 'app';
      opened?: boolean;
      crashed?: boolean;
      exited?: boolean;
      launch?: { ok?: boolean; failure?: string; reason?: string } | null;
    }
  | {
      kind: 'native-host';
      layoutApplied?: boolean;
      integLinked?: boolean;
      hostGate?: boolean;
      userOpened?: boolean;
    };

export type WorkspaceStartup = 'overview' | 'last' | 'workspace';

export interface WorkspacePickerSettings {
  v: 1;
  startup: WorkspaceStartup;
  startupWorkspaceId: string | null;
  overviewHidden: boolean;
  /** 总览本地快照开关。缺省开。关掉后不采集。 */
  snapshotEnabled: boolean;
}

export type StartupResolution =
  | { kind: 'welcome' }
  | { kind: 'overview' }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'last'; workspaceId: string | null };

export const WORKSPACE_CARD_CLASS = {
  root: 'kb-ws-card',
  selected: 'is-selected',
  favorite: 'is-favorite',
} as const;

export const QUICK_SWITCH_DEFAULT_KEY = 'Ctrl+Shift+F';

export const DEFAULT_WORKSPACE_PICKER_SETTINGS: WorkspacePickerSettings = {
  v: 1,
  startup: 'last',
  startupWorkspaceId: null,
  overviewHidden: false,
  snapshotEnabled: true,
};
