/**
 * desk-r1 A — thin re-export of B DESKTOP_PANEL_IPC (dot style).
 * Do NOT maintain a parallel colon/dot fork. Shared protocol is B-owned.
 */
import { DESKTOP_PANEL_IPC } from '../../shared/desktopPanel/protocol';

export { DESKTOP_PANEL_IPC };

/** Capture invoke / event channels used by A (aliases into DESKTOP_PANEL_IPC). */
export const CAPTURE_IPC = {
  start: DESKTOP_PANEL_IPC.captureStart,
  pause: DESKTOP_PANEL_IPC.capturePause,
  resume: DESKTOP_PANEL_IPC.captureResume,
  stop: DESKTOP_PANEL_IPC.captureStop,
  getStatus: DESKTOP_PANEL_IPC.captureGetStatus,
  status: DESKTOP_PANEL_IPC.captureStatus,
} as const;

/**
 * Session/state channels belong to B.
 * A does NOT register session.start / session.stop / state.get / source.enumerate.
 * source.enumerate is B-only (B may call A's exported enumerateSources()).
 * stateChanged alias kept for optional A-local broadcast during capture tests.
 */
export const DESK_SESSION_IPC = {
  stateChanged: DESKTOP_PANEL_IPC.stateChanged,
} as const;

/** A-local test-only channels; register only when DESK_R1_A_TEST_HOOK=1. */
export const DESK_R1_A_TEST_BOOTSTRAP = 'desktopPanel.capture._testBootstrap' as const;
export const DESK_R1_A_TEST_SET_FULLSCREEN = 'desktopPanel.capture._testSetFullscreen' as const;
export const DESK_R1_A_TEST_SET_CONTENT_PROTECTION = 'desktopPanel.capture._testSetContentProtection' as const;