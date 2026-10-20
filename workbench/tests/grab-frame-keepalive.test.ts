// E-04 GrabFrame KeepAlive freeze fix — unit/mock tests (no display, no Electron).
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const libUrl = pathToFileURL(join(__dirname, '..', 'scripts', 'desk-r1-a-acceptance', 'grab-frame-lib.mjs')).href;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const loadLib = async (): Promise<any> => import(libUrl);

/** Mock page globals: a desktop track whose frames advance (live) or freeze (stale). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockPage(opts: { frozen?: boolean; frames?: number } = {}): any {
  const state = { gum: 0, stops: 0, readerReads: 0 };
  let ts = 0;
  let level = 0;
  const track = {
    readyState: 'live',
    addEventListener() {},
    stop() { state.stops += 1; track.readyState = 'ended'; },
  };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
  class MediaStreamTrackProcessor {
    readable: { getReader: () => { read: () => Promise<unknown>; cancel: () => Promise<void> } };
    constructor() {
      let cancelled = false;
      this.readable = {
        getReader: () => ({
          read: async () => {
            await new Promise((r) => setTimeout(r, 5));
            if (cancelled || track.readyState !== 'live') return { done: true };
            state.readerReads += 1;
            if (opts.frozen && state.readerReads > 1) return new Promise(() => {}); // no new frames ever
            ts += 33333;
            level = (level + 40) % 256;
            return { done: false, value: { timestamp: ts, displayWidth: 4, displayHeight: 4, level, close() {} } };
          },
          cancel: async () => { cancelled = true; },
        }),
      };
    }
  }
  class OffscreenCanvas {
    w: number; h: number; level = 0;
    constructor(w: number, h: number) { this.w = w; this.h = h; }
    getContext() {
      return {
        drawImage: (src: { level: number }) => { this.level = src.level; },
        getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(this.level) }),
      };
    }
    async convertToBlob() { return { arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer }; }
  }
  const g = {
    navigator: { mediaDevices: { getUserMedia: async () => { state.gum += 1; return stream; } } },
    MediaStreamTrackProcessor,
    OffscreenCanvas,
    setTimeout,
    Date,
    btoa: (s: string) => Buffer.from(s, 'binary').toString('base64'),
  };
  return { g, state, track };
}

describe('grab-frame E-04 persistent session', () => {
  it('opens getUserMedia once, never stops the track per grab, seq/timestamp advance', async () => {
    const lib = await loadLib();
    const { g, state } = mockPage();
    const s = await lib.createGrabSession(g, 'screen:0:0', {});
    const roi = { x: 0, y: 0, w: 2, h: 2 };
    const a = await s.grab({ roi });
    await new Promise((r) => setTimeout(r, 40));
    const b = await s.grab({ roi });
    await new Promise((r) => setTimeout(r, 40));
    const c = await s.grab({ roi });
    expect(state.gum).toBe(1);
    expect(state.stops).toBe(0);
    expect(b.seq).toBeGreaterThan(a.seq);
    expect(c.captureTsUs).toBeGreaterThan(b.captureTsUs);
    expect(b.streamOpens).toBe(1);
    expect(b.frameSource).toBe('MediaStreamTrackProcessor');
    expect(b.pngB64).toBe(Buffer.from([137, 80, 78, 71]).toString('base64'));
    const v = lib.evaluateFreshness({ a, b, roi, pcThreshold: 1 });
    expect(v.fresh).toBe(true);
    expect(v.pcMad).toBeGreaterThan(1);
    await s.close();
    expect(state.stops).toBe(1);
  });

  it('frozen track (minimized, no new frames) -> stale with reasons', async () => {
    const lib = await loadLib();
    const { g } = mockPage({ frozen: true });
    const s = await lib.createGrabSession(g, 'screen:0:0', {});
    const roi = { x: 0, y: 0, w: 2, h: 2 };
    const a = await s.grab({ roi });
    await new Promise((r) => setTimeout(r, 40));
    const b = await s.grab({ roi });
    const v = lib.evaluateFreshness({ a, b, roi, pcThreshold: 1 });
    expect(v.fresh).toBe(false);
    expect(v.verdict).toBe('stale');
    expect(v.reasons).toEqual(expect.arrayContaining(['seq-not-advanced', 'capture-ts-not-advanced']));
    expect(b.seqDeltaSinceLastGrab).toBe(0);
    await s.close();
  });

  it('positive control MAD<=threshold is stale even if seq advances; reopen is stale', async () => {
    const lib = await loadLib();
    const roi = { x: 0, y: 0, w: 1, h: 1 };
    const a = { seq: 1, captureTsUs: 1, trackState: 'live', streamOpens: 1 };
    expect(lib.evaluateFreshness({ a, b: { seq: 9, captureTsUs: 9, trackState: 'live', streamOpens: 1, pcMad: 0 }, roi }).verdict).toBe('stale');
    expect(lib.evaluateFreshness({ a, b: { seq: 9, captureTsUs: 9, trackState: 'live', streamOpens: 2 } }).reasons).toContain('stream-reopened');
    expect(lib.evaluateFreshness({ a, b: { seq: 9, captureTsUs: 9, trackState: 'ended', streamOpens: 1 } }).fresh).toBe(false);
    expect(lib.evaluateFreshness({ a, b: { seq: 9, captureTsUs: 9, trackState: 'live', streamOpens: 1 } }).fresh).toBe(true);
  });

  it('sidecar carries Win32 IsIconic minimized + freshness fields', async () => {
    const lib = await loadLib();
    // v2: minimized = IsIconic of the targeted (own) hwnd only; a bare pid window list never implies minimized
    const w = lib.parseWin32Result('noise\r\n{"pid":43304,"action":"minimize","applied":true,"target":{"hwnd":1,"iconic":true,"visible":true,"title":"A"},"windows":{"hwnd":1,"iconic":true,"visible":true,"title":"A"}}');
    expect(w.ok).toBe(true);
    expect(w.minimized).toBe(true);
    expect(w.applied).toBe(true);
    expect(lib.parseWin32Result('{"pid":1,"windows":[{"iconic":true},{"iconic":false}]}').minimized).toBe(null);
    expect(lib.parseWin32Result('{"pid":1,"windows":[]}').minimized).toBe(null);
    const side = lib.buildSidecar({
      okFlag: true, pngPath: 'x.png', pid: 43304, frameIndex: 3, mode: 'keep-alive', seq: 120, captureTsUs: 4000000,
      captureWallMs: 1, frameSource: 'MediaStreamTrackProcessor', streamOpens: 1, minimized: w.minimized,
      minimizedSource: 'win32-IsIconic', stale: false,
    });
    expect(lib.validateSidecarShape(side)).toEqual({ ok: true, missing: [] });
    expect(side.minimized).toBe(true);
    expect(side.minimizedSource).toBe('win32-IsIconic');
    const s2 = lib.buildSidecar({ okFlag: false, pngPath: 'y.png' });
    expect(s2.minimized).toBe(null);
    expect(s2.minimizedSource).toBe('unavailable');
  });

  it('win32Script / parseRoi validate inputs', async () => {
    const lib = await loadLib();
    expect(lib.win32Script(1, 'query')).toMatch(/IsIconic/);
    expect(lib.win32Script({ pid: 1, action: 'offscreen', hwnd: 5 })).toMatch(/-32000/);
    expect(() => lib.win32Script(1, 'close')).toThrow();
    expect(lib.parseRoi('10,20,30,40')).toEqual({ x: 10, y: 20, w: 30, h: 40 });
    expect(lib.parseRoi(null)).toBe(null);
    expect(() => lib.parseRoi('1,2,0,4')).toThrow();
    expect(lib.rgbaMad(new Uint8Array([0, 0, 0, 255]), new Uint8Array([30, 30, 30, 255]))).toBe(30);
  });
});

// ---- v2 (review fixes): freshness without timestamps, verdict/exit mapping, own-hwnd targeting ----
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function imageCaptureOnlyPage(sameImage: boolean): any {
  const { g } = mockPage();
  let level = 7;
  // remove MSTP -> createGrabSession falls back to ImageCapture
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g2: any = { ...g, MediaStreamTrackProcessor: undefined };
  g2.ImageCapture = class {
    async grabFrame() {
      if (!sameImage) level = (level + 50) % 256;
      return { width: 4, height: 4, level, close() {} };
    }
  };
  return g2;
}

describe('grab-frame v2: freshness never "fresh" without capture timestamps', () => {
  it('ImageCapture mock returning the same image each call, no --pc-roi -> NOT fresh (was fresh:true)', async () => {
    const lib = await loadLib();
    const s = await lib.createGrabSession(imageCaptureOnlyPage(true), 'screen:0:0', {});
    const a = await s.grab({});
    const b = await s.grab({});
    expect(b.frameSource).toBe('ImageCapture');
    expect(b.seq).toBeGreaterThan(a.seq); // per-call counter, meaningless
    expect(b.captureTsUs).toBe(null);
    const v = lib.evaluateFreshness({ a, b, roi: null });
    expect(v.fresh).toBe(false);
    expect(v.verdict).toBe('inconclusive');
    expect(v.inconclusiveReasons).toEqual(expect.arrayContaining(['capture-ts-missing', 'image-capture-requires-pc-roi']));
    await s.close();
  });

  it('ImageCapture + roi: same image -> stale; changing image -> inconclusive (still never fresh)', async () => {
    const lib = await loadLib();
    const roi = { x: 0, y: 0, w: 2, h: 2 };
    const s1 = await lib.createGrabSession(imageCaptureOnlyPage(true), 'screen:0:0', {});
    const a1 = await s1.grab({ roi });
    const b1 = await s1.grab({ roi });
    expect(lib.evaluateFreshness({ a: a1, b: b1, roi }).verdict).toBe('stale');
    const s2 = await lib.createGrabSession(imageCaptureOnlyPage(false), 'screen:0:0', {});
    const a2 = await s2.grab({ roi });
    const b2 = await s2.grab({ roi });
    const v2 = lib.evaluateFreshness({ a: a2, b: b2, roi });
    expect(b2.pcMad).toBeGreaterThan(1);
    expect(v2.fresh).toBe(false);
    expect(v2.verdict).toBe('inconclusive');
  });

  it('MSTP timestamp not a number -> inconclusive, never fresh', async () => {
    const lib = await loadLib();
    const a = { seq: 1, captureTsUs: 'x', trackState: 'live', streamOpens: 1, frameSource: 'MediaStreamTrackProcessor' };
    const b = { seq: 5, captureTsUs: undefined, trackState: 'live', streamOpens: 1, frameSource: 'MediaStreamTrackProcessor' };
    const v = lib.evaluateFreshness({ a, b });
    expect(v.fresh).toBe(false);
    expect(v.verdict).toBe('inconclusive');
    expect(lib.evaluateFreshness({ a: { ...a, captureTsUs: NaN }, b: { ...b, captureTsUs: 9 } }).verdict).toBe('inconclusive');
    // stale evidence wins over missing ts
    expect(lib.evaluateFreshness({ a, b: { ...b, seq: 1 } }).verdict).toBe('stale');
  });

  it('exit code mapping: any stale -> 3, else any inconclusive -> 4, else 0', async () => {
    const lib = await loadLib();
    expect(lib.EXIT).toMatchObject({ OK: 0, ERROR: 1, BAD_ARGS: 2, STALE: 3, INCONCLUSIVE: 4 });
    expect(lib.exitCodeForVerdicts(['fresh', 'unchecked'])).toBe(0);
    expect(lib.exitCodeForVerdicts(['fresh', 'inconclusive'])).toBe(4);
    expect(lib.exitCodeForVerdicts(['inconclusive', 'stale', 'fresh'])).toBe(3);
  });

  it('sidecar: no check -> stale null; hide failure recorded as not applied', async () => {
    const lib = await loadLib();
    const s = lib.buildSidecar({ okFlag: true, pngPath: 'a.png' });
    expect(s.stale).toBe(null);
    expect(s.verdict).toBe('unchecked');
    expect(s.freshnessCheck).toBe('not-run');
    expect(lib.validateSidecarShape(s)).toEqual({ ok: true, missing: [] });
    const f = lib.buildSidecar({ okFlag: true, pngPath: 'a.png', freshnessCheck: 'disabled-by-flag', hideMode: 'minimize', hideApplied: false, hideError: 'boom' });
    expect(f).toMatchObject({ freshnessCheck: 'disabled-by-flag', hideMode: 'minimize', hideApplied: false, hideError: 'boom', stale: null });
  });
});

describe('grab-frame v2: Win32 acts on OUR hwnd only (mocked enumeration)', () => {
  const MARK = '[GrabFrame-A:t]';
  const wins = [
    { hwnd: 11, title: 'KB ' + MARK, className: 'Chrome_WidgetWin_1', visible: true, iconic: false },
    { hwnd: 12, title: 'E panel', className: 'Chrome_WidgetWin_1', visible: true, iconic: false },
  ];

  it('win32Script: actions require an explicit hwnd, verify pid ownership, never loop over pid windows', async () => {
    const lib = await loadLib();
    expect(() => lib.win32Script({ pid: 5, action: 'minimize' })).toThrow(/explicit hwnd/);
    expect(() => lib.win32Script(5, 'minimize')).toThrow(/explicit hwnd/);
    const sc = lib.win32Script({ pid: 5, action: 'minimize', hwnd: 11 });
    expect(sc).toMatch(/\$thwnd = \[int64\]11/);
    expect(sc).toMatch(/GetWindowThreadProcessId\(\$h, \[ref\]\$owner\)/);
    expect(sc).toMatch(/IsWindow\(\$h\)/);
    // the ForPid loop only describes windows; no ShowWindow inside it
    const loop = sc.slice(sc.indexOf('foreach ($w in'));
    expect(loop).not.toMatch(/ShowWindow|SetWindowPos/);
  });

  it('selectOwnWindow: unique marker / explicit hwnd ok; 0, >1, foreign or protected -> refuse', async () => {
    const lib = await loadLib();
    expect(lib.selectOwnWindow(wins, { titleMarker: MARK })).toMatchObject({ ok: true, hwnd: 11, source: 'title-marker', others: [12] });
    expect(lib.selectOwnWindow(wins, { hwnd: 12, hwndSource: 'explicit --hwnd' })).toMatchObject({ ok: true, hwnd: 12 });
    expect(lib.selectOwnWindow(wins, { titleMarker: '[nope]' }).ok).toBe(false);
    expect(lib.selectOwnWindow(wins.map((w) => ({ ...w, title: 'x ' + MARK })), { titleMarker: MARK })).toMatchObject({ ok: false, candidates: [11, 12] });
    expect(lib.selectOwnWindow(wins, { hwnd: 99 }).ok).toBe(false);
    expect(lib.selectOwnWindow(wins, { titleMarker: MARK, protectHwnds: [11] }).reason).toMatch(/cannot separate E panel/);
    expect(lib.selectOwnWindow(wins, {}).ok).toBe(false);
  });

  it('simulateWin32 + parseWin32Result: minimize touches only the target; failure -> applied false + error', async () => {
    const lib = await loadLib();
    const state = { pid: 5, windows: wins.map((w) => ({ ...w, pid: 5 })), failActions: [] as string[] };
    const r = lib.parseWin32Result(lib.simulateWin32(state, { pid: 5, action: 'minimize', hwnd: 11 }));
    expect(r).toMatchObject({ ok: true, applied: true, minimized: true });
    expect(r.windows.map((w: { hwnd: number }) => w.hwnd)).toEqual([11, 12]);
    expect(state.windows[1].iconic).toBe(false);
    const st2 = { pid: 5, windows: wins.map((w) => ({ ...w, pid: 5 })), failActions: ['offscreen'] };
    const f = lib.parseWin32Result(lib.simulateWin32(st2, { pid: 5, action: 'offscreen', hwnd: 11 }));
    expect(f.ok).toBe(false);
    expect(f.applied).toBe(false);
    expect(f.error).toMatch(/simulated offscreen failure/);
    const foreign = lib.parseWin32Result(lib.simulateWin32(state, { pid: 6, action: 'minimize', hwnd: 12 }));
    expect(foreign.ok).toBe(false);
    expect(foreign.error).toMatch(/owned by pid/);
  });
});
