// GrabFrame v2 — end-to-end CLI tests against a MOCK CDP endpoint (HTTP /json/list + minimal WebSocket server).
// The real grab-frame.mjs main entry is spawned with plain Node (no Electron, no windows); Runtime.evaluate
// expressions are executed in a node:vm mock page (mock desktopPanelCapture, getUserMedia, MediaStreamTrackProcessor /
// ImageCapture, OffscreenCanvas). Win32 is simulated via DESK_R1_GF_WIN32_MOCK (test-only state file).
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import type { Duplex } from 'node:stream';

const SCRIPT = join(__dirname, '..', 'scripts', 'desk-r1-a-acceptance', 'grab-frame.mjs');
const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

type PageMode = { source?: 'mstp' | 'imagecapture'; frozen?: boolean; captureStartFails?: boolean; grabFailAfter?: number; freezeAfterGrabs?: number; gumDelayMs?: number; closeHangs?: boolean; staticScreen?: boolean; noEmit?: boolean; emitTsShiftUs?: number };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makePageContext(mode: PageMode): any {
  let ts = 0;
  let level = 0;
  let reads = 0;
  const track = { readyState: 'live', addEventListener() {}, stop() { track.readyState = 'ended'; } };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
  const gum = { calls: 0 };
  // v6: VideoFrame.timestamp modelled as a TimeTicks-like clock: BASE + performance.now() (us) at capture
  const BASE_US = 117000000000;
  const pending: number[] = []; // static screen: frames exist only when the screen changes (ts shift per frame)
  const nextFrame = (shiftUs = 0) => {
    if (!mode.frozen) { ts = BASE_US + Math.round(performance.now() * 1000) + shiftUs; level = (level + 40) % 256; }
    return { timestamp: ts, displayWidth: 4, displayHeight: 4, width: 4, height: 4, level, close() {} };
  };
  class MediaStreamTrackProcessor {
    readable: unknown;
    constructor() {
      let cancelled = false;
      this.readable = {
        getReader: () => ({
          read: async () => {
            await new Promise((r) => setTimeout(r, 5));
            if (cancelled || track.readyState !== 'live') return { done: true };
            reads += 1;
            if (mode.frozen && reads > 1) return new Promise(() => {});
            if (mode.staticScreen && reads > 1) {
              while (!pending.length) {
                await new Promise((r) => setTimeout(r, 5));
                if (cancelled || track.readyState !== 'live') return { done: true };
              }
              return { done: false, value: nextFrame(pending.shift()) };
            }
            return { done: false, value: nextFrame() };
          },
          cancel: async () => { cancelled = true; },
        }),
      };
    }
  }
  class ImageCapture {
    async grabFrame() { return nextFrame(); }
  }
  class OffscreenCanvas {
    level = 0;
    constructor(public w: number, public h: number) {}
    getContext() {
      return {
        drawImage: (src: { level: number }) => { this.level = src.level; },
        getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(this.level) }),
      };
    }
    async convertToBlob() { return { arrayBuffer: async () => new Uint8Array(PNG_SIG).buffer }; }
  }
  const capture = {
    _testSetFullscreen: async () => true,
    _testBootstrap: async () => ({ sessionId: 's1', source: { id: 'screen:0:0' } }),
    _testSetContentProtection: async (..._args: unknown[]) => ({ on: true, raised: { requested: false } }),
    captureGetStatus: async () => ({ status: 'idle' }),
    enumerateSources: async () => [{ id: 'screen:0:0' }],
    captureStart: async () => (mode.captureStartFails ? { ok: false, error: 'mock captureStart failure' } : { ok: true, status: 'live', captureId: 'screen:0:0', excludeSelfOk: false }),
  };
  const sandbox: Record<string, unknown> = {
    desktopPanelCapture: capture,
    document: { title: 'LocalKnowledgeWorkbench' },
    navigator: { mediaDevices: { getUserMedia: async () => { gum.calls += 1; if (mode.gumDelayMs) await new Promise((r) => setTimeout(r, mode.gumDelayMs)); return stream; } } },
    __mockTrack: track,
    performance,
    __emitFrame: () => { if (!mode.noEmit) pending.push(mode.emitTsShiftUs || 0); },
    __mockGum: gum,
    OffscreenCanvas,
    ImageCapture,
    setTimeout,
    Date,
    btoa: (s: string) => Buffer.from(s, 'binary').toString('base64'),
  };
  if ((mode.source || 'mstp') === 'mstp') sandbox.MediaStreamTrackProcessor = MediaStreamTrackProcessor;
  const ctx = vm.createContext(sandbox);
  vm.runInContext('globalThis.window = globalThis;', ctx);
  return ctx;
}

/** Minimal RFC6455 server frames (server->client unmasked text). */
function wsSend(sock: Duplex, text: string) {
  const payload = Buffer.from(text, 'utf8');
  let header: Buffer;
  if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
  else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
  sock.write(Buffer.concat([header, payload]));
}

async function startMockCdp(mode: PageMode): Promise<{ port: number; server: Server; ctx: unknown; titles: string[] }> {
  const ctx = makePageContext(mode);
  const titles: string[] = [];
  let grabs = 0;
  const server = createServer((req, res) => {
    const port = (server.address() as { port: number }).port;
    if (req.url === '/json/list') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify([{ type: 'page', title: 'KB', url: 'app://index.html', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/1` }]));
    } else { res.statusCode = 404; res.end(); }
  });
  server.on('upgrade', (req, sock: Duplex) => {
    upgraded.add(sock);
    sock.on('close', () => upgraded.delete(sock));
    const key = String(req.headers['sec-websocket-key'] || '');
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buf = Buffer.alloc(0);
    sock.on('error', () => {});
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const masked = (buf[1] & 0x80) !== 0;
        const need = off + (masked ? 4 : 0) + len;
        if (buf.length < need) return;
        const mask = masked ? buf.subarray(off, off + 4) : null;
        const data = Buffer.from(buf.subarray(off + (masked ? 4 : 0), need));
        if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
        buf = buf.subarray(need);
        if (op === 0x8) { try { sock.write(Buffer.from([0x88, 0])); sock.end(); } catch {} return; }
        if (op !== 0x1) continue;
        const msg = JSON.parse(data.toString('utf8'));
        void (async () => {
          let reply: unknown;
          if (msg.method === 'Runtime.evaluate') {
            try {
              if (mode.closeHangs && String(msg.params.expression).includes('titleHasMarker')) return; // cleanup CDP call never answers
              if (String(msg.params.expression).includes('s.grab(')) {
                grabs += 1;
                if (mode.grabFailAfter != null && grabs > mode.grabFailAfter) throw new Error('mock grab failure #' + grabs);
              }
              const value = await vm.runInContext(msg.params.expression, ctx as vm.Context);
              if (mode.freezeAfterGrabs != null && grabs >= mode.freezeAfterGrabs) mode.frozen = true; // capture freezes from now on
              titles.push(String(vm.runInContext('document.title', ctx as vm.Context)));
              reply = { id: msg.id, result: { result: { type: 'object', value: JSON.parse(JSON.stringify(value ?? null)) } } };
            } catch (e) {
              reply = { id: msg.id, result: { result: { type: 'object' }, exceptionDetails: { text: String((e as Error)?.message || e) } } };
            }
          } else reply = { id: msg.id, result: {} };
          try { wsSend(sock, JSON.stringify(reply)); } catch {}
        })();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { port: (server.address() as { port: number }).port, server, ctx, titles };
}

const PID = 4242;
const NONCE = 'vitest-1';
const MARKER = `[GrabFrame-A:${NONCE}]`;
type Placement = { state: string; left: number; top: number; right: number; bottom: number; flags?: number; showCmd?: number; minX?: number; minY?: number };
type Win = { hwnd: number; pid: number; title: string; className: string; visible: boolean; iconic: boolean; ops?: string[]; x?: number; y?: number; placement?: Placement };
function win32State(windows?: Win[], failActions?: string[], extra?: Record<string, unknown>) {
  return {
    pid: PID,
    failActions: failActions || [],
    ...(extra || {}),
    windows: windows || [
      { hwnd: 1001, pid: PID, title: `LocalKnowledgeWorkbench ${MARKER}`, className: 'Chrome_WidgetWin_1', visible: true, iconic: false, x: 200, y: 150 },
      { hwnd: 1002, pid: PID, title: 'E Snap panel', className: 'Chrome_WidgetWin_1', visible: true, iconic: false },
      { hwnd: 2001, pid: 999, title: `foreign ${MARKER}`, className: 'Notepad', visible: true, iconic: false },
    ],
  };
}

const servers: Server[] = [];
const upgraded = new Set<Duplex>();
const dirs: string[] = [];
afterEach(() => {
  for (const sock of upgraded) { try { sock.destroy(); } catch {} }
  upgraded.clear();
  for (const s of servers.splice(0)) { s.closeAllConnections?.(); s.close(); }
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
});

async function runCli(args: string[], o: { mode?: PageMode; windows?: Win[]; failActions?: string[]; stdin?: string[]; signal?: { sig: NodeJS.Signals; when: RegExp; again?: RegExp; sig2?: NodeJS.Signals }; w32Extra?: Record<string, unknown> } = {}) {
  const cdp = await startMockCdp(o.mode || {});
  servers.push(cdp.server);
  const dir = mkdtempSync(join(tmpdir(), 'gf-e2e-'));
  dirs.push(dir);
  const w32 = join(dir, 'win32-mock.json');
  writeFileSync(w32, JSON.stringify(win32State(o.windows, o.failActions, o.w32Extra)), 'utf8');
  const out = join(dir, 'frame.png');
  // Plain Node, never Electron (no windows): under electron-as-node vitest use the `node` on PATH.
  const nodeBin = process.versions.electron ? 'node' : process.execPath;
  const child = spawn(nodeBin, [SCRIPT, `--out=${out}`, `--cdp-port=${cdp.port}`, `--pid=${PID}`, ...args], {
    env: { ...process.env, DESK_R1_GF_WIN32_MOCK: w32, DESK_R1_GF_TITLE_NONCE: NONCE, DESK_R1_CDP_WS: 'ws', DESK_R1_GF_TEST_DELAY_MS: '150', ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  child.stdout.on('data', (d) => {
    stdout += d;
    if (o.stdin && /warmed up/.test(stdout) && o.stdin.length) {
      const lines = o.stdin.splice(0);
      void (async () => {
        for (const l of lines) { await new Promise((r) => setTimeout(r, 300)); child.stdin.write(l + '\n'); await new Promise((r) => setTimeout(r, 300)); }
      })();
    }
  });
  // v6 static screen: a frame is produced only when a (mock) window changes state (~120ms after, like an animation)
  let lastSig = '';
  const screenWatch = o.mode?.staticScreen ? setInterval(() => {
    try {
      const st = JSON.parse(readFileSync(w32, 'utf8'));
      const sig = JSON.stringify(st.windows.map((w: Win) => [w.hwnd, w.iconic, w.x, w.y]));
      if (lastSig && sig !== lastSig) setTimeout(() => vm.runInContext('__emitFrame()', cdp.ctx as vm.Context), 120);
      lastSig = sig;
    } catch {}
  }, 10) : null;
  let signalled = false;
  let signalled2 = false;
  const maybeSignal = () => {
    if (o.signal && !signalled && o.signal.when.test(stdout)) { signalled = true; child.kill(o.signal.sig); }
    else if (o.signal?.again && signalled && !signalled2 && o.signal.again.test(stdout)) { signalled2 = true; setTimeout(() => child.kill(o.signal!.sig2 || o.signal!.sig), 300); }
  };
  child.stdout.on('data', maybeSignal);
  child.stderr.on('data', (d) => { stdout += d; maybeSignal(); });
  const code: number = await new Promise((r) => child.on('close', (c) => r(c ?? -1)));
  if (screenWatch) clearInterval(screenWatch);
  const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
  const pageState = {
    title: String(vm.runInContext('document.title', cdp.ctx as vm.Context)),
    trackState: String(vm.runInContext('__mockTrack.readyState', cdp.ctx as vm.Context)),
    gumCalls: Number(vm.runInContext('__mockGum.calls', cdp.ctx as vm.Context)),
    grabSession: vm.runInContext('window.__deskR1AGrab == null', cdp.ctx as vm.Context) ? null : 'left-open',
  };
  return { code, stdout, out, dir, w32: readJson(w32), titles: cdp.titles, readJson, pageState };
}

describe('grab-frame.mjs main entry end-to-end (mock CDP, mock Win32, no Electron)', () => {
  it('single frame: writes PNG + sidecar via restored connectPage; hides ONLY own hwnd (title marker)', async () => {
    const r = await runCli([]);
    expect(r.stdout).not.toMatch(/ReferenceError/);
    expect(r.code, r.stdout).toBe(0);
    expect([...readFileSync(r.out)]).toEqual(PNG_SIG);
    const side = r.readJson(r.out.replace(/\.png$/, '.json'));
    expect(side.mode).toBe('single');
    expect(side.stale).toBe(null); // no freshness check performed
    expect(side.verdict).toBe('unchecked');
    expect(side.freshnessCheck).toBe('not-requested');
    expect(side.hideMode).toBe('minimize');
    expect(side.hideApplied).toBe(true);
    expect(side.ownHwnd).toBe(1001);
    expect(side.ownHwndSource).toBe('title-marker');
    expect(side.minimized).toBe(true);
    expect(side.minimizedSource).toBe('win32-IsIconic(own-hwnd)');
    expect(side.hwndOps.length).toBeGreaterThan(0);
    expect(side.hwndOps.some((o: { action: string; targetHwnd: number }) => o.action === 'minimize' && o.targetHwnd === 1001)).toBe(true);
    expect(side.hwndOps.every((o: { action: string; targetHwnd: number | null }) => o.action === 'query' || o.targetHwnd === 1001)).toBe(true);
    expect(side.hwndOps[0].windows.map((w: { hwnd: number }) => w.hwnd).sort()).toEqual([1001, 1002]);
    // E's window (same pid) and the foreign window were never touched
    const byH = Object.fromEntries(r.w32.windows.map((w: Win) => [w.hwnd, w]));
    expect(byH[1001].ops).toEqual(['minimize', 'restore']); // v3: hide undone on exit
    expect(byH[1001].iconic).toBe(false);
    expect(byH[1002].ops).toBeUndefined();
    expect(byH[1002].iconic).toBe(false);
    expect(byH[2001].ops).toBeUndefined();
    // page title carried the marker during the session and was restored on close
    expect(r.titles.some((t) => t.includes(MARKER))).toBe(true);
    expect(r.titles[r.titles.length - 1]).toBe('LocalKnowledgeWorkbench');
  }, 120000);

  it('multi-frame fresh (MSTP): freshness check fresh, frames stale:false, exit 0, freshness.json records hwnds', async () => {
    const r = await runCli(['--count=2', '--interval-ms=50']);
    expect(r.code, r.stdout).toBe(0);
    const fj = r.readJson(join(r.dir, 'frame.freshness.json'));
    expect(fj.verdict).toBe('fresh');
    expect(fj.ownHwnd).toBe(1001);
    expect(fj.hwndOps.length).toBeGreaterThan(0);
    expect(fj.ownWindow.windows.sort()).toEqual([1001, 1002]);
    for (const n of ['001', '002']) {
      const s = r.readJson(join(r.dir, `frame-${n}.json`));
      expect(s.stale).toBe(false);
      expect(s.verdict).toBe('fresh');
      expect(s.freshnessCheck).toBe('enabled');
    }
  }, 120000);

  it('multi-frame frozen track -> STALE exit 3 (not 0), sidecar stale:true', async () => {
    const r = await runCli(['--count=2', '--interval-ms=50'], { mode: { frozen: true } });
    expect(r.code, r.stdout).toBe(3);
    const s = r.readJson(join(r.dir, 'frame.json'));
    expect(s.stale).toBe(true);
    expect(s.verdict).toBe('stale');
    expect(s.exit).toBe(3);
    expect(r.stdout).not.toMatch(/GrabFrame done exit=0/);
  }, 120000);

  it('single frame with --freshness-check on frozen track -> exit 3', async () => {
    const r = await runCli(['--freshness-check'], { mode: { frozen: true } });
    expect(r.code, r.stdout).toBe(3);
  }, 120000);

  it('--no-freshness-check: freshnessCheck disabled-by-flag, stale null', async () => {
    const r = await runCli(['--count=2', '--interval-ms=50', '--no-freshness-check'], { mode: { frozen: true } });
    expect(r.code, r.stdout).toBe(0);
    const s = r.readJson(join(r.dir, 'frame-002.json'));
    expect(s.freshnessCheck).toBe('disabled-by-flag');
    expect(s.stale).toBe(null);
    expect(s.verdict).toBe('unchecked');
  }, 120000);

  it('ImageCapture fallback without --pc-roi -> INCONCLUSIVE exit 4, no frame judged fresh', async () => {
    const r = await runCli(['--count=2', '--interval-ms=50'], { mode: { source: 'imagecapture', frozen: true } });
    expect(r.code, r.stdout).toBe(4);
    const s = r.readJson(join(r.dir, 'frame.json'));
    expect(s.verdict).toBe('inconclusive');
    expect(s.stale).toBe(null);
    expect(String(s.error)).toMatch(/--pc-roi is required/);
    expect(existsSync(r.out)).toBe(false);
  }, 120000);

  it('ImageCapture + --pc-roi, same image every call -> STALE exit 3 (seq self-increment no longer fools it)', async () => {
    const r = await runCli(['--count=2', '--interval-ms=50', '--pc-roi=0,0,2,2'], { mode: { source: 'imagecapture', frozen: true } });
    expect(r.code, r.stdout).toBe(3);
  }, 120000);

  it('ImageCapture + --pc-roi, changing image -> still never fresh (no timestamp) -> INCONCLUSIVE exit 4', async () => {
    const r = await runCli(['--count=2', '--interval-ms=50', '--pc-roi=0,0,2,2'], { mode: { source: 'imagecapture' } });
    expect(r.code, r.stdout).toBe(4);
    const fj = r.readJson(join(r.dir, 'frame.freshness.json'));
    expect(fj.verdict).toBe('inconclusive');
    expect(fj.attempts[0].inconclusiveReasons).toContain('capture-ts-missing');
  }, 120000);

  it('--prefer-image-capture without --pc-roi is a bad-args error (exit 2)', async () => {
    const r = await runCli(['--prefer-image-capture']);
    expect(r.code, r.stdout).toBe(2);
  }, 120000);

  it('own window not uniquely identifiable (2 windows carry the marker) -> refuse to hide, INCONCLUSIVE exit 4, nothing touched', async () => {
    const wins = win32State().windows.slice(0, 2).map((w) => ({ ...w, title: `x ${MARKER}` }));
    const r = await runCli([], { windows: wins });
    expect(r.code, r.stdout).toBe(4);
    expect(r.w32.windows.every((w: Win) => w.ops === undefined && w.iconic === false)).toBe(true);
    const s = r.readJson(join(r.dir, 'frame.json'));
    expect(s.verdict).toBe('inconclusive');
    expect(s.hideApplied).toBe(false);
    expect(String(s.hideError)).toMatch(/refused: ambiguous/);
    expect(s.hwndOps.every((o: { action: string }) => o.action === 'query')).toBe(true);
  }, 120000);

  it('own hwnd == protected E panel hwnd -> refuse, exit 4', async () => {
    const r = await runCli(['--hwnd=1001', '--protect-hwnd=1001']);
    expect(r.code, r.stdout).toBe(4);
    expect(r.w32.windows.every((w: Win) => w.ops === undefined)).toBe(true);
  }, 120000);

  it('explicit --hwnd targets that window only; foreign-pid hwnd is refused', async () => {
    const ok = await runCli(['--hwnd=1002', '--no-freshness-check']);
    expect(ok.code, ok.stdout).toBe(0);
    expect(ok.w32.windows.find((w: Win) => w.hwnd === 1002).ops).toEqual(['minimize', 'restore']);
    expect(ok.w32.windows.find((w: Win) => w.hwnd === 1001).ops).toBeUndefined();
    const bad = await runCli(['--hwnd=2001']);
    expect(bad.code, bad.stdout).toBe(4);
    expect(bad.w32.windows.every((w: Win) => w.ops === undefined)).toBe(true);
  }, 120000);

  it('Win32 minimize failure -> hideMode minimize, hideApplied false, hideError recorded, INCONCLUSIVE exit 4', async () => {
    const r = await runCli([], { failActions: ['minimize'] });
    expect(r.code, r.stdout).toBe(4); // v3 (a): hide failure == refused hide -> exit 4
    const s = r.readJson(r.out.replace(/\.png$/, '.json'));
    expect(s.hideMode).toBe('minimize');
    expect(s.hideApplied).toBe(false);
    expect(String(s.hideError)).toMatch(/simulated minimize failure/);
    expect(s.minimized).toBe(false);
  }, 120000);

  it('freshness check: minimize fails -> falls back to offscreen on own hwnd', async () => {
    const r = await runCli(['--count=2', '--interval-ms=50'], { failActions: ['minimize'] });
    expect(r.code, r.stdout).toBe(0);
    const fj = r.readJson(join(r.dir, 'frame.freshness.json'));
    expect(fj.hideMode).toBe('offscreen');
    expect(fj.hideApplied).toBe(true);
    expect(fj.attempts[0]).toMatchObject({ hideMode: 'minimize', hideApplied: false });
    expect(r.w32.windows.find((w: Win) => w.hwnd === 1001).ops).toEqual(['offscreen', 'restore']);
    expect(r.w32.windows.find((w: Win) => w.hwnd === 1001).x).toBe(200); // v4: original placement written back on exit
    expect(r.w32.windows.find((w: Win) => w.hwnd === 1002).ops).toBeUndefined();
  }, 120000);

  it('keep-alive: warmup + stdin grab + quit on ONE persistent stream, exit 0', async () => {
    const r = await runCli(['--keep-alive', '--interval-ms=50'], { stdin: ['grab', 'quit'] });
    expect(r.code, r.stdout).toBe(0);
    const s = r.readJson(r.out.replace(/\.png$/, '.json'));
    expect(s.mode).toBe('keep-alive');
    expect(s.frameIndex).toBe(1);
    expect(s.streamOpens).toBe(1);
    expect(s.verdict).toBe('fresh');
    expect(s.ownHwnd).toBe(1001);
  }, 120000);

  // v3 cleanup: title marker + media track (+ own-hwnd hide) are restored on error and on signal exit.
  const ORIG_TITLE = 'LocalKnowledgeWorkbench';
  it('v3 cleanup: captureStart fails -> exit 1, title restored, no track left running', async () => {
    const r = await runCli([], { mode: { captureStartFails: true } });
    expect(r.code, r.stdout).toBe(1);
    expect(r.stdout).toMatch(/captureStart failed/);
    expect(r.titles.some((t) => t.includes(MARKER))).toBe(false); // restored inside prepare before throwing
    expect(r.pageState.title).toBe(ORIG_TITLE);
    expect(r.pageState.gumCalls).toBe(0);
    expect(r.pageState.grabSession).toBe(null);
  }, 120000);

  it('v3 cleanup: multi-frame grab throws midway -> exit 1, title restored, track stopped, hwnd restored', async () => {
    const r = await runCli(['--count=3', '--interval-ms=50'], { mode: { grabFailAfter: 3 } });
    expect(r.code, r.stdout).toBe(1);
    expect(r.stdout).toMatch(/mock grab failure/);
    expect(r.titles.some((t) => t.includes(MARKER))).toBe(true);
    expect(r.pageState.title).toBe(ORIG_TITLE);
    expect(r.pageState.trackState).toBe('ended');
    expect(r.pageState.grabSession).toBe(null);
    const w = r.w32.windows.find((x: Win) => x.hwnd === 1001);
    expect(w.ops).toEqual(['minimize', 'restore']);
    expect(w.iconic).toBe(false);
  }, 120000);

  it('v3 cleanup: SIGINT before keep-alive warm-up -> exit 130, title restored, track stopped', async () => {
    const r = await runCli(['--keep-alive', '--interval-ms=50'], { signal: { sig: 'SIGINT', when: /session opened/ } });
    expect(r.code, r.stdout).toBe(130);
    expect(r.stdout).not.toMatch(/warmed up/);
    expect(r.pageState.title).toBe(ORIG_TITLE);
    expect(r.pageState.trackState).toBe('ended');
    expect(r.pageState.grabSession).toBe(null);
    expect(r.w32.windows.find((x: Win) => x.hwnd === 1001).iconic).toBe(false);
  }, 120000);

  it('v3 cleanup: SIGTERM while keep-alive is serving -> exit 143, title restored, track stopped, hwnd restored', async () => {
    const r = await runCli(['--keep-alive', '--interval-ms=50'], { signal: { sig: 'SIGTERM', when: /warmed up/ } });
    expect(r.code, r.stdout).toBe(143);
    expect(r.pageState.title).toBe(ORIG_TITLE);
    expect(r.pageState.trackState).toBe('ended');
    expect(r.pageState.grabSession).toBe(null);
    const w = r.w32.windows.find((x: Win) => x.hwnd === 1001);
    expect(w.ops?.slice(-1)).toEqual(['restore']);
    expect(w.iconic).toBe(false);
  }, 120000);

  it('v3 keep-alive quit exit code = worst frame verdict: a STALE frame after warm-up -> quit exits 3 (not 0)', async () => {
    // freshness check (a before hide, b after; v6: b is also the warm-up frame) is fresh; capture freezes after that -> stdin grab is STALE
    const r = await runCli(['--keep-alive', '--interval-ms=50'], { mode: { freezeAfterGrabs: 2 }, stdin: ['grab', 'quit'] });
    expect(r.code, r.stdout).toBe(3);
    expect(r.stdout).toMatch(/quit \(worst frame verdict -> exit 3/);
    const s = r.readJson(r.out.replace(/\.png$/, '.json'));
    expect(s.frameIndex).toBe(1);
    expect(s.verdict).toBe('stale');
    expect(s.stale).toBe(true);
    expect(r.pageState.title).toBe(ORIG_TITLE);
    expect(r.pageState.trackState).toBe('ended');
  }, 120000);

  // v4: undo writes back the ORIGINAL placement (GetWindowPlacement before the first hide), non-activating, verified.
  const ORIG_PL = { state: 'normal', left: 200, top: 150, right: 1000, bottom: 750 };
  const own = (r: { w32: { windows: Win[] } }) => r.w32.windows.find((x: Win) => x.hwnd === 1001) as Win;
  it('v4 undo: offscreen restores the exact original non-(0,0) placement (200,150)', async () => {
    const r = await runCli(['--hide-mode=offscreen', '--no-freshness-check']);
    expect(r.code, r.stdout).toBe(0);
    expect(own(r).ops).toEqual(['offscreen', 'restore']);
    expect(own(r).placement).toMatchObject(ORIG_PL);
    expect(own(r).x).toBe(200);
    expect(own(r).y).toBe(150);
    const s = r.readJson(r.out.replace(/\.png$/, '.json'));
    expect(s.hwndOps.find((o: { action: string }) => o.action === 'offscreen').placementBefore).toMatchObject(ORIG_PL);
    expect(s.cleanup.window.ok).toBe(true);
    expect(s.cleanup.window.hwnds[0]).toMatchObject({ hwnd: 1001, ok: true, undo: ['offscreen'], original: ORIG_PL });
  }, 120000);

  it('v4 undo: minimize failed -> offscreen fallback also restores the original placement (200,150)', async () => {
    const r = await runCli(['--count=2', '--interval-ms=50'], { failActions: ['minimize'] });
    expect(r.code, r.stdout).toBe(0);
    expect(own(r).ops).toEqual(['offscreen', 'restore']);
    expect(own(r).placement).toMatchObject(ORIG_PL);
    const fj = r.readJson(join(r.dir, 'frame.freshness.json'));
    expect(fj.cleanup.window.hwnds[0]).toMatchObject({ ok: true, undo: ['offscreen'], original: ORIG_PL });
  }, 120000);

  it('v4 undo: a window that was ALREADY minimized stays minimized after undo', async () => {
    const wins = win32State().windows.map((w) => (w.hwnd === 1001 ? { ...w, iconic: true } : w));
    const r = await runCli([], { windows: wins });
    expect(r.code, r.stdout).toBe(0);
    expect(own(r).ops).toEqual(['minimize']); // v5: current == original -> compared once, nothing written back
    expect(own(r).iconic).toBe(true);
    expect(own(r).placement?.state).toBe('minimized');
    const s = r.readJson(r.out.replace(/\.png$/, '.json'));
    expect(s.cleanup.window.hwnds[0]).toMatchObject({ ok: true, unchanged: true, original: { state: 'minimized' } });
  }, 120000);

  it('v4 undo: does not activate the window / change the foreground window', async () => {
    const r = await runCli([], { w32Extra: { foreground: 5555 } });
    expect(r.code, r.stdout).toBe(0);
    expect(own(r).ops).toEqual(['minimize', 'restore']);
    expect(own(r).iconic).toBe(false);
    expect(r.w32.foreground).toBe(5555);
    const s = r.readJson(r.out.replace(/\.png$/, '.json'));
    expect(s.cleanup.window.hwnds[0].foregroundChanged).toBe(false);
  }, 120000);

  it('v4 undo: restore verification mismatch -> applied=false with reason (cleanup.window.ok false)', async () => {
    const r = await runCli([], { w32Extra: { restoreDrift: 7 } });
    const s = r.readJson(r.out.replace(/\.png$/, '.json'));
    expect(s.cleanup.window.ok).toBe(false);
    expect(s.cleanup.window.hwnds[0].ok).toBe(false);
    expect(String(s.cleanup.window.hwnds[0].reason)).toMatch(/verify: rcNormalPosition \(207,150,1000,750\) != original \(200,150,1000,750\)/);
    expect(String(s.cleanup.window.reason)).toMatch(/hwnd 1001: verify/);
    expect(r.stdout).toMatch(/hwnd restore: hwnd=1001 .*applied=false/);
  }, 120000);

  it('v4 (d): SIGINT during in-flight prepare -> cleanup awaits prepare, track stopped, title restored, exit 130', async () => {
    const r = await runCli(['--keep-alive', '--interval-ms=50'], { mode: { gumDelayMs: 1500 }, signal: { sig: 'SIGINT', when: /CDP page title=/ } });
    expect(r.code, r.stdout).toBe(130);
    expect(r.stdout).not.toMatch(/warmed up/);
    expect(own(r).ops).toBeUndefined(); // nothing hidden after cleanup started
    expect(r.pageState.gumCalls).toBe(1);
    expect(r.pageState.trackState).toBe('ended');
    expect(r.pageState.grabSession).toBe(null);
    expect(r.pageState.title).toBe(ORIG_TITLE);
    expect(r.stdout).toMatch(/cleanup: title=true track=true window=true/);
  }, 120000);

  it('v4 (e): cleanup stuck -> second SIGTERM force-exits immediately with 143', async () => {
    const t0 = Date.now();
    const r = await runCli(['--keep-alive', '--interval-ms=50'], { mode: { closeHangs: true }, signal: { sig: 'SIGTERM', when: /warmed up/, again: /SIGTERM received/ } });
    expect(r.code, r.stdout).toBe(143);
    expect(r.stdout).toMatch(/second SIGTERM during cleanup -> force exit 143/);
    expect(Date.now() - t0).toBeLessThan(60000);
  }, 120000);

  // v5
  const MAXMIN_PL = { state: 'minimized', showCmd: 2, flags: 2, minX: -1, minY: -1, left: 200, top: 150, right: 1000, bottom: 750 };
  const maxMinWins = () => win32State().windows.map((w) => (w.hwnd === 1001 ? { ...w, iconic: true, placement: { ...MAXMIN_PL } } : w));
  it('v5: original with flags=2 (WPF_RESTORETOMAXIMIZED) round-trips through offscreen + undo', async () => {
    const r = await runCli(['--hide-mode=offscreen', '--no-freshness-check'], { windows: maxMinWins() });
    expect(own(r).ops).toEqual(['offscreen', 'restore']);
    expect(own(r).placement).toMatchObject(MAXMIN_PL);
    expect(own(r).iconic).toBe(true);
    const s = r.readJson(r.out.replace(/\.png$/, '.json'));
    expect(s.hwndOps.find((o: { action: string }) => o.action === 'offscreen').placementBefore.flags).toBe(2);
    expect(s.cleanup.window.hwnds[0]).toMatchObject({ ok: true, unchanged: false, original: { flags: 2 }, after: { flags: 2 }, dpiAwareness: 'per-monitor-v2' });
  }, 120000);

  it('v5: flags&2 is verified: restore that drops WPF_RESTORETOMAXIMIZED -> applied=false with reason', async () => {
    const r = await runCli(['--hide-mode=offscreen', '--no-freshness-check'], { windows: maxMinWins(), w32Extra: { restoreDropFlags: true } });
    const s = r.readJson(r.out.replace(/\.png$/, '.json'));
    expect(s.cleanup.window.ok).toBe(false);
    expect(String(s.cleanup.window.hwnds[0].reason)).toMatch(/verify: flags WPF_RESTORETOMAXIMIZED 0 != original 2/);
  }, 120000);

  it('v5: second signal force exit (SIGTERM then SIGINT) -> window already restored, cleanup.forced recorded, first code 143 wins', async () => {
    const r = await runCli(['--keep-alive', '--interval-ms=50'], { mode: { closeHangs: true }, signal: { sig: 'SIGTERM', when: /warmed up/, again: /SIGTERM received/, sig2: 'SIGINT' } });
    expect(r.code, r.stdout).toBe(143);
    expect(r.stdout).toMatch(/second SIGINT during cleanup -> force exit 143/);
    expect(own(r).ops?.slice(-1)).toEqual(['restore']);
    expect(own(r).iconic).toBe(false);
    expect(own(r).placement).toMatchObject(ORIG_PL);
    const s = r.readJson(r.out.replace(/\.png$/, '.json'));
    expect(s.cleanup.forced).toBe(true);
    expect(s.cleanup.forcedBy).toBe('SIGINT');
    expect(s.cleanup.window.ok).toBe(true);
    expect(s.cleanup.title.ok).toBe(false); // CDP close never answered
    expect(String(s.cleanup.title.reason)).toMatch(/pending/);
  }, 120000);

  it('v5: GetWindowPlacement failure -> window untouched (no hide), reason recorded, INCONCLUSIVE exit 4', async () => {
    const r = await runCli([], { w32Extra: { failGetPlacement: true } });
    expect(r.code, r.stdout).toBe(4);
    expect(own(r).ops).toBeUndefined();
    expect(own(r).iconic).toBe(false);
    const s = r.readJson(r.out.replace(/\.png$/, '.json'));
    expect(String(s.hideError)).toMatch(/GetWindowPlacement failed/);
    expect(s.hwndOps.find((o: { action: string }) => o.action === 'minimize').placementBefore).toBe(null);
    expect(s.cleanup.window.hwnds[0]).toMatchObject({ hwnd: 1001, ok: true, undo: [] });
    expect(String(s.cleanup.window.hwnds[0].reason)).toMatch(/GetWindowPlacement failed.*window not touched/);
  }, 120000);

  it('v5 (a): failed offscreen that already un-minimized the window (ShowWindow 4 ok, SetWindowPos failed) is undone', async () => {
    const wins = win32State().windows.map((w) => (w.hwnd === 1001 ? { ...w, iconic: true } : w));
    const r = await runCli(['--hide-mode=offscreen', '--no-freshness-check'], { windows: wins, failActions: ['offscreen'], w32Extra: { offscreenPartial: true } });
    expect(r.code, r.stdout).toBe(4);
    expect(own(r).ops).toEqual(['restore']);
    expect(own(r).iconic).toBe(true);
    const s = r.readJson(r.out.replace(/\.png$/, '.json'));
    expect(s.cleanup.window.hwnds[0]).toMatchObject({ ok: true, undo: [], attempted: ['offscreen'], unchanged: false, original: { state: 'minimized' } });
  }, 120000);

  it('v5 (b): error before any artifact -> cleanup-only JSON <out>.cleanup.json', async () => {
    const r = await runCli([], { mode: { captureStartFails: true } });
    expect(r.code, r.stdout).toBe(1);
    expect(existsSync(r.out.replace(/\.png$/, '.json'))).toBe(false);
    const c = r.readJson(join(r.dir, 'frame.cleanup.json'));
    expect(c.mode).toBe('cleanup-only');
    expect(c.cleanup.title).toEqual({ ok: true, reason: null });
    expect(c.cleanup.track).toMatchObject({ ok: true });
    expect(c.cleanup.window.ok).toBe(true);
  }, 120000);

  it('v5 keep-alive: freshness.json written at warm-up with the real check; warm-up sidecar has real verdict; quit adds cleanup', async () => {
    const r = await runCli(['--keep-alive', '--interval-ms=50'], { stdin: ['quit'] });
    expect(r.code, r.stdout).toBe(0);
    const fj = r.readJson(join(r.dir, 'frame.freshness.json'));
    expect(fj.verdict).toBe('fresh');
    expect(fj.performed).toBe(true);
    expect(fj.framesGrabbed).toBe(2);
    expect(fj.frameSource).toBe('MediaStreamTrackProcessor');
    expect(fj.freshnessCheck).toBe('enabled');
    expect(fj.attempts[0].bSeq).toBeGreaterThan(fj.attempts[0].aSeq);
    expect(fj.cleanup.title).toEqual({ ok: true, reason: null });
    expect(fj.cleanup.track).toEqual({ ok: true, reason: null });
    expect(fj.cleanup.window.ok).toBe(true);
    const w = r.readJson(r.out.replace(/\.png$/, '.json')); // warm-up frame (no grab after it)
    expect(w.frameIndex).toBe(0);
    expect(w.warmup).toBe(true);
    expect(w.verdict).toBe('fresh');
    expect(w.stale).toBe(false);
    expect(w.frameSource).toBe('MediaStreamTrackProcessor');
    expect(typeof w.seq).toBe('number');
    expect(typeof w.captureTsUs).toBe('number');
    expect(w.warmupFreshness).toMatchObject({ verdict: 'fresh', fresh: true, frameSource: 'MediaStreamTrackProcessor' });
    expect(w.cleanup.title.ok).toBe(true);
  }, 120000);

  it('v5 keep-alive --no-freshness-check: freshness.json still written (performed:false, unchecked) and gets cleanup', async () => {
    const r = await runCli(['--keep-alive', '--interval-ms=50', '--no-freshness-check'], { stdin: ['quit'] });
    expect(r.code, r.stdout).toBe(0);
    const fj = r.readJson(join(r.dir, 'frame.freshness.json'));
    expect(fj).toMatchObject({ performed: false, verdict: 'unchecked', freshnessCheck: 'disabled-by-flag', framesGrabbed: 0 });
    expect(fj.cleanup.window.ok).toBe(true);
    const w = r.readJson(r.out.replace(/\.png$/, '.json'));
    expect(w.verdict).toBe('unchecked');
    expect(w.warmupFreshness).toMatchObject({ verdict: 'unchecked', performed: false });
  }, 120000);

  // v6: baseline a BEFORE hide; fresh = seq advanced AND captureTs after hide (same clock) AND hide effective
  it('v6: static screen, the hide itself produced one frame -> fresh (single frame), sidecar records post-hide basis', async () => {
    const r = await runCli(['--freshness-check'], { mode: { staticScreen: true } });
    expect(r.code, r.stdout).toBe(0);
    const s = r.readJson(r.out.replace(/\.png$/, '.json'));
    expect(s.verdict).toBe('fresh');
    expect(s.stale).toBe(false);
    expect(s.seqAfter).toBeGreaterThan(s.seqBefore);
    expect(typeof s.hideIssuedAt).toBe('string');
    expect(s.captureTsAfter).toBeGreaterThan(s.hideIssuedTsUs);
    expect(s.freshBasis).toBe('seq-advanced+captureTs-after-hide+hide-effective');
    expect(s.clock).toMatchObject({ marginUs: 50000 });
    expect(typeof s.clock.clockOffsetUs).toBe('number');
  }, 120000);

  it('v6: static screen, no new frame after the hide -> STALE exit 3', async () => {
    const r = await runCli(['--freshness-check'], { mode: { staticScreen: true, noEmit: true } });
    expect(r.code, r.stdout).toBe(3);
    const s = r.readJson(r.out.replace(/\.png$/, '.json'));
    expect(s.verdict).toBe('stale');
    expect(s.seqAfter).toBe(s.seqBefore);
    expect(String(s.freshBasis)).toMatch(/seq-not-advanced-after-hide/);
  }, 120000);

  it('v6: new frame whose capture timestamp is earlier than the hide -> STALE exit 3', async () => {
    const r = await runCli(['--freshness-check'], { mode: { staticScreen: true, emitTsShiftUs: -2000000 } });
    expect(r.code, r.stdout).toBe(3);
    const s = r.readJson(r.out.replace(/\.png$/, '.json'));
    expect(s.seqAfter).toBeGreaterThan(s.seqBefore);
    expect(String(s.freshBasis)).toMatch(/capture-ts-not-after-hide/);
  }, 120000);

  it('v6: hide not effective (minimize and offscreen both fail) -> STALE exit 3 even with live frames', async () => {
    const r = await runCli(['--freshness-check'], { failActions: ['minimize', 'offscreen'] });
    expect(r.code, r.stdout).toBe(3);
    const fj = r.readJson(join(r.dir, 'frame.freshness.json'));
    expect(fj.verdict).toBe('stale');
    expect(fj.attempts.map((x: { reasons: string[] }) => x.reasons)).toEqual([['hide-not-effective'], ['hide-not-effective']]);
  }, 120000);

  it('v6: --pc-roi MAD never substitutes: static screen, no post-hide frame, ROI given -> still STALE', async () => {
    const r = await runCli(['--freshness-check', '--pc-roi=0,0,2,2'], { mode: { staticScreen: true, noEmit: true } });
    expect(r.code, r.stdout).toBe(3);
  }, 120000);

  it('v6 multi-frame on a static screen: frame 1 = post-hide frame (fresh), frame 2 has no new frame -> STALE exit 3', async () => {
    const r = await runCli(['--count=2', '--interval-ms=50'], { mode: { staticScreen: true } });
    expect(r.code, r.stdout).toBe(3);
    const f1 = r.readJson(join(r.dir, 'frame-001.json'));
    const f2 = r.readJson(join(r.dir, 'frame-002.json'));
    expect(f1.verdict).toBe('fresh');
    expect(f1.freshBasis).toBe('seq-advanced+captureTs-after-hide+hide-effective');
    expect(f2.verdict).toBe('stale');
    expect(f2.freshBasis).toBe('vs-previous-grab (no per-frame hide)');
  }, 120000);

  it('v6 keep-alive on a static screen: warm-up frame = post-hide frame (fresh); a later grab without a new frame -> STALE, quit 3', async () => {
    const r = await runCli(['--keep-alive', '--interval-ms=50'], { mode: { staticScreen: true }, stdin: ['grab', 'quit'] });
    expect(r.code, r.stdout).toBe(3);
    const s = r.readJson(r.out.replace(/\.png$/, '.json'));
    expect(s.frameIndex).toBe(1);
    expect(s.verdict).toBe('stale');
  }, 120000);

  it('v4 (f): cleanup results (title/track/window) recorded in every sidecar and freshness.json', async () => {
    const r = await runCli(['--count=2', '--interval-ms=50']);
    expect(r.code, r.stdout).toBe(0);
    for (const p of ['frame.freshness.json', 'frame-001.json', 'frame-002.json']) {
      const j = r.readJson(join(r.dir, p));
      expect(j.cleanup.title).toEqual({ ok: true, reason: null });
      expect(j.cleanup.track).toEqual({ ok: true, reason: null });
      expect(j.cleanup.window.ok).toBe(true);
      expect(typeof j.cleanup.at).toBe('string');
    }
    const s = r.readJson(join(r.dir, 'frame-001.json'));
    expect(s.verdict).toBe('fresh'); // existing fields unchanged
    expect(s.stale).toBe(false);
  }, 120000);


  it('v8 source: prepare expression contains raise: false', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).toMatch(/_testSetContentProtection\(true,\s*\{\s*raise:\s*false\s*\}\)/);
  });
  it('keep-alive frozen -> exit 3 before serving grabs', async () => {
    const r = await runCli(['--keep-alive'], { mode: { frozen: true } });
    expect(r.code, r.stdout).toBe(3);
    expect(r.readJson(r.out.replace(/\.png$/, '.json')).stale).toBe(true);
  }, 120000);
});
