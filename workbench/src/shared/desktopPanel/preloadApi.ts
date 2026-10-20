/**
 * 渲染侧 desktopPanel API 形状（preload 经 contextBridge 暴露为 **唯一** window.desktopPanel）。
 * PRELOAD ADJUDICATION: 禁止另起 window.desktopPanelCapture / 第二全局；
 * A 挂 capture 子命名空间，D LocalTextBridge 对齐 localText 子命名空间。
 * 与 kb 并列，不混入 KbApi。
 *
 * 本文件以 TYPE-FIRST 定形；runtime 嵌套由集成期挂载（不在本提交改 preload/index.ts）。
 */
import type {
  CaptureStatus,
  DesktopPanelError,
  PointerInputPayload,
  SourceDescriptor,
  TargetDescriptor,
  TextInjectMethod,
} from './types';
import type { SessionStartResult, StateSnapshot } from './protocol';

/** A mounts under window.desktopPanel.capture — NOT window.desktopPanelCapture */
export interface DesktopPanelCaptureApi {
  enumerateSources(): Promise<SourceDescriptor[]>;
  captureStart(sessionId: string, source: SourceDescriptor): Promise<CaptureStatus | { ok: boolean; error?: string }>;
  capturePause(sessionId: string, reason?: string): Promise<{ ok: boolean; error?: string }>;
  captureResume(sessionId: string): Promise<{ ok: boolean; error?: string }>;
  captureStop(sessionId: string): Promise<{ ok: boolean; error?: string }>;
  captureGetStatus(sessionId?: string): Promise<CaptureStatus | null>;
  onCaptureStatus(handler: (s: CaptureStatus) => void): () => void;
  /** GrabFrame close: panel UI session (stub gate, raise:false) */
  uiStart?(source: SourceDescriptor): Promise<{
    ok: boolean;
    sessionId?: string;
    source?: SourceDescriptor;
    status?: CaptureStatus;
    error?: string;
  }>;
  uiStop?(sessionId?: string): Promise<{ ok: boolean; error?: string }>;
  /** desk-input: panel enter mode + real pointer (main validates; only while entered) */
  inputEnter?(sessionId: string): Promise<{ ok: boolean; error?: string; injector?: string }>;
  inputExit?(reason?: string): Promise<{ ok: boolean; error?: string }>;
  inputPointer?(payload: {
    sessionId: string;
    action: 'move' | 'down' | 'up' | 'click' | 'wheel';
    u: number;
    v: number;
    button?: 'left' | 'right' | 'middle';
    wheel?: { vertical: number; horizontal: number };
  }): Promise<{ ok: boolean; error?: string; sent?: number; dropped?: string }>;
}

/**
 * D LocalTextBridge aligns under window.desktopPanel.localText.
 * Top-level openLocalInput / inputTextSubmit / … remain for B UI; this namespace
 * is the typed bridge surface D controllers should prefer.
 */
export interface DesktopPanelLocalTextApi {
  openLocalInput(
    target?: TargetDescriptor,
  ): Promise<{ ok: true } | { ok: false; error: DesktopPanelError }>;
  submitLocalText(req: {
    text: string;
    method?: TextInjectMethod;
  }): Promise<
    | { ok: true; cleared?: boolean; method?: TextInjectMethod }
    | { ok: false; error: DesktopPanelError }
  >;
  sendEnter(): Promise<{ ok: true } | { ok: false; error: DesktopPanelError }>;
  returnToDesktopOp(): Promise<{ ok: true } | { ok: false; error: DesktopPanelError }>;
  exitDesktopOp(): Promise<{ ok: true } | { ok: false; error: DesktopPanelError }>;
}

/** C-SEAM: optional pointer/helper surface when real injection lands */
export interface DesktopPanelPointerApi {
  inputPointer(payload: PointerInputPayload): Promise<{ ok: boolean; error?: string }>;
  releaseAll?(reason?: string): Promise<{ ok: boolean; error?: string }>;
}

export interface DesktopPanelPreloadApi {
  sessionStart(sourceHint?: Partial<SourceDescriptor>): Promise<SessionStartResult>;
  sessionStop(): Promise<{ ok: boolean }>;
  stateGet(): Promise<StateSnapshot>;
  enterDesktopOp(opts?: { consumeClick?: boolean }): Promise<{ ok: boolean; error?: string }>;
  exitDesktopOp(): Promise<{ ok: boolean; error?: string }>;
  openLocalInput(target?: TargetDescriptor): Promise<{ ok: boolean; error?: string }>;
  returnToDesktopOp(): Promise<{ ok: boolean; error?: string }>;
  inputPointer(payload: PointerInputPayload): Promise<{ ok: boolean; error?: string }>;
  inputTextSubmit(body: { text: string; sendEnter?: boolean }): Promise<{ ok: boolean; error?: string }>;
  inputSendEnter(): Promise<{ ok: boolean; error?: string }>;
  sourceEnumerate(): Promise<SourceDescriptor[]>;
  metricsUpdate(payload: unknown): Promise<{ ok: boolean }>;
  fullscreenStubGet(): Promise<{ stubFullscreen: boolean; fullscreen: boolean }>;
  fullscreenStubSet(on: boolean): Promise<StateSnapshot>;
  onStateChanged(cb: (snap: StateSnapshot) => void): () => void;
  onCaptureStatus(cb: (status: unknown) => void): () => void;

  /** A ownership — mount capture controls here */
  capture?: DesktopPanelCaptureApi;
  /** D ownership — LocalTextBridge aligns here */
  localText?: DesktopPanelLocalTextApi;
  /** C-SEAM — real pointer/helper later */
  pointer?: DesktopPanelPointerApi;
}

declare global {
  interface Window {
    /** Sole desk-r1 panel bridge; no parallel desktopPanelCapture global */
    desktopPanel?: DesktopPanelPreloadApi;
  }
}
