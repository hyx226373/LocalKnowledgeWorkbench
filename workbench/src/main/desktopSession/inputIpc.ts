/**
 * desk-input: Electron IPC wiring for panel real-click / enter mode.
 * Channels: desktopPanel.input.enter | .exit | .pointer
 * - Sender must be a visible, non-minimized BrowserWindow; window blur/hide/close -> exit (releases held buttons).
 * - Active capture session -> source physical rect via screen.dipToScreenRect (win32) else scaleFactor.
 * - Injector: real SendInput (koffi) by default; KB_DESK_INPUT_MOCK=1 -> MockInputInjector (verification, no real mouse).
 * - Never focuses / raises / alwaysOnTop (raise:false kept).
 */
import { BrowserWindow, ipcMain, screen, type IpcMainInvokeEvent } from 'electron';
import { isPanelOnSourceScreen } from '../../shared/desktopPanel/enterState';
import { dipRectToPhysical, virtualDesktopRect, type RectLike } from '../../shared/desktopPanel/inputMap';
import { sessionManager } from './captureSessionManager';
import { DesktopInputController } from './inputController';
import { createSendInputInjector, MockInputInjector, type InputInjector } from './inputInjector';

export const DESK_INPUT_IPC = {
  enter: 'desktopPanel.input.enter',
  exit: 'desktopPanel.input.exit',
  pointer: 'desktopPanel.input.pointer',
} as const;

let wired = false;
let controller: DesktopInputController | null = null;
const hookedWindows = new WeakSet<BrowserWindow>();

function toPhysical(r: RectLike, scaleFactor: number): RectLike {
  if (process.platform === 'win32' && typeof screen.dipToScreenRect === 'function') {
    try { return screen.dipToScreenRect(null, r); } catch { /* fall through */ }
  }
  return dipRectToPhysical(r, scaleFactor);
}

function okSender(event: IpcMainInvokeEvent): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return null;
  return win;
}

export function getDesktopInputController(): DesktopInputController | null {
  return controller;
}

export function registerDesktopInputIpc(opts: { injector?: InputInjector } = {}): void {
  if (wired) return;
  wired = true;
  const injector = opts.injector ?? (process.env.KB_DESK_INPUT_MOCK === '1' ? new MockInputInjector() : createSendInputInjector());
  controller = new DesktopInputController({
    injector,
    now: () => Date.now(),
    getActive: () => {
      const rec = sessionManager.get();
      if (!rec || !rec.source || !rec.capture || rec.capture.status !== 'live') return null;
      return { sessionId: rec.sessionId, source: { kind: 'screen', physRect: toPhysical(rec.source.bounds, rec.source.scaleFactor) } };
    },
    getVirtualDesktop: () => virtualDesktopRect(screen.getAllDisplays().map((d) => toPhysical(d.bounds, d.scaleFactor))),
  });
  const ctl = controller;
  sessionManager.onChange(() => {
    const rec = sessionManager.get();
    if (ctl.entered && (!rec || rec.capture?.status !== 'live')) void ctl.exit('session_changed');
  });

  ipcMain.handle(DESK_INPUT_IPC.enter, (event, payload?: { sessionId?: unknown }) => {
    const win = okSender(event);
    if (!win) return { ok: false, error: 'window_not_interactive' };
    if (!hookedWindows.has(win)) {
      hookedWindows.add(win);
      const out = () => { void ctl.exit('window_blur'); };
      win.on('blur', out);
      win.on('hide', out);
      win.on('minimize', out);
      win.on('closed', out);
    }
    const rec = sessionManager.get();
    if (rec?.source && isPanelOnSourceScreen(win.getBounds(), rec.source.bounds)) {
      return { ok: false, error: 'same_screen', injector: injector.name };
    }
    const r = ctl.enter(payload?.sessionId);
    return { ...r, injector: injector.name };
  });
  ipcMain.handle(DESK_INPUT_IPC.exit, async (_e, payload?: { reason?: unknown }) => ctl.exit(typeof payload?.reason === 'string' ? payload.reason.slice(0, 40) : 'renderer'));
  ipcMain.handle(DESK_INPUT_IPC.pointer, async (event, payload: unknown) => {
    if (!okSender(event)) { await ctl.exit('window_not_interactive'); return { ok: false, error: 'window_not_interactive' }; }
    return ctl.pointer(payload);
  });
}

export function unregisterDesktopInputIpc(): void {
  if (!wired) return;
  ipcMain.removeHandler(DESK_INPUT_IPC.enter);
  ipcMain.removeHandler(DESK_INPUT_IPC.exit);
  ipcMain.removeHandler(DESK_INPUT_IPC.pointer);
  wired = false;
  controller = null;
}