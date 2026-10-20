/**
 * desk-input (c): "enter" state machine (pure).
 * idle --enter (input toggle on + picture live)--> entered
 * entered --leave | exitKey | disable | stop | blur | sessionChanged--> idle
 * Pointer events are forwarded only while entered; never auto-inject.
 */
export type EnterState = 'idle' | 'entered';
export type EnterEvent =
  | { type: 'enter'; enabled: boolean; live: boolean }
  | { type: 'leave' }
  | { type: 'exitKey' }
  | { type: 'disable' }
  | { type: 'stop' }
  | { type: 'blur' }
  | { type: 'sessionChanged' };

export interface EnterTransition { state: EnterState; changed: boolean; reason: string }

export function nextEnterState(cur: EnterState, ev: EnterEvent): EnterTransition {
  if (ev.type === 'enter') {
    if (cur === 'entered') return { state: cur, changed: false, reason: 'already-entered' };
    if (!ev.enabled) return { state: 'idle', changed: false, reason: 'input-disabled' };
    if (!ev.live) return { state: 'idle', changed: false, reason: 'not-live' };
    return { state: 'entered', changed: true, reason: 'pointer-enter' };
  }
  if (cur === 'idle') return { state: 'idle', changed: false, reason: `idle-${ev.type}` };
  return { state: 'idle', changed: true, reason: ev.type };
}

/**
 * Exit key. Escape conflicts (content-only mode global Escape in useChromeLayout, native-app-host Escape,
 * dialogs), so the exit key is Ctrl+Alt+Q (unused in src and default keybindings at base 729f913).
 */
export const DESK_INPUT_EXIT_KEY = 'Ctrl+Alt+Q' as const;

export function isExitKey(e: { key: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): boolean {
  return e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && (e.key === 'q' || e.key === 'Q');
}
/**
 * Same-screen guard: if the panel window sits on the captured screen, injected absolute moves would pull
 * the real cursor out of the panel -> immediate leave/exit. So enter mode is auto-disabled in that case.
 * Rule: the screen holding the window center (DIP) == capture source bounds (DIP). Fallback: overlap >= 50% of the window.
 */
export interface DipRect { x: number; y: number; width: number; height: number }
export function isPanelOnSourceScreen(win: DipRect | null | undefined, source: DipRect | null | undefined): boolean {
  if (!win || !source) return false;
  const ok = (r: DipRect) => [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0;
  if (!ok(win) || !ok(source)) return false;
  const cx = win.x + win.width / 2;
  const cy = win.y + win.height / 2;
  if (cx >= source.x && cx < source.x + source.width && cy >= source.y && cy < source.y + source.height) return true;
  const ix = Math.max(0, Math.min(win.x + win.width, source.x + source.width) - Math.max(win.x, source.x));
  const iy = Math.max(0, Math.min(win.y + win.height, source.y + source.height) - Math.max(win.y, source.y));
  return ix * iy >= 0.5 * win.width * win.height;
}
export const SAME_SCREEN_HINT = '\u76ee\u6807\u5c4f\u5c31\u662f\u9762\u677f\u6240\u5728\u5c4f\uff0c\u5df2\u81ea\u52a8\u7981\u7528\u8fdb\u5165\u6a21\u5f0f\uff08\u8bf7\u628a\u9762\u677f\u62d6\u5230\u53e6\u4e00\u5757\u5c4f\u6216\u9009\u62e9\u5176\u4ed6\u5c4f\u5e55\u6e90\uff09';