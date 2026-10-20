/**
 * 托管应用记忆（待排需求第8条 / 外贴31衔接）
 * 对齐窗口托管冻结面：只落盘 NativeAppHostPersist；恢复待激活+须 reselect；禁 hwnd/pid/凭据。
 * 挂点：工作区条目 state.data（与 chrome「只看内容」快照同属工作区持久化）。
 */
import {
  NATIVE_APP_HOST_VIEW_TYPE,
  type NativeAppHostPersist,
  type NativeAppHostViewType,
} from './types';
import { normalizePath, sanitizePersist, toPersistPayload } from './identity';

export type HostedAppActivation = 'pending' | 'active';
export type HostedAppInteraction = 'idle' | 'operating';

/** Runtime view state — session fields are NEVER written to workspace. */
export interface HostedAppMemoryState {
  viewType: NativeAppHostViewType;
  persist: NativeAppHostPersist | null;
  /** Session-only */
  activation: HostedAppActivation;
  /** Session-only */
  interaction: HostedAppInteraction;
  /** Session-only */
  bindingId: string | null;
  hostPath: string;
  titleHint: string;
  /** After workspace restore: user must proposeAttach again. */
  needsReselect: boolean;
}

export function emptyHostedAppMemoryState(): HostedAppMemoryState {
  return {
    viewType: NATIVE_APP_HOST_VIEW_TYPE,
    persist: null,
    activation: 'pending',
    interaction: 'idle',
    bindingId: null,
    hostPath: '',
    titleHint: '',
    needsReselect: false,
  };
}

/**
 * Serialize for workspace item state.data.
 * Omits activation / interaction / bindingId / hwnd / pid.
 */
export function saveHostedAppMemory(
  state: HostedAppMemoryState | undefined | null,
): NativeAppHostPersist | { viewType: NativeAppHostViewType } {
  if (!state) {
    return { viewType: NATIVE_APP_HOST_VIEW_TYPE };
  }
  if (state.persist) {
    return toPersistPayload({
      hostPath: normalizePath(state.persist.hostPath),
      titleHint: state.persist.titleHint,
      layout: state.persist.layout,
      attachPolicy: 'reselect-on-restore',
    });
  }
  if (state.hostPath) {
    return toPersistPayload({
      hostPath: normalizePath(state.hostPath),
      titleHint: state.titleHint,
      attachPolicy: 'reselect-on-restore',
    });
  }
  return { viewType: NATIVE_APP_HOST_VIEW_TYPE };
}

/**
 * Restore from workspace: always pending + needsReselect; never auto-attach / activate.
 * Corrupt / forbidden fields → empty pending shell (keep content panels elsewhere).
 */
export function loadHostedAppMemory(raw: unknown): HostedAppMemoryState {
  if (!raw || typeof raw !== 'object') {
    return { ...emptyHostedAppMemoryState(), activation: 'pending' };
  }
  const o = raw as Record<string, unknown>;
  try {
    if (typeof o.hostPath === 'string' && o.hostPath) {
      const persist = sanitizePersist({
        viewType: NATIVE_APP_HOST_VIEW_TYPE,
        hostPath: normalizePath(o.hostPath),
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
  } catch {
    // snapshot damage: fall through to base UI shell
  }
  return {
    ...emptyHostedAppMemoryState(),
    viewType: NATIVE_APP_HOST_VIEW_TYPE,
    activation: 'pending',
  };
}

/** True when panel awaits user activation (03 待激活). */
export function isHostedAppPendingActivation(state: HostedAppMemoryState): boolean {
  return state.activation === 'pending';
}

/**
 * After user confirms proposeAttach + host.attach and enters interaction.
 * Does not touch persist payload.
 */
export function markHostedAppActive(
  state: HostedAppMemoryState,
  bindingId: string,
): HostedAppMemoryState {
  return {
    ...state,
    bindingId,
    activation: 'active',
    interaction: 'operating',
    needsReselect: false,
  };
}

/** Update persistable fields from a live panel (still no hwnd). */
export function rememberHostedApp(
  state: HostedAppMemoryState,
  input: {
    hostPath: string;
    titleHint?: string;
    layout?: { x: number; y: number; w: number; h: number };
  },
): HostedAppMemoryState {
  const persist = toPersistPayload({
    hostPath: normalizePath(input.hostPath),
    titleHint: input.titleHint ?? state.titleHint,
    layout: input.layout ?? state.persist?.layout,
    attachPolicy: 'reselect-on-restore',
  });
  return {
    ...state,
    persist,
    hostPath: persist.hostPath,
    titleHint: persist.titleHint,
  };
}