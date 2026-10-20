/**
 * 统一面板管理层（布局组，第九轮）的数据模型。
 *
 * 一个“窗口”= 工作区里一块可以独立移动/缩放/叠放/收起/最大化的界面：
 *  - 文档/网页面板：dockview 面板（id = 工作区条目 itemId）。停靠（grid，分屏）或浮动（dockview floating group）。
 *  - 侧栏：id = SIDEBAR_ID。停靠时是 App 原有的 <aside>（保持原分栏与拖动宽度）；浮动时是一个 dockview 浮动面板
 *    （组件 SIDEBAR_COMPONENT，内容通过 React portal 渲染同一个 <Sidebar>）。
 * 保存时：dockview JSON（含浮动组位置）照旧写在 layout.dock；本层补充的状态写在 layout.windows（带自己的版本号 v），
 * 不改 layout.schema（仍是 4），旧版本应用会忽略 windows 字段。侧栏的浮动面板不进 dock JSON（它不是工作区条目）。
 * windows 中只有几何数字、id、枚举和气泡显示名：不含文件内容、路径、URL 或密钥。
 */

export const PANEL_LAYOUT_VERSION = 1;
export const SIDEBAR_ID = 'kb.sidebar';
export const SIDEBAR_COMPONENT = 'kb.sidebar';
/** 序列化后的 windows 字段上限（远小于工作区 512 KB 上限） */
export const MAX_WINDOWS_BYTES = 64 * 1024;

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface Size {
  width: number;
  height: number;
}

export type DockDirection = 'left' | 'right' | 'above' | 'below' | 'within';

/** 气泡上显示的面板类型。unknown 只出现在旧布局里，界面改显示「面板」。 */
export type BubbleKind = 'file' | 'web' | 'app' | 'native-host' | 'sidebar' | 'unknown';

/** 收起成气泡前的位置（恢复时用） */
export interface CollapsedInfo {
  /** grid = 原来在分屏里；floating = 原来是浮动窗口；sidebar-docked = 侧栏原来停靠在左侧 */
  from: 'grid' | 'floating' | 'sidebar-docked';
  /** from=grid：恢复时停靠到这个面板旁边（方向 dockDir）；面板已不存在时停到最后一个分组右侧 */
  dockRef?: string;
  dockDir?: DockDirection;
  /** from=floating（或侧栏浮动）：收起前的窗口矩形（容器坐标） */
  bounds?: Box;
  /** 收起顺序（气泡排列顺序） */
  seq: number;
  /** 气泡标题。只存显示名，不存路径或 URL。 */
  title?: string;
  /** 气泡类型。旧布局可能是 unknown，打开时再按条目补上。 */
  kind?: BubbleKind;
  /** 气泡在 dock 容器内的拖放位置（左上角）；缺省按底排自动摆。 */
  tray?: { left: number; top: number };
}

export interface FloatMeta {
  /** 浮动窗口最大化：保存最大化前的矩形，还原时回到这里 */
  maximized?: { restore: Box };
}

export interface SidebarWindowState {
  mode: 'docked' | 'floating';
  /** 浮动时的矩形（容器坐标）；停靠时为上次浮动的位置（再次浮动时沿用） */
  bounds?: Box;
  collapsed?: CollapsedInfo;
  maximized?: { restore: Box; from: 'docked' | 'floating' };
}

/** layout.windows（v1） */
export interface PanelLayoutV1 {
  v: 1;
  /** 保存时浮动容器（dock 区域）的尺寸：恢复到更小的屏幕时用于找回 */
  viewport: Size;
  /** 浮动窗口的层级，从下到上。键：面板 id（浮动组里的任一面板，取组内第一个）或 SIDEBAR_ID */
  order: string[];
  /** 收起成气泡的面板 */
  collapsed: Record<string, CollapsedInfo>;
  /** 浮动窗口的附加状态，键 = 组内第一个面板 id */
  floats: Record<string, FloatMeta>;
  /** 分屏里被（dockview 原生）最大化的分组：其中任一面板 id */
  gridMaximized?: string;
  sidebar: SidebarWindowState;
}
export type PanelLayout = PanelLayoutV1;

export type WindowMode = 'docked' | 'floating' | 'collapsed';
/** list() 返回的窗口信息（e2e 与命令面板用） */
export interface WindowInfo {
  id: string;
  title: string;
  kind: 'panel' | 'sidebar';
  mode: WindowMode;
  /** 容器坐标（浮动容器 = dock 区域左上角为 0,0）；收起时为 null */
  bounds: Box | null;
  /** 浮动层级（越大越靠上）；停靠/收起为 -1 */
  z: number;
  maximized: boolean;
  groupId: string | null;
}

/** 统一面板管理 API（PanelManager 实现；id 为面板 id 或 SIDEBAR_ID） */
export interface PanelManagerApi {
  list(): WindowInfo[];
  get(id: string): WindowInfo | undefined;
  /** 移动到容器坐标 (left, top)。停靠的面板先变为浮动 */
  move(id: string, pos: { left: number; top: number }): void;
  /**
   * 调整宽高。浮动：改窗口矩形；停靠在分屏：改所在分组的宽/高（分屏的另一侧随之变化）。
   * commit 缺省为 true。拖动手柄可传 { commit: false }，松手再提交，避免每帧写盘。
   */
  resize(id: string, size: Partial<Size>, opts?: { commit?: boolean }): void;
  bringToFront(id: string): void;
  collapseToBubble(id: string): void;
  restoreFromBubble(id: string): void;
  setBubbleTray(id: string, pos: { left: number; top: number }): void;
  closeBubble(id: string): void;
  maximize(id: string): void;
  restore(id: string): void;
  float(id: string, box?: Partial<Box>): void;
  dock(id: string, target?: { ref?: string; direction?: DockDirection }): void;
  toggleFloat(id: string): void;
  /** 当前状态 → layout.windows */
  serialize(): PanelLayout;
  /** dockview toJSON() → 去掉本层私有的面板（侧栏）后的 dock JSON */
  dockForSave<T>(dock: T): T;
  /** fromJSON 之后调用：按 layout.windows（任意版本，或缺失）恢复本层状态 */
  restoreLayout(raw: unknown): void;
  /** fromJSON 之前调用：记下将被收起的面板（分级加载用） */
  primeCollapsed(raw: unknown): void;
  /** 收起或即将被收起：分级加载按后台标签处理 */
  isHiddenForLoad(id: string): boolean;
  /** 把所有浮动窗口夹回可见区域（窗口缩小、分辨率变化、恢复到更小的屏幕） */
  rescue(): number;
  /** 只藏停靠组的标签条。不关闭面板，不改活动项，浮动窗口仍保留标题。 */
  hideDockedTabs(): void;
  /** 显示停靠组的文档标签。 */
  showDocumentTabs(): void;
  /** 停靠组标签条是否被藏起 */
  dockedTabsHidden(): boolean;
}
