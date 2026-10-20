/**
 * desk-r1 A — capture IPC wiring (public entry: registerDesktopCaptureIpc).
 * Session/state IPC owned by B — A does NOT register session.start|stop / state.get /
 * source.enumerate. B owns desktopPanel.source.enumerate and may call enumerateSources().
 * Channels: DESKTOP_PANEL_IPC (dot style) via ./channels.ts / shared protocol.
 */
import { BrowserWindow, ipcMain, screen, type IpcMainInvokeEvent } from 'electron';
import type { SourceDescriptor } from '../../shared/desktopPanel/types';
import {
  CAPTURE_IPC,
  DESK_SESSION_IPC,
  DESK_R1_A_TEST_BOOTSTRAP,
  DESK_R1_A_TEST_SET_FULLSCREEN,
  DESK_R1_A_TEST_SET_CONTENT_PROTECTION,
} from './channels';
import { sessionManager } from './captureSessionManager';
import { resolveFullscreenGate } from './fullscreenGate';
import * as capture from './captureService';

let wired = false;
let testHookWired = false;

function senderWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
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

/**
 * Register capture.* IPC only. Does NOT register source.enumerate (B-owned).
 * Call from public entry after registerIpc(); safe alongside wireDesktopSessionIpc.
 */
export function registerDesktopCaptureIpc(): void {
  if (wired) return;
  wired = true;

  capture.onCaptureStatus((status) => {
    broadcast(CAPTURE_IPC.status, status);
  });

  // Optional: best-effort broadcast for A-local listeners (B owns state.changed production).
  sessionManager.onChange((rec) => {
    broadcast(DESK_SESSION_IPC.stateChanged, {
      sessionId: rec.sessionId,
      state: rec.state,
      reason: rec.reason,
      source: rec.source,
      target: undefined,
    });
  });

  // --- capture lifecycle (A ownership) ---
  // pause/resume/stop return { ok, error? }; status pushed via capture.status
  // source.enumerate is NOT registered here — B-only; export enumerateSources() for B to call.
  ipcMain.handle(
    CAPTURE_IPC.start,
    async (event, payload: { sessionId: string; source: SourceDescriptor }) => {
      const win = senderWindow(event);
      try {
        return await capture.startCapture(payload.sessionId, payload.source, { win });
      } catch (err) {
        return { ok: false as const, error: errMessage(err) };
      }
    }
  );

  ipcMain.handle(
    CAPTURE_IPC.pause,
    async (_e, payload: { sessionId: string; reason?: string }) => {
      try {
        await capture.pauseCapture(payload.sessionId, payload.reason ?? 'manual');
        return { ok: true as const };
      } catch (err) {
        return { ok: false as const, error: errMessage(err) };
      }
    }
  );

  ipcMain.handle(
    CAPTURE_IPC.resume,
    async (_e, payload: { sessionId: string }) => {
      try {
        await capture.resumeCapture(payload.sessionId);
        return { ok: true as const };
      } catch (err) {
        return { ok: false as const, error: errMessage(err) };
      }
    }
  );

  ipcMain.handle(
    CAPTURE_IPC.stop,
    async (_e, payload: { sessionId: string }) => {
      try {
        await capture.stopCapture(payload.sessionId);
        return { ok: true as const };
      } catch (err) {
        return { ok: false as const, error: errMessage(err) };
      }
    }
  );

  ipcMain.handle(
    CAPTURE_IPC.getStatus,
    async (_e, payload?: { sessionId?: string }) => {
      return capture.getCaptureStatus(payload?.sessionId);
    }
  );

  // Test-only bootstrap: creates session so captureStart can assertSession.
  // NOT part of public integrator surface. Gated by env.
  if (process.env.DESK_R1_A_TEST_HOOK === '1') {
    testHookWired = true;
    ipcMain.handle(
      DESK_R1_A_TEST_SET_FULLSCREEN,
      async (event, payload?: { on?: boolean }) => {
        const win = senderWindow(event);
        if (!win || win.isDestroyed()) {
          return { ok: false as const, fullscreen: false, error: 'no_window' };
        }
        const on = payload?.on !== false;
        try {
          win.setFullScreen(on);
          return { ok: true as const, fullscreen: win.isFullScreen() };
        } catch (err) {
          return { ok: false as const, fullscreen: false, error: errMessage(err) };
        }
      }
    );
    ipcMain.handle(
      DESK_R1_A_TEST_SET_CONTENT_PROTECTION,
      async (event, payload?: { on?: boolean; raise?: boolean }) => {
        // Test-only (A-03 v2): toggle OS content protection on the sender window and report raw window facts.
        const win = senderWindow(event);
        if (!win || win.isDestroyed()) {
          return { ok: false as const, on: null, error: 'no_window' };
        }
        const on = payload?.on !== false;
        try {
          win.setContentProtection(on);
          // A-03 v2.1 (test hook only): raise marker window above everything, focus, settle 300ms before caller samples.
          const raised = { requested: payload?.raise !== false, alwaysOnTop: false, moveTop: false, focus: false, waitMs: 0 };
          if (raised.requested) {
            try { win.setAlwaysOnTop(true, 'screen-saver'); raised.alwaysOnTop = win.isAlwaysOnTop(); } catch { /* recorded false */ }
            try { win.moveTop(); raised.moveTop = true; } catch { /* recorded false */ }
            try { win.focus(); raised.focus = true; } catch { /* recorded false */ }
            await new Promise((r) => setTimeout(r, 300));
            raised.waitMs = 300;
          }
          let hwnd: string | null = null;
          try {
            const buf = win.getNativeWindowHandle();
            if (buf.length >= 4) {
              const v = buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
              hwnd = `0x${v.toString(16).toUpperCase()}`;
            }
          } catch {
            hwnd = null;
          }
          const bounds = win.getBounds();
          let scaleFactor: number | null = null;
          try {
            scaleFactor = screen.getDisplayMatching(bounds).scaleFactor;
          } catch {
            scaleFactor = null;
          }
          return {
            ok: true as const,
            on,
            raised,
            hwnd,
            pid: process.pid,
            bounds,
            scaleFactor,
            isVisible: win.isVisible(),
            isMinimized: win.isMinimized(),
            isFullScreen: win.isFullScreen(),
            isFocused: win.isFocused(),
          };
        } catch (err) {
          return { ok: false as const, on: null, error: errMessage(err) };
        }
      }
    );
    ipcMain.handle(
      DESK_R1_A_TEST_BOOTSTRAP,
      async (event, payload?: { sourceHint?: SourceDescriptor }) => {
        const win = senderWindow(event);
        const gate = resolveFullscreenGate(win);
        if (!gate.isFullscreen) {
          throw Object.assign(new Error(gate.reason), { code: 'invalid_state' });
        }
        const sources = await capture.enumerateSources();
        const source =
          (payload?.sourceHint
            ? sources.find((s) => s.displayKey === payload.sourceHint!.displayKey)
            : null) ??
          sources[0] ??
          null;
        if (!source) {
          throw Object.assign(new Error('no_capture_source'), { code: 'invalid_target' });
        }
        const rec = sessionManager.create(source);
        return { sessionId: rec.sessionId, source };
      }
    );
  }
}

export function unregisterDesktopCaptureIpc(): void {
  if (!wired) return;
  const channels = [
    CAPTURE_IPC.start,
    CAPTURE_IPC.pause,
    CAPTURE_IPC.resume,
    CAPTURE_IPC.stop,
    CAPTURE_IPC.getStatus,
  ];
  for (const ch of channels) {
    ipcMain.removeHandler(ch);
  }
  if (testHookWired) {
    ipcMain.removeHandler(DESK_R1_A_TEST_BOOTSTRAP);
    ipcMain.removeHandler(DESK_R1_A_TEST_SET_FULLSCREEN);
    ipcMain.removeHandler(DESK_R1_A_TEST_SET_CONTENT_PROTECTION);
    testHookWired = false;
  }
  wired = false;
}