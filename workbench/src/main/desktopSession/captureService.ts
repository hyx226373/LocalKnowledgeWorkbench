/**
 * desk-r1 A · captureService
 * Enumerate screen sources, start/pause/resume/stop capture, excludeSelf hooks.
 * Does NOT implement pointer forwarding (C) or enter-desktopOp (B).
 */
import {
  BrowserWindow,
  desktopCapturer,
  screen,
  type DesktopCapturerSource,
  type Display,
} from 'electron';
import type {
  CaptureId,
  CaptureStatus,
  SessionId,
  SourceDescriptor,
} from '../../shared/desktopPanel/types';
import { rediscoverSource, serializeSourceForPersist } from '../../shared/desktopPanel/sourceMatch';
import { sessionManager } from './captureSessionManager';
import { resolveFullscreenGate } from './fullscreenGate';
import { computeExcludeSelfOk, EXCLUDE_SELF_BEST_EFFORT_MSG } from './excludeSelfPolicy';
export { computeExcludeSelfOk, EXCLUDE_SELF_BEST_EFFORT_MSG } from './excludeSelfPolicy';

export type CapturePauseReason =
  | 'bubble_collapse'
  | 'exit_fullscreen'
  | 'source_lost'
  | 'session_pause'
  | 'manual'
  | string;

interface ActiveCapture {
  sessionId: SessionId;
  captureId: CaptureId;
  source: SourceDescriptor;
  status: CaptureStatus['status'];
  frameSize: { width: number; height: number };
  excludeSelfOk: boolean;
  message?: string;
  pausedReason?: string;
}

type StatusListener = (status: CaptureStatus) => void;

/** Optional native helper bridge for capture.excludeSelf (C owns helper process). */
export interface ExcludeSelfHelper {
  /** Send capture.excludeSelf { hwnds } over JSON-lines; resolve true if applied. */
  excludeSelf(hwnds: string[]): Promise<boolean>;
}

let excludeSelfHelper: ExcludeSelfHelper | null = null;

export function setExcludeSelfHelper(helper: ExcludeSelfHelper | null): void {
  excludeSelfHelper = helper;
}

const listeners = new Set<StatusListener>();
let active: ActiveCapture | null = null;

/** Map of sessionId → last CaptureStatus for getStatus. */
function toStatus(a: ActiveCapture): CaptureStatus {
  return {
    sessionId: a.sessionId,
    captureId: a.captureId,
    source: a.source,
    status: a.status,
    frameSize: { ...a.frameSize },
    excludeSelfOk: a.excludeSelfOk,
    message: a.message,
  };
}

function emitStatus(): void {
  if (!active) return;
  const st = toStatus(active);
  sessionManager.setCapture(st);
  for (const fn of listeners) fn(st);
}

export function onCaptureStatus(fn: StatusListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function displayKeyFor(d: Display): string {
  // Electron display.id is stable enough within a boot; stringify for SourceDescriptor.
  return String(d.id);
}

function labelFor(d: Display, index: number): string {
  // display.label exists on newer Electron; fall back.
  const anyD = d as Display & { label?: string };
  if (anyD.label && anyD.label.trim()) return anyD.label;
  return d.internal ? `内置显示器 ${index + 1}` : `显示器 ${index + 1}`;
}

/**
 * Match capturer source to Electron Display via display_id / size / name.
 */
function matchDisplay(
  src: DesktopCapturerSource,
  displays: Display[]
): Display | null {
  const displayId = (src as DesktopCapturerSource & { display_id?: string }).display_id;
  if (displayId) {
    const byId = displays.find((d) => String(d.id) === String(displayId));
    if (byId) return byId;
  }
  // Fallback: match by size (physical-ish via size * scaleFactor)
  const { width, height } = src.thumbnail?.isEmpty?.()
    ? { width: 0, height: 0 }
    : { width: 0, height: 0 };
  void width;
  void height;
  // Name often contains "Screen" / display index — prefer primary if single screen
  if (displays.length === 1) return displays[0];
  // Try bounds size against capturer name patterns later; size match:
  const sized = displays.find((d) => {
    const bw = d.bounds.width * d.scaleFactor;
    const bh = d.bounds.height * d.scaleFactor;
    // capturer does not give pixel size directly here; skip strict size
    void bw;
    void bh;
    return false;
  });
  return sized ?? displays[0] ?? null;
}

function descriptorFromDisplay(
  d: Display,
  index: number,
  capturer?: DesktopCapturerSource
): SourceDescriptor {
  const scale = d.scaleFactor || 1;
  const desc: SourceDescriptor = {
    v: 1,
    displayKey: displayKeyFor(d),
    label: labelFor(d, index),
    bounds: {
      x: Math.round(d.bounds.x * scale),
      y: Math.round(d.bounds.y * scale),
      width: Math.round(d.bounds.width * scale),
      height: Math.round(d.bounds.height * scale),
    },
    scaleFactor: scale,
  };
  if (capturer) {
    const display_id = (capturer as DesktopCapturerSource & { display_id?: string })
      .display_id;
    desc.mediaSourceHint = {
      name: capturer.name,
      display_id: display_id ? String(display_id) : String(d.id),
    };
  }
  return desc;
}

/** Runtime map: displayKey → current capturer source.id (session-local only). */
const captureIdByDisplayKey = new Map<string, CaptureId>();

export async function enumerateSources(): Promise<SourceDescriptor[]> {
  const displays = screen.getAllDisplays();
  let sources: DesktopCapturerSource[] = [];
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false,
    });
  } catch (err) {
    console.warn('[desk-r1-A] desktopCapturer.getSources failed', err);
  }

  captureIdByDisplayKey.clear();
  const out: SourceDescriptor[] = [];

  if (sources.length === 0) {
    // Still emit display-based descriptors so rediscovery/UI can work offline of capturer
    displays.forEach((d, i) => out.push(descriptorFromDisplay(d, i)));
    return out;
  }

  // Pair each screen capturer source with a Display
  const used = new Set<number>();
  for (const src of sources) {
    const d =
      matchDisplay(src, displays.filter((x) => !used.has(x.id))) ??
      matchDisplay(src, displays);
    if (!d) continue;
    used.add(d.id);
    const index = displays.findIndex((x) => x.id === d.id);
    const desc = descriptorFromDisplay(d, index >= 0 ? index : 0, src);
    out.push(desc);
    captureIdByDisplayKey.set(desc.displayKey, src.id);
  }

  // Any displays without capturer row
  displays.forEach((d, i) => {
    if (used.has(d.id)) return;
    out.push(descriptorFromDisplay(d, i));
  });

  return out;
}

/**
 * Resolve temporary captureId for a SourceDescriptor (session-local).
 */
export function resolveCaptureId(source: SourceDescriptor): CaptureId | null {
  const fromMap = captureIdByDisplayKey.get(source.displayKey);
  if (fromMap) return fromMap;
  const hintName = source.mediaSourceHint?.name;
  // Last resort: callers should re-enumerate first
  void hintName;
  return null;
}

async function collectAppHwnds(win: BrowserWindow | null): Promise<string[]> {
  const hwnds: string[] = [];
  if (!win || win.isDestroyed()) return hwnds;
  try {
    const buf = win.getNativeWindowHandle();
    // Windows HWND is pointer-sized little-endian in the Buffer
    if (process.platform === 'win32' && buf.length >= 4) {
      const hwnd =
        buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
      hwnds.push(`0x${hwnd.toString(16).toUpperCase()}`);
    }
  } catch (err) {
    console.warn('[desk-r1-A] getNativeWindowHandle failed', err);
  }
  // Child windows
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    try {
      const buf = w.getNativeWindowHandle();
      if (process.platform === 'win32' && buf.length >= 4) {
        const hwnd =
          buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
        const s = `0x${hwnd.toString(16).toUpperCase()}`;
        if (!hwnds.includes(s)) hwnds.push(s);
      }
    } catch {
      /* ignore */
    }
  }
  return hwnds;
}

/**
 * Apply exclude-self: always best-effort setContentProtection; excludeSelfOk is honest.
 * Returns true ONLY when the C helper (`excludeSelfHelper.excludeSelf`) returns true.
 * setContentProtection success alone does NOT set excludeSelfOk=true (M-3).
 */
export async function applyExcludeSelf(win: BrowserWindow | null): Promise<boolean> {
  // Best-effort OS content protection — never treated as verified excludeSelf.
  if (win && !win.isDestroyed()) {
    try {
      // Electron: request OS to exclude window from capture where supported (Win10 2004+).
      win.setContentProtection(true);
    } catch (err) {
      console.warn('[desk-r1-A] setContentProtection failed', err);
    }
  }

  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    try {
      w.setContentProtection(true);
    } catch {
      /* ignore */
    }
  }

  const hwnds = await collectAppHwnds(win);
  if (excludeSelfHelper && hwnds.length > 0) {
    try {
      const helperOk = await excludeSelfHelper.excludeSelf(hwnds);
      return computeExcludeSelfOk(helperOk);
    } catch (err) {
      console.warn('[desk-r1-A] helper excludeSelf failed (C handoff)', err);
      return false;
    }
  }

  // Helper absent or no hwnds — contentProtection may still be on; not verified.
  return false;
}


export async function startCapture(
  sessionId: SessionId,
  source: SourceDescriptor,
  opts?: { win?: BrowserWindow | null }
): Promise<CaptureStatus> {
  sessionManager.assertSession(sessionId);

  const win = opts?.win ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
  const gate = resolveFullscreenGate(win);
  if (!gate.isFullscreen) {
    sessionManager.setState('unavailable', gate.reason);
    throw Object.assign(new Error('fullscreen_required'), {
      code: 'invalid_state',
      message: gate.reason,
    });
  }

  // Refresh capturer ids
  const live = await enumerateSources();
  const matched = rediscoverSource(source, live) ?? live.find((s) => s.displayKey === source.displayKey) ?? source;
  let captureId = resolveCaptureId(matched);
  if (!captureId) {
    // Re-enumerate already filled map; try hint name scan
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 },
    });
    const hintId = matched.mediaSourceHint?.display_id;
    const hit =
      sources.find((s) => {
        const did = (s as DesktopCapturerSource & { display_id?: string }).display_id;
        return hintId && String(did) === String(hintId);
      }) ??
      sources.find((s) => s.name === matched.mediaSourceHint?.name) ??
      sources[0];
    if (!hit) {
      throw Object.assign(new Error('source_not_found'), { code: 'invalid_target' });
    }
    captureId = hit.id;
    captureIdByDisplayKey.set(matched.displayKey, captureId);
  }

  const excludeSelfOk = await applyExcludeSelf(win);
  const frameSize = {
    width: matched.bounds.width,
    height: matched.bounds.height,
  };

  let message: string;
  if (excludeSelfOk) {
    message = gate.stub ? `live (fullscreen stub: ${gate.reason})` : 'live';
  } else if (gate.stub) {
    message = `live (fullscreen stub: ${gate.reason}; excludeSelf best-effort via setContentProtection; not verified; helper absent)`;
  } else {
    message = EXCLUDE_SELF_BEST_EFFORT_MSG;
  }

  active = {
    sessionId,
    captureId,
    source: serializeSourceForPersist(matched),
    status: 'live',
    frameSize,
    excludeSelfOk,
    message,
  };

  sessionManager.setSource(active.source);
  sessionManager.setState('viewing', 'capture_started');
  emitStatus();
  return toStatus(active);
}

export async function pauseCapture(
  sessionId: SessionId,
  reason: CapturePauseReason
): Promise<CaptureStatus | null> {
  sessionManager.assertSession(sessionId);
  if (!active || active.sessionId !== sessionId) return null;
  active = {
    ...active,
    status: 'paused',
    pausedReason: reason,
    message: `paused: ${reason}`,
  };
  if (reason === 'exit_fullscreen') {
    sessionManager.setState('paused', reason);
  } else if (reason === 'bubble_collapse') {
    // Keep session; stop interaction is B's job — capture pauses per A strategy.
    sessionManager.setState(sessionManager.getState() === 'unavailable' ? 'unavailable' : 'paused', reason);
  } else {
    sessionManager.setState('paused', reason);
  }
  emitStatus();
  return toStatus(active);
}

export async function resumeCapture(sessionId: SessionId): Promise<CaptureStatus> {
  sessionManager.assertSession(sessionId);
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
  const gate = resolveFullscreenGate(win);
  if (!gate.isFullscreen) {
    sessionManager.setState('unavailable', gate.reason);
    throw Object.assign(new Error('fullscreen_required'), { code: 'invalid_state' });
  }

  if (!active || active.sessionId !== sessionId) {
    const rec = sessionManager.get();
    if (!rec?.source) {
      throw Object.assign(new Error('no_source'), { code: 'invalid_state' });
    }
    return startCapture(sessionId, rec.source, { win });
  }

  // Rediscover — new captureId allowed
  const live = await enumerateSources();
  const matched = rediscoverSource(active.source, live) ?? active.source;
  const captureId = resolveCaptureId(matched) ?? active.captureId;
  const excludeSelfOk = await applyExcludeSelf(win);

  active = {
    sessionId,
    captureId,
    source: serializeSourceForPersist(matched),
    status: 'live',
    frameSize: {
      width: matched.bounds.width,
      height: matched.bounds.height,
    },
    excludeSelfOk,
    message: excludeSelfOk
      ? 'resumed — viewing'
      : 'resumed — viewing (excludeSelf best-effort via setContentProtection; not verified; helper absent)',
  };
  sessionManager.setSource(active.source);
  sessionManager.setState('viewing', 'capture_resumed');
  emitStatus();
  return toStatus(active);
}

export async function stopCapture(sessionId: SessionId): Promise<void> {
  try {
    sessionManager.assertSession(sessionId);
  } catch {
    active = null;
    return;
  }
  if (active && active.sessionId === sessionId) {
    active = {
      ...active,
      status: 'ended',
      message: 'stopped',
    };
    emitStatus();
  }
  active = null;
  sessionManager.setCapture(null);
}

export function getCaptureStatus(sessionId?: SessionId): CaptureStatus | null {
  if (!active) return null;
  if (sessionId && active.sessionId !== sessionId) return null;
  return toStatus(active);
}

/**
 * Handle host fullscreen / bubble events from B or main shell.
 */
export async function onHostPresentationEvent(
  event: 'enter-fullscreen' | 'leave-fullscreen' | 'bubble-collapse' | 'bubble-expand',
  win?: BrowserWindow | null
): Promise<void> {
  const w = win ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;

  if (event === 'leave-fullscreen') {
    const sid = sessionManager.getSessionId();
    if (sid && active) await pauseCapture(sid, 'exit_fullscreen');
    sessionManager.setState('unavailable', 'leave-fullscreen');
    return;
  }

  if (event === 'bubble-collapse') {
    const sid = sessionManager.getSessionId();
    if (sid && active) await pauseCapture(sid, 'bubble_collapse');
    return;
  }

  if (event === 'enter-fullscreen' || event === 'bubble-expand') {
    const gate = resolveFullscreenGate(w);
    if (!gate.isFullscreen && event === 'enter-fullscreen') {
      // Still unavailable without stub
      sessionManager.setState('unavailable', gate.reason);
      return;
    }
    const rec = sessionManager.get();
    if (rec?.sessionId && rec.source) {
      try {
        await resumeCapture(rec.sessionId);
      } catch {
        // If session was invalidated, caller should session.start again
      }
    }
  }
}

/** Test/helper export */
export function _resetCaptureServiceForTests(): void {
  active = null;
  captureIdByDisplayKey.clear();
  listeners.clear();
  excludeSelfHelper = null;
}
