/**
 * Win32 product helper surface for native window hosting.
 * Documented OS APIs only (EnumWindows, GetWindowThreadProcessId, QueryFullProcessImageName,
 * process create time, SetParent, SetWindowPos, ShowWindow, IsWindow, SetForegroundWindow).
 * No injection / hook / exploit paths.
 *
 * On non-win32: stub returns PLATFORM_UNSUPPORTED so pure TS can be unit-tested on Linux.
 */
import type {
  NativeHostCandidate,
  NativeHostIdentity,
  NativeHostRect,
} from '../../shared/nativeAppHost/types';

export type HelperErrorCode =
  | 'PLATFORM_UNSUPPORTED'
  | 'HELPER_UNAVAILABLE'
  | 'ENUM_FAILED'
  | 'NOT_FOUND'
  | 'OS_ERROR'
  | 'IDENTITY_MISMATCH'
  | 'UNAUTHORIZED';

export class NativeHelperError extends Error {
  constructor(
    readonly code: HelperErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'NativeHelperError';
  }
}

export interface EmbedParent {
  /** Electron BrowserWindow content HWND as decimal string. */
  hwnd: string;
}

export interface Win32NativeHelper {
  readonly platform: NodeJS.Platform;
  isSupported(): boolean;
  listTopLevelWindows(): Promise<NativeHostCandidate[]>;
  /** Verify hwnd still exists (IsWindow). */
  isAlive(hwnd: string): Promise<boolean>;
  /** Re-read identity for hwnd; throws if gone or mismatch. */
  readIdentity(hwnd: string): Promise<NativeHostIdentity>;
  /**
   * Product embed: SetParent(child, electronContentHwnd) + style adjust for child.
   * Returns original parent hwnd for detach restore.
   */
  attach(hwnd: string, parent: EmbedParent): Promise<{ originalParentHwnd: string }>;
  /** Restore parent / top-level style. */
  detach(hwnd: string, originalParentHwnd: string | null): Promise<void>;
  setBounds(hwnd: string, bounds: NativeHostRect): Promise<void>;
  setVisible(hwnd: string, visible: boolean): Promise<void>;
  activate(hwnd: string): Promise<void>;
  /** GetParent(hwnd) as decimal string; "0" if no parent. */
  getParent(hwnd: string): Promise<string>;
  /** GWL_STYLE / GWL_EXSTYLE as numbers. */
  getStyle(hwnd: string): Promise<{ style: number; exStyle: number }>;
  /** GetWindowRect → {x,y,width,height} in screen coords. */
  getBounds(hwnd: string): Promise<NativeHostRect>;
  /** IsWindowVisible. */
  isWindowVisible(hwnd: string): Promise<boolean>;
  /** WindowFromPoint(screenX, screenY) → HWND decimal string ("0" if none). */
  windowFromPoint(x: number, y: number): Promise<string>;
  /** GetClassNameW — e.g. Chrome_RenderWidgetHostHWND diagnostics. */
  getClassName(hwnd: string): Promise<string>;
  /**
   * ChildWindowFromPointEx(parent, clientX, clientY) — hit-test in parent client coords.
   * Preferred embed visibility assert (avoids full-screen WFP false neighbors).
   */
  childWindowFromPoint(parent: string, clientX: number, clientY: number): Promise<string>;
  /** GetClientRect → usually {x:0,y:0,width,height} in client coords. */
  getClientRect(hwnd: string): Promise<NativeHostRect>;
  /** ScreenToClient — convert screen point to hwnd client coords. */
  screenToClient(hwnd: string, pt: { x: number; y: number }): Promise<{ x: number; y: number }>;
  /**
   * SetWindowPos HWND_TOP without SWP_NOZORDER + RedrawWindow.
   * Re-asserts z-order above Chromium siblings after embed.
   */
  bringToTop(hwnd: string): Promise<void>;
  /** True if hwnd === ancestor or IsChild(ancestor, hwnd). */
  isSameOrChild(hwnd: string, ancestor: string): Promise<boolean>;
  /** EnumChildWindows + class names (Chrome_RenderWidgetHostHWND diagnostics). */
  listChildHwnds(parent: string): Promise<Array<{ hwnd: string; className: string }>>;
}

/** Non-Windows / no-helper stub — clear errors, no silent success. */
export class StubWin32Helper implements Win32NativeHelper {
  readonly platform: NodeJS.Platform;
  constructor(platform: NodeJS.Platform = process.platform) {
    this.platform = platform;
  }
  isSupported(): boolean {
    return false;
  }
  private unsupported(op: string): never {
    throw new NativeHelperError(
      'PLATFORM_UNSUPPORTED',
      `native-app-host ${op} requires win32 helper (current platform: ${this.platform})`,
    );
  }
  async listTopLevelWindows(): Promise<NativeHostCandidate[]> {
    this.unsupported('list');
  }
  async isAlive(): Promise<boolean> {
    return false;
  }
  async readIdentity(): Promise<NativeHostIdentity> {
    this.unsupported('readIdentity');
  }
  async attach(): Promise<{ originalParentHwnd: string }> {
    this.unsupported('attach');
  }
  async detach(): Promise<void> {
    this.unsupported('detach');
  }
  async setBounds(): Promise<void> {
    this.unsupported('setBounds');
  }
  async setVisible(): Promise<void> {
    this.unsupported('setVisible');
  }
  async activate(): Promise<void> {
    this.unsupported('activate');
  }
  async getParent(): Promise<string> {
    this.unsupported('getParent');
  }
  async getStyle(): Promise<{ style: number; exStyle: number }> {
    this.unsupported('getStyle');
  }
  async getBounds(): Promise<NativeHostRect> {
    this.unsupported('getBounds');
  }
  async isWindowVisible(): Promise<boolean> {
    return false;
  }
  async windowFromPoint(): Promise<string> {
    this.unsupported('windowFromPoint');
  }
  async getClassName(): Promise<string> {
    this.unsupported('getClassName');
  }
  async childWindowFromPoint(): Promise<string> {
    this.unsupported('childWindowFromPoint');
  }
  async getClientRect(): Promise<NativeHostRect> {
    this.unsupported('getClientRect');
  }
  async screenToClient(): Promise<{ x: number; y: number }> {
    this.unsupported('screenToClient');
  }
  async bringToTop(): Promise<void> {
    this.unsupported('bringToTop');
  }
  async isSameOrChild(): Promise<boolean> {
    this.unsupported('isSameOrChild');
  }
  async listChildHwnds(): Promise<Array<{ hwnd: string; className: string }>> {
    this.unsupported('listChildHwnds');
  }
}

/**
 * In-memory fake helper for unit tests (simulates Notepad++-like window).
 * Not used in production.
 */
export class FakeWin32Helper implements Win32NativeHelper {
  readonly platform: NodeJS.Platform = 'win32';
  windows = new Map<
    string,
    NativeHostCandidate & {
      originalParent?: string;
      parent?: string;
      style?: number;
      exStyle?: number;
      savedStyle?: number;
      savedExStyle?: number;
      /** Client size for getClientRect (defaults to bounds size). */
      clientWidth?: number;
      clientHeight?: number;
      /** Screen origin of client area (for screenToClient / windowFromPoint). */
      clientScreenX?: number;
      clientScreenY?: number;
      /** Z-order among siblings under same parent; higher = closer to top. */
      zOrder?: number;
      children?: string[];
    }
  >();
  killed = new Set<string>();
  /** Synthetic top-of-z stack for windowFromPoint (hwnd strings, last = topmost). */
  zStack: string[] = [];

  isSupported(): boolean {
    return true;
  }

  seed(c: NativeHostCandidate): void {
    // Default top-level-ish style (WS_OVERLAPPEDWINDOW-ish); exStyle 0
    this.windows.set(c.hwnd, {
      ...c,
      style: 0x14cf0000,
      exStyle: 0,
      parent: '0',
      clientWidth: c.bounds.width,
      clientHeight: c.bounds.height,
      clientScreenX: c.bounds.x,
      clientScreenY: c.bounds.y,
      zOrder: 0,
      children: [],
    });
    if (!this.zStack.includes(c.hwnd)) this.zStack.push(c.hwnd);
  }

  /** Seed a parent Electron-like window for embed / windowFromPoint tests. */
  seedParent(
    hwnd: string,
    bounds: NativeHostRect,
    opts?: { className?: string; clientInset?: number },
  ): void {
    const inset = opts?.clientInset ?? 0;
    this.windows.set(hwnd, {
      hwnd,
      pid: 1,
      createTime: 1,
      path: 'C:\\Electron\\electron.exe',
      title: 'host-r1 embed smoke',
      className: opts?.className ?? 'Chrome_WidgetWin_1',
      bounds: { ...bounds },
      visible: true,
      style: 0x14cf0000,
      exStyle: 0,
      parent: '0',
      clientWidth: Math.max(0, bounds.width - inset * 2),
      clientHeight: Math.max(0, bounds.height - inset * 2),
      clientScreenX: bounds.x + inset,
      clientScreenY: bounds.y + inset,
      zOrder: 0,
      children: [],
    });
    if (!this.zStack.includes(hwnd)) this.zStack.push(hwnd);
  }

  /** Simulate force-kill of target process (L4). */
  forceKill(hwnd: string): void {
    this.windows.delete(hwnd);
    this.killed.add(hwnd);
  }

  async listTopLevelWindows(): Promise<NativeHostCandidate[]> {
    return [...this.windows.values()]
      .filter((w) => !w.parent || w.parent === '0')
      .map((w) => ({
        hwnd: w.hwnd,
        pid: w.pid,
        createTime: w.createTime,
        path: w.path,
        title: w.title,
        className: w.className,
        bounds: { ...w.bounds },
        visible: w.visible,
      }));
  }

  async isAlive(hwnd: string): Promise<boolean> {
    return this.windows.has(hwnd) && !this.killed.has(hwnd);
  }

  async readIdentity(hwnd: string): Promise<NativeHostIdentity> {
    const w = this.windows.get(hwnd);
    if (!w) throw new NativeHelperError('NOT_FOUND', `hwnd ${hwnd} gone`);
    return { hwnd: w.hwnd, pid: w.pid, createTime: w.createTime, path: w.path };
  }

  async attach(hwnd: string, parent: EmbedParent): Promise<{ originalParentHwnd: string }> {
    const w = this.windows.get(hwnd);
    if (!w) throw new NativeHelperError('NOT_FOUND', `hwnd ${hwnd} gone`);
    const original = w.parent ?? '0';
    w.originalParent = original;
    w.savedStyle = w.style ?? 0x14cf0000;
    w.savedExStyle = w.exStyle ?? 0;
    w.parent = parent.hwnd;
    // WS_CHILD | WS_VISIBLE; clear popup-ish chrome bits loosely
    w.style = ((w.savedStyle | 0x40000000 | 0x10000000) & ~0x80000000) >>> 0;
    w.visible = true;
    w.zOrder = 1000; // brought to top among siblings
    const p = this.windows.get(parent.hwnd);
    if (p) {
      p.children = [...(p.children ?? []).filter((h) => h !== hwnd), hwnd];
      // Place child in parent client area origin for subsequent setBounds
      w.bounds = {
        x: p.clientScreenX ?? p.bounds.x,
        y: p.clientScreenY ?? p.bounds.y,
        width: w.bounds.width,
        height: w.bounds.height,
      };
    }
    // Move to top of zStack
    this.zStack = this.zStack.filter((h) => h !== hwnd);
    this.zStack.push(hwnd);
    return { originalParentHwnd: original };
  }

  async detach(hwnd: string, originalParentHwnd: string | null): Promise<void> {
    const w = this.windows.get(hwnd);
    if (!w) return; // already gone — detach is idempotent
    w.parent = originalParentHwnd ?? '0';
    if (w.savedStyle != null) {
      w.style = w.savedStyle;
      w.exStyle = w.savedExStyle ?? 0;
      delete w.savedStyle;
      delete w.savedExStyle;
    }
  }

  async setBounds(hwnd: string, bounds: NativeHostRect): Promise<void> {
    const w = this.windows.get(hwnd);
    if (!w) throw new NativeHelperError('NOT_FOUND', `hwnd ${hwnd} gone`);
    // Embedded children: bounds are parent CLIENT coords → convert to screen via parent.
    const parentHwnd = w.parent && w.parent !== '0' ? w.parent : null;
    if (parentHwnd) {
      const p = this.windows.get(parentHwnd);
      if (p) {
        const ox = p.clientScreenX ?? p.bounds.x;
        const oy = p.clientScreenY ?? p.bounds.y;
        w.bounds = {
          x: ox + bounds.x,
          y: oy + bounds.y,
          width: bounds.width,
          height: bounds.height,
        };
      } else {
        w.bounds = { ...bounds };
      }
    } else {
      w.bounds = { ...bounds };
    }
    w.zOrder = (w.zOrder ?? 0) + 1;
    this.zStack = this.zStack.filter((h) => h !== hwnd);
    this.zStack.push(hwnd);
  }

  async setVisible(hwnd: string, visible: boolean): Promise<void> {
    const w = this.windows.get(hwnd);
    if (!w) throw new NativeHelperError('NOT_FOUND', `hwnd ${hwnd} gone`);
    w.visible = visible;
  }

  async activate(hwnd: string): Promise<void> {
    if (!(await this.isAlive(hwnd))) throw new NativeHelperError('NOT_FOUND', `hwnd ${hwnd} gone`);
  }

  async getParent(hwnd: string): Promise<string> {
    const w = this.windows.get(hwnd);
    if (!w) throw new NativeHelperError('NOT_FOUND', `hwnd ${hwnd} gone`);
    return w.parent ?? '0';
  }

  async getStyle(hwnd: string): Promise<{ style: number; exStyle: number }> {
    const w = this.windows.get(hwnd);
    if (!w) throw new NativeHelperError('NOT_FOUND', `hwnd ${hwnd} gone`);
    return { style: w.style ?? 0, exStyle: w.exStyle ?? 0 };
  }

  async getBounds(hwnd: string): Promise<NativeHostRect> {
    const w = this.windows.get(hwnd);
    if (!w) throw new NativeHelperError('NOT_FOUND', `hwnd ${hwnd} gone`);
    return { ...w.bounds };
  }

  async isWindowVisible(hwnd: string): Promise<boolean> {
    const w = this.windows.get(hwnd);
    if (!w || this.killed.has(hwnd)) return false;
    return !!w.visible;
  }

  async windowFromPoint(x: number, y: number): Promise<string> {
    // Walk zStack from top; first whose screen bounds contain the point wins.
    for (let i = this.zStack.length - 1; i >= 0; i--) {
      const hwnd = this.zStack[i]!;
      const w = this.windows.get(hwnd);
      if (!w || !w.visible || this.killed.has(hwnd)) continue;
      const b = w.bounds;
      if (x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height) {
        return hwnd;
      }
    }
    return '0';
  }

  async getClassName(hwnd: string): Promise<string> {
    const w = this.windows.get(hwnd);
    if (!w) throw new NativeHelperError('NOT_FOUND', `hwnd ${hwnd} gone`);
    return w.className ?? '';
  }

  async childWindowFromPoint(parent: string, clientX: number, clientY: number): Promise<string> {
    const p = this.windows.get(parent);
    if (!p) throw new NativeHelperError('NOT_FOUND', `hwnd ${parent} gone`);
    const ox = p.clientScreenX ?? p.bounds.x;
    const oy = p.clientScreenY ?? p.bounds.y;
    return this.windowFromPoint(ox + clientX, oy + clientY);
  }

  async getClientRect(hwnd: string): Promise<NativeHostRect> {
    const w = this.windows.get(hwnd);
    if (!w) throw new NativeHelperError('NOT_FOUND', `hwnd ${hwnd} gone`);
    return {
      x: 0,
      y: 0,
      width: w.clientWidth ?? w.bounds.width,
      height: w.clientHeight ?? w.bounds.height,
    };
  }

  async screenToClient(hwnd: string, pt: { x: number; y: number }): Promise<{ x: number; y: number }> {
    const w = this.windows.get(hwnd);
    if (!w) throw new NativeHelperError('NOT_FOUND', `hwnd ${hwnd} gone`);
    const ox = w.clientScreenX ?? w.bounds.x;
    const oy = w.clientScreenY ?? w.bounds.y;
    return { x: pt.x - ox, y: pt.y - oy };
  }

  async bringToTop(hwnd: string): Promise<void> {
    const w = this.windows.get(hwnd);
    if (!w) throw new NativeHelperError('NOT_FOUND', `hwnd ${hwnd} gone`);
    w.zOrder = (w.zOrder ?? 0) + 1;
    w.visible = true;
    this.zStack = this.zStack.filter((h) => h !== hwnd);
    this.zStack.push(hwnd);
  }

  async isSameOrChild(hwnd: string, ancestor: string): Promise<boolean> {
    if (hwnd === ancestor) return true;
    let cur = this.windows.get(hwnd);
    const seen = new Set<string>();
    while (cur) {
      const p = cur.parent ?? '0';
      if (p === '0') return false;
      if (p === ancestor) return true;
      if (seen.has(p)) return false;
      seen.add(p);
      cur = this.windows.get(p);
    }
    return false;
  }

  async listChildHwnds(parent: string): Promise<Array<{ hwnd: string; className: string }>> {
    const p = this.windows.get(parent);
    if (!p) throw new NativeHelperError('NOT_FOUND', `hwnd ${parent} gone`);
    const kids = p.children ?? [];
    // Also include any window whose parent field matches
    const fromMap = [...this.windows.values()]
      .filter((w) => w.parent === parent)
      .map((w) => w.hwnd);
    const all = [...new Set([...kids, ...fromMap])];
    return all.map((h) => {
      const w = this.windows.get(h);
      return { hwnd: h, className: w?.className ?? '' };
    });
  }
}

/**
 * Factory: real win32 helper when platform is win32 and native bridge is loadable;
 * otherwise StubWin32Helper.
 *
 * The real bridge loads `native/native-app-helper` which exports `createHelper()`
 * (koffi FFI over documented Win32 APIs). On missing koffi / non-win32, falls back to stub.
 */
export function createWin32Helper(opts?: {
  platform?: NodeJS.Platform;
  /** Injected helper for tests. */
  override?: Win32NativeHelper;
}): Win32NativeHelper {
  if (opts?.override) return opts.override;
  const platform = opts?.platform ?? process.platform;
  if (platform !== 'win32') return new StubWin32Helper(platform);
  // Attempt optional native bridge (may be absent until PC build ships the helper).
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bridge = require('../../../native/native-app-helper') as { createHelper?: () => Win32NativeHelper };
    if (typeof bridge.createHelper === 'function') return bridge.createHelper();
  } catch {
    // Helper binary / addon not present yet.
  }
  return new StubWin32Helper(platform);
}
