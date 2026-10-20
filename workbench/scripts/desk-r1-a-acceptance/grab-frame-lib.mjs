/**
 * grab-frame-lib.mjs — pure / injectable helpers for GrabFrame (desk-r1-A, E-04 KeepAlive freeze fix).
 * No side effects on import (safe for vitest; no display / Electron needed).
 *
 * E-04 root cause (BCDE-live2-P2): keep-alive re-ran openStream -> drawImage(video) -> track.stop() per grab.
 * With the A window minimized (IsIconic), a <video> element in a hidden renderer stops painting, so
 * drawImage() returned the first decoded (stale) frame; sidecar `minimized` was a page-side guess (always false).
 * Fix: ONE persistent MediaStreamTrack per session read via MediaStreamTrackProcessor (VideoFrame.timestamp =
 * capture-source timestamp, per-frame seq) — independent of rendering/visibility — with ImageCapture.grabFrame()
 * fallback; `minimized` from Win32 IsIconic of OUR hwnd; freshness self-check (seq/timestamp + positive-control ROI MAD).
 * v2: missing capture timestamp is never fresh (ImageCapture -> at best INCONCLUSIVE, --pc-roi required);
 * Win32 ops act on ONE explicit hwnd (own window), never on all windows of the pid.
 */

export const SIDECAR_REQUIRED = [
  'ok', 'timestamp', 'width', 'height', 'videoWidth', 'videoHeight', 'pid', 'exit', 'frameIndex',
  'captureId', 'excludeSelfOk', 'contentProtection', 'png', 'mode',
  // E-04 freshness fields
  'seq', 'captureTsUs', 'captureWallMs', 'frameSource', 'streamOpens', 'minimized', 'minimizedSource', 'stale',
  // v2: verdict + freshness provenance + own-window (hwnd) targeting
  'verdict', 'freshnessCheck', 'hideMode', 'hideApplied', 'ownHwnd', 'hwndOps',
];

/** Exit codes (CLI + PS1): 0 ok/fresh, 1 error, 2 bad args, 3 STALE, 4 INCONCLUSIVE. */
export const EXIT = Object.freeze({ OK: 0, ERROR: 1, BAD_ARGS: 2, STALE: 3, INCONCLUSIVE: 4 });

/** Overall exit code for a set of per-frame verdicts: any stale -> 3, else any inconclusive -> 4, else 0. */
export function exitCodeForVerdicts(verdicts) {
  const v = (verdicts || []).map((x) => (x && typeof x === 'object' ? x.verdict : x));
  if (v.includes('stale')) return EXIT.STALE;
  if (v.includes('inconclusive')) return EXIT.INCONCLUSIVE;
  return EXIT.OK;
}

/** Sidecar schema used by E — keep stable (fields only added). */
export function buildSidecar({
  okFlag, pngPath, width, height, videoWidth, videoHeight, pid, exitCode, frameIndex, captureId,
  excludeSelfOk, contentProtection, mode, seq, captureTsUs, captureWallMs, frameSource, streamOpens,
  minimized, minimizedSource, stale, verdict, freshnessCheck, hideMode, hideApplied, hideError, ownHwnd, hwndOps,
  extra, now,
}) {
  return {
    ok: !!okFlag,
    timestamp: new Date(now ?? Date.now()).toISOString(),
    width: width ?? null,
    height: height ?? null,
    videoWidth: videoWidth ?? null,
    videoHeight: videoHeight ?? null,
    pid: pid ?? null,
    exit: exitCode ?? 0,
    frameIndex: frameIndex ?? 0,
    captureId: captureId ?? null,
    excludeSelfOk: excludeSelfOk ?? null,
    contentProtection: contentProtection ?? null,
    png: pngPath,
    mode: mode || 'grab',
    seq: seq ?? null,
    captureTsUs: captureTsUs ?? null,
    captureWallMs: captureWallMs ?? null,
    frameSource: frameSource ?? null,
    streamOpens: streamOpens ?? null,
    minimized: minimized === true ? true : minimized === false ? false : null,
    minimizedSource: minimizedSource || 'unavailable',
    // true = stale detected, false = checked & fresh, null = no freshness check performed / inconclusive
    stale: stale === true ? true : stale === false ? false : null,
    verdict: verdict || (stale === true ? 'stale' : stale === false ? 'fresh' : 'unchecked'),
    freshnessCheck: freshnessCheck ?? 'not-run',
    hideMode: hideMode ?? 'none',
    hideApplied: hideApplied === true,
    hideError: hideError ?? null,
    ownHwnd: ownHwnd ?? null,
    hwndOps: Array.isArray(hwndOps) ? hwndOps : [],
    ...(extra || {}),
  };
}

export function validateSidecarShape(obj) {
  const missing = SIDECAR_REQUIRED.filter((k) => !(k in obj));
  if (missing.length) return { ok: false, missing };
  if (typeof obj.ok !== 'boolean') return { ok: false, missing: ['ok:boolean'] };
  if (typeof obj.timestamp !== 'string' || !obj.timestamp.includes('T')) return { ok: false, missing: ['timestamp:iso'] };
  if (typeof obj.exit !== 'number') return { ok: false, missing: ['exit:number'] };
  if (typeof obj.frameIndex !== 'number') return { ok: false, missing: ['frameIndex:number'] };
  if (typeof obj.png !== 'string') return { ok: false, missing: ['png:string'] };
  if (typeof obj.mode !== 'string') return { ok: false, missing: ['mode:string'] };
  if (obj.minimized !== null && typeof obj.minimized !== 'boolean') return { ok: false, missing: ['minimized:bool|null'] };
  if (obj.stale !== null && typeof obj.stale !== 'boolean') return { ok: false, missing: ['stale:bool|null'] };
  if (!['fresh', 'stale', 'inconclusive', 'unchecked'].includes(obj.verdict)) return { ok: false, missing: ['verdict:enum'] };
  if (typeof obj.hideApplied !== 'boolean') return { ok: false, missing: ['hideApplied:boolean'] };
  if (!Array.isArray(obj.hwndOps)) return { ok: false, missing: ['hwndOps:array'] };
  return { ok: true, missing: [] };
}

/** "x,y,w,h" -> {x,y,w,h} | null */
export function parseRoi(s) {
  if (s == null || s === '') return null;
  const p = String(s).split(',').map((v) => Number(v.trim()));
  if (p.length !== 4 || p.some((v) => !Number.isFinite(v)) || p[2] < 1 || p[3] < 1 || p[0] < 0 || p[1] < 0) {
    throw new Error('--pc-roi must be x,y,w,h (non-negative, w/h>=1)');
  }
  return { x: p[0], y: p[1], w: p[2], h: p[3] };
}

/** Mean absolute difference over RGB channels of two RGBA buffers of equal length. */
export function rgbaMad(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return null;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    n += 3;
  }
  return sum / n;
}

/**
 * Freshness verdict between two grabs a (earlier) and b (later) of the same persistent session.
 * verdict:
 *   'fresh'        seq advanced AND capture timestamp (numeric, both frames) advanced AND track live AND no reopen
 *                  AND (when roi) positive-control ROI MAD > threshold.
 *   'stale'        any positive evidence of a frozen frame (seq/ts not advanced, MAD<=threshold, track ended, reopen).
 *   'inconclusive' no stale evidence but freshness cannot be proven: capture timestamp missing / not a number
 *                  (ImageCapture never has one), or ImageCapture without a positive-control ROI.
 * A missing timestamp is NEVER fresh. ImageCapture's seq is a per-call counter (not a frame counter), so it is ignored.
 */
export function evaluateFreshness({ a, b, roi = null, pcThreshold = 1.0 }) {
  const reasons = [];
  const inconclusive = [];
  if (!a || !b) return { fresh: false, verdict: 'stale', reasons: ['missing-frame'], inconclusiveReasons: [], pcMad: null, seqDelta: null };
  const imageCapture = a.frameSource === 'ImageCapture' || b.frameSource === 'ImageCapture';
  if (imageCapture) {
    inconclusive.push('image-capture-seq-is-call-counter');
    if (!roi) inconclusive.push('image-capture-requires-pc-roi');
  } else if (!(Number(b.seq) > Number(a.seq))) reasons.push('seq-not-advanced');
  const tsA = a.captureTsUs;
  const tsB = b.captureTsUs;
  const tsOk = typeof tsA === 'number' && Number.isFinite(tsA) && typeof tsB === 'number' && Number.isFinite(tsB);
  if (!tsOk) inconclusive.push('capture-ts-missing');
  else if (!(tsB > tsA)) reasons.push('capture-ts-not-advanced');
  if (b.trackState && b.trackState !== 'live') reasons.push('track-not-live:' + b.trackState);
  if (b.streamOpens != null && a.streamOpens != null && b.streamOpens !== a.streamOpens) {
    reasons.push('stream-reopened');
  }
  let pcMad = null;
  if (roi) {
    pcMad = b.pcMad ?? null;
    if (pcMad == null) inconclusive.push('positive-control-mad-unavailable');
    else if (!(pcMad > pcThreshold)) reasons.push(`positive-control-mad<=${pcThreshold}`);
  }
  const verdict = reasons.length ? 'stale' : inconclusive.length ? 'inconclusive' : 'fresh';
  return {
    fresh: verdict === 'fresh', verdict, reasons, inconclusiveReasons: inconclusive, pcMad,
    seqDelta: Number(b.seq) - Number(a.seq),
  };
}

/** v6: margin added to the converted hide time (bias toward STALE): covers the minimum capture->arrival latency by
 *  which the calibrated offset over-estimates the true clock offset. */
export const CLOCK_MARGIN_US = 50000;

/**
 * v6 post-hide freshness (baseline `a` grabbed BEFORE the hide, `b` after hide + settle). fresh requires ALL of:
 *   (i)   seq_b > seq_a (a new frame arrived after the baseline),
 *   (ii)  captureTs_b later than the moment the hide was issued, on the same clock:
 *         hideTsUs = hideIssuedPerfMs*1000 - clockOffsetUs + CLOCK_MARGIN_US, require captureTsUs_b > hideTsUs,
 *         clockOffsetUs = min over frames of (performance.now()*1000 at arrival - VideoFrame.timestamp),
 *   (iii) the hide actually took effect (IsIconic / moved offscreen, hideApplied).
 * Any one missing -> 'stale'. pcMad (with --pc-roi) is informational only and never makes a frame fresh.
 * ImageCapture (no capture timestamp): legacy rule, never fresh (unchanged ROI = stale, changed = inconclusive).
 */
export function evaluatePostHideFreshness({ a, b, hideIssuedPerfMs, hideApplied, roi = null, pcThreshold = 1.0, marginUs = CLOCK_MARGIN_US }) {
  if (!a || !b) return { fresh: false, verdict: 'stale', reasons: ['missing-frame'], inconclusiveReasons: [], pcMad: null, seqDelta: null, freshBasis: 'missing-frame' };
  if (a.frameSource === 'ImageCapture' || b.frameSource === 'ImageCapture') {
    const v = evaluateFreshness({ a, b, roi, pcThreshold });
    return { ...v, fresh: false, verdict: v.verdict === 'fresh' ? 'inconclusive' : v.verdict, freshBasis: 'image-capture-never-fresh' };
  }
  const reasons = [];
  if (!hideApplied) reasons.push('hide-not-effective');
  if (!(Number(b.seq) > Number(a.seq))) reasons.push('seq-not-advanced-after-hide');
  const ts = b.captureTsUs;
  const off = b.clockOffsetUs;
  const hp = hideIssuedPerfMs;
  let hideTsUs = null;
  if (!(typeof ts === 'number' && Number.isFinite(ts))) reasons.push('capture-ts-missing');
  else if (!(typeof off === 'number' && Number.isFinite(off)) || !(typeof hp === 'number' && Number.isFinite(hp))) reasons.push('clock-conversion-unavailable');
  else {
    hideTsUs = hp * 1000 - off + marginUs;
    if (!(ts > hideTsUs)) reasons.push('capture-ts-not-after-hide');
  }
  if (b.trackState && b.trackState !== 'live') reasons.push('track-not-live:' + b.trackState);
  if (b.streamOpens != null && a.streamOpens != null && b.streamOpens !== a.streamOpens) reasons.push('stream-reopened');
  const verdict = reasons.length ? 'stale' : 'fresh';
  return {
    fresh: verdict === 'fresh', verdict, reasons, inconclusiveReasons: [],
    pcMad: roi ? b.pcMad ?? null : null, pcMadInformationalOnly: true, pcThreshold: roi ? pcThreshold : null,
    seqDelta: Number(b.seq) - Number(a.seq),
    seqBefore: a.seq ?? null, seqAfter: b.seq ?? null,
    hideIssuedPerfMs: hp ?? null, hideIssuedTsUs: hideTsUs, captureTsAfter: ts ?? null,
    captureTsAfterPerfMs: typeof ts === 'number' && typeof off === 'number' ? (ts + off) / 1000 : null,
    clock: { method: 'calibrated-min-offset(performance.now at frame arrival - VideoFrame.timestamp)', clockOffsetUs: off ?? null, clockSamples: b.clockSamples ?? null, marginUs },
    freshBasis: verdict === 'fresh' ? 'seq-advanced+captureTs-after-hide+hide-effective' : 'stale:' + reasons.join(','),
  };
}

/** Normalise one window record from win32Script() JSON. */
function normWin(x) {
  return {
    hwnd: Number(x.hwnd), title: x.title == null ? '' : String(x.title), className: x.className == null ? '' : String(x.className),
    iconic: x.iconic === true, visible: x.visible === true,
  };
}

/**
 * Parse JSON printed by win32Script(). `windows` = ALL visible-or-iconic top-level windows of the pid (recorded only);
 * `target` = the single window the op addressed (explicit hwnd) or null for a pure query.
 * minimized = IsIconic(target) when a target is given, otherwise null (we never infer from other windows).
 */
export function parseWin32Result(stdout) {
  const txt = String(stdout || '').trim();
  const start = txt.indexOf('{');
  const empty = { ok: false, minimized: null, windows: [], target: null, applied: false };
  if (start < 0) return { ...empty, error: 'no json' };
  let j;
  try {
    j = JSON.parse(txt.slice(start));
  } catch (e) {
    return { ...empty, error: 'bad json: ' + e.message };
  }
  let w = j.windows;
  if (w == null) w = [];
  if (!Array.isArray(w)) w = [w];
  const windows = w.map(normWin);
  const target = j.target ? normWin(j.target) : null;
  const pl = {
    placementBefore: j.placementBefore ?? null, placementAfter: j.placementAfter ?? null,
    foregroundBefore: j.foregroundBefore ?? null, foregroundAfter: j.foregroundAfter ?? null,
    placementError: j.placementError ?? null, unchanged: j.unchanged === true, dpiAwareness: j.dpiAwareness ?? null,
  };
  if (j.error) return { ...empty, windows, target, action: j.action, error: String(j.error), ...pl };
  return {
    ok: true, action: j.action, windows, target, ...pl,
    minimized: target ? target.iconic : null,
    applied: j.applied === true,
    error: null,
  };
}

/**
 * PowerShell (5.1-compatible, ASCII) for Win32 window ops.
 *   query            enumerate the pid's top-level windows (hwnd, title, class, IsIconic, IsWindowVisible); touches nothing.
 *   minimize|offscreen|restore  act on exactly ONE explicit hwnd, after verifying IsWindow + GetWindowThreadProcessId == pid.
 *                    Never iterates over the pid's windows for an action.
 */
export function win32Script(pidOrOpts, actionArg = 'query') {
  const o = typeof pidOrOpts === 'object' && pidOrOpts !== null ? pidOrOpts : { pid: pidOrOpts, action: actionArg };
  const pid = Number(o.pid);
  const action = o.action || 'query';
  if (!Number.isFinite(pid) || pid <= 0) throw new Error('win32Script: pid required');
  if (!['query', 'minimize', 'offscreen', 'restore'].includes(action)) throw new Error('win32Script: bad action ' + action);
  const hwnd = o.hwnd == null ? 0 : Number(o.hwnd);
  // v4 restore = SetWindowPlacement(original placement recorded by GetWindowPlacement before the first hide), non-activating
  const P = o.placement || null;
  if (action === 'restore') {
    if (!P || !['normal', 'minimized', 'maximized'].includes(P.state)) throw new Error('win32Script: restore requires the recorded original placement');
    for (const k of ['left', 'top', 'right', 'bottom']) if (!Number.isSafeInteger(P[k])) throw new Error('win32Script: placement.' + k + ' must be an integer');
  }
  const rState = P ? P.state : 'normal';
  const rCmd = restoreShowCmd(rState);
  const rNum = (k, d = 0) => (P && Number.isSafeInteger(P[k]) ? P[k] : d);
  if (action !== 'query' && !(Number.isSafeInteger(hwnd) && hwnd > 0)) throw new Error('win32Script: explicit hwnd required for ' + action);
  return `$ErrorActionPreference='Stop'
if (-not ('GfW32c' -as [type])) {
Add-Type -TypeDefinition @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class GfW32c {
  [StructLayout(LayoutKind.Sequential)] public struct PT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RC { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct WP { public int length; public int flags; public int showCmd; public PT ptMin; public PT ptMax; public RC rc; }
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetWindowPlacement(IntPtr h, ref WP p);
  [DllImport("user32.dll")] public static extern bool SetWindowPlacement(IntPtr h, ref WP p);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  public static bool TryGetPl(IntPtr h, out WP p) { p = new WP(); p.length = Marshal.SizeOf(typeof(WP)); return GetWindowPlacement(h, ref p); }
  public static bool SetPl(IntPtr h, int cmd, int flags, int minx, int miny, int l, int t, int r, int b) {
    WP p; if (!TryGetPl(h, out p)) return false;
    p.length = Marshal.SizeOf(typeof(WP)); p.showCmd = cmd; p.flags = flags & 3; p.ptMin.X = minx; p.ptMin.Y = miny; // WPF_SETMINPOSITION(1) | WPF_RESTORETOMAXIMIZED(2)
    p.rc.Left = l; p.rc.Top = t; p.rc.Right = r; p.rc.Bottom = b; return SetWindowPlacement(h, ref p);
  }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  public static List<IntPtr> ForPid(uint tp) {
    var r = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr l) { uint p; GetWindowThreadProcessId(h, out p); if (p == tp && (IsWindowVisible(h) || IsIconic(h))) r.Add(h); return true; }, IntPtr.Zero);
    return r;
  }
}
"@
}
# v5: per-monitor-v2 DPI awareness so placement coordinates are physical pixels (no 125% scaling conversion)
$dpiAwareness = 'unknown'
try { $prevCtx = [GfW32c]::SetThreadDpiAwarenessContext([IntPtr](-4)); if ($prevCtx -eq [IntPtr]::Zero) { $dpiAwareness = 'failed: SetThreadDpiAwarenessContext returned NULL' } else { $dpiAwareness = 'per-monitor-v2' } } catch { $dpiAwareness = 'unavailable: ' + $_.Exception.Message }
$plErr = $null
function Pl($h) {
  $p = New-Object GfW32c+WP
  if (-not [GfW32c]::TryGetPl($h, [ref]$p)) { $script:plErr = 'GetWindowPlacement failed (Win32 error ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error() + ')'; return $null }
  $st = 'normal'; if ([GfW32c]::IsIconic($h)) { $st = 'minimized' } elseif ([GfW32c]::IsZoomed($h)) { $st = 'maximized' }
  [pscustomobject]@{ state = $st; showCmd = $p.showCmd; flags = $p.flags; minX = $p.ptMin.X; minY = $p.ptMin.Y; left = $p.rc.Left; top = $p.rc.Top; right = $p.rc.Right; bottom = $p.rc.Bottom }
}
function Desc($h) {
  $sb = New-Object System.Text.StringBuilder 512; [void][GfW32c]::GetWindowText($h, $sb, 512)
  $cb = New-Object System.Text.StringBuilder 256; [void][GfW32c]::GetClassName($h, $cb, 256)
  [pscustomobject]@{ hwnd = $h.ToInt64(); title = $sb.ToString(); className = $cb.ToString(); iconic = [GfW32c]::IsIconic($h); visible = [GfW32c]::IsWindowVisible($h) }
}
$tpid = ${pid}; $action = '${action}'; $thwnd = [int64]${hwnd}
$rState = '${rState}'; $rCmd = ${rCmd}; $rFlags = ${rNum('flags')}; $rMinX = ${rNum('minX', -1)}; $rMinY = ${rNum('minY', -1)}
$rL = ${rNum('left')}; $rT = ${rNum('top')}; $rR = ${rNum('right')}; $rB = ${rNum('bottom')}
$err = $null; $applied = $false; $target = $null; $before = $null; $after = $null; $unchanged = $false
$fgBefore = [GfW32c]::GetForegroundWindow().ToInt64()
if ($action -ne 'query') {
  $h = [IntPtr]$thwnd
  $owner = [uint32]0
  if (-not [GfW32c]::IsWindow($h)) { $err = 'hwnd not a window' }
  else {
    [void][GfW32c]::GetWindowThreadProcessId($h, [ref]$owner)
    if ($owner -ne [uint32]$tpid) { $err = "hwnd owned by pid $owner not $tpid" }
    elseif ($action -ne 'restore') { $before = Pl $h; if ($null -eq $before) { $err = "$plErr; window not touched (no original placement)" } }
    if ($err) { }
    elseif ($action -eq 'minimize') { [void][GfW32c]::ShowWindow($h, 7); Start-Sleep -Milliseconds 150; $applied = [GfW32c]::IsIconic($h); if (-not $applied) { $err = 'IsIconic false after SW_SHOWMINNOACTIVE' } }
    elseif ($action -eq 'offscreen') { [void][GfW32c]::ShowWindow($h, 4); $applied = [GfW32c]::SetWindowPos($h, [IntPtr]::Zero, -32000, -32000, 0, 0, 0x0015); if (-not $applied) { $err = 'SetWindowPos failed' } }
    elseif ($action -eq 'restore') {
      # non-activating: SetWindowPlacement(showCmd normal->4 SW_SHOWNOACTIVATE, minimized->7 SW_SHOWMINNOACTIVE, maximized->3); never SW_RESTORE / SetForegroundWindow
      # v5: compare current placement with the original once; only write it back if different
      $cur = Pl $h
      $same = ($null -ne $cur) -and ($cur.state -eq $rState) -and ($cur.left -eq $rL) -and ($cur.top -eq $rT) -and ($cur.right -eq $rR) -and ($cur.bottom -eq $rB) -and (($cur.flags -band 2) -eq ($rFlags -band 2))
      $unchanged = $same
      $setOk = $true
      if (-not $same) { $setOk = [GfW32c]::SetPl($h, $rCmd, $rFlags, $rMinX, $rMinY, $rL, $rT, $rR, $rB); Start-Sleep -Milliseconds 100 }
      $after = Pl $h
      if (-not $setOk) { $err = 'SetWindowPlacement failed' }
      elseif ($null -eq $after) { $err = "verify: $plErr" }
      elseif ($after.state -ne $rState) { $err = "verify: state $($after.state) != original $rState" }
      elseif ($after.left -ne $rL -or $after.top -ne $rT -or $after.right -ne $rR -or $after.bottom -ne $rB) { $err = "verify: rcNormalPosition ($($after.left),$($after.top),$($after.right),$($after.bottom)) != original ($rL,$rT,$rR,$rB)" }
      elseif (($after.flags -band 2) -ne ($rFlags -band 2)) { $err = "verify: flags WPF_RESTORETOMAXIMIZED $($after.flags -band 2) != original $($rFlags -band 2)" }
      else { $applied = $true }
    }
    if ([GfW32c]::IsWindow($h)) { $target = Desc $h }
  }
}
$res = @(); foreach ($w in [GfW32c]::ForPid([uint32]$tpid)) { $res += Desc $w }
$fgAfter = [GfW32c]::GetForegroundWindow().ToInt64()
$o = New-Object psobject -Property @{ pid = $tpid; action = $action; hwnd = $thwnd; applied = $applied; error = $err; target = $target; windows = @($res); placementBefore = $before; placementAfter = $after; placementError = $plErr; unchanged = $unchanged; dpiAwareness = $dpiAwareness; foregroundBefore = $fgBefore; foregroundAfter = $fgAfter }
$o | ConvertTo-Json -Compress -Depth 4
`;
}

/**
 * v4: showCmd used to put a window back into its ORIGINAL state without activating it.
 * normal -> SW_SHOWNOACTIVATE (4); minimized -> SW_SHOWMINNOACTIVE (7); maximized -> SW_SHOWMAXIMIZED (3): Win32 has no
 * non-activating maximize, so an originally maximized window may be activated by undo (documented; reported in hwndOps).
 */
export function restoreShowCmd(state) {
  return state === 'minimized' ? 7 : state === 'maximized' ? 3 : 4;
}

/** Unique per-run window title marker set by the GrabFrame page (document.title) to find OUR top-level window. */
export function makeTitleMarker(nonce) {
  return `[GrabFrame-A:${nonce}]`;
}

/**
 * Pick OUR window among the pid's top-level windows. Priority: explicit --hwnd > page test-hook hwnd > unique title marker.
 * Refuses (ok:false) when: no candidate, >1 candidates (ambiguous), the hwnd is not one of the pid's windows,
 * or the candidate is a protected (E panel) hwnd -> caller must NOT hide and must report INCONCLUSIVE.
 */
export function selectOwnWindow(windows, { hwnd = null, hwndSource = null, titleMarker = null, protectHwnds = [] } = {}) {
  const ws = (windows || []).map(normWin);
  const listed = ws.map((w) => w.hwnd);
  const prot = (protectHwnds || []).map(Number).filter(Number.isFinite);
  const refuse = (reason, extra) => ({ ok: false, hwnd: null, source: null, reason, windows: listed, ...(extra || {}) });
  let cand = [];
  let source = null;
  if (hwnd != null && Number(hwnd) > 0) {
    source = hwndSource || 'explicit';
    cand = ws.filter((w) => w.hwnd === Number(hwnd));
    if (!cand.length) return refuse(`hwnd ${hwnd} (${source}) is not a top-level window of the pid`);
  } else if (titleMarker) {
    source = 'title-marker';
    cand = ws.filter((w) => w.title.includes(titleMarker));
    if (!cand.length) return refuse(`no window title contains marker ${titleMarker}`);
    if (cand.length > 1) return refuse(`ambiguous: ${cand.length} windows carry marker ${titleMarker}`, { candidates: cand.map((w) => w.hwnd) });
  } else {
    return refuse('no hwnd / title marker to identify own window');
  }
  const own = cand[0];
  if (prot.includes(own.hwnd)) {
    return refuse(`own window ${own.hwnd} is also a protected (E panel) hwnd: cannot separate E panel from ours`);
  }
  return { ok: true, hwnd: own.hwnd, source, reason: null, windows: listed, others: listed.filter((h) => h !== own.hwnd), own };
}

/** Test-only Win32 simulator (state = { pid, windows:[{hwnd,pid,title,className,iconic,visible,x,y}] }). Mutates state. */
/** Mock placement (GetWindowPlacement model) for simulateWin32: state + rcNormalPosition. */
function simPlacement(w) {
  if (!w.placement) {
    const x = Number.isFinite(w.x) ? w.x : 0; const y = Number.isFinite(w.y) ? w.y : 0;
    w.placement = { state: w.iconic ? 'minimized' : w.maximized ? 'maximized' : 'normal', showCmd: w.iconic ? 2 : w.maximized ? 3 : 1, flags: 0, minX: -1, minY: -1, left: x, top: y, right: x + 800, bottom: y + 600 };
  }
  return w.placement;
}

export function simulateWin32(state, { pid, action = 'query', hwnd = null, placement = null }) {
  const mine = state.windows.filter((w) => Number(w.pid ?? state.pid) === Number(pid) && (w.visible || w.iconic));
  let err = null; let applied = false; let target = null; let before = null; let after = null; let plErr = null; let unchanged = false;
  const fgBefore = state.foreground ?? null;
  const dpiAwareness = state.dpiFail ? 'unavailable: simulated' : 'per-monitor-v2';
  const plFails = (w) => state.failGetPlacement === true || (Array.isArray(state.failGetPlacement) && state.failGetPlacement.includes(Number(w.hwnd)));
  if (action !== 'query') {
    const w = state.windows.find((x) => Number(x.hwnd) === Number(hwnd));
    if (!w) err = 'hwnd not a window';
    else if (Number(w.pid ?? state.pid) !== Number(pid)) err = `hwnd owned by pid ${w.pid} not ${pid}`;
    else {
      if (action !== 'restore') {
        if (plFails(w)) { plErr = 'GetWindowPlacement failed (simulated)'; err = plErr + '; window not touched (no original placement)'; }
        else before = { ...simPlacement(w) };
      }
      if (err) { /* untouched */ }
      else if (state.failActions && state.failActions.includes(action)) {
        err = `simulated ${action} failure`;
        // test-only: offscreen = ShowWindow(4) then SetWindowPos; SetWindowPos fails but ShowWindow already un-minimized it
        if (action === 'offscreen' && state.offscreenPartial) { const pl = simPlacement(w); w.iconic = false; pl.state = 'normal'; pl.showCmd = 1; err = 'SetWindowPos failed'; }
      }
      else {
        const pl = simPlacement(w);
        if (action === 'minimize') { w.iconic = true; pl.state = 'minimized'; pl.showCmd = 2; applied = true; }
        if (action === 'offscreen') {
          const wd = pl.right - pl.left; const ht = pl.bottom - pl.top;
          w.iconic = false; w.visible = true; w.x = -32000; w.y = -32000;
          Object.assign(pl, { state: 'normal', showCmd: 1, flags: 0, left: -32000, top: -32000, right: -32000 + wd, bottom: -32000 + ht });
          applied = true;
        }
        if (action === 'restore') {
          const cur = simPlacement(w);
          const same = placement && cur.state === placement.state && ['left', 'top', 'right', 'bottom'].every((k) => cur[k] === placement[k]) && ((cur.flags || 0) & 2) === ((placement.flags || 0) & 2);
          if (!placement) err = 'restore requires the recorded original placement';
          else if (same) { unchanged = true; applied = true; after = { ...cur }; }
          else {
            const cmd = restoreShowCmd(placement.state);
            if (cmd === 3) state.foreground = Number(hwnd); // SW_SHOWMAXIMIZED activates (only activating case)
            const drift = state.restoreDrift ? Number(state.restoreDrift) : 0; // test-only: placement not honoured
            Object.assign(pl, { ...placement, flags: state.restoreDropFlags ? (placement.flags || 0) & 1 : (placement.flags || 0) & 3, left: placement.left + drift, showCmd: placement.state === 'minimized' ? 2 : placement.state === 'maximized' ? 3 : 1 });
            w.iconic = placement.state === 'minimized'; w.maximized = placement.state === 'maximized';
            w.x = pl.left; w.y = pl.top; w.visible = true;
            after = { ...pl };
            if (after.state !== placement.state) err = `verify: state ${after.state} != original ${placement.state}`;
            else if (['left', 'top', 'right', 'bottom'].some((k) => after[k] !== placement[k])) err = `verify: rcNormalPosition (${after.left},${after.top},${after.right},${after.bottom}) != original (${placement.left},${placement.top},${placement.right},${placement.bottom})`;
            else if (((after.flags || 0) & 2) !== ((placement.flags || 0) & 2)) err = `verify: flags WPF_RESTORETOMAXIMIZED ${(after.flags || 0) & 2} != original ${(placement.flags || 0) & 2}`;
            else applied = true;
          }
        }
        if (!(action === 'restore' && unchanged)) w.ops = (w.ops || []).concat(action);
      }
    }
    if (w) target = w;
  }
  return JSON.stringify({ pid, action, hwnd, applied, error: err, target, windows: mine, placementBefore: before, placementAfter: after, placementError: plErr, unchanged, dpiAwareness, foregroundBefore: fgBefore, foregroundAfter: state.foreground ?? null });
}

/**
 * In-page persistent grab session. Self-contained (serialised with toString() and injected via CDP).
 * g = page globalThis (or a mock in unit tests). Opens getUserMedia ONCE; never stops the track until close().
 */
export async function createGrabSession(g, captureId, opts) {
  const o = opts || {};
  const sleep = (ms) => new Promise((r) => g.setTimeout(r, ms));
  const constraints = {
    audio: false,
    video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: captureId, maxWidth: 16384, maxHeight: 16384, maxFrameRate: o.maxFrameRate || 30 } },
  };
  const stream = await g.navigator.mediaDevices.getUserMedia(constraints);
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error('no video track');
  const s = {
    captureId, stream, track, seq: 0, latest: null, latestTsUs: null, latestWallMs: null,
    streamOpens: 1, trackStops: 0, frameSource: null, ended: false, readerError: null,
    lastGrabSeq: null, prevRoi: null, closed: false,
  };
  if (typeof track.addEventListener === 'function') track.addEventListener('ended', () => { s.ended = true; });
  if (o.preferImageCapture !== true && typeof g.MediaStreamTrackProcessor === 'function') {
    s.frameSource = 'MediaStreamTrackProcessor';
    const reader = new g.MediaStreamTrackProcessor({ track }).readable.getReader();
    s.reader = reader;
    (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) { s.ended = true; break; }
        if (s.latest && typeof s.latest.close === 'function') { try { s.latest.close(); } catch (e) {} }
        s.latest = value;
        s.seq += 1;
        s.latestTsUs = typeof value.timestamp === 'number' && Number.isFinite(value.timestamp) ? value.timestamp : null;
        s.latestWallMs = g.Date.now();
        // v6 clock calibration: offset(us) = performance.now()*1000 at arrival - VideoFrame.timestamp. Capture always
        // precedes arrival, so min(offset) over all frames is the tightest estimate of the constant clock offset
        // (it over-estimates it by the minimum capture->arrival latency; compensated by CLOCK_MARGIN_US toward STALE).
        const arr = g.performance && typeof g.performance.now === 'function' ? g.performance.now() : null;
        s.latestArrivalPerfMs = arr;
        if (arr != null && s.latestTsUs != null) {
          const off = arr * 1000 - s.latestTsUs;
          s.clockOffsetUs = s.clockOffsetUs == null ? off : Math.min(s.clockOffsetUs, off);
          s.clockSamples = (s.clockSamples || 0) + 1;
        }
      }
    })().catch((e) => { s.readerError = String((e && e.message) || e); s.ended = true; });
    for (let i = 0; i < 100 && !s.latest; i++) await sleep(50);
    if (!s.latest) throw new Error('no frame from MediaStreamTrackProcessor within 5s');
  } else if (typeof g.ImageCapture === 'function') {
    s.frameSource = 'ImageCapture';
    s.ic = new g.ImageCapture(track);
  } else {
    throw new Error('neither MediaStreamTrackProcessor nor ImageCapture available');
  }

  s.grab = async function grab(gopts) {
    const go = gopts || {};
    if (s.closed) throw new Error('session closed');
    let src;
    let seq;
    let tsUs;
    let wall;
    if (s.frameSource === 'ImageCapture') {
      src = await s.ic.grabFrame(); // ImageBitmap: NO capture timestamp; seq below is a per-call counter only
      s.seq += 1;
      seq = s.seq; tsUs = null; wall = g.Date.now(); // tsUs null => evaluateFreshness can never say 'fresh'
    } else {
      src = s.latest; seq = s.seq; tsUs = s.latestTsUs; wall = s.latestWallMs;
    }
    const w = src.displayWidth || src.codedWidth || src.width;
    const h = src.displayHeight || src.codedHeight || src.height;
    const canvas = new g.OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(src, 0, 0);
    if (s.frameSource === 'ImageCapture' && typeof src.close === 'function') { try { src.close(); } catch (e) {} }
    let pcMad = null;
    const roi = go.roi || null;
    if (roi) {
      const d = ctx.getImageData(roi.x, roi.y, roi.w, roi.h).data;
      if (s.prevRoi && s.prevRoi.length === d.length) {
        let sum = 0; let n = 0;
        for (let i = 0; i < d.length; i += 4) { sum += Math.abs(d[i] - s.prevRoi[i]) + Math.abs(d[i + 1] - s.prevRoi[i + 1]) + Math.abs(d[i + 2] - s.prevRoi[i + 2]); n += 3; }
        pcMad = sum / n;
      }
      s.prevRoi = new Uint8ClampedArray(d);
    }
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    const prev = s.lastGrabSeq;
    s.lastGrabSeq = seq;
    return {
      pngB64: g.btoa(bin), width: w, height: h, videoWidth: w, videoHeight: h,
      seq, captureTsUs: tsUs, captureWallMs: wall, grabWallMs: g.Date.now(),
      seqDeltaSinceLastGrab: prev == null ? null : seq - prev,
      frameSource: s.frameSource, streamOpens: s.streamOpens, trackStops: s.trackStops,
      trackState: track.readyState, ended: s.ended, readerError: s.readerError, pcMad,
      clockOffsetUs: s.clockOffsetUs ?? null, clockSamples: s.clockSamples || 0,
      arrivalPerfMs: s.latestArrivalPerfMs ?? null,
      grabPerfMs: g.performance && typeof g.performance.now === 'function' ? g.performance.now() : null,
    };
  };
  s.info = function info() {
    return { captureId: s.captureId, seq: s.seq, frameSource: s.frameSource, streamOpens: s.streamOpens, trackStops: s.trackStops, trackState: track.readyState, ended: s.ended, readerError: s.readerError };
  };
  s.close = async function close() {
    if (s.closed) return s.info();
    s.closed = true;
    try { if (s.reader) await s.reader.cancel(); } catch (e) {}
    for (const t of stream.getTracks()) { t.stop(); s.trackStops += 1; }
    if (s.latest && typeof s.latest.close === 'function') { try { s.latest.close(); } catch (e) {} }
    return s.info();
  };
  return s;
}
