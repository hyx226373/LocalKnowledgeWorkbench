/**
 * GrabFrame 收口：UI 面板用 session 启动/停止（无 test hook、不抢前台）。
 * 设置 BrowserWindow._stubFullscreen 以满足 A 全屏门闸；不 setAlwaysOnTop/focus/moveTop。
 */
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { SourceDescriptor } from '../../shared/desktopPanel/types';
import { DESK_R1_STUB_FULLSCREEN_FLAG } from '../../shared/desktopPanel/protocol';
import { sessionManager } from './captureSessionManager';
import { resolveFullscreenGate } from './fullscreenGate';
import * as capture from './captureService';

export const CAPTURE_UI_IPC = {
  start: 'desktopPanel.capture.uiStart',
  stop: 'desktopPanel.capture.uiStop',
} as const;

let wired = false;

function senderWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

function errMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { code?: string; message?: string };
    if (e.code && e.message) return `${e.code}: ${e.message}`;
    if (e.code) return e.code;
    if (e.message) return e.message;
  }
  return err instanceof Error ? err.message : String(err);
}

function applyUiFullscreenGate(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;
  const flagged = win as BrowserWindow & { [DESK_R1_STUB_FULLSCREEN_FLAG]?: boolean };
  // UI panel path: stub gate only — never raise / focus / alwaysOnTop (raise:false).
  flagged[DESK_R1_STUB_FULLSCREEN_FLAG] = true;
}

export function registerDesktopCaptureUiIpc(): void {
  if (wired) return;
  wired = true;

  ipcMain.handle(
    CAPTURE_UI_IPC.start,
    async (event, payload: { source: SourceDescriptor }) => {
      const win = senderWindow(event);
      try {
        if (!payload?.source) {
          return { ok: false as const, error: 'missing_source' };
        }
        applyUiFullscreenGate(win);
        const gate = resolveFullscreenGate(win);
        if (!gate.isFullscreen) {
          return { ok: false as const, error: `fullscreen_required: ${gate.reason}` };
        }
        // Stop any prior A session so uiStart is idempotent for panel re-pick.
        const prev = sessionManager.getSessionId();
        if (prev) {
          try {
            await capture.stopCapture(prev);
          } catch {
            /* ignore */
          }
          sessionManager.invalidate('ui_restart');
        }
        const rec = sessionManager.create(payload.source);
        const status = await capture.startCapture(rec.sessionId, payload.source, { win });
        return {
          ok: true as const,
          sessionId: rec.sessionId,
          source: status.source,
          status,
        };
      } catch (err) {
        return { ok: false as const, error: errMessage(err) };
      }
    },
  );

  ipcMain.handle(CAPTURE_UI_IPC.stop, async (_e, payload?: { sessionId?: string }) => {
    try {
      const sid = payload?.sessionId ?? sessionManager.getSessionId();
      if (sid) {
        try {
          await capture.stopCapture(sid);
        } catch {
          /* ignore */
        }
        sessionManager.invalidate('ui_stop');
      }
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: errMessage(err) };
    }
  });
}

export function unregisterDesktopCaptureUiIpc(): void {
  if (!wired) return;
  ipcMain.removeHandler(CAPTURE_UI_IPC.start);
  ipcMain.removeHandler(CAPTURE_UI_IPC.stop);
  wired = false;
}
