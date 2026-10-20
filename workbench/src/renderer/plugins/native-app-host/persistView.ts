/**
 * View-level persist helpers — reuses shared toPersistPayload / sanitizePersist (no hwnd).
 * Restore strategy: reselect-on-restore + activation pending (the user 03 §3).
 * Never auto-attach; never auto-activate outbound on restore/mount.
 */
import {
  NATIVE_APP_HOST_VIEW_TYPE,
  sanitizePersist,
  toPersistPayload,
  type NativeAppHostPersist,
} from '../../../shared/nativeAppHost';
import type { ActivationState, InteractionMode } from './interaction';

export interface NativeAppHostViewState {
  /** Always the frozen literal for serialize checks (VC-L1-06). */
  viewType: typeof NATIVE_APP_HOST_VIEW_TYPE;
  persist: NativeAppHostPersist | null;
  interaction: InteractionMode;
  /**
   * Session product activation (not persisted).
   * Restore / fresh panel → pending; user enter interaction → active.
   */
  activation: ActivationState;
  bindingId: string | null;
  titleHint: string;
  hostPath: string;
  /** Pending restore: user must confirm proposeAttach again. */
  needsReselect: boolean;
}

export function emptyViewState(): NativeAppHostViewState {
  return {
    viewType: NATIVE_APP_HOST_VIEW_TYPE,
    persist: null,
    interaction: 'idle',
    activation: 'pending',
    bindingId: null,
    titleHint: '',
    hostPath: '',
    needsReselect: false,
  };
}

/** Serialize for workspace — VC-L1-06 / VC-L1-10. activation is session-only (omitted). */
export function serializeNativeAppHostState(
  state: NativeAppHostViewState | undefined,
): NativeAppHostPersist | { viewType: typeof NATIVE_APP_HOST_VIEW_TYPE } {
  if (!state) {
    return { viewType: NATIVE_APP_HOST_VIEW_TYPE };
  }
  if (state.persist) {
    return toPersistPayload({
      hostPath: state.persist.hostPath,
      titleHint: state.persist.titleHint,
      layout: state.persist.layout,
      attachPolicy: 'reselect-on-restore',
    });
  }
  if (state.hostPath) {
    return toPersistPayload({
      hostPath: state.hostPath,
      titleHint: state.titleHint,
      attachPolicy: 'reselect-on-restore',
    });
  }
  return { viewType: NATIVE_APP_HOST_VIEW_TYPE };
}

/**
 * Restore: never auto-attach; activation always pending; interaction idle.
 * User must reselect (proposeAttach) then enter interaction to become active.
 */
export function restoreNativeAppHostState(raw: unknown): NativeAppHostViewState {
  if (!raw || typeof raw !== 'object') {
    return { ...emptyViewState(), activation: 'pending' };
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.hostPath === 'string' && o.hostPath) {
    const persist = sanitizePersist({
      viewType: NATIVE_APP_HOST_VIEW_TYPE,
      hostPath: o.hostPath,
      titleHint: typeof o.titleHint === 'string' ? o.titleHint : '',
      layout: o.layout,
      attachPolicy: 'reselect-on-restore',
    });
    return {
      viewType: NATIVE_APP_HOST_VIEW_TYPE,
      persist,
      interaction: 'idle',
      activation: 'pending',
      bindingId: null,
      titleHint: persist.titleHint,
      hostPath: persist.hostPath,
      needsReselect: true,
    };
  }
  return {
    ...emptyViewState(),
    viewType: NATIVE_APP_HOST_VIEW_TYPE,
    activation: 'pending',
  };
}

/** True when panel awaits user activation (03 待激活). */
export function isPendingActivation(state: NativeAppHostViewState): boolean {
  return state.activation === 'pending';
}
