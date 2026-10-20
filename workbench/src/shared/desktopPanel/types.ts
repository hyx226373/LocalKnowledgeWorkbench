/**
 * desk-r1 共用类型（01-共用接口.md）。各组只读扩展须申请。
 * 统一树：B 为基座；吸收 A CaptureStreamStatus / D 文本注入与标签辅助。
 */
export type SessionId = string; // uuid v4
export type CaptureId = string; // desktopCapturer source.id，仅会话内有效

export type SessionState =
  | 'unavailable' // A 不可用：未全屏
  | 'viewing' // B 查看
  | 'desktopOp' // C 桌面操作
  | 'localText' // D 本地文字输入
  | 'paused'; // E 暂停/失效

/**
 * UI 常驻横幅文案（01 §2.1）。
 * viewing 可为 null（可无常驻条）；paused 对齐「已暂停 / 会话失效」。
 */
export const SESSION_STATE_BANNER: Record<SessionState, string | null> = {
  unavailable: '进入全屏后启用',
  viewing: null,
  desktopOp: '桌面操作中',
  localText: '本地输入中',
  paused: '已暂停 / 会话失效',
};

/**
 * 更完整的状态标签（源自 D）。viewing 供工具栏可选显示「查看中」；
 * 常驻横幅仍以 SESSION_STATE_BANNER 为准（viewing=null）。
 */
export const SESSION_STATE_LABEL: Record<SessionState, string> = {
  unavailable: '进入全屏后启用',
  viewing: '查看中',
  desktopOp: '桌面操作中',
  localText: '本地输入中',
  paused: '已暂停 / 会话失效',
};

export interface SourceDescriptor {
  v: 1;
  displayKey: string;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  mediaSourceHint?: {
    name?: string;
    display_id?: string;
  };
}

export interface TargetDescriptor {
  v: 1;
  hwnd: string;
  title: string;
  processName?: string;
  pid?: number;
  bounds: { x: number; y: number; width: number; height: number };
  visible: boolean;
  minimized?: boolean;
}

export interface PanelCssPoint {
  x: number;
  y: number;
  space: 'panel-css';
}
export interface VideoContentPoint {
  x: number;
  y: number;
  space: 'video-content';
}
export interface SourcePixelPoint {
  x: number;
  y: number;
  space: 'source-pixel';
}
export interface WinDesktopPoint {
  x: number;
  y: number;
  space: 'win-desktop';
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VideoMetrics {
  videoElementCss: Rect;
  contentCss: Rect;
  sourceWidth: number;
  sourceHeight: number;
  scaleFactor: number;
  sourceOrigin: { x: number; y: number };
}

/** A-group stream lifecycle (01 §9). */
export type CaptureStreamStatus = 'live' | 'paused' | 'ended' | 'error';

export interface CaptureStatus {
  sessionId: SessionId;
  captureId: CaptureId;
  source: SourceDescriptor;
  status: CaptureStreamStatus;
  frameSize: { width: number; height: number };
  excludeSelfOk: boolean;
  message?: string;
}

export type DragOwner = 'panel' | 'desktop';

export interface DragSession {
  dragId: string;
  owner: DragOwner;
  startCss: PanelCssPoint;
  pointerId: number;
}

/** D: unicode / clipboard-paste */
export type TextInjectMethod = 'unicode' | 'clipboard-paste';

export interface PointerInputPayload {
  sessionId: SessionId;
  stateMustBe: 'desktopOp';
  action: 'move' | 'down' | 'up' | 'click' | 'dblclick' | 'wheel';
  button?: 'left' | 'right' | 'middle';
  point: WinDesktopPoint;
  wheel?: { dx: number; dy: number };
  dragId?: string;
  /**
   * C-SEAM: reserved for real-injection extras (buttons mask, timestamp, …).
   * Omit until C helper lands; do not invent parallel payload types.
   */
  cExt?: Record<string, unknown>;
}

export interface TextInputPayload {
  target: TargetDescriptor;
  /** Unicode NFC */
  text: string;
  method: TextInjectMethod;
  restoreClipboard?: boolean;
}

export interface KeyInputPayload {
  target: TargetDescriptor;
  key: 'Enter' | 'Tab' | 'Escape';
  action: 'click';
}

/** 前端 text-submit（01 §6）；发文字与发 Enter 逻辑分离 */
export interface TextSubmitData {
  text: string;
  /** 若 true，须在文字成功后另一次 sendEnter；不得把 Enter 绑死在同一次 text 里偷偷发 */
  sendEnter: boolean;
  target: TargetDescriptor;
  method: TextInjectMethod;
}

export type DesktopInputEvent =
  | { kind: 'pointer'; data: PointerInputPayload }
  | { kind: 'keyboard'; data: KeyInputPayload }
  | { kind: 'text-submit'; data: TextSubmitData };

export interface SessionStateChangedEvent {
  sessionId: SessionId | null;
  state: SessionState;
  reason?: string;
  target?: TargetDescriptor | null;
  source?: SourceDescriptor | null;
}

/** 开框时写入的目标快照 + 本地缓冲元数据（D） */
export interface LocalTextSnapshot {
  target: TargetDescriptor;
  /** 打开时刻（ms） */
  openedAt: number;
  /** 开框后暂停 keyboard 直转桌面 */
  keyboardPassthroughPaused: true;
}

export interface DesktopPanelError {
  code: string;
  message: string;
}

/** hwnd 短格式展示：优先十六进制后 4 位（D） */
export function formatHwndShort(hwnd: string): string {
  const raw = String(hwnd ?? '').trim();
  if (!raw) return '(无 hwnd)';
  let hex = raw;
  if (/^0x/i.test(raw)) {
    hex = raw.slice(2);
  } else if (/^\d+$/.test(raw)) {
    hex = Number(raw).toString(16).toUpperCase();
  } else {
    return raw.length > 10 ? raw.slice(-8) : raw;
  }
  hex = hex.replace(/^0+/, '') || '0';
  const padded = hex.toUpperCase().padStart(Math.max(4, hex.length), '0');
  return `0x…${padded.slice(-4)}`;
}

/** 目标身份一行文案：title + processName + hwnd 短格式（D） */
export function formatTargetIdentity(target: TargetDescriptor): string {
  const title = target.title?.trim() || '(无标题)';
  const proc = target.processName?.trim() || '(未知进程)';
  return `${title} · ${proc} · ${formatHwndShort(target.hwnd)}`;
}
