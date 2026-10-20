#!/usr/bin/env node
/**
 * GrabFrame CLI for desk-r1-A — independent desktop frame capture for group E (Snap Assist).
 *
 * Reuses A's proven CDP capture path (NOT OS GDI):
 *   _testSetFullscreen -> enumerateSources -> _testBootstrap -> captureStart
 *   -> getUserMedia(chromeMediaSourceId) -> canvas grabFrame -> PNG + JSON sidecar
 *
 * Modes:
 *   --self-check          Static only: validate args, preflight helpers, JSON shape. NO Electron.
 *   --out <path.png>      Grab one or more frames (requires live CDP / Electron launched by PS1).
 *   --count N             Multi-frame count (default 1).
 *   --interval-ms M       Delay between frames (default 500).
 *   --keep-alive          Stay running; grab on trigger-file / stdin. No Electron relaunch per frame.
 *   --trigger <path>      Trigger file (default: out/acceptance/grab-trigger).
 *   --cdp-port N          CDP port (default DESK_R1_CDP_PORT or 9222).
 *   --pid N               Electron pid recorded into JSON sidecar.
 *   --no-minimize         Do not hide the A window (default: hide via Win32 so it does not occlude E).
 *   --hide-mode M         minimize (default; falls back to offscreen if stale) | offscreen (SetWindowPos -32000).
 *   --no-freshness-check  Skip the live freshness self-check (default ON for --keep-alive and --count>=2).
 *   --freshness-check     Force the live freshness self-check (also for single grabs).
 *   --pc-roi x,y,w,h      Positive-control ROI (desktop px) that MUST change between check grabs (MAD > --pc-threshold).
 *   --pc-threshold T      Positive-control MAD threshold (default 1.0).
 *   --prefer-image-capture  Use ImageCapture.grabFrame() instead of MediaStreamTrackProcessor.
 *
 * E-04 (KeepAlive freeze) fix: ONE persistent MediaStream/track per process (window.__deskR1AGrab in page),
 * frames read from the live track via MediaStreamTrackProcessor (VideoFrame.timestamp, per-frame seq) — not
 * from a <video> element that stops painting when the window is minimized; the track is stopped only on quit.
 * `minimized` in the sidecar = Win32 IsIconic of OUR window (explicit hwnd), not of all the pid's windows.
 * Stale (seq/timestamp not advancing, or positive control MAD<=threshold) -> sidecar stale:true, exit 3.
 *
 * v2 (after review):
 *   --hwnd N              Our own top-level hwnd (e.g. BrowserWindow.getNativeWindowHandle()). Otherwise the page test
 *                         hook _testGetNativeWindowHandle(), otherwise a unique per-run document.title marker
 *                         "[GrabFrame-A:<pid>-<nonce>]" matched among the pid's top-level windows.
 *   --protect-hwnd a,b    hwnds that must never be touched (E panel). Own == protected -> refuse -> INCONCLUSIVE.
 *   Win32 hide acts on exactly ONE hwnd; 0 or >1 candidates -> refuse to hide, exit 4 INCONCLUSIVE.
 *   Every Win32 op (with the pid's full hwnd list) is recorded in sidecar.hwndOps and <out>.freshness.json.
 *   Missing capture timestamp is never fresh: ImageCapture -> --pc-roi required, best verdict INCONCLUSIVE.
 *   Exit: 0 ok | 1 error | 2 bad args | 3 STALE (any frame) | 4 INCONCLUSIVE.
 *   sidecar.stale: true | false (checked fresh) | null (no check / inconclusive); freshnessCheck: enabled |
 *   forced-by-flag | not-requested | disabled-by-flag; hideMode + hideApplied + hideError.
 *
 * Trigger protocol (keep-alive):
 *   Write a line to the trigger file (or stdin):
 *     grab                 -> capture to --out (or out/acceptance/grab-frame.png)
 *     grab <abs-or-rel.png>
 *     quit | exit          -> clean shutdown (exit 0)
 *   After each grab the trigger file is rewritten to "idle\n" so E can edge-trigger on mtime/content.
 *
 * JSON sidecar (<png>.json):
 *   { ok, timestamp, width, height, videoWidth, videoHeight, pid, exit, frameIndex,
 *     captureId, excludeSelfOk, contentProtection, png, mode,
 *     seq, captureTsUs, captureWallMs, frameSource, streamOpens, minimized, minimizedSource, stale,
 *     ts, seqDeltaSinceLastGrab, trackState, hideMode, pcMad, freshness }
 */
import { existsSync, writeFileSync, mkdirSync, readFileSync, watch, openSync, closeSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve, extname, basename, parse as parsePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire as __createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import {
  buildSidecar,
  validateSidecarShape,
  evaluateFreshness,
  parseRoi,
  parseWin32Result,
  win32Script,
  createGrabSession,
  selectOwnWindow,
  makeTitleMarker,
  simulateWin32,
  exitCodeForVerdicts,
  evaluatePostHideFreshness,
  EXIT,
} from './grab-frame-lib.mjs';
import { randomUUID } from 'node:crypto';

const __require = __createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

function parseArgs(argv) {
  const out = {
    selfCheck: false,
    keepAlive: false,
    noMinimize: false,
    out: null,
    count: 1,
    intervalMs: 500,
    trigger: null,
    cdpPort: Number(process.env.DESK_R1_CDP_PORT || 9222),
    pid: null,
    hideMode: 'minimize',
    freshnessCheck: null,
    pcRoi: null,
    pcThreshold: 1.0,
    preferImageCapture: false,
    hwnd: null,
    protectHwnds: [],
    freshnessCheckFlag: null,
  };
  const a = argv.slice();
  for (let i = 0; i < a.length; i++) {
    const t = a[i];
    if (t === '--self-check') out.selfCheck = true;
    else if (t === '--keep-alive') out.keepAlive = true;
    else if (t === '--no-minimize') out.noMinimize = true;
    else if (t === '--out') out.out = a[++i];
    else if (t.startsWith('--out=')) out.out = t.slice('--out='.length);
    else if (t === '--count') out.count = Number(a[++i]);
    else if (t.startsWith('--count=')) out.count = Number(t.slice('--count='.length));
    else if (t === '--interval-ms') out.intervalMs = Number(a[++i]);
    else if (t.startsWith('--interval-ms=')) out.intervalMs = Number(t.slice('--interval-ms='.length));
    else if (t === '--trigger') out.trigger = a[++i];
    else if (t.startsWith('--trigger=')) out.trigger = t.slice('--trigger='.length);
    else if (t === '--cdp-port') out.cdpPort = Number(a[++i]);
    else if (t.startsWith('--cdp-port=')) out.cdpPort = Number(t.slice('--cdp-port='.length));
    else if (t === '--pid') out.pid = Number(a[++i]);
    else if (t.startsWith('--pid=')) out.pid = Number(t.slice('--pid='.length));
    else if (t === '--hide-mode') out.hideMode = a[++i];
    else if (t.startsWith('--hide-mode=')) out.hideMode = t.slice('--hide-mode='.length);
    else if (t === '--no-freshness-check') { out.freshnessCheck = false; out.freshnessCheckFlag = 'disabled-by-flag'; }
    else if (t === '--freshness-check') { out.freshnessCheck = true; out.freshnessCheckFlag = 'forced-by-flag'; }
    else if (t === '--hwnd') out.hwnd = Number(a[++i]);
    else if (t.startsWith('--hwnd=')) out.hwnd = Number(t.slice('--hwnd='.length));
    else if (t === '--protect-hwnd') out.protectHwnds.push(...String(a[++i]).split(',').map(Number));
    else if (t.startsWith('--protect-hwnd=')) out.protectHwnds.push(...t.slice('--protect-hwnd='.length).split(',').map(Number));
    else if (t === '--pc-roi') out.pcRoi = parseRoi(a[++i]);
    else if (t.startsWith('--pc-roi=')) out.pcRoi = parseRoi(t.slice('--pc-roi='.length));
    else if (t === '--pc-threshold') out.pcThreshold = Number(a[++i]);
    else if (t.startsWith('--pc-threshold=')) out.pcThreshold = Number(t.slice('--pc-threshold='.length));
    else if (t === '--prefer-image-capture') out.preferImageCapture = true;
    else if (t === '--help' || t === '-h') out.help = true;
    else throw new Error('unknown arg: ' + t);
  }
  if (!Number.isFinite(out.count) || out.count < 1) throw new Error('--count must be >= 1');
  if (!Number.isFinite(out.intervalMs) || out.intervalMs < 0) throw new Error('--interval-ms must be >= 0');
  if (!Number.isFinite(out.cdpPort) || out.cdpPort < 1) throw new Error('--cdp-port invalid');
  if (out.pid != null && !Number.isFinite(out.pid)) throw new Error('--pid invalid');
  if (!['minimize', 'offscreen'].includes(out.hideMode)) throw new Error('--hide-mode must be minimize|offscreen');
  if (!Number.isFinite(out.pcThreshold) || out.pcThreshold < 0) throw new Error('--pc-threshold invalid');
  if (out.hwnd != null && !(Number.isSafeInteger(out.hwnd) && out.hwnd > 0)) throw new Error('--hwnd must be a positive integer');
  if (out.protectHwnds.some((h) => !Number.isSafeInteger(h) || h <= 0)) throw new Error('--protect-hwnd must be positive integers');
  if (out.preferImageCapture && !out.pcRoi) throw new Error('--prefer-image-capture requires --pc-roi (ImageCapture has no capture timestamp)');
  if (out.freshnessCheck == null) out.freshnessCheck = !!(out.keepAlive || out.count >= 2);
  // test-only: shorten hide-settle / freshness gap for mock e2e tests (unset in real runs -> 1200ms / 300ms defaults)
  const td = process.env.DESK_R1_GF_TEST_DELAY_MS;
  if (td != null && td !== '' && Number.isFinite(Number(td)) && Number(td) >= 0) { out.settleMs = Number(td); out.gapMs = Number(td); }
  return out;
}

function ok(msg) {
  console.log(`[ok] ${msg}`);
}
function fail(msg) {
  console.error(`[fail] ${msg}`);
  process.exitCode = 1;
}

function writePngFromDataUrl(dataUrl, filePath) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
    throw new Error('expected png data URL');
  }
  const b64 = dataUrl.slice('data:image/png;base64,'.length);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, Buffer.from(b64, 'base64'));
}


function frameOutPath(baseOut, index, count) {
  if (count <= 1) return resolve(baseOut);
  const p = parsePath(resolve(baseOut));
  const seq = String(index + 1).padStart(3, '0');
  return join(p.dir, `${p.name}-${seq}${p.ext || '.png'}`);
}

function sidecarPathFor(pngPath) {
  return pngPath.replace(/\.png$/i, '') + '.json';
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

function resolveWsImpl(prefer = process.env.DESK_R1_CDP_WS || 'ws') {
  if (prefer === 'undici' || prefer === 'global') {
    if (typeof globalThis.WebSocket !== 'function') throw new Error('global WebSocket unavailable');
    return { kind: 'undici-global', WS: globalThis.WebSocket };
  }
  const candidates = [
    join(ROOT, 'node_modules', 'ws'),
    join(__dirname, '..', '..', 'node_modules', 'ws'),
    'ws',
  ];
  for (const c of candidates) {
    try {
      const WS = __require(c);
      if (typeof WS === 'function') return { kind: 'ws-package', WS, source: c };
    } catch {}
  }
  if (typeof globalThis.WebSocket === 'function') {
    return { kind: 'undici-global-fallback', WS: globalThis.WebSocket };
  }
  throw new Error('no WebSocket impl (npm i ws or Node>=22)');
}

async function cdpEvaluate(wsUrl, expression, timeoutMs = 120000) {
  const impl = resolveWsImpl();
  console.log(`[cdp] WS impl=${impl.kind}${impl.source ? ' src=' + impl.source : ''}`);
  return new Promise((resolveP, reject) => {
    const ws = impl.kind.startsWith('ws-package')
      ? new impl.WS(wsUrl, { perMessageDeflate: false })
      : new impl.WS(wsUrl);
    let id = 0;
    const pending = new Map();
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error('CDP evaluate timeout after ' + timeoutMs + 'ms'));
    }, timeoutMs);

    function send(method, params) {
      const msgId = ++id;
      return new Promise((res, rej) => {
        pending.set(msgId, { res, rej });
        ws.send(JSON.stringify({ id: msgId, method, params }));
      });
    }

    ws.onopen = async () => {
      try {
        await send('Runtime.enable', {});
        const result = await send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
        });
        clearTimeout(timer);
        try {
          ws.close();
        } catch {}
        resolveP(result);
      } catch (e) {
        clearTimeout(timer);
        try {
          ws.close();
        } catch {}
        reject(e);
      }
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg.id != null && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      }
    };
    const onErr = (e) => {
      clearTimeout(timer);
      reject(new Error('CDP websocket error: ' + (e?.message || e?.type || 'unknown')));
    };
    ws.onerror = onErr;
    if (typeof ws.on === 'function') ws.on('error', onErr);
  });
}

/** Page expression: content protection + ensureLive + install ONE persistent grab session (reused across CDP calls).
 *  v2: also stamps a unique marker into document.title (BrowserWindow title follows it) so Node can find OUR
 *  top-level hwnd among the pid's windows, and asks the optional test hook for the native window handle. */
function buildPrepareExpression({ maxFrameRate = 30, preferImageCapture = false, titleMarker = null } = {}) {
  return `(async () => {
    const c = (window.desktopPanel && window.desktopPanel.capture) || window.desktopPanelCapture || window.deskR1A || window.__deskR1A;
    if (!c) throw new Error('desktopPanelCapture API missing in page');
    if (typeof c._testSetFullscreen !== 'function') throw new Error('_testSetFullscreen missing (need DESK_R1_A_TEST_HOOK=1)');
    if (typeof c._testBootstrap !== 'function') throw new Error('_testBootstrap missing');
    if (typeof c.captureStart !== 'function') throw new Error('captureStart missing');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const marker = ${JSON.stringify(titleMarker)};
    let titleMarker = null;
    let setTitleHere = false;
    const restoreTitleOnFail = () => {
      // v3: prepare failed before a session existed -> put the original title back before throwing
      if (setTitleHere && !window.__deskR1AGrab && window.__deskR1AGrabTitle != null && typeof document !== 'undefined') {
        document.title = window.__deskR1AGrabTitle;
        window.__deskR1AGrabTitle = null;
      }
    };
    try {
    if (marker && typeof document !== 'undefined') {
      setTitleHere = window.__deskR1AGrabTitle == null;
      if (window.__deskR1AGrabTitle == null) window.__deskR1AGrabTitle = String(document.title || '');
      document.title = (window.__deskR1AGrabTitle ? window.__deskR1AGrabTitle + ' ' : '') + marker;
      titleMarker = marker;
    }
    let hookHwnd = null;
    try {
      if (typeof c._testGetNativeWindowHandle === 'function') {
        const h = await c._testGetNativeWindowHandle();
        const n = typeof h === 'string' ? Number(h) : (h && typeof h.hwnd !== 'undefined' ? Number(h.hwnd) : Number(h));
        if (Number.isSafeInteger(n) && n > 0) hookHwnd = n;
      }
    } catch (e) {}
    const prev = window.__deskR1AGrab;
    if (prev && !prev.closed && !prev.ended && prev.track && prev.track.readyState === 'live') {
      return { reused: true, started: prev.started, contentProtection: prev.contentProtection, info: prev.info(), titleMarker, hookHwnd };
    }
    let contentProtection = null;
    // GrabFrame: raise:false — content protection ON, but do NOT setAlwaysOnTop/moveTop/focus (would steal E/Amy foreground until A exits).
    if (typeof c._testSetContentProtection === 'function') contentProtection = await c._testSetContentProtection(true, { raise: false });
    let started = await c.captureGetStatus();
    if (!(started && started.status === 'live' && started.captureId)) {
      await c._testSetFullscreen(true);
      await sleep(400);
      const srcs = await c.enumerateSources();
      if (!srcs.length) throw new Error('no sources');
      const boot = await c._testBootstrap();
      started = await c.captureStart(boot.sessionId, srcs[0] || boot.source);
      if (!started || started.ok === false) throw new Error('captureStart failed: ' + JSON.stringify(started));
      if (started.status !== 'live') throw new Error('not live: ' + JSON.stringify(started));
    }
    const createGrabSession = ${createGrabSession.toString()};
    const s = await createGrabSession(globalThis, started.captureId, ${JSON.stringify({ maxFrameRate, preferImageCapture })});
    s.started = started;
    s.contentProtection = contentProtection;
    window.__deskR1AGrab = s;
    return { reused: false, started, contentProtection, info: s.info(), titleMarker, hookHwnd };
    } catch (e) {
      restoreTitleOnFail();
      throw e;
    }
  })()`;
}

function buildSessionGrabExpression({ roi }) {
  return `(async () => {
    const s = window.__deskR1AGrab;
    if (!s || s.closed) throw new Error('no persistent grab session (prepare not run)');
    return await s.grab(${JSON.stringify({ roi: roi || null })});
  })()`;
}

/** v4: close returns the post-cleanup page state so Node can record title/track results (cleanup fields). */
function buildCloseExpression(marker) {
  return `(async () => {
    const marker = ${JSON.stringify(marker || null)};
    const s = window.__deskR1AGrab; let r = null; let hadSession = !!s; let trackState = null; let closeError = null;
    if (s) {
      try { r = await s.close(); } catch (e) { closeError = String(e && e.message || e); }
      try { if (s.track && s.track.readyState !== 'ended') s.track.stop(); } catch (e) { closeError = closeError || String(e && e.message || e); }
      try { trackState = s.track ? String(s.track.readyState) : null; } catch (e) {}
      window.__deskR1AGrab = null;
    }
    if (window.__deskR1AGrabTitle != null && typeof document !== 'undefined') { document.title = window.__deskR1AGrabTitle; window.__deskR1AGrabTitle = null; }
    const title = typeof document !== 'undefined' ? String(document.title || '') : null;
    return { closed: r, hadSession, trackState, closeError, title, titleHasMarker: !!(marker && title && title.includes(marker)) };
  })()`;
}
const CLEANUP_TIMEOUT_MS = 5000; // v4: cleanup CDP calls / awaiting an in-flight prepare are bounded (not the 120s default)

async function connectPage(port) {
  const list = await fetchJson(`http://127.0.0.1:${port}/json/list`);
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('no page target on CDP port ' + port);
  return page;
}

async function evalValue(page, expr, label, timeoutMs) {
  const result = await cdpEvaluate(page.webSocketDebuggerUrl, expr, timeoutMs);
  if (result?.exceptionDetails) throw new Error(`${label} exception: ` + JSON.stringify(result.exceptionDetails));
  return result?.result?.value;
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Run one Win32 op. Real: PowerShell (user32). Test-only: DESK_R1_GF_WIN32_MOCK=<state.json> (simulateWin32). */
function runWin32Raw(req) {
  const mockPath = process.env.DESK_R1_GF_WIN32_MOCK;
  if (mockPath) {
    const state = JSON.parse(readFileSync(mockPath, 'utf8'));
    const out = simulateWin32(state, req);
    writeFileSync(mockPath, JSON.stringify(state, null, 2), 'utf8');
    return out;
  }
  if (process.platform !== 'win32') throw new Error('not win32');
  const enc = Buffer.from(win32Script(req), 'utf16le').toString('base64');
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
}

/**
 * Win32 op on the Electron pid. Actions other than 'query' require an explicit hwnd (OUR window only).
 * Every op (incl. the full hwnd list of the pid) is appended to SESSION.hwndOps. Never throws.
 */
function win32(pid, action = 'query', hwnd = null, extra = null) {
  let r;
  if (SESSION.closing && action !== 'query' && action !== 'restore') r = { ok: false, minimized: null, windows: [], target: null, applied: false, error: 'refused: cleanup in progress' };
  else if (!pid) r = { ok: false, minimized: null, windows: [], target: null, applied: false, error: 'no pid' };
  else {
    try {
      r = parseWin32Result(runWin32Raw({ pid, action, hwnd, ...(extra || {}) }));
    } catch (e) {
      r = { ok: false, minimized: null, windows: [], target: null, applied: false, error: String(e?.message || e) };
    }
  }
  if (action === 'query' && r.ok && hwnd != null) {
    const t = r.windows.find((w) => w.hwnd === Number(hwnd)) || null;
    r = { ...r, target: t, minimized: t ? t.iconic : null };
  }
  SESSION.hwndOps.push({
    at: new Date().toISOString(), action, targetHwnd: hwnd ?? null, ok: !!r.ok, applied: !!r.applied, error: r.error || null,
    placementBefore: r.placementBefore ?? null, placementAfter: r.placementAfter ?? null,
    placementError: r.placementError ?? null, unchanged: !!r.unchanged, dpiAwareness: r.dpiAwareness ?? null,
    foregroundBefore: r.foregroundBefore ?? null, foregroundAfter: r.foregroundAfter ?? null,
    windows: (r.windows || []).map((w) => ({ hwnd: w.hwnd, title: w.title, className: w.className, iconic: w.iconic, visible: w.visible })),
  });
  return r;
}

function minimizedFields(w) {
  if (w.ok && w.target) return { minimized: w.target.iconic, minimizedSource: 'win32-IsIconic(own-hwnd)' };
  return { minimized: null, minimizedSource: 'unavailable:' + (w.error || (w.ok ? 'own hwnd not resolved' : '?')) };
}

/** One persistent session per process. */
const SESSION = {
  page: null, prep: null, lastFrame: null, titleMarker: null,
  own: null, // selectOwnWindow() result
  hide: { mode: 'none', applied: false, error: null, refused: false },
  hwndOps: [],
  freshness: null,
  pid: null,
  closing: null, // v3: closeSession() promise (idempotent)
  preparing: null, // v4: in-flight prepare promise (closeSession awaits it, bounded)
  artifacts: [], // v4: sidecar / freshness.json paths written this run (cleanup results are appended after close)
  cleanup: null,
  cleanupPartial: null, // v5: cleanup object being filled (used by forced exit)
  cleanupWindow: null, // v5: window restore result (computed once)
  outPath: null, // v5: --out (for the cleanup-only JSON)
};

async function ensureSession(opts) {
  SESSION.pid = opts.pid ?? null;
  if (opts.out && !SESSION.outPath) SESSION.outPath = resolve(opts.out);
  if (!SESSION.page) {
    SESSION.page = await connectPage(opts.cdpPort);
    ok(`CDP page title=${SESSION.page.title || ''} url=${SESSION.page.url || ''}`);
  }
  if (!SESSION.titleMarker) {
    SESSION.titleMarker = makeTitleMarker(process.env.DESK_R1_GF_TITLE_NONCE || `${process.pid}-${randomUUID().slice(0, 8)}`);
  }
  SESSION.preparing = evalValue(
    SESSION.page,
    buildPrepareExpression({ preferImageCapture: opts.preferImageCapture, titleMarker: SESSION.titleMarker }),
    'prepare',
  );
  let prep;
  try {
    prep = await SESSION.preparing;
  } finally {
    SESSION.preparing = null;
  }
  if (SESSION.closing) throw new Error('cleanup in progress (signal during prepare): not continuing');
  if (!prep) throw new Error('empty prepare result');
  SESSION.prep = prep;
  ok(`session ${prep.reused ? 'reused' : 'opened'}: source=${prep.info?.frameSource} streamOpens=${prep.info?.streamOpens} captureId=${prep.started?.captureId} titleMarker=${prep.titleMarker} hookHwnd=${prep.hookHwnd}`);
  return prep;
}

/** Identify OUR top-level window: --hwnd > page test-hook hwnd > unique document.title marker. Retries for title propagation. */
async function resolveOwnWindow(opts) {
  if (SESSION.own && SESSION.own.ok) return SESSION.own;
  const hwnd = opts.hwnd ?? SESSION.prep?.hookHwnd ?? null;
  const hwndSource = opts.hwnd != null ? 'explicit --hwnd' : SESSION.prep?.hookHwnd != null ? 'page-test-hook' : null;
  let sel = null;
  for (let i = 0; i < 5; i++) {
    const q = win32(opts.pid, 'query');
    if (!q.ok) {
      sel = { ok: false, hwnd: null, source: null, reason: 'win32 query failed: ' + q.error, windows: [] };
    } else {
      sel = selectOwnWindow(q.windows, { hwnd, hwndSource, titleMarker: SESSION.prep?.titleMarker || null, protectHwnds: opts.protectHwnds });
    }
    if (sel.ok || hwnd != null || !q.ok) break;
    await sleepMs(250); // document.title -> BrowserWindow title propagation
  }
  SESSION.own = sel;
  ok(`own window: ok=${sel.ok} hwnd=${sel.hwnd} source=${sel.source} pidWindows=[${(sel.windows || []).join(',')}]${sel.reason ? ' reason=' + sel.reason : ''}`);
  return sel;
}

/**
 * Hide OUR window only (explicit hwnd). Refuses (no Win32 action at all) if our window cannot be uniquely identified.
 * Returns { refused, reason, w }.
 */
async function hideWindow(opts, mode) {
  if (opts.noMinimize || mode === 'none') {
    SESSION.hide = { mode: 'none', applied: false, error: null, refused: false };
    const own = opts.pid ? await resolveOwnWindow(opts) : { ok: false };
    return { refused: false, w: win32(opts.pid, 'query', own.ok ? own.hwnd : null) };
  }
  const own = await resolveOwnWindow(opts);
  if (!own.ok) {
    SESSION.hide = { mode, applied: false, error: 'refused: ' + own.reason, refused: true };
    fail(`INCONCLUSIVE: refusing to hide (${own.reason})`);
    return { refused: true, reason: own.reason, w: { ok: false, target: null, windows: [], error: own.reason } };
  }
  const w = win32(opts.pid, mode, own.hwnd);
  const applied = !!(w.ok && w.applied);
  SESSION.hide = { mode, applied, error: applied ? null : w.error || 'not applied', refused: false };
  ok(`hide=${mode} hwnd=${own.hwnd} applied=${applied} minimized(IsIconic own)=${w.minimized} ${w.error ? 'err=' + w.error : ''}`);
  return { refused: false, w };
}

/** v6: flat sidecar fields of the post-hide check (last attempt = the deciding one). */
function postHideFields(fresh) {
  const at = fresh && Array.isArray(fresh.attempts) && fresh.attempts.length ? fresh.attempts[fresh.attempts.length - 1] : null;
  if (!at) return {};
  return {
    seqBefore: at.seqBefore ?? at.aSeq ?? null, seqAfter: at.seqAfter ?? at.bSeq ?? null,
    hideIssuedAt: at.hideIssuedAt ?? null, hideIssuedPerfMs: at.hideIssuedPerfMs ?? null, hideIssuedTsUs: at.hideIssuedTsUs ?? null,
    captureTsAfter: at.captureTsAfter ?? at.bTsUs ?? null, captureTsAfterPerfMs: at.captureTsAfterPerfMs ?? null,
    freshBasis: at.freshBasis ?? (at.verdict === 'fresh' ? 'fresh' : 'stale:' + (at.reasons || [at.reason || at.hideError || '?']).join(',')),
    clock: at.clock ?? null,
  };
}

/** v6: page clock (performance.now(), ms) via CDP; same clock the grab session calibrates VideoFrame.timestamp against. */
async function pageNowMs() {
  try {
    const v = await evalValue(SESSION.page, 'performance.now()', 'clock', 5000);
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

async function grabRaw(opts) {
  const v = await evalValue(SESSION.page, buildSessionGrabExpression({ roi: opts.pcRoi }), 'grab');
  if (!v || !v.pngB64) throw new Error('grab returned no frame');
  return v;
}

function freshnessCheckLabel(opts) {
  if (opts.freshnessCheckFlag === 'disabled-by-flag') return 'disabled-by-flag';
  return opts.freshnessCheck ? 'enabled' : 'not-requested';
}

function hideFields() {
  return {
    hideMode: SESSION.hide.mode,
    hideApplied: SESSION.hide.applied,
    hideError: SESSION.hide.error,
    ownHwnd: SESSION.own && SESSION.own.ok ? SESSION.own.hwnd : null,
    hwndOps: SESSION.hwndOps.slice(),
  };
}

/**
 * Write PNG + sidecar. Per-frame verdict compares with the previous grab of this session (evaluateFreshness) unless
 * freshness checking is disabled/not requested -> stale:null, verdict 'unchecked'.
 */
function writeFrame(opts, f, pngPath, frameIndex, mode, extra) {
  mkdirSync(dirname(pngPath), { recursive: true });
  writeFileSync(pngPath, Buffer.from(f.pngB64, 'base64'));
  const w = win32(opts.pid, 'query', SESSION.own && SESSION.own.ok ? SESSION.own.hwnd : null);
  let fv = null;
  if (extra && extra.postHide) {
    // v6: this frame IS the post-hide grab `b` of the freshness check -> its verdict is the post-hide rule result
    fv = extra.postHide;
  } else if (opts.freshnessCheck && SESSION.lastFrame) {
    // frames after the post-hide frame: no per-frame hide -> must show a NEW frame vs the previous grab (static -> stale)
    fv = evaluateFreshness({ a: SESSION.lastFrame, b: f, roi: opts.pcRoi, pcThreshold: opts.pcThreshold });
  }
  SESSION.lastFrame = f;
  const verdict = fv ? fv.verdict : 'unchecked';
  const stale = verdict === 'stale' ? true : verdict === 'fresh' ? false : null;
  const exitCode = exitCodeForVerdicts([verdict]);
  const side = buildSidecar({
    okFlag: verdict === 'fresh' || verdict === 'unchecked',
    pngPath,
    width: f.width,
    height: f.height,
    videoWidth: f.videoWidth,
    videoHeight: f.videoHeight,
    pid: opts.pid,
    exitCode,
    frameIndex,
    captureId: SESSION.prep?.started?.captureId ?? null,
    excludeSelfOk: SESSION.prep?.started?.excludeSelfOk ?? null,
    contentProtection: SESSION.prep?.contentProtection?.on ?? SESSION.prep?.contentProtection ?? null,
    mode,
    seq: f.seq,
    captureTsUs: f.captureTsUs,
    captureWallMs: f.captureWallMs,
    frameSource: f.frameSource,
    streamOpens: f.streamOpens,
    ...minimizedFields(w),
    stale,
    verdict,
    freshnessCheck: freshnessCheckLabel(opts),
    ...hideFields(),
    extra: {
      ts: f.grabWallMs,
      seqDeltaSinceLastGrab: f.seqDeltaSinceLastGrab,
      trackState: f.trackState,
      pcMad: f.pcMad,
      frameFreshness: fv,
      titleMarker: SESSION.prep?.titleMarker ?? null,
      ownHwndSource: SESSION.own?.source ?? null,
      ...(extra || {}),
    },
  });
  const sp = sidecarPathFor(pngPath);
  writeFileSync(sp, JSON.stringify(side, null, 2), 'utf8');
  SESSION.artifacts.push(sp);
  ok(`frame[${frameIndex}] ${f.width}x${f.height} seq=${f.seq} tsUs=${f.captureTsUs} minimized=${side.minimized} verdict=${verdict} -> ${pngPath}`);
  return side;
}

/** Sidecar for a run that produced no usable frame (refused hide / inconclusive precondition / stale check). */
function writeVerdictSidecar(opts, pngPath, mode, verdict, error, extra) {
  const side = buildSidecar({
    okFlag: false, pngPath, pid: opts.pid, exitCode: exitCodeForVerdicts([verdict]), mode,
    ...minimizedFields(win32(opts.pid, 'query', SESSION.own && SESSION.own.ok ? SESSION.own.hwnd : null)),
    stale: verdict === 'stale' ? true : null,
    verdict,
    freshnessCheck: freshnessCheckLabel(opts),
    frameSource: SESSION.prep?.info?.frameSource ?? null,
    streamOpens: SESSION.prep?.info?.streamOpens ?? null,
    ...hideFields(),
    extra: { error, noFrameWritten: true, titleMarker: SESSION.prep?.titleMarker ?? null, ...(extra || {}) },
  });
  mkdirSync(dirname(pngPath), { recursive: true });
  writeFileSync(sidecarPathFor(pngPath), JSON.stringify(side, null, 2), 'utf8');
  SESSION.artifacts.push(sidecarPathFor(pngPath));
  return side;
}

/**
 * Live freshness self-check with OUR window hidden: two grabs >= gapMs apart (evaluateFreshness).
 * minimize first; if stale -> fallback offscreen; still stale -> 'stale'. Refused hide / no timestamp -> 'inconclusive'.
 */
async function freshnessCheck(opts) {
  const modes = opts.noMinimize ? ['none'] : opts.hideMode === 'offscreen' ? ['offscreen'] : ['minimize', 'offscreen'];
  const attempts = [];
  for (const mode of modes) {
    // v6: baseline `a` BEFORE the hide; hideIssuedAt = page performance.now() taken right before launching the hide op
    const a = await grabRaw(opts);
    const hideIssuedPerfMs = await pageNowMs();
    const hideIssuedAt = new Date().toISOString();
    const h = await hideWindow(opts, mode);
    if (h.refused) {
      attempts.push({ hideMode: mode, refused: true, reason: h.reason, verdict: 'inconclusive' });
      return { fresh: false, verdict: 'inconclusive', reason: 'hide refused: ' + h.reason, hideMode: mode, hideApplied: false, attempts };
    }
    const hideApplied = mode !== 'none' && SESSION.hide.applied;
    if (!hideApplied) {
      attempts.push({ hideMode: mode, hideApplied: false, hideError: SESSION.hide.error, verdict: 'stale', reasons: ['hide-not-effective'], aSeq: a.seq, seqBefore: a.seq, hideIssuedAt, hideIssuedPerfMs });
      continue; // try next mode; if none applies -> stale (rule iii)
    }
    await sleepMs(opts.settleMs ?? 1200);
    const b = await grabRaw(opts);
    SESSION.lastFrame = b;
    SESSION.postHide = b;
    const v = evaluatePostHideFreshness({ a, b, hideIssuedPerfMs, hideApplied, roi: opts.pcRoi, pcThreshold: opts.pcThreshold });
    const w2 = win32(opts.pid, 'query', SESSION.own && SESSION.own.ok ? SESSION.own.hwnd : null);
    attempts.push({
      hideMode: mode, hideApplied: SESSION.hide.applied, ownHwnd: SESSION.own?.hwnd ?? null,
      minimized: w2.ok && w2.target ? w2.target.iconic : null, win32Error: h.w.error || w2.error || null,
      aSeq: a.seq, bSeq: b.seq, aTsUs: a.captureTsUs, bTsUs: b.captureTsUs, frameSource: b.frameSource,
      hideIssuedAt, ...v,
    });
    ok(`freshness[${mode}] verdict=${v.verdict} seq ${a.seq}->${b.seq} tsAfter=${b.captureTsUs} hideTs=${v.hideIssuedTsUs} basis=${v.freshBasis}`);
    if (v.fresh) return { fresh: true, verdict: 'fresh', hideMode: mode, hideApplied: SESSION.hide.applied, attempts, postHide: v };
    if (v.verdict === 'inconclusive') return { fresh: false, verdict: 'inconclusive', hideMode: mode, hideApplied: SESSION.hide.applied, attempts, postHide: v };
  }
  const anyStale = attempts.some((x) => x.verdict === 'stale');
  return { fresh: false, verdict: anyStale ? 'stale' : 'inconclusive', hideMode: SESSION.hide.mode, hideApplied: SESSION.hide.applied, attempts };
}

function writeFreshnessEvidence(opts, res) {
  const p = resolve(opts.out).replace(/\.png$/i, '') + '.freshness.json';
  mkdirSync(dirname(p), { recursive: true });
  const atts = Array.isArray(res.attempts) ? res.attempts : [];
  const graded = atts.filter((x) => x.aSeq !== undefined || x.bSeq !== undefined);
  const body = {
    // v5: summary of the check actually performed (added fields; existing ones unchanged)
    performed: res.performed ?? graded.length > 0,
    framesGrabbed: graded.length * 2,
    frameSource: graded.length ? graded[graded.length - 1].frameSource ?? null : SESSION.prep?.info?.frameSource ?? null,
    ...res, pid: opts.pid ?? null, at: new Date().toISOString(),
    freshnessCheck: freshnessCheckLabel(opts),
    ownWindow: SESSION.own, titleMarker: SESSION.prep?.titleMarker ?? null,
    ...hideFields(),
  };
  writeFileSync(p, JSON.stringify(body, null, 2), 'utf8');
  SESSION.artifacts.push(p);
  ok('freshness evidence -> ' + p);
  return p;
}

/**
 * v4: undo every applied Win32 hide on our own hwnd by writing back the ORIGINAL placement (GetWindowPlacement recorded
 * before the FIRST hide attempt of that hwnd, incl. a failed minimize before the offscreen fallback) with a
 * non-activating SetWindowPlacement; the lib re-reads the placement and only reports applied when it matches.
 */
function restoreHwndOps() {
  const per = new Map(); // hwnd -> { original, hidden, attempted, placementError }
  for (const op of SESSION.hwndOps) {
    if (op.targetHwnd == null || op.action === 'query') continue;
    if (op.action === 'restore') { if (op.applied) per.delete(op.targetHwnd); continue; }
    const e = per.get(op.targetHwnd) || { original: null, hidden: [], attempted: [], placementError: null };
    if (!e.original && op.placementBefore) e.original = op.placementBefore;
    if (!op.placementBefore && op.placementError && !e.placementError) e.placementError = op.placementError;
    e.attempted.push(op.action);
    if (op.applied) e.hidden.push(op.action);
    per.set(op.targetHwnd, e);
  }
  const results = [];
  for (const [hwnd, e] of per) {
    if (!e.original) {
      // v5: no original placement (e.g. GetWindowPlacement failed) -> the window is never touched (hide refused too)
      results.push({
        hwnd, undo: e.hidden, ok: !e.hidden.length,
        reason: (e.placementError || 'no original placement recorded') + (e.hidden.length ? '; window was changed and could not be restored' : '; window not touched'),
      });
      continue;
    }
    // v5 (a): whenever an original exists, compare once with the current placement and write it back if different
    // (covers ops that failed after partially changing the window, e.g. offscreen ShowWindow(4) ok + SetWindowPos failed)
    const r = win32(SESSION.pid, 'restore', hwnd, { placement: e.original });
    const okR = !!(r.ok && r.applied);
    const fgChanged = r.foregroundBefore != null && r.foregroundAfter != null && r.foregroundBefore !== r.foregroundAfter;
    results.push({
      hwnd, undo: e.hidden, attempted: e.attempted, ok: okR, reason: okR ? null : r.error || 'restore not applied',
      unchanged: !!r.unchanged, original: e.original, after: r.placementAfter ?? null, foregroundChanged: fgChanged,
      dpiAwareness: r.dpiAwareness ?? null,
    });
    ok(`hwnd restore: hwnd=${hwnd} undo=${e.hidden.join('+') || '-'} -> ${e.original.state} (${e.original.left},${e.original.top}) applied=${okR} unchanged=${!!r.unchanged}${r.error ? ' err=' + r.error : ''}`);
  }
  return results;
}

/** v5: window restore (local, synchronous, page-independent) -> SESSION.cleanupWindow. Runs at most once. */
function restoreWindowsOnce() {
  if (SESSION.cleanupWindow) return SESSION.cleanupWindow;
  let w = { ok: true, reason: 'no hwnd op to undo', hwnds: [] };
  try {
    const hw = restoreHwndOps();
    if (hw.length) {
      const bad = hw.filter((x) => !x.ok);
      w = { ok: !bad.length, reason: bad.length ? bad.map((x) => `hwnd ${x.hwnd}: ${x.reason}`).join('; ') : null, hwnds: hw };
    }
  } catch (e) {
    console.warn('[warn] hwnd restore failed: ' + (e?.message || e));
    w = { ok: false, reason: 'hwnd restore failed: ' + (e?.message || e), hwnds: [] };
  }
  SESSION.cleanupWindow = w;
  return w;
}

function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timeout after ${ms}ms`)), ms); }),
  ]);
}

/** v5 (b): cleanup-only JSON written next to --out when no sidecar / freshness.json was written (error / signal). */
function cleanupOnlyPath() {
  return SESSION.outPath ? SESSION.outPath.replace(/\.png$/i, '') + '.cleanup.json' : null;
}

/** v4: append { cleanup } to every sidecar / freshness.json written this run (existing fields unchanged). */
function recordCleanup(cleanup) {
  const paths = [...new Set(SESSION.artifacts)];
  if (!paths.length) {
    const p = cleanupOnlyPath();
    if (p) {
      try {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, JSON.stringify({ mode: 'cleanup-only', noFrameWritten: true, pid: SESSION.pid, titleMarker: SESSION.titleMarker, hwndOps: SESSION.hwndOps.slice(), cleanup }, null, 2), 'utf8');
        ok('cleanup-only record -> ' + p);
      } catch (e) {
        console.warn('[warn] cleanup-only record failed: ' + (e?.message || e));
      }
    }
    return;
  }
  for (const p of paths) {
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'));
      j.cleanup = cleanup;
      writeFileSync(p, JSON.stringify(j, null, 2), 'utf8');
    } catch (e) {
      console.warn('[warn] cleanup record failed for ' + p + ': ' + (e?.message || e));
    }
  }
}

/**
 * v3/v4: idempotent cleanup for every exit path (normal, error, signal). Awaits an in-flight prepare (bounded), then
 * restores the page title, stops the track(s), restores own-hwnd placement; results go to SESSION.cleanup and into the
 * sidecars / freshness.json as `cleanup`. CDP calls bounded by CLEANUP_TIMEOUT_MS. Never throws.
 */
function closeSession() {
  if (SESSION.closing) return SESSION.closing;
  SESSION.closing = (async () => {
    const cleanup = {
      at: null,
      title: { ok: true, reason: 'no page session' },
      track: { ok: true, reason: 'no page session' },
      window: null,
    };
    SESSION.cleanupPartial = cleanup;
    // v5: window first (local, synchronous, independent of the page) so a forced exit cannot leave it hidden
    cleanup.window = restoreWindowsOnce();
    if (SESSION.page) { cleanup.title = { ok: false, reason: 'pending (cleanup interrupted)' }; cleanup.track = { ok: false, reason: 'pending (cleanup interrupted)' }; }
    if (SESSION.preparing) {
      try {
        await withTimeout(SESSION.preparing.catch(() => null), CLEANUP_TIMEOUT_MS, 'awaiting in-flight prepare');
      } catch (e) {
        console.warn('[warn] ' + (e?.message || e));
      }
    }
    if (SESSION.page) {
      try {
        const r = await evalValue(SESSION.page, buildCloseExpression(SESSION.titleMarker), 'close', CLEANUP_TIMEOUT_MS);
        ok('session closed: ' + JSON.stringify(r));
        cleanup.title = r && !r.titleHasMarker ? { ok: true, reason: null } : { ok: false, reason: 'title still carries marker: ' + (r && r.title) };
        if (!r || !r.hadSession) cleanup.track = { ok: true, reason: 'no capture session was open' };
        else if (r.trackState === 'ended' && !r.closeError) cleanup.track = { ok: true, reason: null };
        else cleanup.track = { ok: false, reason: r.closeError || 'track state ' + r.trackState };
      } catch (e) {
        const reason = 'close failed: ' + (e?.message || e);
        console.warn('[warn] session ' + reason);
        cleanup.title = { ok: false, reason };
        cleanup.track = { ok: false, reason };
      }
    }
    cleanup.at = new Date().toISOString();
    SESSION.cleanup = cleanup;
    ok(`cleanup: title=${cleanup.title.ok} track=${cleanup.track.ok} window=${cleanup.window.ok}`);
    recordCleanup(cleanup);
  })();
  return SESSION.closing;
}

/** v5: forced exit (second signal): restore windows synchronously, record cleanup {forced:true}, exit. */
function forceExit(code, sig) {
  const partial = SESSION.cleanupPartial || {
    title: { ok: false, reason: 'not attempted (forced exit)' }, track: { ok: false, reason: 'not attempted (forced exit)' },
  };
  const cleanup = { ...partial, window: restoreWindowsOnce(), forced: true, forcedBy: sig, at: new Date().toISOString() };
  try {
    recordCleanup(cleanup);
  } catch {}
  process.exit(code);
}

/** v3: SIGINT -> 130, SIGTERM -> 143, SIGBREAK -> 149 (128 + signal number), after closeSession() once.
 *  v5: the FIRST signal's code wins; a second signal (any) force-exits with that same code. */
const SIGNAL_EXIT = Object.freeze({ SIGINT: 130, SIGTERM: 143, SIGBREAK: 149 });
let signalHandled = false;
let firstSignalCode = null;
function installSignalHandlers(onSignal) {
  for (const sig of Object.keys(SIGNAL_EXIT)) {
    try {
      process.on(sig, () => {
        if (signalHandled) {
          // v4/v5: second signal while cleanup is stuck -> restore windows, record cleanup.forced, exit with the FIRST code
          console.error(`[fail] second ${sig} during cleanup -> force exit ${firstSignalCode}`);
          forceExit(firstSignalCode, sig);
          return;
        }
        signalHandled = true;
        firstSignalCode = SIGNAL_EXIT[sig];
        console.error(`[fail] ${sig} received -> cleanup then exit ${SIGNAL_EXIT[sig]}`);
        Promise.resolve()
          .then(() => onSignal && onSignal(sig))
          .catch(() => {})
          .then(() => closeSession())
          .finally(() => process.exit(firstSignalCode));
      });
    } catch {}
  }
}

/** ImageCapture has no capture timestamp: --pc-roi is mandatory, otherwise INCONCLUSIVE before any grab. */
function imageCaptureGuard(opts) {
  if (SESSION.prep?.info?.frameSource === 'ImageCapture' && !opts.pcRoi) {
    return 'frame source is ImageCapture (no capture timestamp): --pc-roi is required';
  }
  return null;
}

/** Single / multi-frame. Returns the process exit code (0 ok | 3 any stale | 4 any inconclusive, none stale). */
async function grabOnce(opts) {
  try {
    return await grabOnceInner(opts);
  } finally {
    await closeSession();
  }
}

async function grabOnceInner(opts) {
  await ensureSession(opts);
  const count = opts.count || 1;
  const baseOut = resolve(opts.out);
  const mode = count > 1 ? 'multi' : 'single';
  const icErr = imageCaptureGuard(opts);
  if (icErr) {
    fail('INCONCLUSIVE: ' + icErr);
    writeVerdictSidecar(opts, baseOut, mode, 'inconclusive', icErr);
    await closeSession();
    return EXIT.INCONCLUSIVE;
  }
  let fresh = null;
  let hideFailed = null;
  if (opts.freshnessCheck) {
    fresh = await freshnessCheck(opts);
    SESSION.freshness = fresh;
    writeFreshnessEvidence(opts, fresh);
    if (!fresh.fresh) {
      fail(`${fresh.verdict.toUpperCase()}: own window hidden but frames not proven fresh -> ` + JSON.stringify(fresh.attempts.map((x) => x.reasons || x.reason || x.hideError)));
      writeVerdictSidecar(opts, baseOut, mode, fresh.verdict, 'freshness check ' + fresh.verdict, { freshness: fresh, ...postHideFields(fresh) });
      await closeSession();
      return exitCodeForVerdicts([fresh.verdict]);
    }
  } else {
    const hm = opts.noMinimize ? 'none' : opts.hideMode || 'minimize';
    const h = await hideWindow(opts, hm);
    if (h.refused) {
      writeVerdictSidecar(opts, baseOut, mode, 'inconclusive', 'hide refused: ' + h.reason);
      await closeSession();
      return EXIT.INCONCLUSIVE;
    }
    if (hm !== 'none' && !SESSION.hide.applied) hideFailed = SESSION.hide.error || 'not applied';
    await sleepMs(opts.settleMs ?? 300);
  }
  const written = [];
  for (let i = 0; i < count; i++) {
    // per-frame verdict compares with the previous grab (incl. the check's last grab): keep >= intervalMs spacing
    // v6: frame 0 after a passed check IS the post-hide grab `b` (judged by the post-hide rule); later frames have no
    // per-frame hide and must show a new frame vs the previous grab (static screen -> stale)
    const usePost = i === 0 && fresh && fresh.fresh && SESSION.postHide;
    if (i > 0) await sleepMs(opts.intervalMs);
    const f = usePost ? SESSION.postHide : await grabRaw(opts);
    const pngPath = frameOutPath(baseOut, i, count);
    const side = writeFrame(opts, f, pngPath, i, mode, {
      freshness: fresh?.verdict ?? freshnessCheckLabel(opts),
      ...(usePost ? { postHide: fresh.postHide, ...postHideFields(fresh) } : { freshBasis: fresh ? 'vs-previous-grab (no per-frame hide)' : 'unchecked' }),
    });
    written.push({ png: pngPath, json: sidecarPathFor(pngPath), side });
  }
  await closeSession();
  let code = exitCodeForVerdicts(written.map((x) => x.side.verdict));
  if (hideFailed && code === EXIT.OK) {
    // v3 (a): hide FAILURE is as inconclusive as a refused hide (frames were grabbed with our window NOT hidden)
    fail('INCONCLUSIVE: own window hide failed (' + hideFailed + ') -> exit 4');
    code = EXIT.INCONCLUSIVE;
  }
  if (code === EXIT.STALE) fail('STALE frame(s) detected -> exit 3');
  else if (code === EXIT.INCONCLUSIVE) fail('INCONCLUSIVE frame(s) -> exit 4');
  return code;
}

function defaultTriggerPath() {
  return join(ROOT, 'out', 'acceptance', 'grab-trigger');
}

function defaultOutPath() {
  return join(ROOT, 'out', 'acceptance', 'grab-frame.png');
}

async function keepAliveMain(opts) {
  try {
    return await keepAliveInner(opts);
  } finally {
    await closeSession();
  }
}

async function keepAliveInner(opts) {
  const trigger = resolve(opts.trigger || defaultTriggerPath());
  const defaultOut = resolve(opts.out || defaultOutPath());
  mkdirSync(dirname(trigger), { recursive: true });
  if (!existsSync(trigger)) writeFileSync(trigger, 'idle\n', 'utf8');
  ok(`keep-alive: trigger=${trigger}`);
  ok(`keep-alive: defaultOut=${defaultOut}`);
  ok('keep-alive: send "grab", "grab <path.png>", or "quit" via trigger file or stdin');

  // ONE persistent MediaStream/track for the whole session (no stop/reopen per frame).
  await ensureSession(opts);
  const icErr = imageCaptureGuard(opts);
  if (icErr) {
    fail('keep-alive: INCONCLUSIVE: ' + icErr + ' -> exit 4');
    writeVerdictSidecar(opts, defaultOut, 'keep-alive', 'inconclusive', icErr);
    await closeSession();
    return EXIT.INCONCLUSIVE;
  }
  let freshVerdict = freshnessCheckLabel(opts);
  if (opts.freshnessCheck) {
    const fresh = await freshnessCheck({ ...opts, out: defaultOut });
    SESSION.freshness = fresh;
    writeFreshnessEvidence({ ...opts, out: defaultOut }, fresh);
    freshVerdict = fresh.verdict;
    if (!fresh.fresh) {
      const code = exitCodeForVerdicts([fresh.verdict]);
      writeVerdictSidecar(opts, defaultOut, 'keep-alive', fresh.verdict, `${fresh.verdict}: frames not proven fresh while own window hidden`, { freshness: fresh, ...postHideFields(fresh) });
      fail(`keep-alive: ${fresh.verdict.toUpperCase()} -> exit ${code}`);
      await closeSession();
      return code;
    }
  } else {
    const h = await hideWindow(opts, opts.noMinimize ? 'none' : opts.hideMode || 'minimize');
    // v5: keep-alive always writes <out>.freshness.json; with the check disabled it records that none was performed
    writeFreshnessEvidence({ ...opts, out: defaultOut }, {
      fresh: false, verdict: 'unchecked', performed: false, reason: 'freshness check ' + freshnessCheckLabel(opts),
      hideMode: SESSION.hide.mode, hideApplied: SESSION.hide.applied, attempts: [],
    });
    if (h.refused) {
      writeVerdictSidecar(opts, defaultOut, 'keep-alive', 'inconclusive', 'hide refused: ' + h.reason);
      await closeSession();
      return EXIT.INCONCLUSIVE;
    }
  }
  let frameIndex = 0;
  const verdictsSeen = []; // v3 (d): quit exit code = worst frame verdict seen (3 stale > 4 inconclusive > 0)
  // per-frame verdict compares with the previous grab: keep >= intervalMs since the last grab (static desktop -> no new frame yet)
  const spacing = async () => {
    const last = SESSION.lastFrame?.grabWallMs;
    const wait = last ? (opts.intervalMs || 0) - (Date.now() - last) : 0;
    if (wait > 0) await sleepMs(wait);
  };
  const usePost = !!(SESSION.freshness && SESSION.freshness.fresh && SESSION.postHide);
  if (!usePost) await spacing();
  // warm-up frame: with the check enabled, writeFrame compares it with the check's last grab (real verdict/stale);
  // warmupFreshness carries the warm-up check result itself
  const wf = SESSION.freshness;
  verdictsSeen.push(writeFrame(opts, usePost ? SESSION.postHide : await grabRaw(opts), defaultOut, frameIndex++, 'keep-alive', {
    freshness: freshVerdict, warmup: true,
    ...(usePost ? { postHide: SESSION.freshness.postHide, ...postHideFields(SESSION.freshness) } : {}),
    warmupFreshness: wf ? { verdict: wf.verdict, fresh: wf.fresh, hideMode: wf.hideMode, attempts: (wf.attempts || []).length, frameSource: (wf.attempts || []).slice(-1)[0]?.frameSource ?? null } : { verdict: 'unchecked', performed: false },
  }).verdict);
  ok('keep-alive: warmed up (initial frame written to defaultOut; stream stays open)');

  let busy = false;
  async function shutdown(code, why) {
    ok(`keep-alive: ${why}`);
    await closeSession();
    process.exit(code);
  }
  async function handleLine(line, source) {
    const raw = String(line || '').trim();
    if (!raw || raw === 'idle') return;
    const lower = raw.toLowerCase();
    if (lower === 'quit' || lower === 'exit') {
      const code = exitCodeForVerdicts(verdictsSeen);
      return shutdown(code, `${source} quit (worst frame verdict -> exit ${code}; per-frame status in each sidecar JSON)`);
    }
    let outPath = defaultOut;
    if (lower === 'grab') outPath = defaultOut;
    else if (lower.startsWith('grab ') || lower.startsWith('grab=')) outPath = resolve(raw.slice(5).trim());
    else {
      console.warn(`[warn] ignore unknown trigger line from ${source}: ${raw}`);
      return;
    }
    if (busy) {
      console.warn('[warn] grab already in progress; skip');
      return;
    }
    busy = true;
    try {
      await spacing();
      const f = await grabRaw(opts); // from the persistent live track
      verdictsSeen.push(writeFrame(opts, f, outPath, frameIndex++, 'keep-alive', { freshness: freshVerdict, freshBasis: 'vs-previous-grab (no per-frame hide)' }).verdict);
      try {
        writeFileSync(trigger, 'idle\n', 'utf8');
      } catch {}
    } catch (e) {
      fail('keep-alive grab failed: ' + (e?.message || e));
      verdictsSeen.push('inconclusive');
      const side = buildSidecar({
        okFlag: false, pngPath: outPath, pid: opts.pid, exitCode: 1, mode: 'keep-alive',
        ...minimizedFields(win32(opts.pid, 'query', SESSION.own && SESSION.own.ok ? SESSION.own.hwnd : null)),
        stale: null, verdict: 'inconclusive', freshnessCheck: freshnessCheckLabel(opts), ...hideFields(),
        extra: { error: String(e?.message || e) },
      });
      try {
        writeFileSync(sidecarPathFor(outPath), JSON.stringify(side, null, 2), 'utf8');
        SESSION.artifacts.push(sidecarPathFor(outPath));
      } catch {}
    } finally {
      busy = false;
    }
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    handleLine(line, 'stdin').catch((e) => fail(String(e?.message || e)));
  });

  let lastContent = existsSync(trigger) ? readFileSync(trigger, 'utf8') : '';
  const onChange = (source) => {
    try {
      if (!existsSync(trigger)) return;
      const cur = readFileSync(trigger, 'utf8');
      if (cur === lastContent) return;
      lastContent = cur;
      const line = cur.split(/\r?\n/).find((l) => l.trim() && l.trim() !== 'idle') || '';
      handleLine(line, source).catch((e) => fail(String(e?.message || e)));
    } catch {}
  };
  const poll = setInterval(() => onChange('trigger-file'), 200);
  try {
    watch(dirname(trigger), { persistent: true }, (_evt, fname) => {
      if (fname && fname !== basename(trigger)) return;
      onChange('trigger-watch');
    });
  } catch (e) {
    ok('fs.watch unavailable; using poll only: ' + (e?.message || e));
  }
  // v3: SIGINT/SIGTERM/SIGBREAK handlers are installed in main() BEFORE ensureSession (exit 130/143/149 after cleanup).
  void poll;
  await new Promise(() => {});
}

async function selfCheckMain(opts) {
  const required = [
    join(__dirname, 'run-acceptance.ps1'),
    join(__dirname, 'cdp-client.mjs'),
    join(__dirname, 'grab-frame.mjs'),
    join(__dirname, 'pixel-tools.mjs'),
    join(__dirname, 'README.md'),
  ];
  for (const f of required) {
    if (!existsSync(f)) fail(`missing ${f}`);
    else ok(`exists ${f.replace(ROOT + '\\', '').replace(ROOT + '/', '')}`);
  }

  // Arg parsing
  const samples = [
    ['--self-check'],
    ['--out', 'C:\\tmp\\x.png', '--count', '3', '--interval-ms', '200'],
    ['--keep-alive', '--out', 'out/acceptance/grab-frame.png'],
    ['--out=frame.png', '--cdp-port=9222', '--pid=1234'],
  ];
  for (const s of samples) {
    try {
      const p = parseArgs(s);
      ok(`parseArgs ${JSON.stringify(s)} -> count=${p.count} keepAlive=${p.keepAlive} selfCheck=${p.selfCheck}`);
    } catch (e) {
      fail(`parseArgs failed for ${JSON.stringify(s)}: ${e.message}`);
    }
  }
  try {
    parseArgs(['--nope']);
    fail('parseArgs should reject unknown args');
  } catch {
    ok('parseArgs rejects unknown args');
  }

  // Preflight helpers (static): port-check logic mirrored — do NOT require port free/busy; just validate function shape
  function testPortInUseLogic(netstatSample, port) {
    const lines = String(netstatSample).split(/\r?\n/);
    for (const ln of lines) {
      if (ln.includes(':' + port) && /LISTENING/i.test(ln)) return true;
    }
    return false;
  }
  const sampleBusy = `  TCP    127.0.0.1:9222         0.0.0.0:0              LISTENING       1234`;
  const sampleFree = `  TCP    127.0.0.1:8080         0.0.0.0:0              LISTENING       1234`;
  if (testPortInUseLogic(sampleBusy, 9222) !== true) fail('preflight helper: busy sample should be in-use');
  else ok('preflight helper: busy sample detected');
  if (testPortInUseLogic(sampleFree, 9222) !== false) fail('preflight helper: free sample should be free');
  else ok('preflight helper: free sample ok');

  // JSON sidecar shape
  const mock = buildSidecar({
    okFlag: true,
    pngPath: join(ROOT, 'out', 'acceptance', 'grab-frame-mock.png'),
    width: 1920,
    height: 1080,
    videoWidth: 1920,
    videoHeight: 1080,
    pid: 4242,
    exitCode: 0,
    frameIndex: 0,
    captureId: 'mock-capture-id',
    excludeSelfOk: false,
    contentProtection: true,
    mode: 'self-check',
    seq: 42,
    captureTsUs: 123456789,
    captureWallMs: 1780000000000,
    frameSource: 'MediaStreamTrackProcessor',
    streamOpens: 1,
    minimized: true,
    minimizedSource: 'win32-IsIconic',
    stale: false,
    extra: { hideMode: 'minimize', seqDeltaSinceLastGrab: 15, note: 'mock only — no Electron' },
  });
  const shape = validateSidecarShape(mock);
  if (!shape.ok) fail('sidecar shape missing: ' + shape.missing.join(','));
  else ok('sidecar JSON shape valid');

  // E-04 freshness logic (mock frames, no display)
  const fA = { seq: 10, captureTsUs: 1000, trackState: 'live', streamOpens: 1 };
  const fB = { seq: 25, captureTsUs: 501000, trackState: 'live', streamOpens: 1, pcMad: 12.5 };
  const frozen = { seq: 10, captureTsUs: 1000, trackState: 'live', streamOpens: 1, pcMad: 0 };
  const roi = { x: 0, y: 0, w: 8, h: 8 };
  if (evaluateFreshness({ a: { seq: 1, captureTsUs: null, frameSource: 'ImageCapture' }, b: { seq: 2, captureTsUs: null, frameSource: 'ImageCapture', pcMad: 0 } }).verdict === 'fresh') fail('freshness: ImageCapture w/o timestamp must never be fresh');
  else ok('freshness: missing capture timestamp / ImageCapture -> never fresh');
  if (!evaluateFreshness({ a: fA, b: fB, roi }).fresh) fail('freshness: advancing frames should be fresh');
  else ok('freshness: advancing seq/ts + positive-control MAD -> fresh');
  const st = evaluateFreshness({ a: fA, b: frozen, roi });
  if (st.fresh || st.verdict !== 'stale') fail('freshness: frozen frames must be stale');
  else ok('freshness: frozen (seq/ts same, MAD=0) -> stale [' + st.reasons.join(',') + ']');
  if (evaluateFreshness({ a: fA, b: { ...fB, pcMad: 0 }, roi }).fresh) fail('freshness: MAD=0 positive control must be stale');
  else ok('freshness: positive control MAD=0 -> stale');
  const wq = parseWin32Result('{"pid":1,"action":"minimize","applied":true,"target":{"hwnd":1,"iconic":true,"visible":true,"title":"x"},"windows":[{"hwnd":1,"iconic":true,"visible":true,"title":"x"}]}');
  if (wq.minimized !== true) fail('parseWin32Result target iconic -> minimized true');
  else ok('parseWin32Result: IsIconic(own hwnd)=true -> minimized=true');
  let needHwnd = false;
  try { win32Script({ pid: 1234, action: 'minimize' }); } catch { needHwnd = true; }
  if (!needHwnd) fail('win32Script must require explicit hwnd for actions');
  else ok('win32Script: actions require explicit hwnd (never all windows of pid)');
  if (!/IsIconic/.test(win32Script(1234, 'query')) || !/ShowWindow\(\$h, 7\)/.test(win32Script({ pid: 1234, action: 'minimize', hwnd: 99 }))) fail('win32Script content');
  else ok('win32Script: IsIconic query + SW_SHOWMINNOACTIVE minimize on one hwnd');
  const selAmb = selectOwnWindow([{ hwnd: 1, title: 'KB [GrabFrame-A:x]' }, { hwnd: 2, title: 'E [GrabFrame-A:x]' }], { titleMarker: '[GrabFrame-A:x]' });
  const selOne = selectOwnWindow([{ hwnd: 1, title: 'KB [GrabFrame-A:x]' }, { hwnd: 2, title: 'E panel' }], { titleMarker: '[GrabFrame-A:x]' });
  if (selAmb.ok || !selOne.ok || selOne.hwnd !== 1) fail('selectOwnWindow');
  else ok('selectOwnWindow: unique title marker -> own hwnd; ambiguous -> refuse (INCONCLUSIVE)');
  if (typeof connectPage !== 'function') fail('connectPage missing');
  else ok('connectPage defined');
  const gfSrc = readFileSync(join(__dirname, 'grab-frame.mjs'), 'utf8');
  if (/getTracks\(\)\)\s*t\.stop\(\);\s*\n\s*video\.remove/.test(gfSrc)) fail('per-grab track.stop() still present');
  else ok('no per-grab openStream/track.stop() (persistent session)');
  if (!/_testSetContentProtection\(true,\s*\{\s*raise:\s*false\s*\}\)/.test(gfSrc)) fail('GrabFrame must call _testSetContentProtection(true, { raise: false })');
  else ok('GrabFrame contentProtection uses raise:false (no foreground steal)');
  const preloadSrc = readFileSync(join(ROOT, 'src', 'preload', 'desktopPanelPreload.ts'), 'utf8');
  if (!/opts\.raise|payload\.raise/.test(preloadSrc) || !/hasOwnProperty\.call\(opts, 'raise'\)/.test(preloadSrc)) fail('preload must forward optional raise to IPC');
  else ok('preload forwards optional raise to _testSetContentProtection IPC');
  if (!existsSync(join(__dirname, 'grab-frame-lib.mjs'))) fail('missing grab-frame-lib.mjs');
  else ok('grab-frame-lib.mjs present');

  // frame path naming
  const p1 = frameOutPath('C:/tmp/desk.png', 0, 1);
  const p2 = frameOutPath('C:/tmp/desk.png', 0, 3);
  const p3 = frameOutPath('C:/tmp/desk.png', 2, 3);
  if (!p1.endsWith('desk.png')) fail('single frame path');
  else ok('single frame path = base out');
  if (!/desk-001\.png$/i.test(p2.replace(/\\/g, '/'))) fail('multi frame path 001');
  else ok('multi frame path desk-001.png');
  if (!/desk-003\.png$/i.test(p3.replace(/\\/g, '/'))) fail('multi frame path 003');
  else ok('multi frame path desk-003.png');

  // PS1 must expose -GrabFrame
  const ps1 = readFileSync(join(__dirname, 'run-acceptance.ps1'), 'utf8');
  if (!/GrabFrame/.test(ps1)) fail('run-acceptance.ps1 missing -GrabFrame');
  else ok('run-acceptance.ps1 has -GrabFrame');
  if (!/\$Out/.test(ps1) && !/Out\s*</.test(ps1) && !/\[string\]\$Out/.test(ps1)) {
    // allow either $Out param
    if (!ps1.includes('$Out')) fail('run-acceptance.ps1 missing -Out param');
    else ok('run-acceptance.ps1 has -Out');
  } else ok('run-acceptance.ps1 has -Out');
  if (!/Count/.test(ps1)) fail('run-acceptance.ps1 missing -Count');
  else ok('run-acceptance.ps1 has -Count');
  if (!/IntervalMs/.test(ps1)) fail('run-acceptance.ps1 missing -IntervalMs');
  else ok('run-acceptance.ps1 has -IntervalMs');
  if (!/\$gfExit -eq 4/.test(ps1) || !/if \(\$script:gfInconclusive\) \{ exit 4 \}/.test(ps1)) fail('run-acceptance.ps1 must propagate exit 4 (INCONCLUSIVE)');
  else ok('run-acceptance.ps1 propagates exit 3 STALE / 4 INCONCLUSIVE (no "GrabFrame OK")');
  if (!/disabled-by-flag/.test(ps1)) fail('run-acceptance.ps1 must log freshnessCheck=disabled-by-flag');
  else ok('run-acceptance.ps1 logs freshnessCheck=disabled-by-flag');
  if (!/KeepAlive/.test(ps1)) fail('run-acceptance.ps1 missing -KeepAlive');
  else ok('run-acceptance.ps1 has -KeepAlive');
  if (!/grab-frame\.mjs/.test(ps1)) fail('run-acceptance.ps1 does not invoke grab-frame.mjs');
  else ok('run-acceptance.ps1 invokes grab-frame.mjs');
  // Must NOT treat GrabFrame as FullRun by default
  if (/if\s*\(\s*\$GrabFrame\s*\)\s*\{\s*\$FullRun\s*=\s*\$true/.test(ps1)) {
    fail('GrabFrame must not force FullRun');
  } else ok('GrabFrame does not force FullRun');

  // Trigger convention
  const trig = defaultTriggerPath();
  ok('trigger default path: ' + trig.replace(ROOT + '\\', '').replace(ROOT + '/', ''));

  const outDir = join(ROOT, 'out', 'acceptance');
  mkdirSync(outDir, { recursive: true });
  const evidence = {
    ok: !process.exitCode,
    mode: 'grab-frame-self-check',
    stubPolicy: 'no-stub',
    capturePath: 'CDP getUserMedia(chromeMediaSourceId) + canvas grabFrame (NOT OS GDI)',
    contentProtection: 'ON via _testSetContentProtection(true, { raise: false }) — protection sticks; no alwaysOnTop/moveTop/focus',
    minimize: 'Win32 ShowWindow(SW_SHOWMINNOACTIVE) on ONE explicit own hwnd only (--hwnd, else _testGetNativeWindowHandle, else unique title marker; otherwise no Win32 action -> INCONCLUSIVE); fallback offscreen SetWindowPos(-32000) if stale; restored on every exit; sidecar minimized = IsIconic(own hwnd)',
    persistentStream: 'one getUserMedia track per process (window.__deskR1AGrab); MediaStreamTrackProcessor latest VideoFrame (seq + timestamp); ImageCapture fallback; track.stop() only on quit',
    freshness: 'keep-alive/multi: 2 grabs >=1.2s apart with window hidden must advance seq/captureTsUs (+ --pc-roi MAD>threshold) else stale -> exit 3',
    keepAliveTrigger: 'out/acceptance/grab-trigger (lines: grab | grab <path> | quit)',
    sidecar: mock,
    sidecarShapeOk: shape.ok,
    cdpPort: opts.cdpPort,
    note: 'NO Electron launched. Static self-check only.',
    generatedAt: new Date().toISOString(),
  };
  const evidencePath = join(outDir, 'grab-frame-self-check.json');
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), 'utf8');
  ok('wrote ' + evidencePath.replace(ROOT + '\\', '').replace(ROOT + '/', ''));

  // Also write mock sidecar as shape example
  writeFileSync(join(outDir, 'grab-frame-mock.json'), JSON.stringify(mock, null, 2), 'utf8');
  ok('wrote out/acceptance/grab-frame-mock.json');

  if (!process.exitCode) ok('GrabFrame self-check PASSED (no Electron / no windows)');
  return evidencePath;
}

function printHelp() {
  console.log(`GrabFrame CLI (desk-r1-A)

  node grab-frame.mjs --self-check
  node grab-frame.mjs --out <path.png> [--count N --interval-ms M] [--pid N] [--cdp-port 9222]
  node grab-frame.mjs --keep-alive [--out <default.png>] [--trigger <path>] [--pid N]
       [--hide-mode minimize|offscreen] [--pc-roi x,y,w,h --pc-threshold 1.0] [--no-freshness-check]
       [--hwnd N] [--protect-hwnd a,b] [--prefer-image-capture --pc-roi x,y,w,h]
  exit: 0 ok | 1 error | 2 bad args | 3 STALE (any frame stale) | 4 INCONCLUSIVE (freshness unprovable,
        e.g. ImageCapture/no timestamp, own window not uniquely identifiable -> hide refused, hide failed)
        | 130 SIGINT / 143 SIGTERM / 149 SIGBREAK (after title/track/hwnd restore)
        keep-alive quit: worst frame verdict seen (3 if any STALE, else 4 if any INCONCLUSIVE, else 0)
  Use ONLY via run-acceptance.ps1 -GrabFrame; never point --cdp-port at the product under test directly.

Via launcher (preferred):
  .\\run-acceptance.ps1 -GrabFrame -SelfCheck
  .\\run-acceptance.ps1 -GrabFrame -Out .\\out\\acceptance\\desk.png
  .\\run-acceptance.ps1 -GrabFrame -Out .\\out\\acceptance\\desk.png -Count 5 -IntervalMs 300
  .\\run-acceptance.ps1 -GrabFrame -KeepAlive -Out .\\out\\acceptance\\grab-frame.png [-PcRoi x,y,w,h] [-HideMode offscreen]
`);
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error('[fail] ' + e.message);
    printHelp();
    process.exit(2);
  }
  if (opts.help) {
    printHelp();
    return;
  }
  // Default to self-check when no out and not keep-alive
  if (!opts.selfCheck && !opts.keepAlive && !opts.out) {
    opts.selfCheck = true;
  }
  if (opts.selfCheck) {
    await selfCheckMain(opts);
    return;
  }
  installSignalHandlers();
  if (opts.keepAlive) {
    if (!opts.out) opts.out = defaultOutPath();
    return keepAliveMain(opts);
  }
  if (!opts.out) {
    fail('--out required for grab (or use --self-check / --keep-alive)');
    process.exit(2);
  }
  const code = await grabOnce(opts);
  ok(`GrabFrame done exit=${code}`);
  return code;
}

main().then(
  (code) => {
    if (typeof code === 'number') process.exit(code);
  },
  async (e) => {
    console.error('[fail] ' + (e?.stack || e?.message || e));
    try {
      await closeSession();
    } catch {}
    process.exit(1);
  },
);
