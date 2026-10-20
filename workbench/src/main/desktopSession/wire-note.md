# desk-r1 A — wire note (public-entry rework)

## IPC A registers

- `desktopPanel.capture.start|pause|resume|stop|getStatus`
- event `desktopPanel.capture.status`
- **test-only** (env `DESK_R1_A_TEST_HOOK=1`): `desktopPanel.capture._testBootstrap` (+ setFullscreen / setContentProtection)

## IPC A does NOT register (B-owned)

- `desktopPanel.session.start|stop`
- `desktopPanel.state.get`
- **`desktopPanel.source.enumerate`** — B-only; A exports `enumerateSources()` for B to call

## Public exports (integrator)

- Main: `registerDesktopCaptureIpc`, `onHostPresentationEvent`, `enumerateSources`
- Preload: `getDesktopPanelCaptureSubtree()` — merge into B `desktopPanel.capture`
- Methods: `enumerateSources`, `captureStart`, `capturePause`, `captureResume`, `captureStop`, `captureGetStatus`, `onCaptureStatus`
- pause/resume/stop return `{ ok, error? }`

## excludeSelfOk

- `true` only when C helper `excludeSelf` returns true
- `setContentProtection(true)` always attempted as best-effort

## File note

- Capture session store: `captureSessionManager.ts` (does not collide with B `sessionManager.ts`)
- IPC registration: `captureIpc.ts`