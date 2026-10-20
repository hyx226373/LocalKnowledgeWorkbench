/**
 * Pure RGBA helpers for desk-r1-A round-2 acceptance (no Electron).
 * Used by --self-check on synthetic buffers; FullRun prefers in-page analysis
 * and may also call these on decoded frames if needed.
 */

/** Mean absolute difference over RGB (ignore alpha). Returns 0..255. */
export function meanAbsDiffRgb(a, b, width, height) {
  if (!a || !b || a.length !== b.length) throw new Error('buffer length mismatch');
  const n = width * height;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    sum += Math.abs(a[o] - b[o]) + Math.abs(a[o + 1] - b[o + 1]) + Math.abs(a[o + 2] - b[o + 2]);
  }
  return sum / (n * 3);
}

/** Fraction of pixels whose per-channel max abs diff exceeds tol (0..1). */
export function changedPixelRatio(a, b, width, height, tol = 12) {
  const n = width * height;
  if (n === 0) return 0;
  let changed = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const d = Math.max(
      Math.abs(a[o] - b[o]),
      Math.abs(a[o + 1] - b[o + 1]),
      Math.abs(a[o + 2] - b[o + 2]),
    );
    if (d > tol) changed++;
  }
  return changed / n;
}

/**
 * Count pixels near target RGB within channel tolerance.
 * @returns {{ hits: number, ratio: number, total: number }}
 */
export function countMarkerHits(rgba, width, height, rgb, tol = 8) {
  const [tr, tg, tb] = rgb;
  const n = width * height;
  let hits = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (
      Math.abs(rgba[o] - tr) <= tol &&
      Math.abs(rgba[o + 1] - tg) <= tol &&
      Math.abs(rgba[o + 2] - tb) <= tol
    ) {
      hits++;
    }
  }
  return { hits, ratio: n ? hits / n : 0, total: n };
}

/** Sample variance of luminance — low means nearly flat/black empty. */
export function luminanceVariance(rgba, width, height) {
  const n = width * height;
  if (n === 0) return 0;
  let sum = 0;
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const y = 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
    ys[i] = y;
    sum += y;
  }
  const mean = sum / n;
  let v = 0;
  for (let i = 0; i < n; i++) {
    const d = ys[i] - mean;
    v += d * d;
  }
  return v / n;
}

/** Fill solid color into Uint8ClampedArray RGBA. */
export function fillSolid(width, height, rgb) {
  const buf = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    buf[o] = rgb[0];
    buf[o + 1] = rgb[1];
    buf[o + 2] = rgb[2];
    buf[o + 3] = 255;
  }
  return buf;
}

/** Checkerboard of two colors, cell size in px. */
export function fillChecker(width, height, rgbA, rgbB, cell = 16) {
  const buf = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const useA = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
      const rgb = useA ? rgbA : rgbB;
      const o = (y * width + x) * 4;
      buf[o] = rgb[0];
      buf[o + 1] = rgb[1];
      buf[o + 2] = rgb[2];
      buf[o + 3] = 255;
    }
  }
  return buf;
}

/** A-02 PASS if changed ratio or mean abs exceeds thresholds. */
export function verdictA02(before, after, width, height, opts = {}) {
  const minRatio = opts.minChangedRatio ?? 0.01;
  const minMad = opts.minMeanAbsDiff ?? 2.5;
  const mad = meanAbsDiffRgb(before, after, width, height);
  const ratio = changedPixelRatio(before, after, width, height, opts.tol ?? 12);
  const pass = ratio >= minRatio || mad >= minMad;
  return { pass, mad, ratio, minRatio, minMad };
}

/**
 * A-03 stream-only heuristic (NOT final):
 *   marker in stream => FAIL (nesting).
 *   No marker + content variance => provisional PASS.
 * Final launcher must call applyA03OsGate: if marker window not on-screen visible
 * OR OS-ref lacks marker color => INCONCLUSIVE (never promote stream-absence to PASS).
 * Do not flip excludeSelfOk defaults in product code.
 */
export function verdictA03(rgba, width, height, markerRgb, opts = {}) {
  const hit = countMarkerHits(rgba, width, height, markerRgb, opts.tol ?? 8);
  const minHitRatio = opts.minHitRatio ?? 0.002; // 0.2% of pixels
  const varY = luminanceVariance(rgba, width, height);
  const minVar = opts.minLumaVariance ?? 50;
  if (hit.ratio >= minHitRatio) {
    return {
      verdict: 'FAIL',
      reason: 'marker_found_in_stream',
      markerHits: hit.hits,
      markerRatio: hit.ratio,
      lumaVariance: varY,
    };
  }
  if (varY >= minVar) {
    return {
      verdict: 'PASS',
      reason: 'marker_absent_content_visible',
      markerHits: hit.hits,
      markerRatio: hit.ratio,
      lumaVariance: varY,
    };
  }
  return {
    verdict: 'INCONCLUSIVE',
    reason: 'marker_absent_but_stream_flat',
    markerHits: hit.hits,
    markerRatio: hit.ratio,
    lumaVariance: varY,
  };
}


/**
 * Apply A-03 OS gate on top of a stream-only verdict.
 * gate = { windowVisible, windowOnPrimary, osHasMarker, gateOk? }
 */
export function applyA03OsGate(streamVerdict, gate) {
  if (!gate) {
    return { ...streamVerdict, verdict: 'INCONCLUSIVE', reason: 'os_gate_missing', osGateOk: false };
  }
  const windowVisible = !!gate.windowVisible;
  const windowOnPrimary = gate.windowOnPrimary !== undefined ? !!gate.windowOnPrimary : true;
  const osHasMarker = !!gate.osHasMarker;
  const osGateOk = gate.gateOk !== undefined
    ? !!gate.gateOk
    : (windowVisible && windowOnPrimary && osHasMarker);
  if (!windowVisible || !windowOnPrimary) {
    return {
      ...streamVerdict,
      verdict: 'INCONCLUSIVE',
      reason: 'marker_window_not_visible',
      osGateOk: false,
      windowVisible,
      windowOnPrimary,
      osHasMarker,
    };
  }
  if (!osHasMarker) {
    return {
      ...streamVerdict,
      verdict: 'INCONCLUSIVE',
      reason: 'os_ref_lacks_marker',
      osGateOk: false,
      windowVisible,
      windowOnPrimary,
      osHasMarker,
    };
  }
  return {
    ...streamVerdict,
    osGateOk,
    windowVisible,
    windowOnPrimary,
    osHasMarker,
  };
}

/** Self-check unit tests — no Electron. */
// ---------------- A-03 v2: positive control (protection OFF) + Win32 visibility (protection ON) ----------------
// Thresholds reused: stream ratio 0.002 == verdictA03.minHitRatio; OS 30 hits / 0.0005 == ps1 Test-OsRefMarker.
export const A03_MARKER_TOL = 8;
export const A03_STREAM_MIN_RATIO = 0.002;
export const A03_OS_MIN_HITS = 30;
export const A03_OS_MIN_RATIO = 0.0005;

export function streamHasMarker(hits, ratio) {
  return Number(hits) > 0 && Number(ratio) >= A03_STREAM_MIN_RATIO;
}

export function osRefHasMarker(hits, ratio) {
  return Number(hits) >= A03_OS_MIN_HITS || Number(ratio) >= A03_OS_MIN_RATIO;
}

export function normHwnd(h) {
  if (h === null || h === undefined || h === '') return null;
  try {
    const v = BigInt(String(h).trim());
    return v === 0n ? null : '0x' + v.toString(16).toUpperCase();
  } catch {
    return null;
  }
}

/** Phase-2 Win32 checks. All must pass, else INCONCLUSIVE. */
export function evalA03Win32(w, expectedHwnd) {
  const hwnd = normHwnd(w && w.hwnd);
  const exp = normHwnd(expectedHwnd);
  const rootAtPoint = normHwnd(w && w.windowFromPoint && w.windowFromPoint.rootHwnd);
  const checks = {
    present: !!w && !w.error,
    hwndMatchesHook: !!hwnd && (!exp || hwnd === exp),
    isWindowVisible: !!w && w.isWindowVisible === true,
    notMinimized: !!w && w.isIconic === false,
    onPrimaryMonitor: !!w && w.intersectsPrimary === true,
    windowFromPointRootIsOurs: !!hwnd && rootAtPoint === hwnd,
    // v2.1: center + 4 quadrant centers; fail closed if ANY sampled point's GA_ROOT is not our hwnd.
    allSamplePointsRootIsOurs: !!w && w.samplesAllRootOurs !== false && (w.samples === undefined || (Array.isArray(w.samples) && w.samples.length >= 5 && w.samples.every((p) => !!hwnd && normHwnd(p && p.rootHwnd) === hwnd))),
  };
  const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  return { checks, allPass: failed.length === 0, failed, hwnd, expectedHwnd: exp, rootAtPoint };
}

const numOrNull = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/** Pure A-03 v2 decision from raw JSON inputs (see run-acceptance.ps1 A-03 section). */
export function decideA03(input = {}) {
  const { p1Arm, p1Os, p1Win32, p1Stream, p2Arm, p2Win32, p2Stream } = input;
  const p1Prot = (p1Arm && p1Arm.contentProtection) || null;
  const p2Prot = (p2Arm && p2Arm.contentProtection) || null;

  const osHits = p1Os ? numOrNull(p1Os.hits) : null;
  const osRatio = p1Os ? numOrNull(p1Os.ratio) : null;
  const osHas = !!p1Os && !p1Os.error && osRefHasMarker(osHits, osRatio);
  const s1Hits = p1Stream ? numOrNull(p1Stream.markerHits) : null;
  const s1Ratio = p1Stream ? numOrNull(p1Stream.markerRatio) : null;
  const s1Has = !!p1Stream && streamHasMarker(s1Hits, s1Ratio);
  const p1ProtOff = !!p1Prot && p1Prot.ok === true && p1Prot.on === false;
  const positiveControlOk = p1ProtOff && osHas && s1Has;

  const phase1 = {
    contentProtection: p1Prot,
    contentProtectionOff: p1ProtOff,
    osRefPng: 'A-03-p1-os-ref.png',
    osMarkerHits: osHits,
    osMarkerSamples: p1Os ? numOrNull(p1Os.samples) : null,
    osMarkerRatio: osRatio,
    osSampleStep: p1Os ? numOrNull(p1Os.step) : null,
    osScanError: p1Os ? p1Os.error ?? null : 'missing',
    osHasMarker: osHas,
    streamPng: 'A-03-p1-stream.png',
    streamMarkerHits: s1Hits,
    streamMarkerRatio: s1Ratio,
    streamTotalPixels: p1Stream ? numOrNull(p1Stream.totalPixels) : null,
    streamVideo: p1Stream ? { width: p1Stream.videoWidth, height: p1Stream.videoHeight } : null,
    streamHasMarker: s1Has,
    win32Info: p1Win32 || null,
    positiveControlOk,
  };

  const win = evalA03Win32(p2Win32, p2Prot ? p2Prot.hwnd : null);
  const s2Hits = p2Stream ? numOrNull(p2Stream.markerHits) : null;
  const s2Ratio = p2Stream ? numOrNull(p2Stream.markerRatio) : null;
  const p2ProtOn = !!p2Prot && p2Prot.ok === true && p2Prot.on === true;
  const phase2 = {
    contentProtection: p2Prot,
    contentProtectionOn: p2ProtOn,
    hwnd: win.hwnd,
    hookHwnd: win.expectedHwnd,
    rect: p2Win32 ? p2Win32.rect ?? null : null,
    primaryMonitor: p2Win32 ? p2Win32.primaryMonitor ?? null : null,
    intersection: p2Win32 ? p2Win32.intersection ?? null : null,
    point: p2Win32 ? p2Win32.point ?? null : null,
    windowFromPoint: p2Win32 ? p2Win32.windowFromPoint ?? null : null,
    samplePoints: p2Win32 ? p2Win32.samples ?? null : null,
    samplesNotOurs: p2Win32 ? p2Win32.samplesNotOurs ?? null : null,
    isWindowVisible: p2Win32 ? p2Win32.isWindowVisible ?? null : null,
    isIconic: p2Win32 ? p2Win32.isIconic ?? null : null,
    intersectsPrimary: p2Win32 ? p2Win32.intersectsPrimary ?? null : null,
    displayAffinity: p2Win32 ? p2Win32.displayAffinity ?? null : null,
    ownerPid: p2Win32 ? p2Win32.ownerPid ?? null : null,
    win32Error: p2Win32 ? p2Win32.error ?? null : 'missing',
    win32Checks: win.checks,
    win32AllPass: win.allPass,
    win32Failed: win.failed,
    streamPng: 'A-03-p2-stream.png',
    streamMarkerHits: s2Hits,
    streamMarkerRatio: s2Ratio,
    streamTotalPixels: p2Stream ? numOrNull(p2Stream.totalPixels) : null,
    streamLumaVariance: p2Stream ? numOrNull(p2Stream.lumaVariance) : null,
    streamVideo: p2Stream ? { width: p2Stream.videoWidth, height: p2Stream.videoHeight } : null,
  };

  let verdict = 'INCONCLUSIVE';
  let reason;
  if (!p1ProtOff) reason = 'phase1_content_protection_not_off';
  else if (!positiveControlOk) {
    const miss = [];
    if (!osHas) miss.push('os');
    if (!s1Has) miss.push('stream');
    reason = 'positive_control_missing_marker:' + miss.join('+');
  } else if (!p2ProtOn) reason = 'phase2_content_protection_not_on';
  else if (!win.allPass) reason = 'win32_check_failed:' + win.failed.join(',');
  else if (!p2Stream || !Number.isFinite(s2Hits)) reason = 'phase2_stream_missing';
  else if (s2Hits === 0) {
    verdict = 'PASS';
    reason = 'protection_on_window_topmost_and_stream_has_no_marker';
  } else {
    verdict = 'FAIL';
    reason = streamHasMarker(s2Hits, s2Ratio)
      ? 'marker_found_in_stream_with_protection_on'
      : 'marker_pixels_in_stream_below_ratio_threshold';
  }

  return {
    test: 'A-03',
    protocol: 'v2: phase1 positive control (protection OFF; OS-ref + stream must show marker) -> phase2 protection ON (Win32 visibility; stream markerHits==0 => PASS)',
    verdict,
    reason,
    thresholds: {
      markerHex: '#E911E9',
      markerTol: A03_MARKER_TOL,
      streamMinRatio: A03_STREAM_MIN_RATIO,
      osMinHits: A03_OS_MIN_HITS,
      osMinRatio: A03_OS_MIN_RATIO,
      phase2PassRequiresStreamHits: 0,
    },
    phase1,
    phase2,
    dpi: {
      pageDevicePixelRatioP1: (p1Arm && p1Arm.page && p1Arm.page.devicePixelRatio) ?? null,
      pageDevicePixelRatioP2: (p2Arm && p2Arm.page && p2Arm.page.devicePixelRatio) ?? null,
      electronScaleFactor: (p2Prot && p2Prot.scaleFactor) ?? null,
      electronBounds: (p2Prot && p2Prot.bounds) ?? null,
      dpiForWindow: (p2Win32 && p2Win32.dpiForWindow) ?? null,
      win32ThreadDpiAwarenessSet: (p2Win32 && p2Win32.threadDpiAwarenessSet) ?? null,
    },
    // Product captureStart().excludeSelfOk — NOT the A-03 PASS/FAIL gate.
    // false here usually means we did not claim the exclude-self API path; A-03 PASS is
    // proven by marker absence under content protection + Win32 topmost, not by this flag.
    excludeSelfOk: (p2Arm && p2Arm.excludeSelfOk) ?? null,
    excludeSelfOkMeaning:
      'captureStart().excludeSelfOk from product API (whether exclude-self / self-exclusion was reported OK). Independent of A-03 PASS: A-03 proves nesting via #E911E9 absence under protection + Win32 topmost. false ≠ A-03 fail.',
    note: 'Phase 2 never uses an OS screenshot as visibility proof (GDI is blacked out by protection). PASS = positive control OK + all Win32 checks + phase2 stream markerHits==0. Do not read excludeSelfOk as the nesting verdict.',
  };
}

/** Render txt strictly from the verdict JSON object. */
export function renderA03VerdictTxt(v) {
  const p1 = v.phase1 || {};
  const p2 = v.phase2 || {};
  const wfp = p2.windowFromPoint || {};
  const lines = [
    `A-03 nesting verdict: ${v.verdict}`,
    `reason: ${v.reason}`,
    `protocol: ${v.protocol}`,
    `phase1.contentProtectionOff: ${p1.contentProtectionOff}`,
    `phase1.osMarkerHits: ${p1.osMarkerHits} (ratio ${p1.osMarkerRatio}, samples ${p1.osMarkerSamples}) osHasMarker=${p1.osHasMarker}`,
    `phase1.streamMarkerHits: ${p1.streamMarkerHits} (ratio ${p1.streamMarkerRatio}) streamHasMarker=${p1.streamHasMarker}`,
    `phase1.positiveControlOk: ${p1.positiveControlOk}`,
    `phase2.contentProtectionOn: ${p2.contentProtectionOn}`,
    `phase2.hwnd: ${p2.hwnd} (hook ${p2.hookHwnd}) ownerPid=${p2.ownerPid} displayAffinity=${p2.displayAffinity}`,
    `phase2.rect: ${JSON.stringify(p2.rect)}`,
    `phase2.isWindowVisible: ${p2.isWindowVisible} isIconic: ${p2.isIconic} intersectsPrimary: ${p2.intersectsPrimary}`,
    `phase2.point: ${JSON.stringify(p2.point)}`,
    `phase2.windowFromPoint: hit=${wfp.hwnd} class=${wfp.class} root=${wfp.rootHwnd} rootClass=${wfp.rootClass}`,
    `phase2.samplePoints: ${(p2.samplePoints || []).map((p) => `${p.name}(${p.x},${p.y}) root=${p.rootHwnd} ${p.rootClass} ours=${p.rootIsOurs}`).join(' | ') || 'none'}`,
    `phase2.win32Checks: ${JSON.stringify(p2.win32Checks)}`,
    `phase2.win32Error: ${p2.win32Error}`,
    `phase2.streamMarkerHits: ${p2.streamMarkerHits} (ratio ${p2.streamMarkerRatio})`,
    `dpi: ${JSON.stringify(v.dpi)}`,
    `captureStart.excludeSelfOk (API flag, NOT A-03 gate): ${v.excludeSelfOk}`,
    `excludeSelfOkMeaning: ${v.excludeSelfOkMeaning || ''}`,
    `generatedAt: ${v.generatedAt || ''}`,
    `note: ${v.note}`,
  ];
  return lines.join('\n') + '\n';
}

export function runPixelSelfTests() {  const W = 64;
  const H = 48;
  const MAGENTA = [233, 17, 233]; // #E911E9
  const results = [];

  const solid = fillSolid(W, H, [10, 20, 30]);
  const solid2 = fillSolid(W, H, [10, 20, 30]);
  const painted = fillSolid(W, H, [10, 20, 30]);
  // paint a bright rectangle (simulating explorer)
  for (let y = 10; y < 40; y++) {
    for (let x = 5; x < 50; x++) {
      const o = (y * W + x) * 4;
      painted[o] = 240;
      painted[o + 1] = 240;
      painted[o + 2] = 250;
    }
  }
  const dSame = verdictA02(solid, solid2, W, H);
  results.push({ name: 'A02_identical_fail', pass: !dSame.pass, detail: dSame });
  const dDiff = verdictA02(solid, painted, W, H);
  results.push({ name: 'A02_painted_pass', pass: dDiff.pass, detail: dDiff });

  const withMarker = fillSolid(W, H, [40, 40, 40]);
  // stamp magenta block
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 20; x++) {
      const o = (y * W + x) * 4;
      withMarker[o] = MAGENTA[0];
      withMarker[o + 1] = MAGENTA[1];
      withMarker[o + 2] = MAGENTA[2];
    }
  }
  const nest = verdictA03(withMarker, W, H, MAGENTA);
  results.push({ name: 'A03_marker_fail', pass: nest.verdict === 'FAIL', detail: nest });

  const desktopLike = fillChecker(W, H, [30, 80, 40], [200, 180, 120], 8);
  const prot = verdictA03(desktopLike, W, H, MAGENTA);
  results.push({
    name: 'A03_no_marker_pass',
    pass: prot.verdict === 'PASS',
    detail: prot,
  });

  const gatedMissing = applyA03OsGate(prot, null);
  results.push({
    name: 'A03_gate_missing_inconclusive',
    pass: gatedMissing.verdict === 'INCONCLUSIVE' && gatedMissing.reason === 'os_gate_missing',
    detail: gatedMissing,
  });
  const gatedNoOs = applyA03OsGate(prot, {
    windowVisible: true,
    windowOnPrimary: true,
    osHasMarker: false,
  });
  results.push({
    name: 'A03_gate_no_os_marker_inconclusive',
    pass: gatedNoOs.verdict === 'INCONCLUSIVE' && gatedNoOs.reason === 'os_ref_lacks_marker',
    detail: gatedNoOs,
  });
  const gatedOk = applyA03OsGate(prot, {
    windowVisible: true,
    windowOnPrimary: true,
    osHasMarker: true,
    gateOk: true,
  });
  results.push({
    name: 'A03_gate_ok_keeps_pass',
    pass: gatedOk.verdict === 'PASS',
    detail: gatedOk,
  });

  // A-03 v2 decideA03 cases
  const okP1Arm = { contentProtection: { ok: true, on: false, hwnd: '0xABC' }, page: { devicePixelRatio: 1 } };
  const okP2Arm = { contentProtection: { ok: true, on: true, hwnd: '0xABC' }, page: { devicePixelRatio: 1 } };
  const okOs = { hits: 5000, samples: 100000, ratio: 0.05, error: null };
  const okS1 = { markerHits: 900000, markerRatio: 0.45, totalPixels: 2000000 };
  const okWin = {
    hwnd: '0xABC', isWindowVisible: true, isIconic: false, intersectsPrimary: true,
    windowFromPoint: { hwnd: '0xDEF', rootHwnd: '0xabc' }, error: null,
  };
  const s2Zero = { markerHits: 0, markerRatio: 0, totalPixels: 2000000 };
  const base = { p1Arm: okP1Arm, p1Os: okOs, p1Stream: okS1, p2Arm: okP2Arm, p2Win32: okWin, p2Stream: s2Zero };
  const a03Cases = [
    ['A03v2_pass', base, 'PASS'],
    ['A03v2_fail_marker', { ...base, p2Stream: { markerHits: 800000, markerRatio: 0.4 } }, 'FAIL'],
    ['A03v2_fail_stray_pixels', { ...base, p2Stream: { markerHits: 3, markerRatio: 0.0000015 } }, 'FAIL'],
    ['A03v2_pc_os_missing', { ...base, p1Os: { hits: 0, samples: 100000, ratio: 0, error: null } }, 'INCONCLUSIVE'],
    ['A03v2_pc_stream_missing', { ...base, p1Stream: { markerHits: 0, markerRatio: 0 } }, 'INCONCLUSIVE'],
    ['A03v2_p1_protection_on', { ...base, p1Arm: okP2Arm }, 'INCONCLUSIVE'],
    ['A03v2_p2_protection_off', { ...base, p2Arm: okP1Arm }, 'INCONCLUSIVE'],
    ['A03v2_win32_not_visible', { ...base, p2Win32: { ...okWin, isWindowVisible: false } }, 'INCONCLUSIVE'],
    ['A03v2_win32_minimized', { ...base, p2Win32: { ...okWin, isIconic: true } }, 'INCONCLUSIVE'],
    ['A03v2_win32_off_primary', { ...base, p2Win32: { ...okWin, intersectsPrimary: false } }, 'INCONCLUSIVE'],
    ['A03v2_win32_occluded', { ...base, p2Win32: { ...okWin, windowFromPoint: { hwnd: '0x1', rootHwnd: '0x999' } } }, 'INCONCLUSIVE'],
    ['A03v2_win32_quadrant_occluded', { ...base, p2Win32: { ...okWin, samples: ['center', 'q_tl', 'q_tr', 'q_bl', 'q_br'].map((name, i) => ({ name, rootHwnd: i === 3 ? '0x999' : '0xabc' })) } }, 'INCONCLUSIVE'],
    ['A03v2_win32_all_points_ours', { ...base, p2Win32: { ...okWin, samples: ['center', 'q_tl', 'q_tr', 'q_bl', 'q_br'].map((name) => ({ name, rootHwnd: '0xabc' })) } }, 'PASS'],
    ['A03v2_win32_missing', { ...base, p2Win32: null }, 'INCONCLUSIVE'],
    ['A03v2_p2_stream_missing', { ...base, p2Stream: null }, 'INCONCLUSIVE'],
  ];
  for (const [name, input, want] of a03Cases) {
    const d = decideA03(input);
    results.push({ name, pass: d.verdict === want, detail: { verdict: d.verdict, reason: d.reason } });
  }
  const a03Txt = renderA03VerdictTxt(decideA03(base));
  results.push({ name: 'A03v2_txt_from_json', pass: a03Txt.startsWith('A-03 nesting verdict: PASS'), detail: a03Txt.split('\n')[0] });

  const okAll = results.every((r) => r.pass);  return { ok: okAll, results };
}
