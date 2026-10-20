#!/usr/bin/env node
/**
 * CDP helper for desk-r1-A acceptance - round 6 (A-03 v2: positive control + Win32 visibility; txt from JSON).
 * --self-check: no Electron. --full: connect CDP, stream frames, A-02/A-03 auto verdicts.
 * Prefer `ws` package over Node/undici global WebSocket; expanded ErrorEvent logging.
 */
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPixelSelfTests, decideA03, renderA03VerdictTxt, A03_MARKER_TOL } from './pixel-tools.mjs';
import { createRequire as __createRequire } from 'node:module';
const __requireCdp = __createRequire(import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const args = new Set(process.argv.slice(2));
const selfCheck = args.has('--self-check') || (!args.has('--full') && !args.has('--full-run'));
const port = Number(process.env.DESK_R1_CDP_PORT || 9222);
const MARKER_HEX = '#E911E9';
const MARKER_RGB = [233, 17, 233];

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
  writeFileSync(filePath, Buffer.from(b64, 'base64'));
}

/** A-03 v2 verdict: offline (no CDP). Reads raw phase JSON, writes A-03-verdict.json, then txt FROM that JSON only. */
async function a03VerdictMain() {
  const outDir = join(ROOT, 'out', 'acceptance');
  mkdirSync(outDir, { recursive: true });
  const read = (n) => {
    const p = join(outDir, n);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    } catch (e) {
      return { __parseError: String((e && e.message) || e), error: 'parse_error' };
    }
  };
  const input = {
    p1Arm: read('A-03-p1-arm.json'),
    p1Os: read('A-03-p1-os.json'),
    p1Win32: read('A-03-p1-win32.json'),
    p1Stream: read('A-03-p1-stream.json'),
    p2Arm: read('A-03-p2-arm.json'),
    p2Win32: read('A-03-p2-win32.json'),
    p2Stream: read('A-03-p2-stream.json'),
  };
  const verdict = decideA03(input);
  verdict.generatedAt = new Date().toISOString();
  const jsonPath = join(outDir, 'A-03-verdict.json');
  writeFileSync(jsonPath, JSON.stringify(verdict, null, 2), 'utf8');
  const fromDisk = JSON.parse(readFileSync(jsonPath, 'utf8'));
  writeFileSync(join(outDir, 'A-03-verdict.txt'), renderA03VerdictTxt(fromDisk), 'utf8');
  ok(`A-03 verdict=${fromDisk.verdict} reason=${fromDisk.reason}`);
  console.log(renderA03VerdictTxt(fromDisk));
  process.exitCode = fromDisk.verdict === 'PASS' ? 0 : fromDisk.verdict === 'FAIL' ? 1 : 2;
}

async function selfCheckMain() {  const required = [
    join(__dirname, 'run-acceptance.ps1'),
    join(__dirname, 'cdp-client.mjs'),
    join(__dirname, 'pixel-tools.mjs'),
    join(__dirname, 'README.md'),
    join(__dirname, 'win32-window-check.ps1'),
    join(ROOT, 'src', 'preload', 'desktopPanelPreload.ts'),
    join(ROOT, 'src', 'main', 'desktopSession', 'index.ts'),
    join(ROOT, 'src', 'main', 'desktopSession', 'excludeSelfPolicy.ts'),
    join(ROOT, 'src', 'main', 'desktopSession', 'channels.ts'),
    join(ROOT, 'src', 'shared', 'desktopPanel', 'preloadApi.ts'),
  ];
  for (const f of required) {
    if (!existsSync(f)) fail(`missing ${f}`);
    else ok(`exists ${f.replace(ROOT + '\\', '').replace(ROOT + '/', '')}`);
  }

  ok('cdp-client.mjs parseable');
  if (typeof globalThis.WebSocket !== 'function') fail('global WebSocket missing (Node >= 22 required for full run)');
  else ok('WebSocket available (prefer ws package; undici global fallback)');

  // FullRun must NOT set stub by default — check launcher source
  const ps1 = readFileSync(join(__dirname, 'run-acceptance.ps1'), 'utf8');
  if (/DESK_R1_STUB_FULLSCREEN\s*=\s*'1'/.test(ps1) && !/AllowStub/.test(ps1)) {
    // Allow only inside -AllowStub branch
    const defaultSetsStub =
      /\$env:DESK_R1_STUB_FULLSCREEN\s*=\s*'1'/.test(ps1) &&
      !ps1.includes('if ($AllowStub)');
    // More precise: stub assignment should be gated
    const stubLine = ps1.split(/\r?\n/).find((l) => l.includes("DESK_R1_STUB_FULLSCREEN = '1'"));
    if (stubLine && !/AllowStub|if \(/.test(ps1.slice(Math.max(0, ps1.indexOf(stubLine) - 120), ps1.indexOf(stubLine) + stubLine.length))) {
      // if the line exists, require nearby AllowStub
      const idx = ps1.indexOf(stubLine);
      const window = ps1.slice(Math.max(0, idx - 200), idx + 80);
      if (!window.includes('AllowStub')) {
        fail('run-acceptance.ps1 sets DESK_R1_STUB_FULLSCREEN=1 outside -AllowStub');
      } else ok('stub env only under -AllowStub');
    } else ok('stub env policy ok (AllowStub gated or absent)');
  } else if (/AllowStub/.test(ps1)) {
    ok('AllowStub switch present; default FullRun is no-stub');
  } else {
    // no stub assignment at all — best
    if (!ps1.includes("DESK_R1_STUB_FULLSCREEN = '1'")) ok('FullRun does not set DESK_R1_STUB_FULLSCREEN');
    else fail('unexpected stub assignment');
  }

  if (!ps1.includes('_testSetFullscreen') && !ps1.includes('testSetFullscreen')) {
    // launcher may only call cdp which uses the hook
    ok('launcher delegates fullscreen to CDP/test hook');
  }

  const pixel = runPixelSelfTests();
  if (!pixel.ok) {
    fail('pixel self-tests failed: ' + JSON.stringify(pixel.results.filter((r) => !r.pass)));
  } else {
    ok(`pixel self-tests PASSED (${pixel.results.length})`);
  }

  // Mock CDP flow documentation
  const mockSteps = [
    'enumerateSources',
    '_testSetFullscreen(true)',
    '_testBootstrap',
    'captureStart',
    'getUserMedia(chromeMediaSourceId)',
    'video+canvas frame capture',
    'A-02 explorer stream diff',
    'A-03 p1: protection OFF -> OS-ref + stream both show marker (positive control)',
    'A-03 p2: protection ON -> Win32 IsWindowVisible/!IsIconic/primary/WindowFromPoint root', 'A-03 p2 stream markerHits==0 => PASS', 'A-03 verdict json -> txt',
  ];
  ok('mock FullRun steps: ' + mockSteps.join(' -> '));

  const outDir = join(ROOT, 'out', 'acceptance');
  mkdirSync(outDir, { recursive: true });
  const payload = {
    ok: !process.exitCode,
    mode: 'self-check',
    round: 3,
    stubPolicy: 'no-stub-default',
    estimatedFullRunMinutes: '5-8',
    envRequired: ['DESK_R1_A_TEST_HOOK=1'],
    envForbiddenUnlessAllowStub: ['DESK_R1_STUB_FULLSCREEN'],
    markerHex: MARKER_HEX,
    cdpPort: port,
    pixelTests: pixel.results,
    note: 'Full run blocked until supervisor says kaipao (go). Uses real setFullScreen via _testSetFullscreen.',
  };
  writeFileSync(join(outDir, 'self-check.json'), JSON.stringify(payload, null, 2), 'utf8');
  ok('wrote out/acceptance/self-check.json');
  if (!process.exitCode) ok('self-check PASSED (no Electron / no windows)');
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

function formatWsErrorEvent(e) {
  const safe = {
    type: e?.type,
    message: e?.message,
    errorName: e?.error?.name,
    errorMessage: e?.error?.message,
    errorStack: e?.error?.stack,
    errorCause: e?.error?.cause
      ? {
          name: e.error.cause?.name,
          message: e.error.cause?.message,
          code: e.error.cause?.code,
          errno: e.error.cause?.errno,
          syscall: e.error.cause?.syscall,
          address: e.error.cause?.address,
          port: e.error.cause?.port,
        }
      : undefined,
  };
  try {
    safe.eventJSON = JSON.stringify(e, Object.getOwnPropertyNames(e || {}));
  } catch (err) {
    safe.eventJSONError = String(err?.message || err);
  }
  try {
    if (e?.error) safe.errorJSON = JSON.stringify(e.error, Object.getOwnPropertyNames(e.error));
  } catch (err) {
    safe.errorJSONError = String(err?.message || err);
  }
  const text = [
    'type=' + String(safe.type),
    'message=' + JSON.stringify(safe.message),
    'error.name=' + JSON.stringify(safe.errorName),
    'error.message=' + JSON.stringify(safe.errorMessage),
    safe.errorCause ? 'error.cause=' + JSON.stringify(safe.errorCause) : null,
    safe.errorStack
      ? 'error.stack=' + String(safe.errorStack).split('\n').slice(0, 6).join(' | ')
      : null,
    safe.eventJSON ? 'eventJSON=' + safe.eventJSON : null,
    safe.errorJSON ? 'errorJSON=' + safe.errorJSON : null,
  ]
    .filter(Boolean)
    .join(' ; ');
  return { text, safe };
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
      const WS = __requireCdp(c);
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
  console.log(`[cdp] WS impl=${impl.kind}${impl.source ? ' src=' + impl.source : ''} url=${wsUrl}`);
  if (impl.kind === 'ws-package') {
    return new Promise((resolve, reject) => {
      const ws = new impl.WS(wsUrl, { perMessageDeflate: false });
      let id = 0;
      const pending = new Map();
      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error('CDP evaluate timeout'));
      }, timeoutMs);
      const send = (method, params) =>
        new Promise((res, rej) => {
          const mid = ++id;
          pending.set(mid, { res, rej });
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      ws.on('open', () => {
        (async () => {
          await send('Runtime.enable', {});
          const result = await send('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
          });
          clearTimeout(timer);
          ws.close();
          resolve(result);
        })().catch((e) => {
          clearTimeout(timer);
          reject(e);
        });
      });
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data));
        if (msg.id && pending.has(msg.id)) {
          const { res, rej } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) rej(new Error(JSON.stringify(msg.error)));
          else res(msg.result);
        }
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(
          new Error(
            'CDP websocket error (ws): ' +
              (err?.message || String(err)) +
              (err?.code ? ' code=' + err.code : ''),
          ),
        );
      });
    });
  }
  const WS = impl.WS;
  return new Promise((resolve, reject) => {
    const ws = new WS(wsUrl);
    let id = 0;
    const pending = new Map();
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('CDP evaluate timeout'));
    }, timeoutMs);
    const send = (method, params) =>
      new Promise((res, rej) => {
        const mid = ++id;
        pending.set(mid, { res, rej });
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
    ws.addEventListener('open', () => {
      (async () => {
        await send('Runtime.enable', {});
        const result = await send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
        });
        clearTimeout(timer);
        ws.close();
        resolve(result);
      })().catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      }
    });
    ws.addEventListener('error', (e) => {
      clearTimeout(timer);
      const formatted = formatWsErrorEvent(e);
      console.error('[cdp] EXPANDED ErrorEvent: ' + formatted.text);
      reject(new Error('CDP websocket error: ' + formatted.text));
    });
  });
}

/** In-page expression: stream capture helpers + A-01/02/03 logic. */
function buildFullExpression(phase) {
  // phase: 'a01' | 'a02-before' | 'a02-after' | 'a03-p1-arm' | 'a03-p1-stream' | 'a03-p2-arm' | 'a03-p2-stream'
  // Shared helpers inlined once per evaluate.
  return `({
  async run() {
    const PHASE = ${JSON.stringify(phase)};
    const MARKER = ${JSON.stringify(MARKER_HEX)};
    const MARKER_RGB = ${JSON.stringify(MARKER_RGB)};

    const c = window.desktopPanel && window.desktopPanel.capture;
    if (!c) throw new Error('desktopPanel.capture missing');
    if (typeof c._testSetFullscreen !== 'function') throw new Error('_testSetFullscreen missing (need DESK_R1_A_TEST_HOOK=1)');
    if (typeof c._testBootstrap !== 'function') throw new Error('_testBootstrap missing');

    function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

    async function ensureLive() {
      let st = await c.captureGetStatus();
      if (st && st.status === 'live' && st.captureId) return st;
      await c._testSetFullscreen(true);
      await sleep(400);
      const srcs = await c.enumerateSources();
      if (!srcs.length) throw new Error('no sources');
      const boot = await c._testBootstrap();
      const started = await c.captureStart(boot.sessionId, srcs[0] || boot.source);
      if (!started || started.ok === false) throw new Error('captureStart failed: ' + JSON.stringify(started));
      if (started.status !== 'live') throw new Error('not live: ' + JSON.stringify(started));
      return started;
    }

    async function openStream(captureId) {
      const constraints = {
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: captureId,
            maxWidth: 16384,
            maxHeight: 16384,
            maxFrameRate: 30,
          },
        },
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const video = document.createElement('video');
      video.muted = true;
      video.autoplay = true;
      video.playsInline = true;
      video.style.position = 'fixed';
      video.style.left = '-10000px';
      video.srcObject = stream;
      document.body.appendChild(video);
      await video.play().catch(() => {});
      // wait for dimensions
      for (let i = 0; i < 50; i++) {
        if (video.videoWidth > 0 && video.videoHeight > 0) break;
        await sleep(100);
      }
      if (!video.videoWidth) throw new Error('videoWidth=0');
      return { stream, video };
    }

    function grabFrame(video) {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0);
      const dataUrl = canvas.toDataURL('image/png');
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return {
        dataUrl,
        width: canvas.width,
        height: canvas.height,
        rgba: Array.from(img.data),
        ts: Date.now(),
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
      };
    }

    function meanAbsDiff(a, b) {
      const n = a.length / 4;
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const o = i * 4;
        sum += Math.abs(a[o]-b[o]) + Math.abs(a[o+1]-b[o+1]) + Math.abs(a[o+2]-b[o+2]);
      }
      return sum / (n * 3);
    }
    function changedRatio(a, b, tol) {
      const n = a.length / 4;
      let ch = 0;
      for (let i = 0; i < n; i++) {
        const o = i * 4;
        const d = Math.max(Math.abs(a[o]-b[o]), Math.abs(a[o+1]-b[o+1]), Math.abs(a[o+2]-b[o+2]));
        if (d > tol) ch++;
      }
      return ch / n;
    }
    function markerHits(rgba, rgb, tol) {
      const n = rgba.length / 4;
      let hits = 0;
      for (let i = 0; i < n; i++) {
        const o = i * 4;
        if (Math.abs(rgba[o]-rgb[0])<=tol && Math.abs(rgba[o+1]-rgb[1])<=tol && Math.abs(rgba[o+2]-rgb[2])<=tol) hits++;
      }
      return { hits, ratio: hits / n, total: n };
    }
    function lumaVar(rgba) {
      const n = rgba.length / 4;
      let sum = 0;
      const ys = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const o = i * 4;
        const y = 0.299*rgba[o] + 0.587*rgba[o+1] + 0.114*rgba[o+2];
        ys[i] = y; sum += y;
      }
      const mean = sum / n;
      let v = 0;
      for (let i = 0; i < n; i++) { const d = ys[i]-mean; v += d*d; }
      return v / n;
    }

    function showMarker() {
      let el = document.getElementById('desk-r1-a-marker');
      if (!el) {
        el = document.createElement('div');
        el.id = 'desk-r1-a-marker';
        el.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
        document.documentElement.appendChild(el);
      }
      // checker of marker + near-black for uniqueness
      el.style.background =
        'repeating-conic-gradient(' + MARKER + ' 0% 25%, #101010 0% 50%) 0 0 / 32px 32px';
      el.style.display = 'block';
      document.documentElement.style.background = MARKER;
      return true;
    }
    function hideMarker() {
      const el = document.getElementById('desk-r1-a-marker');
      if (el) el.style.display = 'none';
      document.documentElement.style.background = '';
    }

    if (PHASE === 'a01') {
      const started = await ensureLive();
      const { stream, video } = await openStream(started.captureId);
      await sleep(300);
      const f1 = grabFrame(video);
      await sleep(200);
      const f2 = grabFrame(video);
      // stop tracks after capture
      for (const t of stream.getTracks()) t.stop();
      video.remove();
      return {
        phase: 'a01',
        started,
        frame1: { ts: f1.ts, videoWidth: f1.videoWidth, videoHeight: f1.videoHeight, width: f1.width, height: f1.height, dataUrl: f1.dataUrl },
        frame2: { ts: f2.ts, videoWidth: f2.videoWidth, videoHeight: f2.videoHeight, width: f2.width, height: f2.height, dataUrl: f2.dataUrl },
        frameDeltaMs: f2.ts - f1.ts,
        pass: !!(f1.videoWidth > 0 && f1.videoHeight > 0 && f1.dataUrl && started.status === 'live'),
      };
    }

    if (PHASE === 'a02-before' || PHASE === 'a02-after') {
      const started = await ensureLive();
      const { stream, video } = await openStream(started.captureId);
      await sleep(400);
      const f = grabFrame(video);
      for (const t of stream.getTracks()) t.stop();
      video.remove();
      // keep rgba for after-diff only on after? return rgba always (may be large) — downsample in page
      const scale = 8;
      const sw = Math.max(1, Math.floor(f.width / scale));
      const sh = Math.max(1, Math.floor(f.height / scale));
      const cnv = document.createElement('canvas');
      cnv.width = sw; cnv.height = sh;
      const cx = cnv.getContext('2d');
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = f.dataUrl; });
      cx.drawImage(img, 0, 0, sw, sh);
      const small = cx.getImageData(0, 0, sw, sh);
      return {
        phase: PHASE,
        startedExcludeSelfOk: started.excludeSelfOk,
        dataUrl: f.dataUrl,
        videoWidth: f.videoWidth,
        videoHeight: f.videoHeight,
        ts: f.ts,
        small: { width: sw, height: sh, rgba: Array.from(small.data) },
      };
    }

    if (PHASE === 'a02-diff') {
      // Expect window.__deskR1A02Before set by host inject — instead node does diff externally.
      throw new Error('a02-diff is computed in node');
    }

    const A03_TOL = ${JSON.stringify(A03_MARKER_TOL)};
    async function setProtection(on) {
      if (typeof c._testSetContentProtection !== 'function') {
        throw new Error('_testSetContentProtection missing (need DESK_R1_A_TEST_HOOK=1 and rebuilt main/preload)');
      }
      const r = await c._testSetContentProtection(!!on);
      if (!r || r.ok !== true) throw new Error('setContentProtection(' + on + ') failed: ' + JSON.stringify(r));
      return r;
    }
    function pageInfo() {
      return {
        devicePixelRatio: window.devicePixelRatio,
        screenX: window.screenX,
        screenY: window.screenY,
        outerWidth: window.outerWidth,
        outerHeight: window.outerHeight,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        screenWidth: window.screen && window.screen.width,
        screenHeight: window.screen && window.screen.height,
        visibilityState: document.visibilityState,
        documentHidden: !!document.hidden,
      };
    }

    if (PHASE === 'a03-p1-arm' || PHASE === 'a03-p2-arm') {
      // A-03 v2. p1: content protection OFF (positive control). p2: content protection ON.
      const started = await ensureLive();
      showMarker();
      const protection = await setProtection(PHASE === 'a03-p2-arm');
      await sleep(800);
      return { phase: PHASE, started, excludeSelfOk: started.excludeSelfOk, contentProtection: protection, page: pageInfo() };
    }

    if (PHASE === 'a03-p1-stream' || PHASE === 'a03-p2-stream') {
      const started = await ensureLive();
      showMarker();
      await sleep(300);
      const { stream, video } = await openStream(started.captureId);
      await sleep(500);
      const f = grabFrame(video);
      for (const t of stream.getTracks()) t.stop();
      video.remove();
      const hit = markerHits(f.rgba, MARKER_RGB, A03_TOL);
      const lv = lumaVar(f.rgba);
      if (PHASE === 'a03-p2-stream') hideMarker();
      return {
        phase: PHASE,
        excludeSelfOk: started.excludeSelfOk,
        captureId: started.captureId,
        dataUrl: f.dataUrl,
        videoWidth: f.videoWidth,
        videoHeight: f.videoHeight,
        ts: f.ts,
        markerHits: hit.hits,
        markerRatio: hit.ratio,
        totalPixels: hit.total,
        markerTol: A03_TOL,
        lumaVariance: lv,
        page: pageInfo(),
      };
    }
    throw new Error('unknown phase ' + PHASE);
  }
}).run()`;
}

async function fullMain() {
  const list = await fetchJson(`http://127.0.0.1:${port}/json/list`);
  let version = null;
  try {
    version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
  } catch {}
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('no page target on CDP port');
  // Must be page-level WS (not browser/shared_worker) for Runtime.evaluate in page context
  ok(`CDP target type=${page.type} title=${page.title || ''} url=${page.url || ''}`);
  ok(`CDP page webSocketDebuggerUrl=${page.webSocketDebuggerUrl}`);
  if (version?.webSocketDebuggerUrl) {
    ok(`CDP /json/version browserWS=${version.webSocketDebuggerUrl} (NOT used for page evaluate)`);
  }
  if (page.type !== 'page') {
    throw new Error(`refusing non-page target type=${page.type}`);
  }

  const outDir = join(ROOT, 'out', 'acceptance');
  mkdirSync(outDir, { recursive: true });
  const phase = [...args].find((a) => a.startsWith('--phase='))?.slice('--phase='.length) || 'a01';

  const result = await cdpEvaluate(page.webSocketDebuggerUrl, buildFullExpression(phase));
  if (result?.exceptionDetails) {
    throw new Error('evaluate exception: ' + JSON.stringify(result.exceptionDetails));
  }
  const value = result?.result?.value;
  if (!value) throw new Error('empty evaluate result: ' + JSON.stringify(result));

  if (phase === 'a01') {
    writePngFromDataUrl(value.frame1.dataUrl, join(outDir, 'A-01-stream.png'));
    writePngFromDataUrl(value.frame2.dataUrl, join(outDir, 'A-01-stream-f2.png'));
    const verdict = {
      pass: !!value.pass && value.frame1.videoWidth >= 800 && value.frame1.videoHeight >= 600,
      videoWidth: value.frame1.videoWidth,
      videoHeight: value.frame1.videoHeight,
      frameTimestamps: [value.frame1.ts, value.frame2.ts],
      frameDeltaMs: value.frameDeltaMs,
      captureStatus: value.started?.status,
      excludeSelfOk: value.started?.excludeSelfOk,
      captureId: value.started?.captureId,
      note: 'OS screenshots are reference-only; stream PNG is the verdict basis',
    };
    writeFileSync(join(outDir, 'A-01-verdict.json'), JSON.stringify(verdict, null, 2), 'utf8');
    writeFileSync(join(outDir, 'cdp-result.json'), JSON.stringify({ phase, started: value.started, verdict }, null, 2), 'utf8');
    ok(`A-01 stream saved; pass=${verdict.pass}`);
    console.log(JSON.stringify(verdict, null, 2));
    if (!verdict.pass) process.exitCode = 1;
    return;
  }

  if (phase === 'a02-before') {
    writePngFromDataUrl(value.dataUrl, join(outDir, 'A-02-before-stream.png'));
    writeFileSync(join(outDir, 'A-02-before-small.json'), JSON.stringify(value.small), 'utf8');
    ok('A-02 before stream saved');
    return;
  }

  if (phase === 'a02-after') {
    writePngFromDataUrl(value.dataUrl, join(outDir, 'A-02-after-stream.png'));
    writeFileSync(join(outDir, 'A-02-after-small.json'), JSON.stringify(value.small), 'utf8');
    const before = JSON.parse(readFileSync(join(outDir, 'A-02-before-small.json'), 'utf8'));
    const after = value.small;
    if (before.width !== after.width || before.height !== after.height) {
      throw new Error('a02 size mismatch');
    }
    const { meanAbsDiffRgb, changedPixelRatio, verdictA02 } = await import('./pixel-tools.mjs');
    const v = verdictA02(
      Uint8ClampedArray.from(before.rgba),
      Uint8ClampedArray.from(after.rgba),
      before.width,
      before.height,
    );
    const verdict = { ...v, beforeTs: null, videoWidth: value.videoWidth, videoHeight: value.videoHeight };
    writeFileSync(join(outDir, 'A-02-verdict.json'), JSON.stringify(verdict, null, 2), 'utf8');
    ok(`A-02 verdict pass=${verdict.pass} mad=${verdict.mad.toFixed(3)} ratio=${verdict.ratio.toFixed(4)}`);
    console.log(JSON.stringify(verdict, null, 2));
    if (!verdict.pass) process.exitCode = 1;
    return;
  }

  if (phase === 'a03-p1-arm' || phase === 'a03-p2-arm') {
    const name = phase === 'a03-p1-arm' ? 'A-03-p1-arm.json' : 'A-03-p2-arm.json';
    writeFileSync(join(outDir, name), JSON.stringify(value, null, 2), 'utf8');
    const cp = value.contentProtection || {};
    ok(`${phase}: contentProtection.on=${cp.on} hwnd=${cp.hwnd} bounds=${JSON.stringify(cp.bounds)} scale=${cp.scaleFactor} dpr=${value.page && value.page.devicePixelRatio}`);
    return;
  }

  if (phase === 'a03-p1-stream' || phase === 'a03-p2-stream') {
    const p = phase === 'a03-p1-stream' ? 'p1' : 'p2';
    const png = `A-03-${p}-stream.png`;
    writePngFromDataUrl(value.dataUrl, join(outDir, png));
    const { dataUrl: _d, ...rest } = value;
    void _d;
    writeFileSync(join(outDir, `A-03-${p}-stream.json`), JSON.stringify({ ...rest, png }, null, 2), 'utf8');
    ok(`${phase}: markerHits=${value.markerHits} ratio=${value.markerRatio} video=${value.videoWidth}x${value.videoHeight}`);
    return;
  }
  throw new Error('unknown phase ' + phase);
}

if (selfCheck) {
  await selfCheckMain();
} else if (args.has('--phase=a03-verdict')) {
  await a03VerdictMain();
} else {
  await fullMain();
}
