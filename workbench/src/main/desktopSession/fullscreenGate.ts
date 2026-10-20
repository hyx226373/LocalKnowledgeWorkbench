/**
 * Fullscreen readiness gate for desk-r1 capture.
 * If console fullscreen API is not ready, honor DESK_R1_STUB_FULLSCREEN.
 */
import { BrowserWindow } from 'electron';
import {
  DESK_R1_STUB_FULLSCREEN_ENV,
  DESK_R1_STUB_FULLSCREEN_FLAG,
} from '../../shared/desktopPanel/protocol';

export interface FullscreenGateResult {
  isFullscreen: boolean;
  stub: boolean;
  reason: string;
}

function envStubEnabled(): boolean {
  const v = process.env[DESK_R1_STUB_FULLSCREEN_ENV];
  return v === '1' || v === 'true' || v === 'TRUE';
}

/**
 * Resolve whether desktop capture may leave unavailable.
 * Stub path: env DESK_R1_STUB_FULLSCREEN=1 OR win[DESK_R1_STUB_FULLSCREEN_FLAG] === true.
 */
export function resolveFullscreenGate(win: BrowserWindow | null): FullscreenGateResult {
  if (envStubEnabled()) {
    return {
      isFullscreen: true,
      stub: true,
      reason: `${DESK_R1_STUB_FULLSCREEN_ENV}=1`,
    };
  }

  if (win) {
    const flagged = (win as BrowserWindow & { [DESK_R1_STUB_FULLSCREEN_FLAG]?: boolean })[
      DESK_R1_STUB_FULLSCREEN_FLAG
    ];
    if (flagged === true) {
      return {
        isFullscreen: true,
        stub: true,
        reason: `BrowserWindow.${DESK_R1_STUB_FULLSCREEN_FLAG}=true`,
      };
    }
    if (typeof win.isFullScreen === 'function' && win.isFullScreen()) {
      return { isFullscreen: true, stub: false, reason: 'BrowserWindow.isFullScreen()' };
    }
    // Some hosts use maximized + kiosk-like chrome; do not invent that here.
  }

  return {
    isFullscreen: false,
    stub: false,
    reason: 'console not fullscreen (and no DESK_R1 stub)',
  };
}

export function isStubFullscreenActive(win: BrowserWindow | null): boolean {
  return resolveFullscreenGate(win).stub;
}
