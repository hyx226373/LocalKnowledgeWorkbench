/**
 * desk-input (c, main side): validated pointer pipeline. Electron-free so it is unit-testable.
 * - Only while entered (enter must match the active capture session).
 * - Validates sessionId / action / button / u,v / wheel; anything else is rejected.
 * - Rate-limits move; exit releases any held buttons (no stuck drag).
 */
import { mapNormalizedToInjection, type InputSource, type RectLike } from '../../shared/desktopPanel/inputMap';
import type { InjectEvent, InputInjector, MouseButton } from './inputInjector';

export type PointerAction = 'move' | 'down' | 'up' | 'click' | 'wheel';
export interface PanelPointerPayload {
  sessionId: string;
  action: PointerAction;
  u: number;
  v: number;
  button?: MouseButton;
  wheel?: { vertical: number; horizontal: number };
}

export interface InputControllerDeps {
  injector: InputInjector;
  getActive(): { sessionId: string; source: InputSource } | null;
  getVirtualDesktop(): RectLike;
  now(): number;
  moveMinIntervalMs?: number;
}

export type InputResult = { ok: true; sent: number; dropped?: string } | { ok: false; error: string };

const ACTIONS = new Set<PointerAction>(['move', 'down', 'up', 'click', 'wheel']);
const BUTTONS = new Set<MouseButton>(['left', 'right', 'middle']);
const isUnit = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
const isInt = (n: unknown, lim: number): n is number => typeof n === 'number' && Number.isInteger(n) && Math.abs(n) <= lim;

export function validatePointerPayload(p: unknown): { ok: true; value: PanelPointerPayload } | { ok: false; error: string } {
  if (!p || typeof p !== 'object') return { ok: false, error: 'bad_payload' };
  const o = p as Record<string, unknown>;
  if (typeof o.sessionId !== 'string' || !o.sessionId || o.sessionId.length > 128) return { ok: false, error: 'bad_session' };
  if (typeof o.action !== 'string' || !ACTIONS.has(o.action as PointerAction)) return { ok: false, error: 'bad_action' };
  if (!isUnit(o.u) || !isUnit(o.v)) return { ok: false, error: 'bad_coords' };
  const action = o.action as PointerAction;
  let button: MouseButton | undefined;
  if (action === 'down' || action === 'up' || action === 'click') {
    if (typeof o.button !== 'string' || !BUTTONS.has(o.button as MouseButton)) return { ok: false, error: 'bad_button' };
    button = o.button as MouseButton;
  }
  let wheel: PanelPointerPayload['wheel'];
  if (action === 'wheel') {
    const w = o.wheel as Record<string, unknown> | undefined;
    if (!w || !isInt(w.vertical, 1200) || !isInt(w.horizontal, 1200)) return { ok: false, error: 'bad_wheel' };
    if (w.vertical === 0 && w.horizontal === 0) return { ok: false, error: 'bad_wheel' };
    wheel = { vertical: w.vertical, horizontal: w.horizontal };
  }
  return { ok: true, value: { sessionId: o.sessionId, action, u: o.u, v: o.v, button, wheel } };
}

export class DesktopInputController {
  private enteredSession: string | null = null;
  private lastMoveAt = -Infinity;
  private lastAbs: { ax: number; ay: number } | null = null;
  private readonly held = new Set<MouseButton>();
  readonly stats = { accepted: 0, dropped: 0, rejected: 0 };

  constructor(private readonly deps: InputControllerDeps) {}

  get entered(): boolean { return this.enteredSession !== null; }

  enter(sessionId: unknown): InputResult {
    const active = this.deps.getActive();
    if (typeof sessionId !== 'string' || !active || active.sessionId !== sessionId) { this.stats.rejected++; return { ok: false, error: 'no_matching_session' }; }
    this.enteredSession = sessionId;
    return { ok: true, sent: 0 };
  }

  async exit(_reason: string): Promise<InputResult> {
    const wasEntered = this.enteredSession !== null;
    this.enteredSession = null;
    if (!wasEntered || !this.held.size || !this.lastAbs) { this.held.clear(); return { ok: true, sent: 0 }; }
    const ups: InjectEvent[] = [...this.held].map((button) => ({ kind: 'up', ax: this.lastAbs!.ax, ay: this.lastAbs!.ay, button }));
    this.held.clear();
    const r = await this.deps.injector.send(ups);
    return r.ok ? { ok: true, sent: r.sent } : { ok: false, error: r.error ?? 'inject_failed' };
  }

  async pointer(raw: unknown): Promise<InputResult> {
    const v = validatePointerPayload(raw);
    if (!v.ok) { this.stats.rejected++; return v; }
    const p = v.value;
    if (!this.enteredSession) { this.stats.dropped++; return { ok: false, error: 'not_entered' }; }
    const active = this.deps.getActive();
    if (!active || active.sessionId !== p.sessionId || p.sessionId !== this.enteredSession) {
      await this.exit('session_mismatch');
      this.stats.rejected++;
      return { ok: false, error: 'session_mismatch' };
    }
    const now = this.deps.now();
    if (p.action === 'move' && now - this.lastMoveAt < (this.deps.moveMinIntervalMs ?? 8)) {
      this.stats.dropped++;
      return { ok: true, sent: 0, dropped: 'rate_limited' };
    }
    const mapped = mapNormalizedToInjection({ u: p.u, v: p.v }, active.source, this.deps.getVirtualDesktop());
    if (!mapped) { this.stats.rejected++; return { ok: false, error: 'out_of_desktop' }; }
    const { ax, ay } = mapped.abs;
    let events: InjectEvent[];
    switch (p.action) {
      case 'move': events = [{ kind: 'move', ax, ay }]; this.lastMoveAt = now; break;
      case 'down': events = [{ kind: 'down', ax, ay, button: p.button! }]; this.held.add(p.button!); break;
      case 'up': events = [{ kind: 'up', ax, ay, button: p.button! }]; this.held.delete(p.button!); break;
      case 'click': events = [{ kind: 'down', ax, ay, button: p.button! }, { kind: 'up', ax, ay, button: p.button! }]; break;
      default: events = [{ kind: 'wheel', ax, ay, vertical: p.wheel!.vertical, horizontal: p.wheel!.horizontal }];
    }
    this.lastAbs = { ax, ay };
    const r = await this.deps.injector.send(events);
    if (!r.ok) return { ok: false, error: r.error ?? 'inject_failed' };
    this.stats.accepted++;
    return { ok: true, sent: r.sent };
  }
}