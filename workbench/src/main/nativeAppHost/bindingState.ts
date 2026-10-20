/**
 * Binding state machine: idle → attached ⇄ hidden-for-modal → invalid → idle
 * Force-kill of target process → invalid (no crash, no zombie bind); re-attach allowed.
 */
import type { NativeHostBindingState, NativeHostIdentity, NativeHostRect } from '../../shared/nativeAppHost/types';

export interface BindingRecord {
  bindingId: string;
  panelId: string;
  state: NativeHostBindingState;
  identity: NativeHostIdentity;
  bounds: NativeHostRect | null;
  /** Last requested visibility (before modal hide). */
  desiredVisible: boolean;
  /** Parent HWND we reparented into (Electron content HWND), if any. */
  hostParentHwnd: string | null;
  /** Original parent before attach (for detach restore). */
  originalParentHwnd: string | null;
  reason?: string;
}

export type BindingEvent =
  | { type: 'attach'; bindingId: string; panelId: string; identity: NativeHostIdentity; bounds?: NativeHostRect }
  | { type: 'detach' }
  | { type: 'markInvalid'; reason: string }
  | { type: 'hideForModal' }
  | { type: 'restoreAfterModal' }
  | { type: 'setVisible'; visible: boolean }
  | { type: 'setBounds'; bounds: NativeHostRect };

export function createIdleBinding(): null {
  return null;
}

export function reduceBinding(current: BindingRecord | null, event: BindingEvent): BindingRecord | null {
  switch (event.type) {
    case 'attach': {
      return {
        bindingId: event.bindingId,
        panelId: event.panelId,
        state: 'attached',
        identity: event.identity,
        bounds: event.bounds ?? null,
        desiredVisible: true,
        hostParentHwnd: null,
        originalParentHwnd: null,
      };
    }
    case 'detach':
      return null;
    case 'markInvalid': {
      if (!current) return null;
      return {
        ...current,
        state: 'invalid',
        reason: event.reason,
      };
    }
    case 'hideForModal': {
      if (!current) return null;
      if (current.state === 'invalid') return current;
      return {
        ...current,
        state: 'hidden-for-modal',
      };
    }
    case 'restoreAfterModal': {
      if (!current) return null;
      if (current.state === 'invalid') return current;
      if (current.state !== 'hidden-for-modal') return current;
      return {
        ...current,
        state: current.desiredVisible ? 'attached' : 'attached',
      };
    }
    case 'setVisible': {
      if (!current) return null;
      if (current.state === 'invalid') return current;
      return {
        ...current,
        desiredVisible: event.visible,
        // Explicit hide while attached stays attached but caller applies ShowWindow;
        // modal path uses hideForModal instead.
        state: current.state === 'hidden-for-modal' && event.visible ? 'attached' : current.state,
      };
    }
    case 'setBounds': {
      if (!current) return null;
      return { ...current, bounds: event.bounds };
    }
    default:
      return current;
  }
}

/** Whether the binding can accept OS ops (bounds/visible/activate). */
export function canOperate(rec: BindingRecord | null): rec is BindingRecord {
  return !!rec && (rec.state === 'attached' || rec.state === 'hidden-for-modal');
}

/** Whether UI should offer re-attach (invalid or idle). */
export function canReattach(rec: BindingRecord | null): boolean {
  return !rec || rec.state === 'invalid' || rec.state === 'idle';
}

export function isZombieRisk(rec: BindingRecord | null, alive: boolean): boolean {
  return !!rec && rec.state !== 'invalid' && rec.state !== 'idle' && !alive;
}
