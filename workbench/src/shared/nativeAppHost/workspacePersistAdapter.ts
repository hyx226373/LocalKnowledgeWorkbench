/**
 * 工作区挂接：把托管应用记忆读写接到既有 panel / WorkspaceItem.state.data。
 * 不另开 bounds 双路径；布局宿主仍调 host.setBounds/setVisible/activate。
 */
import { NATIVE_APP_HOST_VIEW_TYPE } from './types';
import {
  loadHostedAppMemory,
  saveHostedAppMemory,
  type HostedAppMemoryState,
} from './memory';

export const HOSTED_APP_MEMORY_STATE_SCHEMA = 1 as const;

export function isNativeAppHostAdapterId(adapterId: string | undefined | null): boolean {
  return adapterId === NATIVE_APP_HOST_VIEW_TYPE;
}

/** Adapter-facing: serialize into ItemState.data for workspace save. */
export function serializeHostedAppItemState(state: HostedAppMemoryState | undefined): {
  schemaVersion: typeof HOSTED_APP_MEMORY_STATE_SCHEMA;
  data: ReturnType<typeof saveHostedAppMemory>;
} {
  return {
    schemaVersion: HOSTED_APP_MEMORY_STATE_SCHEMA,
    data: saveHostedAppMemory(state),
  };
}

/** Adapter-facing: restoreState(raw) for layoutModel.restoreItemState. */
export function restoreHostedAppItemState(raw: unknown): HostedAppMemoryState {
  if (raw && typeof raw === 'object' && 'data' in (raw as object)) {
    const wrap = raw as { data?: unknown; schemaVersion?: number };
    return loadHostedAppMemory(wrap.data);
  }
  return loadHostedAppMemory(raw);
}

/** migrateState hook — currently identity (schema 1). */
export function migrateHostedAppItemState(data: unknown, _fromVersion: number): unknown {
  return data;
}

/**
 * Minimal adapter surface for plugin-host registration (skeleton).
 * Real native-app-host plugin should reuse these three methods.
 */
export const hostedAppMemoryAdapterHooks = {
  id: NATIVE_APP_HOST_VIEW_TYPE,
  stateSchemaVersion: HOSTED_APP_MEMORY_STATE_SCHEMA,
  serializeState: serializeHostedAppItemState,
  restoreState: restoreHostedAppItemState,
  migrateState: migrateHostedAppItemState,
} as const;