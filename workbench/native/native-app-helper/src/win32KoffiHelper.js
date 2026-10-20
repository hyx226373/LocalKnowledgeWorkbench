'use strict';
/**
 * Win32NativeHelper via koffi — product APIs only.
 * EnumWindows / GetWindowTextW / IsWindowVisible / GetClassNameW / GetWindowRect /
 * GetWindowThreadProcessId / OpenProcess / QueryFullProcessImageNameW / GetProcessTimes /
 * IsWindow / SetParent / SetWindowLong(Ptr) / SetWindowPos / ShowWindow / SetForegroundWindow.
 * No injection, hooks, or exploit paths.
 */

const GW_OWNER = 4;
const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const WS_CHILD = 0x40000000;
const WS_POPUP = 0x80000000;
const WS_CAPTION = 0x00c00000;
const WS_THICKFRAME = 0x00040000;
const WS_SYSMENU = 0x00080000;
const WS_MINIMIZEBOX = 0x00020000;
const WS_MAXIMIZEBOX = 0x00010000;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_APPWINDOW = 0x00040000;
const SW_HIDE = 0;
const SW_SHOW = 5;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;
const SWP_SHOWWINDOW = 0x0040;
const HWND_TOP = 0;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
/** 100-ns ticks from 1601-01-01 → Unix ms */
const FILETIME_UNIX_MS_OFFSET = 11644473600000n;

const KNOWN_EXES = ['notepad++.exe', 'notepad.exe'];

function hwndToString(hwnd) {
  if (hwnd == null || hwnd === 0 || hwnd === 0n) return '0';
  if (typeof hwnd === 'bigint') return hwnd.toString();
  if (typeof hwnd === 'number') return String(Math.trunc(hwnd));
  // l2fix: koffi returns void* as External objects; String(obj) threw -> every candidate dropped
  if (typeof hwnd === 'object') {
    try {
      const k = hwndToString._koffi || require('koffi');
      const a = k.address(hwnd);
      return a ? a.toString() : '0';
    } catch {
      return '0';
    }
  }
  return String(hwnd);
}
hwndToString.l2fix = 'l2fix: koffi';

function parseHwnd(s) {
  if (s == null || s === '' || s === '0') return 0n;
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}

function fileTimeBufToUnixMs(buf) {
  const low = BigInt(buf.readUInt32LE(0));
  const high = BigInt(buf.readUInt32LE(4));
  const ticks = (high << 32n) | low;
  return Number(ticks / 10000n - FILETIME_UNIX_MS_OFFSET);
}

function readWString(buf, charCount) {
  if (!charCount || charCount <= 0) {
    const raw = buf.toString('utf16le');
    const z = raw.indexOf('\0');
    return z >= 0 ? raw.slice(0, z) : raw;
  }
  return buf.toString('utf16le', 0, charCount * 2);
}

/**
 * host-r1 L2 fix: canonical exe path for allowlist compare.
 * Strips Win32 namespace prefixes (\\?\ / \\.\), unifies slashes, lowercases.
 */
function normalizeExePath(exePath) {
  let p = String(exePath || '').trim().replace(/\//g, '\\');
  if (p.startsWith('\\\\?\\UNC\\')) p = '\\\\' + p.slice(8);
  else if (p.startsWith('\\\\?\\') || p.startsWith('\\\\.\\')) p = p.slice(4);
  return p.toLowerCase();
}

/**
 * host-r1 L2 fix: koffi returns void* callback args as bigint (3.x) or External (2.x).
 * Normalise to bigint so every downstream call and hwndToString agree.
 */
function toHwndValue(koffi, hw) {
  if (typeof hw === 'bigint') return hw;
  if (typeof hw === 'number') return BigInt(Math.trunc(hw));
  if (hw && koffi && typeof koffi.address === 'function') {
    try {
      const a = koffi.address(hw);
      return typeof a === 'bigint' ? a : BigInt(a);
    } catch {
      /* fall through */
    }
  }
  return hw;
}

function pathLooksKnown(exePath) {
  const p = normalizeExePath(exePath);
  return KNOWN_EXES.some((e) => p.endsWith('\\' + e) || p.endsWith(e));
}

class Win32KoffiHelper {
  /**
   * @param {typeof import('koffi')} koffi
   */
  constructor(koffi) {
    this.platform = 'win32';
    this._koffi = koffi;
    hwndToString._koffi = koffi;
    /** @type {Map<string, { style: number|bigint, exStyle: number|bigint }>} */
    this._attachMeta = new Map();
    this._loadApis();
  }

  isSupported() {
    return true;
  }

  _loadApis() {
    const koffi = this._koffi;
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');

    this._RECT = koffi.struct('RECT', {
      left: 'long',
      top: 'long',
      right: 'long',
      bottom: 'long',
    });

    this._WNDENUMPROC = koffi.proto(
      'bool __stdcall WNDENUMPROC(void *hwnd, intptr_t lParam)',
    );

    this.EnumWindows = user32.func(
      'bool __stdcall EnumWindows(WNDENUMPROC *lpEnumFunc, intptr_t lParam)',
    );
    this.IsWindow = user32.func('bool __stdcall IsWindow(void *hWnd)');
    this.IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void *hWnd)');
    this.GetWindow = user32.func('void * __stdcall GetWindow(void *hWnd, uint32 uCmd)');
    this.GetWindowTextLengthW = user32.func('int __stdcall GetWindowTextLengthW(void *hWnd)');
    this.GetWindowTextW = user32.func(
      'int __stdcall GetWindowTextW(void *hWnd, void *lpString, int nMaxCount)',
    );
    this.GetClassNameW = user32.func(
      'int __stdcall GetClassNameW(void *hWnd, void *lpClassName, int nMaxCount)',
    );
    // _Out_ required so koffi marshals filled RECT / DWORD back to JS
    this.GetWindowRect = user32.func(
      'bool __stdcall GetWindowRect(void *hWnd, _Out_ RECT *lpRect)',
    );
    this.GetWindowThreadProcessId = user32.func(
      'uint32 __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32 *lpdwProcessId)',
    );
    this.GetWindowLongPtrW = user32.func(
      'intptr_t __stdcall GetWindowLongPtrW(void *hWnd, int nIndex)',
    );
    this.SetWindowLongPtrW = user32.func(
      'intptr_t __stdcall SetWindowLongPtrW(void *hWnd, int nIndex, intptr_t dwNewLong)',
    );
    this.GetParent = user32.func('void * __stdcall GetParent(void *hWnd)');
    this.SetParent = user32.func('void * __stdcall SetParent(void *hWndChild, void *hWndNewParent)');
    this.SetWindowPos = user32.func(
      'bool __stdcall SetWindowPos(void *hWnd, void *hWndInsertAfter, int X, int Y, int cx, int cy, uint32 uFlags)',
    );
    this.ShowWindow = user32.func('bool __stdcall ShowWindow(void *hWnd, int nCmdShow)');
    this.SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(void *hWnd)');
    this.BringWindowToTop = user32.func('bool __stdcall BringWindowToTop(void *hWnd)');

    this.OpenProcess = kernel32.func(
      'void * __stdcall OpenProcess(uint32 dwDesiredAccess, bool bInheritHandle, uint32 dwProcessId)',
    );
    this.CloseHandle = kernel32.func('bool __stdcall CloseHandle(void *hObject)');
    // lpdwSize is in/out (capacity in, char count out)
    this.QueryFullProcessImageNameW = kernel32.func(
      'bool __stdcall QueryFullProcessImageNameW(void *hProcess, uint32 dwFlags, void *lpExeName, _Inout_ uint32 *lpdwSize)',
    );
    this.GetProcessTimes = kernel32.func(
      'bool __stdcall GetProcessTimes(void *hProcess, void *lpCreationTime, void *lpExitTime, void *lpKernelTime, void *lpUserTime)',
    );
    this.GetLastError = kernel32.func('uint32 __stdcall GetLastError()');
  }

  _asHwnd(hwndStr) {
    return parseHwnd(hwndStr);
  }

  _getTitle(hwnd) {
    const len = this.GetWindowTextLengthW(hwnd);
    const n = Math.max(len + 1, 1);
    const buf = Buffer.alloc(n * 2 + 4);
    const got = this.GetWindowTextW(hwnd, buf, n);
    return readWString(buf, got);
  }

  _getClassName(hwnd) {
    const buf = Buffer.alloc(512);
    const got = this.GetClassNameW(hwnd, buf, 256);
    return readWString(buf, got);
  }

  _getRect(hwnd) {
    // Prefer Buffer over {} — reliable across koffi versions / Electron
    const buf = Buffer.alloc(16); // 4 x long (LE)
    const ok = this.GetWindowRect(hwnd, buf);
    if (!ok) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }
    const left = buf.readInt32LE(0);
    const top = buf.readInt32LE(4);
    const right = buf.readInt32LE(8);
    const bottom = buf.readInt32LE(12);
    return {
      x: left,
      y: top,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
    };
  }

  _getPid(hwnd) {
    // Buffer out-param (DWORD) — [0] alone fails without _Out_; Buffer always works
    const pidBuf = Buffer.alloc(4);
    this.GetWindowThreadProcessId(hwnd, pidBuf);
    return pidBuf.readUInt32LE(0);
  }

  _openProcess(pid) {
    if (!pid) return null;
    const h = this.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (!h || hwndToString(h) === '0') return null;
    return h;
  }

  _getImagePath(hProcess) {
    // size is inout: capacity (wchar count) in, used count out
    const maxChars = 32768;
    const sizeBuf = Buffer.alloc(4);
    sizeBuf.writeUInt32LE(maxChars, 0);
    const buf = Buffer.alloc(maxChars * 2);
    const ok = this.QueryFullProcessImageNameW(hProcess, 0, buf, sizeBuf);
    if (!ok) return '';
    return readWString(buf, sizeBuf.readUInt32LE(0));
  }

  _getCreateTimeMs(hProcess) {
    const creation = Buffer.alloc(8);
    const exit = Buffer.alloc(8);
    const kernel = Buffer.alloc(8);
    const user = Buffer.alloc(8);
    const ok = this.GetProcessTimes(hProcess, creation, exit, kernel, user);
    if (!ok) return 0;
    return fileTimeBufToUnixMs(creation);
  }

  _style(hwnd) {
    return this.GetWindowLongPtrW(hwnd, GWL_STYLE);
  }

  _exStyle(hwnd) {
    return this.GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
  }

  _toNumber(v) {
    if (typeof v === 'bigint') return Number(v);
    return Number(v) || 0;
  }

  _isToolWindow(exStyle) {
    return (this._toNumber(exStyle) & WS_EX_TOOLWINDOW) !== 0;
  }

  _isAppWindow(exStyle) {
    return (this._toNumber(exStyle) & WS_EX_APPWINDOW) !== 0;
  }

  _hasOwner(hwnd) {
    const owner = this.GetWindow(hwnd, GW_OWNER);
    return owner != null && hwndToString(owner) !== '0';
  }

  /**
   * Build a candidate for one top-level hwnd, or null if filtered out / unreadable.
   */
  _inspectHwnd(hwnd) {
    if (!this.IsWindow(hwnd)) return null;
    const visible = !!this.IsWindowVisible(hwnd);
    if (!visible) return null;
    if (this._hasOwner(hwnd)) return null;

    const ex = this._exStyle(hwnd);
    if (this._isToolWindow(ex) && !this._isAppWindow(ex)) return null;

    const title = this._getTitle(hwnd);
    const className = this._getClassName(hwnd);
    const pid = this._getPid(hwnd);
    let exePath = '';
    let createTime = 0;
    const hProc = this._openProcess(pid);
    if (hProc) {
      try {
        exePath = this._getImagePath(hProc);
        createTime = this._getCreateTimeMs(hProc);
      } finally {
        this.CloseHandle(hProc);
      }
    }

    const known = pathLooksKnown(exePath);
    if (!known && (!title || !title.trim())) return null;
    // host-r1 L2 fix: list must carry a full identity (attach requires createTime).
    if (!pid || !exePath || !(createTime > 0)) {
      this._lastSkipNoIdentity = (this._lastSkipNoIdentity || 0) + 1;
      return null;
    }

    return {
      hwnd: hwndToString(hwnd),
      pid,
      createTime,
      path: exePath,
      title,
      className,
      bounds: this._getRect(hwnd),
      visible: true,
    };
  }

  async listTopLevelWindows() {
    const koffi = this._koffi;
    /** @type {any[]} */
    const hwnds = [];
    const cb = koffi.register((hwnd, _lp) => {
      hwnds.push(toHwndValue(koffi, hwnd));
      return true;
    }, koffi.pointer(this._WNDENUMPROC));
    try {
      const ok = this.EnumWindows(cb, 0);
      if (!ok) {
        const err = new Error(`EnumWindows failed (GetLastError=${this.GetLastError()})`);
        err.code = 'ENUM_FAILED';
        throw err;
      }
    } finally {
      koffi.unregister(cb);
    }

    return this._collectCandidates(hwnds);
  }

  /**
   * host-r1 L2 fix: per-hwnd errors used to be swallowed silently, so a systematic
   * marshalling failure (e.g. koffi _Out_ typed-pointer + Buffer) produced candidates=[].
   * Now: errors are counted into lastListDiagnostics; if every hwnd failed, throw ENUM_FAILED.
   */
  _collectCandidates(hwnds) {
    const out = [];
    const diag = { enumerated: hwnds.length, candidates: 0, errors: 0, skippedNoIdentity: 0, firstError: null };
    this._lastSkipNoIdentity = 0;
    for (const hwnd of hwnds) {
      try {
        const c = this._inspectHwnd(hwnd);
        if (c) out.push(c);
      } catch (e) {
        diag.errors++;
        if (!diag.firstError) diag.firstError = String((e && e.message) || e);
      }
    }
    diag.candidates = out.length;
    diag.skippedNoIdentity = this._lastSkipNoIdentity || 0;
    this.lastListDiagnostics = diag;
    if (hwnds.length > 0 && out.length === 0 && diag.errors > 0) {
      const err = new Error('host.list: every window inspect failed (' + diag.errors + '/' + hwnds.length + '): ' + diag.firstError);
      err.code = 'ENUM_FAILED';
      throw err;
    }
    return out;
  }

  async isAlive(hwndStr) {
    const hwnd = this._asHwnd(hwndStr);
    if (hwnd === 0n) return false;
    return !!this.IsWindow(hwnd);
  }

  async readIdentity(hwndStr) {
    const hwnd = this._asHwnd(hwndStr);
    if (!this.IsWindow(hwnd)) {
      const err = new Error(`hwnd ${hwndStr} gone`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    const pid = this._getPid(hwnd);
    let path = '';
    let createTime = 0;
    const hProc = this._openProcess(pid);
    if (!hProc) {
      const err = new Error(`OpenProcess failed for pid ${pid}`);
      err.code = 'OS_ERROR';
      throw err;
    }
    try {
      path = this._getImagePath(hProc);
      createTime = this._getCreateTimeMs(hProc);
    } finally {
      this.CloseHandle(hProc);
    }
    return { hwnd: hwndToString(hwnd), pid, createTime, path };
  }

  async attach(hwndStr, parent) {
    const hwnd = this._asHwnd(hwndStr);
    if (!this.IsWindow(hwnd)) {
      const err = new Error(`hwnd ${hwndStr} gone`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    const parentHwnd = this._asHwnd(parent && parent.hwnd);
    const prevParent = this.GetParent(hwnd);
    const originalParentHwnd = hwndToString(prevParent);

    const style = this._style(hwnd);
    const exStyle = this._exStyle(hwnd);
    this._attachMeta.set(hwndToString(hwnd), { style, exStyle });

    // Product embed: child style under Electron content HWND when parent is non-zero.
    if (parentHwnd !== 0n) {
      let nextStyle = this._toNumber(style);
      nextStyle = (nextStyle & ~WS_POPUP) | WS_CHILD;
      // Keep caption/thickframe off for embedded child look; caller may still SetWindowPos.
      nextStyle =
        nextStyle &
        ~(WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX);
      this.SetWindowLongPtrW(hwnd, GWL_STYLE, nextStyle);
      const set = this.SetParent(hwnd, parentHwnd);
      if (set == null && this.GetLastError()) {
        // SetParent returns previous parent; null/0 can be valid. Only fail if window gone.
        if (!this.IsWindow(hwnd)) {
          const err = new Error('SetParent failed — window gone');
          err.code = 'OS_ERROR';
          throw err;
        }
      }
      this.SetWindowPos(
        hwnd,
        HWND_TOP,
        0,
        0,
        0,
        0,
        SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_SHOWWINDOW,
      );
    } else {
      // Identity-only / best-effort attach without embed parent (L1 list+identity gate).
      this.SetParent(hwnd, 0);
    }

    return { originalParentHwnd };
  }

  async detach(hwndStr, originalParentHwnd) {
    const hwnd = this._asHwnd(hwndStr);
    if (!this.IsWindow(hwnd)) return; // idempotent
    const restoreParent = this._asHwnd(originalParentHwnd);
    this.SetParent(hwnd, restoreParent === 0n ? 0 : restoreParent);
    const meta = this._attachMeta.get(hwndToString(hwnd));
    if (meta) {
      this.SetWindowLongPtrW(hwnd, GWL_STYLE, meta.style);
      this.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, meta.exStyle);
      this._attachMeta.delete(hwndToString(hwnd));
    }
    this.SetWindowPos(
      hwnd,
      HWND_TOP,
      0,
      0,
      0,
      0,
      SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_SHOWWINDOW,
    );
    this.ShowWindow(hwnd, SW_SHOW);
  }

  async setBounds(hwndStr, bounds) {
    const hwnd = this._asHwnd(hwndStr);
    if (!this.IsWindow(hwnd)) {
      const err = new Error(`hwnd ${hwndStr} gone`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    const x = Math.trunc(bounds.x);
    const y = Math.trunc(bounds.y);
    const w = Math.max(0, Math.trunc(bounds.width));
    const h = Math.max(0, Math.trunc(bounds.height));
    const ok = this.SetWindowPos(hwnd, HWND_TOP, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
    if (!ok) {
      const err = new Error(`SetWindowPos failed (GetLastError=${this.GetLastError()})`);
      err.code = 'OS_ERROR';
      throw err;
    }
  }

  async setVisible(hwndStr, visible) {
    const hwnd = this._asHwnd(hwndStr);
    if (!this.IsWindow(hwnd)) {
      const err = new Error(`hwnd ${hwndStr} gone`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    this.ShowWindow(hwnd, visible ? SW_SHOW : SW_HIDE);
  }

  async activate(hwndStr) {
    const hwnd = this._asHwnd(hwndStr);
    if (!this.IsWindow(hwnd)) {
      const err = new Error(`hwnd ${hwndStr} gone`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    this.ShowWindow(hwnd, SW_SHOW);
    this.BringWindowToTop(hwnd);
    this.SetForegroundWindow(hwnd);
  }
}

module.exports = { Win32KoffiHelper, hwndToString, parseHwnd, pathLooksKnown, normalizeExePath, toHwndValue };
