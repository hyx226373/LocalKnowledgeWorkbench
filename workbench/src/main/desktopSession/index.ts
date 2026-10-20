/**
 * desk-r1 A — desktopSession entry — capture public surface.
 * Session/state IPC owned by B — A does NOT register session.start|stop / state.get /
 * source.enumerate. Export enumerateSources() for B to wire.
 */
export { sessionManager, SessionManager } from './captureSessionManager';
export type { DesktopSessionRecord } from './captureSessionManager';
export {
  enumerateSources,
  startCapture,
  pauseCapture,
  resumeCapture,
  stopCapture,
  getCaptureStatus,
  onCaptureStatus,
  applyExcludeSelf,
  setExcludeSelfHelper,
  onHostPresentationEvent,
  resolveCaptureId,
} from './captureService';
export { resolveFullscreenGate, isStubFullscreenActive } from './fullscreenGate';
export {
  CAPTURE_IPC,
  DESK_SESSION_IPC,
  DESKTOP_PANEL_IPC,
  DESK_R1_A_TEST_BOOTSTRAP,
  DESK_R1_A_TEST_SET_FULLSCREEN,
} from './channels';
export { registerDesktopCaptureIpc, unregisterDesktopCaptureIpc } from './captureIpc';
export { registerDesktopSourceEnumerateIpc, unregisterDesktopSourceEnumerateIpc } from './sourceEnumerateIpc';
export { registerDesktopCaptureUiIpc, unregisterDesktopCaptureUiIpc, CAPTURE_UI_IPC } from './uiSessionIpc';
export { registerDesktopInputIpc, unregisterDesktopInputIpc, DESK_INPUT_IPC } from './inputIpc';
