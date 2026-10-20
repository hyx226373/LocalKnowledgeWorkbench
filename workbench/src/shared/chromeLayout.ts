/**
 * host-r1-layout · chrome 可隐藏 schema（冻结接口 v1）
 * 依据：layout-schema-freeze.md / integration-patches/02-chrome-layout-schema.md
 * 目录隔离：禁止 import desktopPanel。
 */

/** 稳定 chrome 组件 ID（字面量冻结；扩展须文档登记） */
export type ChromeComponentId =
  | 'chrome.menu'
  | 'chrome.toolbar'
  | 'chrome.sidebar'
  | 'chrome.status'
  | 'chrome.tabs'
  | 'chrome.console'
  | 'chrome.agent'
  | `chrome.${string}`;

export interface ChromeComponentMeta {
  id: ChromeComponentId;
  present: boolean;
  defaultVisible: boolean;
  /** 硬约束：恒为 false — 隐藏后不得占 hit-test */
  hitTestWhenHidden: false;
}

export type ChromeVisibilityMap = Partial<Record<ChromeComponentId, boolean>>;

export interface ChromeLayoutSize {
  width?: number;
  height?: number;
}

/**
 * 工作区可持久化 chrome 字段。
 * 禁止根级 contentOnly/editMode/hwnd/pid；03 允许 preContentOnlySnapshot（仅 visibility+layout）
 */
export interface WorkspaceChromePersisted {
  visibility: ChromeVisibilityMap;
  layout?: Partial<Record<ChromeComponentId, ChromeLayoutSize>>;
  /** 03：进入只看内容前快照（schema 校验；损坏则 restoreBaseUI） */
  preContentOnlySnapshot?: PreContentOnlySnapshotPersisted | null;
}

/** 快照 schema（提前声明供 WorkspaceChromePersisted 引用） */
export const PRE_CONTENT_ONLY_SNAPSHOT_SCHEMA = 1 as const;

export interface PreContentOnlySnapshotPersisted {
  schema: 1;
  visibility: ChromeVisibilityMap;
  layout?: Partial<Record<ChromeComponentId, ChromeLayoutSize>>;
}

export interface ChromeStateSnapshot {
  /** 有效显隐（含 contentOnly 叠加） */
  visibility: ChromeVisibilityMap;
  /** 工作区已保存显隐（非临时） */
  savedVisibility: ChromeVisibilityMap;
  /** 已保存尺寸（呼出时保留） */
  layout: Partial<Record<ChromeComponentId, ChromeLayoutSize>>;
  contentOnly: boolean;
  editMode: boolean;
  dirty: boolean;
}

export type LayoutChangeReason =
  | 'chrome-toggle'
  | 'content-only'
  | 'edit-drag'
  | 'restore'
  | 'workspace-open'
  | 'dpi-change'
  | 'layout-adjust';

/** 内容区逻辑像素（DIP）；scaleFactor 来自显示器列表，禁止硬编码 96 DPI */
export interface ContentBounds {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 面板中心所在显示器的 Electron scaleFactor（如 1.25）；L2 必带 */
  scaleFactor?: number;
}

export interface ChromeSetVisibleRequest {
  id: ChromeComponentId;
  visible: boolean;
}

export interface ChromeContentOnlyRequest {
  enabled: boolean;
}

export interface ChromeEditModeRequest {
  enabled: boolean;
}

/** preload 点分 method 名（与 host.* 对齐；合入时由 integ 挂到 preload） */
export const CHROME_IPC = {
  setVisible: 'chrome.setVisible',
  getVisibility: 'chrome.getVisibility',
  restore: 'chrome.restore',
  setContentOnly: 'chrome.setContentOnly',
  setEditMode: 'chrome.setEditMode',
  commitEdit: 'chrome.commitEdit',
  cancelEdit: 'chrome.cancelEdit',
  listComponents: 'chrome.listComponents',
} as const;

export type ChromeIpcMethod = (typeof CHROME_IPC)[keyof typeof CHROME_IPC];

export const CHROME_IPC_METHODS: readonly ChromeIpcMethod[] = [
  CHROME_IPC.setVisible,
  CHROME_IPC.getVisibility,
  CHROME_IPC.restore,
  CHROME_IPC.setContentOnly,
  CHROME_IPC.setEditMode,
  CHROME_IPC.commitEdit,
  CHROME_IPC.cancelEdit,
  CHROME_IPC.listComponents,
];

/** Agent ActionId（冻结 v1） */
export const CHROME_ACTION_IDS = {
  layoutAdjust: 'layoutAdjust',
  chromeSetVisible: 'chromeSetVisible',
  chromeContentOnly: 'chromeContentOnly',
  chromeRestore: 'chromeRestore',
  chromeEditMode: 'chromeEditMode',
  chromeCommitEdit: 'chromeCommitEdit',
} as const;

/** layout.* 事件名（插件只消费，禁止再调 host.setBounds/setVisible/activate） */
export const LAYOUT_EVENTS = {
  contentBoundsChanged: 'layout.contentBoundsChanged',
  chromeVisibilityChanged: 'layout.chromeVisibilityChanged',
  hostOcclusionChanged: 'layout.hostOcclusionChanged',
  editModeChanged: 'layout.editModeChanged',
} as const;

export type LayoutEventName = (typeof LAYOUT_EVENTS)[keyof typeof LAYOUT_EVENTS];

/** 反向请求（插件 → 布局宿主；布局宿主唯一调 host.activate）· freeze addendum-1 */
export const LAYOUT_REQUEST_EVENTS = {
  requestActivate: 'layout.requestActivate',
} as const;

export type LayoutRequestEventName = (typeof LAYOUT_REQUEST_EVENTS)[keyof typeof LAYOUT_REQUEST_EVENTS];

export type LayoutActivateReason = 'user-enter' | 'panel-focus' | 'content-only';

export interface LayoutRequestActivatePayload {
  panelId: string;
  reason: 'user-enter' | 'panel-focus';
}


export interface LayoutContentBoundsChangedPayload {
  panelId: string;
  bounds: ContentBounds;
  reason: LayoutChangeReason;
}

export interface LayoutChromeVisibilityChangedPayload {
  visibility: ChromeVisibilityMap;
  contentOnly: boolean;
  reason: LayoutChangeReason;
}

export interface LayoutHostOcclusionChangedPayload {
  panelId: string;
  occluded: boolean;
}

export interface LayoutEditModeChangedPayload {
  editMode: boolean;
  dirty: boolean;
}

/**
 * 持久化禁止字段（正式 chrome.visibility/layout 及快照内均禁止）。
 * 注：03 裁决允许独立字段 `preContentOnlySnapshot`（仅 visibility+layout），
 * 见 PRE_CONTENT_ONLY_SNAPSHOT_KEY；仍禁止 hwnd / 输入控制态 / 凭据。
 */
export const CHROME_FORBIDDEN_PERSIST_KEYS = [
  'contentOnly',
  'editMode',
  'hwnd',
  'pid',
  'inputControl',
  'credentials',
  'approvalCredentials',
] as const;

/** 工作区 layout 键内快照字段名（随 workspace.chrome.<wsId> 落盘） */
export const PRE_CONTENT_ONLY_SNAPSHOT_KEY = 'preContentOnlySnapshot' as const;


/**
 * 03 界面三裁决 · 产品可配置（覆写此前会话级/Esc 默认）
 * 权威：`/workspace/out/host-r1/03-界面三裁决-冻结.md`
 */
export interface ChromeProductConfig {
  /** 只看内容切换快捷键（默认 Ctrl+Shift+F11）；再按切回 */
  contentOnlyToggleKey: string;
  /**
   * 额外退出键。Esc 默认关闭；仅当配置为 true 时 Esc 可退出。
   */
  contentOnlyExit: {
    /** 再按切换键退出（与 toggle 同一键） */
    sameCommand: boolean;
    /** Esc 退出；默认 false（03 覆写） */
    escape: boolean;
  };
  /** 命令面板快捷键（默认 Ctrl+Shift+P） */
  commandPaletteKey: string;
  /**
   * 命令面板默认作用域：仅控制台交互态。
   * 托管应用获焦时普通编辑键交原应用；切换/恢复通道仍有效。
   */
  commandPaletteConsoleOnly: boolean;
  /** 可选边缘呼出；默认关 */
  edgeRevealEnabled: boolean;
  /**
   * 菜单隐藏后命令入口。
   */
  hiddenMenuAccess: {
    commandPalette: boolean;
    globalShortcuts: boolean;
    stripInvisibleAccelerators: true;
  };
  /**
   * preContentOnlySnapshot 是否落盘。03 裁决：默认 true（随工作区）。
   */
  persistContentOnlySnapshot: boolean;
}

export const DEFAULT_CHROME_PRODUCT_CONFIG: ChromeProductConfig = {
  contentOnlyToggleKey: 'Ctrl+Shift+F11',
  contentOnlyExit: { sameCommand: true, escape: false },
  commandPaletteKey: 'Ctrl+Shift+P',
  commandPaletteConsoleOnly: true,
  edgeRevealEnabled: false,
  hiddenMenuAccess: {
    commandPalette: true,
    globalShortcuts: true,
    stripInvisibleAccelerators: true,
  },
  persistContentOnlySnapshot: true,
};

/** 命令 / hook 稳定名（03 + integ 转发） */
export const EXIT_CONTENT_ONLY_COMMAND_ID = 'chrome.exitContentOnly' as const;
export const TOGGLE_CONTENT_ONLY_COMMAND_ID = 'chrome.toggleContentOnly' as const;
export const RESTORE_BASE_UI_COMMAND_ID = 'chrome.restoreBaseUI' as const;
export const OPEN_COMMAND_PALETTE_COMMAND_ID = 'chrome.openCommandPalette' as const;
export const RESTORE_UI_COMMAND_ID = 'chrome.restoreUI' as const;

/** 主进程转发 hook：toggle 为主；exit 为兼容别名 */
export const TOGGLE_CONTENT_ONLY_HOOK = '__kbToggleContentOnly' as const;
export const EXIT_CONTENT_ONLY_HOOK = '__kbExitContentOnly' as const;
export const OPEN_COMMAND_PALETTE_HOOK = '__kbOpenCommandPalette' as const;
export const RESTORE_UI_HOOK = '__kbRestoreUI' as const;
export const RESTORE_BASE_UI_HOOK = '__kbRestoreBaseUI' as const;

/** VC-UI-01：快捷键变更通知（main 重注册全局转发） */
export const LAYOUT_SHORTCUTS_CHANGED_EVENT = 'layout.shortcutsChanged' as const;
export const SHORTCUTS_CHANGED_HOOK = '__kbOnShortcutsChanged' as const;

/** 可持久化的快捷键子集（无 hwnd/凭据/输入控制态） */
export interface ChromeShortcutsPersisted {
  contentOnlyToggleKey: string;
  commandPaletteKey: string;
}

export interface LayoutShortcutsChangedPayload {
  contentOnlyToggleKey: string;
  commandPaletteKey: string;
}

/** kb.getLayout/setLayout 键（全局 UI，非工作区） */
export const CHROME_SHORTCUTS_LAYOUT_KEY = 'chrome.shortcuts' as const;

/** 快捷键冲突报告 */
export interface ShortcutConflictReport {
  key: string;
  /** 本产品意图绑定的命令 id */
  intendedCommandId: string;
  /** 已有绑定（保留，不静默覆盖） */
  existingBinding: { commandId: string; source?: string } | null;
  conflict: boolean;
  message: string;
}

// ---- L2 显示器列表 / DPI（外贴31·布局切片，2026-10-13）----

/** 与 native DisplayMetrics 对齐；scaleFactor 必须 > 0，禁止硬编码 96 DPI */
export interface DisplayMetrics {
  id?: number;
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
}

export const LAYOUT_DISPLAYS_CHANGED_EVENT = 'layout.displaysChanged' as const;

export interface LayoutDisplaysChangedPayload {
  displays: DisplayMetrics[];
}

/** 可选：挂到 window 供插件同步读取非空列表 */
export const GET_DISPLAYS_HOOK = '__kbGetDisplays' as const;

/** L2 几何断言阈值：DIP→物理 回读偏差 */
export const L2_BOUNDS_THRESHOLD = {
  /** CSS/DIP 像素最大绝对偏差 */
  maxCssPx: 2,
  /** 物理像素最大绝对偏差（≈ maxCssPx * scale 的宽松上限取 1 当 scale≥1 时用 max(1, …)） */
  maxPhysicalPx: 1,
} as const;

