/**
 * Preload snippet for desk-r1 A — capture IPC under window.desktopPanel.capture.
 *
 * INTEGRATOR (merge, do NOT overwrite B):
 *   // AFTER B exposes desktopPanel:
 *   //   import { getDesktopPanelCaptureSubtree } from './desktopPanelPreload';
 *   //   attach capture: getDesktopPanelCaptureSubtree() onto B's existing object
 *   // OR mount inside B's exposeInMainWorld as: capture: getDesktopPanelCaptureSubtree()
 *
 * A-only worktree (no B preload yet): exposeDesktopPanelWithCapture() mounts { capture }
 * for local testing — never open a second global (no desktopPanelCapture).
 *
 * Method names align with B DesktopPanelCaptureApi (preloadApi.ts @ b3eadd8).
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { CaptureStatus, SourceDescriptor } from '../shared/desktopPanel/types';
import type { DesktopPanelCaptureApi } from '../shared/desktopPanel/preloadApi';
import { DESKTOP_PANEL_IPC } from '../shared/desktopPanel/protocol';

/** Test-only channel (main registers only when DESK_R1_A_TEST_HOOK=1). Harmless if absent. */
const TEST_BOOTSTRAP = 'desktopPanel.capture._testBootstrap';
const TEST_SET_FULLSCREEN = 'desktopPanel.capture._testSetFullscreen';
const TEST_SET_CONTENT_PROTECTION = 'desktopPanel.capture._testSetContentProtection';
/** GrabFrame close: panel session start/stop (main uiSessionIpc; raise:false stub gate). */
const CAPTURE_UI_START = 'desktopPanel.capture.uiStart';
const CAPTURE_UI_STOP = 'desktopPanel.capture.uiStop';

/**
 * Capture subtree matching B DesktopPanelCaptureApi.
 * Prefer exporting this for B merge over exposing a whole desktopPanel object.
 */
export const desktopPanelCaptureApi: DesktopPanelCaptureApi & {
  /** A-local test hook — strip from integrator public patch */
  _testBootstrap?: (payload?: {
    sourceHint?: SourceDescriptor;
  }) => Promise<{ sessionId: string; source: SourceDescriptor }>;
  _testSetFullscreen?: (on: boolean) => Promise<{ ok: boolean; fullscreen: boolean; error?: string }>;
  _testSetContentProtection?: (on: boolean, opts?: { raise?: boolean }) => Promise<Record<string, unknown>>;
} = {
  enumerateSources: (): Promise<SourceDescriptor[]> =>
    ipcRenderer.invoke(DESKTOP_PANEL_IPC.sourceEnumerate),

  captureStart: (sessionId: string, source: SourceDescriptor) =>
    ipcRenderer.invoke(DESKTOP_PANEL_IPC.captureStart, { sessionId, source }),

  capturePause: (sessionId: string, reason?: string) =>
    ipcRenderer.invoke(DESKTOP_PANEL_IPC.capturePause, { sessionId, reason }),

  captureResume: (sessionId: string) =>
    ipcRenderer.invoke(DESKTOP_PANEL_IPC.captureResume, { sessionId }),

  captureStop: (sessionId: string) =>
    ipcRenderer.invoke(DESKTOP_PANEL_IPC.captureStop, { sessionId }),

  captureGetStatus: (sessionId?: string) =>
    ipcRenderer.invoke(DESKTOP_PANEL_IPC.captureGetStatus, { sessionId }),

  onCaptureStatus: (handler: (s: CaptureStatus) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, s: CaptureStatus) => handler(s);
    ipcRenderer.on(DESKTOP_PANEL_IPC.captureStatus, listener);
    return () => ipcRenderer.removeListener(DESKTOP_PANEL_IPC.captureStatus, listener);
  },

  uiStart: (source: SourceDescriptor) =>
    ipcRenderer.invoke(CAPTURE_UI_START, { source }),
  inputEnter: (sessionId: string) => ipcRenderer.invoke('desktopPanel.input.enter', { sessionId }),
  inputExit: (reason?: string) => ipcRenderer.invoke('desktopPanel.input.exit', { reason }),
  inputPointer: (payload: {
    sessionId: string;
    action: 'move' | 'down' | 'up' | 'click' | 'wheel';
    u: number;
    v: number;
    button?: 'left' | 'right' | 'middle';
    wheel?: { vertical: number; horizontal: number };
  }) => ipcRenderer.invoke('desktopPanel.input.pointer', payload),
  uiStop: (sessionId?: string) =>
    ipcRenderer.invoke(CAPTURE_UI_STOP, { sessionId }),

  // Always expose invoke; main only handles when DESK_R1_A_TEST_HOOK=1
  _testBootstrap: (payload?: { sourceHint?: SourceDescriptor }) =>
    ipcRenderer.invoke(TEST_BOOTSTRAP, payload ?? {}),
  _testSetFullscreen: (on: boolean) => ipcRenderer.invoke(TEST_SET_FULLSCREEN, { on: !!on }),
  _testSetContentProtection: (on: boolean, opts?: { raise?: boolean }) => {
    // GrabFrame must pass { raise: false } so content protection stays ON without
    // setAlwaysOnTop/moveTop/focus (captureIpc defaults raise!==false → steals foreground).
    // A-03 keeps calling with one arg → raise omitted → still raises (v2.1 behavior).
    const payload: { on: boolean; raise?: boolean } = { on: !!on };
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'raise')) payload.raise = !!opts.raise;
    return ipcRenderer.invoke(TEST_SET_CONTENT_PROTECTION, payload);
  },
};

/** Preferred export for integrator: merge into B's desktopPanel as `capture`. */
export function getDesktopPanelCaptureSubtree(): DesktopPanelCaptureApi {
  // Strip test hook from the typed public surface returned to integrator merges.
  const { _testBootstrap: _tb, _testSetFullscreen: _tf, _testSetContentProtection: _tcp, ...publicApi } = desktopPanelCaptureApi;
  void _tb; void _tf; void _tcp;
  return publicApi;
}

/**
 * A-only: expose `{ capture }` when B has not yet mounted desktopPanel.
 * Integrator must NOT call this against a tree that already has B's desktopPanel —
 * use getDesktopPanelCaptureSubtree() and merge instead.
 */
export function exposeDesktopPanelWithCapture(): void {
  contextBridge.exposeInMainWorld('desktopPanel', {
    capture: desktopPanelCaptureApi,
  });
}
// window.desktopPanel global type is declared by B in shared/desktopPanel/preloadApi.ts
// (DesktopPanelPreloadApi with optional capture?: DesktopPanelCaptureApi). Do not redeclare here.
