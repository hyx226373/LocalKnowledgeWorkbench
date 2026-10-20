# native-app-helper (host-r1)

Win32 product helper for Electron `native-app-host`, loaded via `createWin32Helper()` → `createHelper()`.

## Install (Windows PC)

```bat
cd /d "D:\workspace\kb\kb-wt-host-r1-native"
npm install koffi
REM or:
cd native\native-app-helper
npm install
```

`koffi` is an **optionalDependency** of this package. Linux box unit tests do not need it (Fake/Stub).

## Product APIs used (documented OS surface only)

| Capability | Win32 API |
|------------|-----------|
| Enumerate top-level windows | `EnumWindows`, `GetWindowTextW`, `IsWindowVisible`, `GetClassNameW` |
| Bounds read | `GetWindowRect` |
| PID | `GetWindowThreadProcessId` |
| Image path | `OpenProcess` + `QueryFullProcessImageNameW` |
| Process create time | `GetProcessTimes` → Unix ms |
| Alive check | `IsWindow` |
| Embed (product) | `SetParent` into Electron content HWND; child style via `SetWindowLongPtrW` / `GWL_STYLE` |
| Bounds write | `SetWindowPos` |
| Show/hide | `ShowWindow` (`SW_HIDE` / `SW_SHOW`) |
| Activate | `SetForegroundWindow` / `BringWindowToTop` (best-effort) |
| Detach | restore `SetParent` + original style |

**Forbidden**: injection, hooks, exploit PoCs, attack procedures.

## Candidate filter

Top-level only (`GW_OWNER == 0`), visible, not tool-window-only (`WS_EX_TOOLWINDOW` without `WS_EX_APPWINDOW`), and either has a non-empty title **or** a known exe (`notepad++.exe`, `notepad.exe`).

## Gate app

Notepad++ (`notepad++.exe`) — enumerate → user selects → attach with identity `hwnd+pid+createTime+path`.

## Non-win32 / missing koffi

`createHelper()` throws (`PLATFORM_UNSUPPORTED` / `HELPER_UNAVAILABLE`). `createWin32Helper()` in TypeScript catches and returns `StubWin32Helper`.
