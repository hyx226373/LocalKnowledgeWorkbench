/**
 * GrabFrame close: desktop panel UI.
 * Blank-panel fix: error boundary + absolute fill + defensive source rows.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CaptureStatus, SourceDescriptor } from '../../shared/desktopPanel/types';
import { bindStreamToElement } from './bindStream';
import { clientToNormalized, wheelToMouseData } from '../../shared/desktopPanel/inputMap';
import { DESK_INPUT_EXIT_KEY, SAME_SCREEN_HINT, isPanelOnSourceScreen, isExitKey, nextEnterState, type EnterEvent, type EnterState } from '../../shared/desktopPanel/enterState';
export { DESKTOP_PANEL_COMPONENT, DESKTOP_PANEL_DOCK_ID } from './ids';

type CapApi = NonNullable<NonNullable<Window['desktopPanel']>['capture']> & {
  uiStart?: (source: SourceDescriptor) => Promise<{
    ok: boolean;
    sessionId?: string;
    source?: SourceDescriptor;
    status?: CaptureStatus;
    error?: string;
  }>;
  uiStop?: (sessionId?: string) => Promise<{ ok: boolean; error?: string }>;
  inputEnter?: (sessionId: string) => Promise<{ ok: boolean; error?: string; injector?: string }>;
  inputExit?: (reason?: string) => Promise<{ ok: boolean; error?: string }>;
  inputPointer?: (payload: {
    sessionId: string;
    action: 'move' | 'down' | 'up' | 'click' | 'wheel';
    u: number;
    v: number;
    button?: 'left' | 'right' | 'middle';
    wheel?: { vertical: number; horizontal: number };
  }) => Promise<{ ok: boolean; error?: string; sent?: number; dropped?: string }>;
};

const BUTTON_MAP: Record<number, 'left' | 'middle' | 'right'> = { 0: 'left', 1: 'middle', 2: 'right' };
const T_TOGGLE = '\u542f\u7528\u70b9\u51fb/\u8fdb\u5165';
const T_ENTERED = (k: string) => `\u25cf \u5df2\u8fdb\u5165\u76ee\u6807\u5c4f\uff08\u79bb\u5f00\u6216 ${k} \u9000\u51fa\uff09`;
const T_IDLE = '\u25cb \u672a\u8fdb\u5165\uff08\u60ac\u505c\u753b\u9762\u8fdb\u5165\uff09';
const T_OFF = '\u25cb \u70b9\u51fb\u6ce8\u5165\u5173\u95ed';

function getCaptureApi(): CapApi | null {
  return (window.desktopPanel?.capture as CapApi | undefined) ?? null;
}

function sourceMeta(s: SourceDescriptor): string {
  const b = s && s.bounds;
  if (!b || typeof b.width !== 'number' || typeof b.height !== 'number') return 'size unknown';
  const sf = typeof s.scaleFactor === 'number' ? s.scaleFactor : 1;
  return b.width + 'x' + b.height + ' @' + sf + 'x';
}

class DesktopPanelErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        className="kb-desktop-panel kb-desktop-panel--crashed"
        data-testid="desktop-panel-crashed"
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          padding: 24,
          background: '#1a1a1a',
          color: '#eee',
          textAlign: 'center',
          zIndex: 5,
        }}
      >
        <strong>Desktop panel render failed</strong>
        <div style={{ color: '#f88', fontSize: 12, maxWidth: 480, wordBreak: 'break-word' }}>
          {String(this.state.error.message || this.state.error)}
        </div>
        <p style={{ opacity: 0.7, fontSize: 12, margin: 0 }}>
          Close the tab titled desktop panel to recover. Main window stays.
        </p>
        <button
          type="button"
          className="kb-button kb-button--secondary"
          data-testid="desktop-panel-retry"
          onClick={() => this.setState({ error: null })}
        >
          Retry
        </button>
      </div>
    );
  }
}

function DesktopPanelBody(): React.ReactElement {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stopStreamRef = useRef<(() => void) | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  const [sources, setSources] = useState<SourceDescriptor[]>([]);
  const [loadingEnum, setLoadingEnum] = useState(false);
  const [enumError, setEnumError] = useState<string | null>(null);
  const [activeSource, setActiveSource] = useState<SourceDescriptor | null>(null);
  const [status, setStatus] = useState<CaptureStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);

  // desk-input: opt-in real click + enter mode (default off; never auto-inject)
  const [inputEnabled, setInputEnabled] = useState(false);
  const [enterState, setEnterState] = useState<EnterState>('idle');
  const [inputNote, setInputNote] = useState<string | null>(null);
  const enterRef = useRef<EnterState>('idle');
  const pendingMoveRef = useRef<{ u: number; v: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const isLive = status?.status === 'live';
  const [sameScreen, setSameScreen] = useState(false);

  // same-screen guard: re-check on source change and while the window may move (cheap 1s poll, no focus/raise)
  useEffect(() => {
    const src = activeSource?.bounds ?? null;
    const check = () => setSameScreen(isPanelOnSourceScreen(
      { x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight }, src));
    check();
    if (!src) return;
    const id = window.setInterval(check, 1000);
    return () => window.clearInterval(id);
  }, [activeSource]);
  useEffect(() => { if (sameScreen) setInputEnabled(false); }, [sameScreen]);

  const dispatchEnter = useCallback((ev: EnterEvent): boolean => {
    const tr = nextEnterState(enterRef.current, ev);
    if (!tr.changed) return false;
    enterRef.current = tr.state;
    setEnterState(tr.state);
    if (tr.state === 'idle') {
      pendingMoveRef.current = null;
      if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      void getCaptureApi()?.inputExit?.(tr.reason);
    }
    return true;
  }, []);

  const toNorm = useCallback((clientX: number, clientY: number) => {
    const el = videoRef.current;
    if (!el || !el.videoWidth || !el.videoHeight) return null;
    const r = el.getBoundingClientRect();
    return clientToNormalized(clientX, clientY, { x: r.left, y: r.top, width: r.width, height: r.height }, { width: el.videoWidth, height: el.videoHeight });
  }, []);

  const sendPointer = useCallback((p: { action: 'move' | 'down' | 'up' | 'wheel'; u: number; v: number; button?: 'left' | 'middle' | 'right'; wheel?: { vertical: number; horizontal: number } }) => {
    const api = getCaptureApi();
    const sid = sessionIdRef.current;
    if (enterRef.current !== 'entered' || !api?.inputPointer || !sid) return;
    void api.inputPointer({ sessionId: sid, ...p }).then((r) => {
      if (!r.ok && r.error) {
        setInputNote(r.error);
        if (r.error === 'not_entered' || r.error === 'session_mismatch') dispatchEnter({ type: 'sessionChanged' });
      }
    });
  }, [dispatchEnter]);

  const onOverlayEnter = useCallback(async () => {
    const api = getCaptureApi();
    const sid = sessionIdRef.current;
    if (!api?.inputEnter || !sid) { setInputNote('input IPC not mounted'); return; }
    if (!dispatchEnter({ type: 'enter', enabled: inputEnabled && !sameScreen, live: isLive })) return;
    const r = await api.inputEnter(sid);
    setInputNote(r.ok ? `injector:${r.injector ?? '?'}` : r.error ?? 'enter failed');
    if (!r.ok) dispatchEnter({ type: 'sessionChanged' });
  }, [dispatchEnter, inputEnabled, isLive, sameScreen]);

  const onOverlayMove = useCallback((e: React.PointerEvent) => {
    if (enterRef.current !== 'entered') return;
    const n = toNorm(e.clientX, e.clientY);
    if (!n) return;
    pendingMoveRef.current = n;
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const m = pendingMoveRef.current;
        pendingMoveRef.current = null;
        if (m) sendPointer({ action: 'move', ...m });
      });
    }
  }, [sendPointer, toNorm]);

  const onOverlayButton = useCallback((e: React.PointerEvent, action: 'down' | 'up') => {
    if (enterRef.current !== 'entered') return;
    const button = BUTTON_MAP[e.button];
    const n = toNorm(e.clientX, e.clientY);
    if (!button || !n) return;
    e.preventDefault();
    sendPointer({ action, button, ...n });
  }, [sendPointer, toNorm]);

  const onOverlayWheel = useCallback((e: React.WheelEvent) => {
    if (enterRef.current !== 'entered') return;
    const n = toNorm(e.clientX, e.clientY);
    if (!n) return;
    const wheel = wheelToMouseData(e.deltaY, e.deltaX, e.deltaMode);
    if (!wheel.vertical && !wheel.horizontal) return;
    sendPointer({ action: 'wheel', wheel, ...n });
  }, [sendPointer, toNorm]);

  // exit key (Ctrl+Alt+Q; Escape is taken by content-only mode / dialogs) + window blur -> exit
  useEffect(() => {
    if (enterState !== 'entered') return;
    const onKey = (e: KeyboardEvent) => {
      if (isExitKey(e)) { e.preventDefault(); e.stopPropagation(); dispatchEnter({ type: 'exitKey' }); }
    };
    const onBlur = () => dispatchEnter({ type: 'blur' });
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('blur', onBlur); };
  }, [enterState, dispatchEnter]);

  // capture stopped / source changed / toggle off / unmount -> exit
  useEffect(() => { if (!isLive) dispatchEnter({ type: 'stop' }); }, [isLive, dispatchEnter]);
  useEffect(() => { dispatchEnter({ type: 'sessionChanged' }); }, [activeSource?.displayKey, dispatchEnter]);
  useEffect(() => { if (!inputEnabled) dispatchEnter({ type: 'disable' }); }, [inputEnabled, dispatchEnter]);
  useEffect(() => () => { dispatchEnter({ type: 'stop' }); }, [dispatchEnter]);

  const teardownStream = useCallback(() => {
    stopStreamRef.current?.();
    stopStreamRef.current = null;
  }, []);

  const refreshSources = useCallback(async () => {
    const api = getCaptureApi();
    if (!api?.enumerateSources) {
      setEnumError('desktopPanel.capture not mounted (preload)');
      return;
    }
    setLoadingEnum(true);
    setEnumError(null);
    try {
      const list = await api.enumerateSources();
      setSources(Array.isArray(list) ? list.filter(Boolean) : []);
    } catch (e) {
      setEnumError(e instanceof Error ? e.message : String(e));
      setSources([]);
    } finally {
      setLoadingEnum(false);
    }
  }, []);

  useEffect(() => {
    void refreshSources();
  }, [refreshSources]);

  useEffect(() => {
    const api = getCaptureApi();
    if (!api?.onCaptureStatus) return;
    return api.onCaptureStatus((s) => {
      setStatus(s);
      if (s.sessionId) sessionIdRef.current = s.sessionId;
    });
  }, []);

  useEffect(() => {
    return () => {
      teardownStream();
      const api = getCaptureApi();
      const sid = sessionIdRef.current;
      if (api && sid) {
        void (api.uiStop?.(sid) ?? api.captureStop?.(sid));
      }
    };
  }, [teardownStream]);

  const bindLive = useCallback(
    async (captureId: string) => {
      const el = videoRef.current;
      if (!el) return;
      teardownStream();
      const bound = await bindStreamToElement(captureId, el);
      stopStreamRef.current = bound.stop;
    },
    [teardownStream],
  );

  const startWithSource = useCallback(
    async (source: SourceDescriptor) => {
      const api = getCaptureApi();
      if (!api) {
        setError('desktopPanel.capture not mounted');
        return;
      }
      setBusy(true);
      setError(null);
      try {
        teardownStream();
        if (sessionIdRef.current) {
          await (api.uiStop?.(sessionIdRef.current) ?? api.captureStop?.(sessionIdRef.current));
          sessionIdRef.current = null;
        }

        let statusResult: CaptureStatus | null = null;
        if (api.uiStart) {
          const r = await api.uiStart(source);
          if (!r.ok || !r.status) {
            throw new Error(r.error || 'uiStart failed');
          }
          statusResult = r.status;
          if (r.sessionId) sessionIdRef.current = r.sessionId;
          setActiveSource(r.source ?? source);
        } else {
          const anyApi = api as CapApi & {
            _testBootstrap?: (p?: { sourceHint?: SourceDescriptor }) => Promise<{ sessionId: string; source: SourceDescriptor }>;
          };
          if (!anyApi._testBootstrap) {
            throw new Error('uiStart unavailable; main must register desktopPanel.capture.uiStart');
          }
          const boot = await anyApi._testBootstrap({ sourceHint: source });
          sessionIdRef.current = boot.sessionId;
          setActiveSource(boot.source);
          const started = await api.captureStart(boot.sessionId, boot.source);
          if (started && typeof started === 'object' && 'ok' in started && (started as { ok: boolean }).ok === false) {
            throw new Error((started as { error?: string }).error || 'captureStart failed');
          }
          statusResult = started as CaptureStatus;
        }

        setStatus(statusResult);
        if (statusResult?.captureId) {
          await bindLive(statusResult.captureId);
        } else {
          throw new Error('captureStart returned no captureId');
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        teardownStream();
      } finally {
        setBusy(false);
      }
    },
    [bindLive, teardownStream],
  );

  const stopCapture = useCallback(async () => {
    const api = getCaptureApi();
    const sid = sessionIdRef.current;
    setBusy(true);
    try {
      teardownStream();
      if (api && sid) {
        await (api.uiStop?.(sid) ?? api.captureStop?.(sid));
      }
      sessionIdRef.current = null;
      setStatus(null);
      setActiveSource(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [teardownStream]);

  return (
    <div
      className="kb-desktop-panel"
      data-testid="desktop-panel"
      data-desk-r1-desktop-panel="1"
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        minHeight: 0,
        background: '#111',
        color: '#eee',
        fontSize: 13,
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          padding: '8px 10px',
          borderBottom: '1px solid #333',
          flexShrink: 0,
          flexWrap: 'wrap',
          background: '#161616',
        }}
      >
        <strong style={{ marginRight: 4 }}>Desktop Panel</strong>
        <button type="button" data-testid="desktop-panel-refresh" disabled={loadingEnum || busy} onClick={() => void refreshSources()}>
          Refresh sources
        </button>
        <button type="button" data-testid="desktop-panel-stop" disabled={busy || !status} onClick={() => void stopCapture()}>
          Stop capture
        </button>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          Zoom
          <input
            data-testid="desktop-panel-zoom"
            type="range"
            min={0.5}
            max={2}
            step={0.1}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
          />
          <span>{Math.round(zoom * 100)}%</span>
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }} title={`hover into the picture to enter; leave or ${DESK_INPUT_EXIT_KEY} to exit`}>
          <input
            data-testid="desktop-panel-input-toggle"
            type="checkbox"
            checked={inputEnabled}
            disabled={sameScreen}
            onChange={(e) => setInputEnabled(e.target.checked)}
          />
          {T_TOGGLE}
        </label>
        <span
          data-testid="desktop-panel-input-state"
          data-state={enterState}
          style={{
            padding: '2px 8px',
            borderRadius: 10,
            fontWeight: 600,
            background: enterState === 'entered' ? '#c62828' : '#333',
            color: enterState === 'entered' ? '#fff' : '#aaa',
          }}
        >
          {enterState === 'entered' ? T_ENTERED(DESK_INPUT_EXIT_KEY) : inputEnabled ? T_IDLE : T_OFF}
        </span>
        {sameScreen ? <span data-testid="desktop-panel-input-same-screen" style={{ color: '#fb3', fontSize: 12 }}>{SAME_SCREEN_HINT}</span> : null}
        {inputNote ? <span data-testid="desktop-panel-input-note" style={{ opacity: 0.6, fontSize: 11 }}>{inputNote}</span> : null}
        <span style={{ opacity: 0.75 }} data-testid="desktop-panel-status">
          {status ? 'status ' + status.status : 'idle'}
          {activeSource ? ' · ' + (activeSource.label || activeSource.displayKey) : ''}
        </span>
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <aside
          data-testid="desktop-panel-source-list"
          style={{
            width: 220,
            flexShrink: 0,
            borderRight: '1px solid #333',
            overflow: 'auto',
            padding: 8,
            background: '#141414',
          }}
        >
          <div style={{ marginBottom: 6, opacity: 0.8 }}>Sources</div>
          {loadingEnum ? <div data-testid="desktop-panel-enum-loading">Enumerating...</div> : null}
          {enumError ? (
            <div style={{ color: '#f88' }} data-testid="desktop-panel-enum-error">
              {enumError}
            </div>
          ) : null}
          {!loadingEnum && !enumError && sources.length === 0 ? (
            <div style={{ opacity: 0.75 }} data-testid="desktop-panel-enum-empty">
              No sources (click Refresh)
            </div>
          ) : null}
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {sources.map((s, idx) => {
              const key = (s && s.displayKey) || ('src-' + idx);
              const selected = activeSource?.displayKey === s?.displayKey;
              return (
                <li key={key} style={{ marginBottom: 4 }}>
                  <button
                    type="button"
                    data-testid="desktop-panel-source"
                    data-display-key={key}
                    disabled={busy || !s}
                    onClick={() => s && void startWithSource(s)}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      padding: '8px 10px',
                      border: selected ? '1px solid #6af' : '1px solid #444',
                      background: selected ? '#1a2a44' : '#1a1a1a',
                      color: '#eee',
                      cursor: 'pointer',
                      borderRadius: 4,
                    }}
                  >
                    <div>{(s && s.label) || key}</div>
                    <div style={{ opacity: 0.55, fontSize: 11 }}>{sourceMeta(s)}</div>
                  </button>
                </li>
              );
            })}
          </ul>
          <p style={{ opacity: 0.55, fontSize: 11, marginTop: 12, lineHeight: 1.4 }}>
            Close this panel via its tab. No extra BrowserWindow.
          </p>
        </aside>

        <main style={{ flex: 1, position: 'relative', minWidth: 0, overflow: 'hidden', background: '#0a0a0a' }}>
          {error ? (
            <div
              data-testid="desktop-panel-error"
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#f88',
                padding: 16,
                textAlign: 'center',
                zIndex: 2,
                background: '#0a0a0a',
              }}
            >
              {error}
            </div>
          ) : null}
          {!status && !error ? (
            <div
              data-testid="desktop-panel-empty"
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                color: '#bbb',
                zIndex: 1,
                background: '#0a0a0a',
                border: '1px dashed #333',
                margin: 8,
                borderRadius: 6,
                padding: 16,
                textAlign: 'center',
              }}
            >
              <strong style={{ color: '#eee' }}>No capture yet</strong>
              <span>Pick a source on the left to start live video</span>
              <span style={{ opacity: 0.6, fontSize: 12 }}>If list empty, Refresh; still blank: close this tab</span>
            </div>
          ) : null}
          <div
            style={{
              width: '100%',
              height: '100%',
              transform: 'scale(' + zoom + ')',
              transformOrigin: 'center center',
            }}
          >
            <video
              ref={videoRef}
              data-testid="desktop-panel-video"
              data-desk-r1-video="1"
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'contain',
                background: '#000',
                display: status?.status === 'live' ? 'block' : 'none',
              }}
            />
          </div>
          {inputEnabled && isLive && !sameScreen ? (
            <div
              data-testid="desktop-panel-input-overlay"
              onPointerEnter={() => void onOverlayEnter()}
              onPointerLeave={() => dispatchEnter({ type: 'leave' })}
              onPointerMove={onOverlayMove}
              onPointerDown={(e) => onOverlayButton(e, 'down')}
              onPointerUp={(e) => onOverlayButton(e, 'up')}
              onWheel={onOverlayWheel}
              onContextMenu={(e) => e.preventDefault()}
              onAuxClick={(e) => e.preventDefault()}
              style={{
                position: 'absolute',
                inset: 0,
                zIndex: 3,
                cursor: enterState === 'entered' ? 'crosshair' : 'default',
                outline: enterState === 'entered' ? '3px solid #c62828' : 'none',
                outlineOffset: -3,
              }}
            />
          ) : null}
          {status?.status === 'paused' ? (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#ddd',
                background: 'rgba(0,0,0,0.55)',
              }}
            >
              Paused / session invalid
            </div>
          ) : null}
        </main>
      </div>
    </div>
  );
}

export function DesktopPanel(): React.ReactElement {
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', minHeight: 120, background: '#111' }}>
      <DesktopPanelErrorBoundary>
        <DesktopPanelBody />
      </DesktopPanelErrorBoundary>
    </div>
  );
}

export default DesktopPanel;
