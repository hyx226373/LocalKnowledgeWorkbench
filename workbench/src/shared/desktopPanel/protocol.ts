/**
 * desk-r1 IPC / helper 协议常量（01 §4–§5）。
 * 五组共用：channel 名唯一从此文件导出（desktopPanel.* 点号风格）。
 *
 * ADJUDICATION LOCKED (manager + D confirmed): keep B
 * `stateReturnToDesktopOp` = `desktopPanel.state.returnToDesktopOp`
 * (wired in B main/preload). D renames away from `returnDesktopOp`.
 *
 * C extension seam: HelperRequest.payload is `unknown`; C may extend
 * HelperRequestType / HelperEvent.event via PR against this file when real
 * injection lands — do not fork protocol elsewhere.
 */
import type {
  SessionId,
  SessionState,
  SourceDescriptor,
  TargetDescriptor,
  VideoMetrics,
  CaptureStatus,
} from './types';

export const HELPER_PROTOCOL_VERSION = 1 as const;

export const DESKTOP_PANEL_IPC = {
  sessionStart: 'desktopPanel.session.start',
  sessionStop: 'desktopPanel.session.stop',
  stateGet: 'desktopPanel.state.get',
  stateEnterDesktopOp: 'desktopPanel.state.enterDesktopOp',
  stateExitDesktopOp: 'desktopPanel.state.exitDesktopOp',
  stateOpenLocalInput: 'desktopPanel.state.openLocalInput',
  /** ADJUDICATION LOCKED: returnToDesktopOp (D will rename away from returnDesktopOp) */
  stateReturnToDesktopOp: 'desktopPanel.state.returnToDesktopOp',
  inputPointer: 'desktopPanel.input.pointer',
  inputTextSubmit: 'desktopPanel.input.textSubmit',
  inputSendEnter: 'desktopPanel.input.sendEnter',
  sourceEnumerate: 'desktopPanel.source.enumerate',
  /** A capture lifecycle — point-style (A patch used colon; B authoritative) */
  captureStart: 'desktopPanel.capture.start',
  capturePause: 'desktopPanel.capture.pause',
  captureResume: 'desktopPanel.capture.resume',
  captureStop: 'desktopPanel.capture.stop',
  captureGetStatus: 'desktopPanel.capture.getStatus',
  metricsUpdate: 'desktopPanel.metrics.update',
  /** 主 → 渲染 */
  stateChanged: 'desktopPanel.state.changed',
  captureStatus: 'desktopPanel.capture.status',
  targetChanged: 'desktopPanel.target.changed',
  /** 全屏 stub 探测（B） */
  fullscreenStubGet: 'desktopPanel.fullscreen.stubGet',
  fullscreenStubSet: 'desktopPanel.fullscreen.stubSet',
} as const;

export type DesktopPanelIpcChannel = (typeof DESKTOP_PANEL_IPC)[keyof typeof DESKTOP_PANEL_IPC];

/**
 * Helper request literals (01 §4).
 * C-SEAM: append new literals here (manager-reviewed) when real SendInput /
 * batching / focus helpers land. Keep union single-sourced in this file.
 */
export type HelperRequestType =
  | 'ping'
  | 'session.hello'
  | 'session.close'
  | 'window.list'
  | 'window.atPoint'
  | 'window.get'
  | 'focus.set'
  | 'input.pointer'
  | 'input.key'
  | 'input.text'
  | 'input.releaseAll'
  | 'capture.excludeSelf'
  | 'display.list';
// C-SEAM: append future request literals (e.g. input.pointer.batch) to the union above — do not fork

export interface HelperRequest {
  v: 1;
  id: string;
  sessionId: SessionId;
  type: HelperRequestType;
  /** C-SEAM: typed payloads stay optional/unknown until C lands real injection shapes */
  payload?: unknown;
}

export interface HelperResponse {
  v: 1;
  id: string;
  sessionId: SessionId;
  ok: boolean;
  type: string;
  payload?: unknown;
  error?: { code: string; message: string };
}

export interface HelperEvent {
  v: 1;
  type: 'event';
  event: 'helper.ready' | 'helper.crash' | 'focus.changed' | 'target.invalidated';
  sessionId?: SessionId;
  payload?: unknown;
}

/** B base + D extras: composing | empty_text | helper_unavailable */
export type HelperErrorCode =
  | 'stale_session'
  | 'invalid_state'
  | 'invalid_target'
  | 'focus_failed'
  | 'input_rejected'
  | 'unsupported'
  | 'internal'
  | 'composing'
  | 'empty_text'
  | 'helper_unavailable';

export interface ReleaseAllPayload {
  reason: string;
}

export interface SessionStartResult {
  sessionId: SessionId;
  state: SessionState;
  source: SourceDescriptor | null;
  /** A 组未就绪时 true */
  captureStubbed: boolean;
}

export interface StateSnapshot {
  sessionId: SessionId | null;
  state: SessionState;
  source: SourceDescriptor | null;
  target: TargetDescriptor | null;
  capture: CaptureStatus | null;
  /** 控制台全屏 API 未就绪时使用 stub */
  stubFullscreen: boolean;
  fullscreen: boolean;
}

export interface MetricsUpdatePayload {
  sessionId: SessionId;
  metrics: VideoMetrics;
}

/** A: env / flag for treating console as fullscreen when real API not ready */
export const DESK_R1_STUB_FULLSCREEN_ENV = 'DESK_R1_STUB_FULLSCREEN';
export const DESK_R1_STUB_FULLSCREEN_FLAG = '_stubFullscreen' as const;

/** stdio JSON Lines helper framing（D） */
export function encodeHelperLine(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}

export function parseHelperLine(line: string): unknown {
  const t = line.replace(/\r?\n$/, '');
  if (!t) return null;
  return JSON.parse(t);
}

/** 规范化待发文字为 Unicode NFC（D） */
export function normalizeInjectText(text: string): string {
  return String(text ?? '').normalize('NFC');
}
