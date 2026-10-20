/**
 * desk-r1 B — minimal source.enumerate IPC (GrabFrame preflight path).
 * Registers desktopPanel.source.enumerate only; calls A's enumerateSources().
 * Does NOT wire session/state/input/snap/FullRun.
 */
import { ipcMain } from 'electron';
import { DESKTOP_PANEL_IPC } from './channels';
import { enumerateSources } from './captureService';

let wired = false;

/**
 * Register desktopPanel.source.enumerate via A's real capturer enumerateSources().
 * Idempotent; safe alongside registerDesktopCaptureIpc.
 */
export function registerDesktopSourceEnumerateIpc(): void {
  if (wired) return;
  wired = true;

  // Literal sourceEnumerate must survive into out/main/index.js for GrabFrame preflight.
  ipcMain.handle(DESKTOP_PANEL_IPC.sourceEnumerate, () => enumerateSources());
}

export function unregisterDesktopSourceEnumerateIpc(): void {
  if (!wired) return;
  ipcMain.removeHandler(DESKTOP_PANEL_IPC.sourceEnumerate);
  wired = false;
}
