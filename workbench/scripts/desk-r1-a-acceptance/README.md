# desk-r1-A acceptance (A-01鈥-03) 鈥?round 5

## What `DESK_R1_STUB_FULLSCREEN` stubs

`DESK_R1_STUB_FULLSCREEN=1` makes `resolveFullscreenGate` return `isFullscreen: true` **without** calling real `BrowserWindow.setFullScreen` / console fullscreen. It only stubs the **gate** so capture can leave `unavailable`. It does **not** make the window OS-fullscreen.

**Round-2 FullRun default: stub OFF.** Real fullscreen via test hook `_testSetFullscreen(true)` (requires `DESK_R1_A_TEST_HOOK=1`). Use `-AllowStub` only with an explicit reason printed by the script.

## Modes

| Mode | Command | Shows windows? | When |
| --- | --- | --- | --- |
| **Self-check (default)** | `.\run-acceptance.ps1` | **No** | Always until supervisor says 寮€璺?|
| Full run | `.\run-acceptance.ps1 -FullRun` | Yes | **Only after 寮€璺?* |

Estimated full-run: **5鈥? minutes** (build ~1鈥? min). `-SkipBuild` saves build.

## Full run (after 寮€璺?

1. `DESK_R1_A_TEST_HOOK=1`, **no** stub env (unless `-AllowStub`)
2. Build, start Electron with `--remote-debugging-port=9222`
3. CDP phases:
   - **A-01:** `_testSetFullscreen` 鈫?bootstrap 鈫?`captureStart` 鈫?`getUserMedia(chromeMediaSourceId)` 鈫?video/canvas 鈫?`A-01-stream.png` + frame timestamps
   - **A-02:** stream before / open `out\acceptance\explorer-probe` / stream after 鈫?pixel diff 鈫?`A-02-verdict.json`
   - **A-03:** `a03-arm` (show `#E911E9` marker + window metrics) 鈫?OS `A-03-os-ref.png` scanned for marker 鈫?`A-03-os-gate.json` 鈫?stream judge. **PASS/FAIL only if gateOk** (window visible/on-primary AND OS-ref contains marker); otherwise **INCONCLUSIVE**. `A-03-verdict.txt` is written from the same JSON fields (no stale NEED_HUMAN).
4. OS `CopyFromScreen` 鈫?`A-01-os-ref.png` reference; `A-03-os-ref.png` is an **A-03 gate input** (not optional).
5. Cleanup by recorded Electron pid + explorer path Quit; write `cleanup-log.txt`; re-verify process/CDP gone
6. **Preflight:** if port 9222 (or `-CdpPort`) is already LISTENING 鈫?**immediate error exit** (no launch)

## Constraints

- Never `-FullRun` until **寮€璺?*
- No mouse / DevTools clicks
- Do not push / merge
- Wallpaper evidence stays on PC + box only

## CDP note (2026-10-05)

Chromium/Electron 44 may reject DevTools WebSocket clients without an Origin allowlist
(**銆屾湭纭瘉銆?* as sole historical root cause; keep allowlist as hardening).
FullRun launches Electron with `--remote-debugging-port=9222 --remote-allow-origins=*`.
Without the second flag, some environments fail with `CDP websocket error: unknown`
(undici `#onSocketClose`) and no `A-01-stream.png` is produced.

Cleanup log is overwritten each run with `runId`/timestamp; VERIFY polls after taskkill
and retries `Stop-Process` to avoid false FAIL from the taskkill race. Console is
transcripted to `out/acceptance/fullrun-console.txt` on every FullRun.

## A-03 v2 (positive control + Win32)

`-A03Only` runs only A-03:

1. **Phase 1 (content protection OFF, via test-only `_testSetContentProtection(false)`)**: OS-ref (GDI CopyFromScreen) AND stream frame must both contain `#E911E9` (OS: >=30 hits or ratio>=0.0005 on step-4 samples; stream: ratio>=0.002, tol 8). Either side missing -> `INCONCLUSIVE` (pipeline broken).
2. **Phase 2 (content protection ON)**: no screenshot is used as visibility proof. `win32-window-check.ps1` records `IsWindowVisible`, `IsIconic`, `GetWindowRect` vs primary monitor, `WindowFromPoint(center)` -> `GetAncestor(GA_ROOT)` == our hwnd. All pass + stream markerHits==0 -> `PASS`; stream has marker -> `FAIL`; any Win32 check fails -> `INCONCLUSIVE`.
3. `--phase=a03-verdict` (offline) reads `A-03-p1-*.json` / `A-03-p2-*.json`, writes `A-03-verdict.json`, then renders `A-03-verdict.txt` from that JSON only. Exit 0=PASS 1=FAIL 2=INCONCLUSIVE.

- A-03 v2.1: test hook _testSetContentProtection now also raises the marker window in BOTH phases (setAlwaysOnTop(true,'screen-saver') + moveTop() + focus(), then 300ms settle) before OS-ref/stream/Win32 sampling; recorded as contentProtection.raised. win32-window-check.ps1 samples WindowFromPoint at center + 4 quadrant centers (samples[] in JSON); fail closed: any point whose GA_ROOT != our hwnd -> INCONCLUSIVE. Other judging unchanged.

## GrabFrame (group E Snap Assist)

Independent desktop-frame entry via A CDP path (not OS GDI).

> **Use GrabFrame ONLY via `run-acceptance.ps1 -GrabFrame`** (it launches its own test Electron with the test hook and a free CDP port). Do **not** run `grab-frame.mjs` by hand with `--cdp-port` pointed at the product under test: it stamps the page title, opens a capture track and hides a window in whatever page it connects to.

| Mode | Command | Windows? |
| --- | --- | --- |
| **GrabFrame self-check** | `.\run-acceptance.ps1 -GrabFrame -SelfCheck` | **No** |
| Single | `.\run-acceptance.ps1 -GrabFrame -Out <path.png>` | Yes (content-protected + minimize) |
| Multi | `.\run-acceptance.ps1 -GrabFrame -Out <path.png> -Count N -IntervalMs M` | Yes |
| Keep-alive | `.\run-acceptance.ps1 -GrabFrame -KeepAlive -Out <path.png>` | Yes (one launch; trigger file) |

Keep-alive trigger file: `out\acceptance\grab-trigger` — lines `grab` / `grab <path.png>` / `quit`.
Docs: `汇报\desk-r1-A-acceptance\GrabFrame-用法.md`.
Node: `grab-frame.mjs --self-check` | `--out` | `--keep-alive`.

### E-04 KeepAlive freeze fix (2026-10-06)

- Root cause: each grab did `openStream -> <video> drawImage -> track.stop()`; with the A window minimized the hidden renderer stops painting the `<video>`, so frames froze (MAD=0). Sidecar `minimized` was a page-side guess (always false).
- Now: ONE persistent `getUserMedia` track per process (`window.__deskR1AGrab`), read via `MediaStreamTrackProcessor` (latest `VideoFrame`, per-frame `seq`, `captureTsUs` = `VideoFrame.timestamp`), `ImageCapture.grabFrame()` fallback (`--prefer-image-capture`). Track is stopped only on quit / end of a single run.
- Electron (GrabFrame launch only) gets `--disable-renderer-backgrounding --disable-background-timer-throttling --disable-backgrounding-occluded-windows` (process-level `backgroundThrottling:false`; no product change).
- Window hide is done from Node via Win32 on ONE explicit own hwnd only (v2/v3: `-Hwnd`, else page test hook `_testGetNativeWindowHandle()`, else the unique title marker; if none resolves -> no Win32 action, INCONCLUSIVE): `ShowWindow(SW_SHOWMINNOACTIVE)`; if the freshness check is stale while minimized it falls back to `offscreen` (`SetWindowPos(-32000,-32000)`: not minimized, occludes nothing, does not block WindowFromPoint). `-HideMode offscreen` forces it.
- Sidecar adds `seq, captureTsUs, captureWallMs, frameSource, streamOpens, minimized (Win32 IsIconic, live per frame), minimizedSource, stale, seqDeltaSinceLastGrab, trackState, hideMode, pcMad, freshness`.
- Freshness self-check (default ON for `-KeepAlive` and `-Count>=2`): with own window hidden, 2 grabs >=1.2s apart must advance `seq` + `captureTsUs`, track live, no reopen; with `-PcRoi x,y,w,h` the positive-control ROI MAD must exceed `-PcThreshold` (default 1.0). Otherwise `<out>.freshness.json` + sidecar `stale:true` and **exit 3**.
- New params: `-HideMode minimize|offscreen`, `-PcRoi x,y,w,h`, `-PcThreshold`, `-NoFreshnessCheck` (node: `--hide-mode --pc-roi --pc-threshold --no-freshness-check --freshness-check --prefer-image-capture`).
- Logic lives in `grab-frame-lib.mjs` (side-effect free); tests: `tests/grab-frame-keepalive.test.ts` (mock track, no display).
- Not yet verified on a real machine (no windows opened for this change).

### E-04 v2 (review rework, 2026-10-06)

- **Exit codes** (node and PS1; PS1 propagates and prints `GrabFrame OK` only on 0): `0` ok | `1` error | `2` bad args | `3` **STALE** (any frame, single/multi/keep-alive check) | `4` **INCONCLUSIVE** (freshness unprovable or own window not uniquely identifiable -> hide refused) | `5` **PREFLIGHT** (PS1 only, v7: `out\main\index.js` missing or lacks one of the 6 IPC handlers GrabFrame needs: B `sourceEnumerate`, `CAPTURE_IPC.start`, `CAPTURE_IPC.getStatus`, `DESK_R1_A_TEST_BOOTSTRAP`, `DESK_R1_A_TEST_SET_FULLSCREEN`, `DESK_R1_A_TEST_SET_CONTENT_PROTECTION`; build from the merge stack, e.g. 7134bcb, then `-SkipBuild`).
- **Freshness**: `fresh` requires seq advance AND numeric, advancing `captureTsUs` on both frames (+ track live, no reopen, + ROI MAD > threshold with `--pc-roi`). A missing / non-numeric timestamp is **never** fresh -> `inconclusive` (or `stale` when there is stale evidence).
- **ImageCapture** fallback has no capture timestamp and its `seq` is a per-call counter: `--pc-roi` is **required** (missing -> exit 4 before grabbing; `--prefer-image-capture` without `--pc-roi` -> exit 2). With ROI: unchanged ROI -> STALE, changing ROI -> still INCONCLUSIVE. Only MediaStreamTrackProcessor can yield `fresh`.
- Sidecar: `stale` = true | false | **null** (no check performed / inconclusive); `verdict`; `freshnessCheck` = enabled | not-requested | **disabled-by-flag** (v5 note: `forced-by-flag` is never emitted; `--freshness-check` reports `enabled`) (`-NoFreshnessCheck`, also logged by PS1).
- **Own-window targeting**: Win32 ops act on exactly ONE hwnd, verified `IsWindow` + owned by `--pid`; never on all windows of the pid. Own hwnd = `-Hwnd N` (`--hwnd`, e.g. `BrowserWindow.getNativeWindowHandle()`) > page test hook `_testGetNativeWindowHandle()` > unique per-run `document.title` marker `[GrabFrame-A:<pid>-<nonce>]` matched among the pid's top-level windows (title restored on close). 0 or >1 candidates, foreign hwnd, or own hwnd listed in `-ProtectHwnd a,b` (E panel) -> **refuse to hide, INCONCLUSIVE (exit 4)**, no Win32 action.
- Every Win32 op incl. the pid's full hwnd list is recorded in sidecar `hwndOps[]` and `<out>.freshness.json` (+ `ownWindow`, `ownHwnd`, `titleMarker`). `minimized` = IsIconic(own hwnd).
- Win32 failure: `hideMode` = requested mode, `hideApplied:false`, `hideError`.
- Tests: `tests/grab-frame-cli-e2e.test.ts` runs the real `grab-frame.mjs` main entry against a mock CDP (HTTP + minimal WebSocket + node:vm page) with simulated Win32 (`DESK_R1_GF_WIN32_MOCK`, test-only) — plain Node, no Electron.
- Still not verified on a real machine (no windows opened). If the product blocks `page-title-updated`, the marker will not match -> safe INCONCLUSIVE; pass `-Hwnd`.

### E-04 v3 (review rework 2, 2026-10-06)

- **Cleanup on every exit path**: `grabOnce` and keep-alive run inside `try/finally { closeSession() }`; `main`'s error branch also calls `closeSession()` before `exit 1`. `closeSession()` is idempotent and restores the original `document.title` (removes `[GrabFrame-A:<pid>-<nonce>]`), stops the capture track(s), and undoes every applied hwnd op recorded in `hwndOps[]` only on our own hwnd (v4: by writing back the original `GetWindowPlacement`, see below; no `SW_RESTORE`).
- If the page-side prepare fails internally (e.g. `captureStart` fails) it restores the title itself before throwing.
- **Signals**: `SIGINT`, `SIGTERM`, `SIGBREAK` handlers are registered before `ensureSession` (single and keep-alive). Handler runs `closeSession()` once, then exits **130** (SIGINT) / **143** (SIGTERM) / **149** (SIGBREAK) (128 + signal number). PS1 treats these as errors (no `GrabFrame OK`).
- **Hide failure** (Win32 action not applied) in single/multi with `--no-freshness-check` / no check -> **INCONCLUSIVE exit 4**, same as a refused hide.
- **KeepAlive quit exit code = worst frame seen**: `3` if any frame was STALE, else `4` if any INCONCLUSIVE (incl. a failed grab), else `0`. Per-frame status (`verdict`, `stale`, `exit`) is in **each frame's sidecar JSON** (`<png>.json`). PS1 prints `GrabFrame OK` only on 0 and surfaces 3 / 4 from KeepAlive quit as STALE / INCONCLUSIVE.
- ImageCapture rule unchanged: never fresh (unchanged ROI = STALE, changed ROI = INCONCLUSIVE); only MediaStreamTrackProcessor can be fresh.
- New e2e tests (mock CDP): captureStart fails; multi-frame grab throws midway; SIGINT before keep-alive warm-up; SIGTERM while serving; keep-alive quit after a STALE frame -> 3.

### E-04 v4 (review rework 3, 2026-10-06)

- **Undo restores the real original values.** Before ANY `minimize` / `offscreen` the Win32 helper calls `GetWindowPlacement` and records it in that op's `hwndOps[].placementBefore` (`state` normal|minimized|maximized, `showCmd`, `flags`, `minX/minY` = ptMinPosition, `left/top/right/bottom` = rcNormalPosition). Undo uses the placement recorded before the FIRST hide attempt on that hwnd (so the `minimize failed -> offscreen` fallback also returns to the original position) and writes it back with `SetWindowPlacement`. A window that was already minimized stays minimized.
- **Non-activating.** `showCmd` for undo: normal -> `SW_SHOWNOACTIVATE` (4), minimized -> `SW_SHOWMINNOACTIVE` (7). Never `SW_RESTORE`, never `SetForegroundWindow`. Maximized -> `SW_SHOWMAXIMIZED` (3): Win32 has no non-activating maximize, so an originally maximized window may be activated by undo; this is the only activating case and is visible as `foregroundChanged` in `cleanup.window.hwnds[]` (own hwnd only; for E's foreground-sensitive runs keep the A window un-maximized).
- **Verified.** After `SetWindowPlacement` the helper re-reads the placement; `applied=true` only when state and rcNormalPosition equal the recorded original, else `applied=false` with a reason (`verify: state ...` / `verify: rcNormalPosition (...) != original (...)` / `SetWindowPlacement failed`).
- **Cleanup ordering / timeouts.** `closeSession()` first awaits an in-flight prepare (max 5 s), so a signal during prepare still stops the getUserMedia track; once cleanup has started no further hide action is taken. Cleanup CDP calls use a 5 s timeout (not 120 s). A second SIGINT/SIGTERM/SIGBREAK while cleanup is stuck exits immediately with the same code (130/143/149).

#### Per-frame sidecar `<png>.json` fields (E reads these; names stable)

| Field | Meaning |
| --- | --- |
| `verdict` | `fresh` / `stale` / `inconclusive` / `unchecked` (no freshness check; **not fresh**, see note below the table) |
| `stale` | `true` / `false` / `null` (not checked or inconclusive) |
| `exit` | exit code this frame alone would give (0 / 3 / 4); **1** for a keep-alive grab that failed (sidecar with `verdict:'inconclusive'`, `stale:null`, `error`; counts as INCONCLUSIVE for the quit code) |
| `seq` | frame sequence number of the persistent track (MSTP: advances per new VideoFrame) |
| `captureTsUs` / `captureWallMs` | capture timestamp (`VideoFrame.timestamp`, µs; `null` for ImageCapture) / wall clock of capture |
| `frameSource` | freshness source: `MediaStreamTrackProcessor` (can be fresh) or `ImageCapture` (never fresh) |
| `freshnessCheck` | `enabled` / `not-requested` / `disabled-by-flag` (`forced-by-flag` never appears) |
| `minimized`, `minimizedSource`, `hideMode`, `hideApplied`, `hideError`, `ownHwnd`, `hwndOps[]` | own-window hide state and every Win32 op (incl. `placementBefore/After`, `foregroundBefore/After`) |
| `cleanup` (v4, added after close) | `{ at, title: {ok, reason}, track: {ok, reason}, window: {ok, reason, hwnds: [{hwnd, undo, ok, reason, original, after, foregroundChanged}]} }` |

> **`verdict:'unchecked'` 不代表 fresh**: it only means no freshness check was done. Acceptance and real-machine runs must use `-FreshnessCheck` (`--freshness-check`) or `-Count >= 2` / `-KeepAlive`; the single-frame default and `-NoFreshnessCheck` are debug only and don't count toward acceptance.

`cleanup.title.ok` = page title no longer carries the `[GrabFrame-A:...]` marker; `cleanup.track.ok` = capture track `ended` (or no session was opened); `cleanup.window.ok` = every hidden own hwnd verified back at its original placement (`ok:true, reason:'no hwnd op to undo'` if nothing was hidden). `reason` is `null` on success, else why it failed. The same `cleanup` object is added to `<out>.freshness.json`. Cleanup results do not change the exit code.

### E-04 v5 (review rework 4, 2026-10-06)

- `SetWindowPlacement` keeps `flags & 3` (WPF_SETMINPOSITION | **WPF_RESTORETOMAXIMIZED**); verification also compares `flags & 2` (`verify: flags WPF_RESTORETOMAXIMIZED a != original b`).
- `GetWindowPlacement` return value is checked. On failure `placementBefore = null`, `placementError` is recorded in `hwndOps[]`, and the window is **not touched** (the hide is refused -> hide failed -> INCONCLUSIVE exit 4); `cleanup.window.hwnds[]` carries the reason (`GetWindowPlacement failed ...; window not touched`).
- **Window restore runs first** in cleanup (local synchronous Win32, independent of the page), before awaiting prepare / CDP close. A second signal therefore finds the window already restored; the forced exit re-runs the (idempotent) window restore synchronously and writes `cleanup` with **`forced: true`, `forcedBy: <signal>`** (title/track then show `reason: 'pending (cleanup interrupted)'`).
- **Two signals back to back: the FIRST signal's exit code wins** (e.g. SIGTERM then SIGINT -> 143); the second only forces the exit.
- Whenever an original placement was recorded for our hwnd (any attempted hide op, applied or not), undo compares the current placement once and writes the original back only if different (`cleanup.window.hwnds[].unchanged`). Covers e.g. offscreen where `ShowWindow(4)` already un-minimized the window but `SetWindowPos` failed. Entries also list `attempted` ops.
- **Cleanup-only JSON**: if the run fails before any sidecar / freshness.json was written (e.g. captureStart fails, signal during prepare), cleanup results go to **`<out without .png>.cleanup.json`** (`{ mode: 'cleanup-only', noFrameWritten: true, pid, titleMarker, hwndOps, cleanup }`).
- **DPI**: every Win32 PowerShell payload calls `SetThreadDpiAwarenessContext(-4)` (per-monitor v2) before reading/writing coordinates, so placements are physical pixels at 125% scaling. Failure (older Windows / missing export) is caught and recorded as `dpiAwareness` (`per-monitor-v2` | `failed: ...` | `unavailable: ...`) in `hwndOps[]` and `cleanup.window.hwnds[]`.

#### `<out>.freshness.json` per mode (path = `--out` / `-Out` with `.png` stripped + `.freshness.json`)

| Mode | Written | Updated |
| --- | --- | --- |
| Single (`-Out x.png`, Count 1) | only if the check runs (`--freshness-check`), right after the check, before frames | `cleanup` added on exit (normal, error, signal, forced) |
| Multi (`-Count N>=2`) | after the check (default ON; not written with `-NoFreshnessCheck`) | `cleanup` added on exit (all paths) |
| KeepAlive (`-KeepAlive -Out x.png`) | **always**, at warm-up: the real check result (`verdict`, `performed:true`, `framesGrabbed`, `frameSource`, `attempts[]` with seq/ts/MAD per hide mode); with `-NoFreshnessCheck`: `performed:false`, `verdict:'unchecked'` | `cleanup` added on quit or any cleanup path (error, signal, forced: `cleanup.forced:true`) |

KeepAlive warm-up frame (`frameIndex 0`, `warmup:true`): with the check enabled its `verdict` / `stale` are real (compared with the check's last grab, like every later frame) and `warmupFreshness` holds the warm-up check summary (`verdict, fresh, hideMode, attempts, frameSource`); `unchecked` / `stale:null` only with `-NoFreshnessCheck`.

### E-04 v6 (root-cause fix: static screen, 2026-10-06)

Chromium 152 (Electron 44.5.1) desktop capture delivers **no new frame when the screen is static** (0 Hz: `DesktopCaptureDevice::Core::OnCaptureResult` drops frames whose `updated_region()` is empty; WGC on Win11 24H2+ and DXGI otherwise both report an empty region for unchanged content). So "seq/ts did not advance between two grabs" is not proof of a frozen capture. v6 judges against the hide action instead:

- **Baseline `a` is grabbed BEFORE the hide.** `hideIssuedAt` = page `performance.now()` read via CDP right before the Win32 hide op is launched (`hideIssuedPerfMs`, plus wall-clock ISO `hideIssuedAt` for humans). Then hide, settle (`settleMs`, default 1200 ms), grab `b`.
- **fresh requires ALL of:** (i) `seqAfter > seqBefore`; (ii) `captureTsAfter` (VideoFrame.timestamp of `b`) is later than the hide moment on the same clock; (iii) the hide took effect (`hideApplied`: IsIconic / moved offscreen). Any one missing -> **STALE** (exit 3). Refused hide (own window not identifiable) stays INCONCLUSIVE (exit 4). ImageCapture: unchanged, never fresh.
- **Clock conversion:** the grab session records, for every frame, `offset = performance.now()*1000 at frame arrival - VideoFrame.timestamp` and keeps the minimum (`clockOffsetUs`). Capture always precedes arrival, so the minimum is the tightest estimate of the constant offset between the two clocks (both tick in µs of the same monotonic time base); it over-estimates the true offset by the minimum capture->arrival latency, which would make the hide look earlier, so a fixed **`CLOCK_MARGIN_US` = 50 ms** is added toward STALE: `hideIssuedTsUs = hideIssuedPerfMs*1000 - clockOffsetUs + 50000`, fresh needs `captureTsAfter > hideIssuedTsUs`. Recorded in `clock { method, clockOffsetUs, clockSamples, marginUs }`. (`requestVideoFrameCallback().captureTime` is not available: no `<video>` element in the MSTP path.)
- **`--pc-roi` MAD is informational only** (`pcMad`, `pcMadInformationalOnly:true`); it can never make a frame fresh nor replace (i)-(iii). (Before v6 MAD was an additional requirement, never a substitute.)
- **New sidecar / freshness.json attempt fields:** `seqBefore`, `seqAfter`, `hideIssuedAt`, `hideIssuedPerfMs`, `hideIssuedTsUs`, `captureTsAfter`, `captureTsAfterPerfMs`, `freshBasis` (`seq-advanced+captureTs-after-hide+hide-effective` or `stale:<reasons>`), `clock`. Existing fields unchanged.
- **Which frame is written:** single frame (with the check) writes the post-hide frame `b` itself; multi writes `b` as frame 1; KeepAlive writes `b` as the warm-up frame (frameIndex 0).
- **Frames after that (multi frames 2..N, every KeepAlive `grab`) have no per-frame hide** (the window stays hidden). Each must show a NEW frame vs the previous grab (seq and ts advanced; `freshBasis: 'vs-previous-grab (no per-frame hide)'`). A previous frame's image never counts as fresh: **on a static screen these frames are STALE** and KeepAlive quit exits 3. Per-frame hide/restore cycles were not implemented (would flash our window and disturb E's foreground/Snap state).
- Single frame without `--freshness-check` (public default for `-Count 1`) is unchanged: `verdict:'unchecked'`. **`verdict:'unchecked'` 不代表 fresh**: it only means no freshness check was done. Acceptance and real-machine runs must use `-FreshnessCheck` (`--freshness-check`) or `-Count >= 2` / `-KeepAlive`; the single-frame default and `-NoFreshnessCheck` are debug only and don't count toward acceptance.

### E-04 v8 (raise:false — no foreground steal, 2026-10-13)

GrabFrame prepare used to call `_testSetContentProtection(true)` with no `raise` option. Preload forwarded only `{ on }`, and `captureIpc.ts` treats `payload.raise !== false` as **true** by default → `setAlwaysOnTop(true, 'screen-saver')` + `moveTop()` + `focus()` + 300 ms settle, then **stays on top until A exits**. That steals foreground from E's Win-key / Snap cases and from the user's windows whenever `DESK_R1_A_TEST_HOOK=1` and prepare cannot reuse a live frame.

- **GrabFrame path:** `c._testSetContentProtection(true, { raise: false })`.
- **Preload:** optional second arg `{ raise?: boolean }` is forwarded only when present; one-arg callers (A-03 via `cdp-client.mjs`) still omit `raise` → default raise stays **true** (A-03 v2.1 unchanged).
- **Content protection without always-on-top:** `win.setContentProtection(on)` runs **before** the raise block in `captureIpc.ts` and does not depend on it. With `raise: false`, protection stays ON; alwaysOnTop / moveTop / focus / wait are skipped.
- No PS payload change (no new parsecheck script).
