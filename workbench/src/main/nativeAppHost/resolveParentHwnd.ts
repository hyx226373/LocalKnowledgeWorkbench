/**
 * Resolve Electron BrowserWindow → content HWND (decimal string) for native attach.
 *
 * Product embed parent is this HWND from getNativeWindowHandle() (Electron native
 * window handle), not a persisted value. Never write hwnd into workspace layout /
 * disk state — resolve fresh on each attach.
 *
 * Win32-only semantics. Manager: getNativeWindowHandle() is sufficient; no
 * FindWindowEx chrome-child digging unless docs require it.
 */

/** Duck-typed BrowserWindow surface (avoid hard electron import in unit tests). */
export type BrowserWindowLike = {
  isDestroyed?: () => boolean;
  getNativeWindowHandle: () => Buffer;
};

/**
 * Convert Electron getNativeWindowHandle() Buffer → HWND decimal string.
 * Win32 only semantics; returns null if empty/zero.
 *
 * Electron Buffer is pointer-sized LE: prefer 8-byte BigUInt64LE on 64-bit
 * Windows even when high bits are 0; fall back to 4-byte UInt32LE.
 */
export function nativeHandleBufferToHwnd(buf: Buffer | null | undefined): string | null {
  if (!buf || buf.length === 0) return null;
  try {
    if (buf.length >= 8) {
      const v = buf.readBigUInt64LE(0);
      if (v === 0n) return null;
      return String(v);
    }
    if (buf.length >= 4) {
      const v = buf.readUInt32LE(0);
      if (v === 0) return null;
      return String(v);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read HWND from a live BrowserWindow.
 * Returns null if destroyed / non-win32 / zero / missing handle.
 */
export function hwndFromBrowserWindow(
  win: BrowserWindowLike | null | undefined,
  opts?: { platform?: NodeJS.Platform },
): string | null {
  const platform = opts?.platform ?? process.platform;
  if (platform !== 'win32') return null;
  if (!win) return null;
  try {
    if (win.isDestroyed?.()) return null;
    const buf = win.getNativeWindowHandle();
    return nativeHandleBufferToHwnd(buf);
  } catch {
    return null;
  }
}

/**
 * Build ParentHwndResolver for integ.
 * `lookupPanelWindow(panelId)` must return the BrowserWindow that hosts that
 * panel's content area (v1: usually the main window; later per-panel).
 * Never cache/persist the hwnd string in disk state.
 */
export function createResolveParentHwnd(
  lookupPanelWindow: (panelId: string) => BrowserWindowLike | null | undefined,
  opts?: { platform?: NodeJS.Platform },
): (panelId: string) => string | null {
  return (panelId: string) => {
    const win = lookupPanelWindow(panelId);
    return hwndFromBrowserWindow(win, opts);
  };
}
