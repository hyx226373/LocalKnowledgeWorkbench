/**
 * Minimal sessionId lifecycle for desk-r1 A (capture).
 * B/C/D may extend; do not weaken state machine A–E.
 */
import { randomUUID } from 'node:crypto';
import type { CaptureStatus, SessionId, SessionState, SourceDescriptor } from '../../shared/desktopPanel/types';

export interface DesktopSessionRecord {
  sessionId: SessionId;
  state: SessionState;
  source: SourceDescriptor | null;
  capture: CaptureStatus | null;
  createdAt: number;
  reason?: string;
}

type Listener = (rec: DesktopSessionRecord) => void;

export class SessionManager {
  private current: DesktopSessionRecord | null = null;
  private readonly listeners = new Set<Listener>();

  get(): DesktopSessionRecord | null {
    return this.current ? { ...this.current, source: this.current.source, capture: this.current.capture } : null;
  }

  getSessionId(): SessionId | null {
    return this.current?.sessionId ?? null;
  }

  getState(): SessionState {
    return this.current?.state ?? 'unavailable';
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    if (!this.current) return;
    const snap = this.get()!;
    for (const fn of this.listeners) fn(snap);
  }

  /** Create session when entering usable capture (unavailable → viewing). */
  create(source: SourceDescriptor | null = null): DesktopSessionRecord {
    this.invalidate('replaced');
    this.current = {
      sessionId: randomUUID(),
      state: 'viewing',
      source,
      capture: null,
      createdAt: Date.now(),
    };
    this.emit();
    return this.get()!;
  }

  setState(state: SessionState, reason?: string): DesktopSessionRecord | null {
    if (!this.current) return null;
    this.current = { ...this.current, state, reason };
    this.emit();
    return this.get();
  }

  setSource(source: SourceDescriptor | null): void {
    if (!this.current) return;
    this.current = { ...this.current, source };
    this.emit();
  }

  setCapture(capture: CaptureStatus | null): void {
    if (!this.current) return;
    this.current = { ...this.current, capture };
    this.emit();
  }

  /** Ensure caller sessionId is still the live one. */
  assertSession(sessionId: SessionId): DesktopSessionRecord {
    if (!this.current || this.current.sessionId !== sessionId) {
      const err = new Error('stale_session');
      (err as Error & { code: string }).code = 'stale_session';
      throw err;
    }
    return this.current;
  }

  invalidate(reason: string): void {
    if (!this.current) return;
    this.current = { ...this.current, state: 'paused', reason };
    this.emit();
    this.current = null;
  }
}

export const sessionManager = new SessionManager();
