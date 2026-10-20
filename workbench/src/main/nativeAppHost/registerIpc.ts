/**
 * Registers host.* product methods on the shared `kb` IPC table.
 * Integrator merges `nativeHostMethodTable(service)` into the main `api` object
 * (see integration-patches). This module can also self-register via registerNativeHostIpc
 * when a dedicated bootstrap is preferred.
 */
import type { IpcMain } from 'electron';
import { NATIVE_HOST_IPC, NATIVE_HOST_IPC_METHODS } from '../../shared/nativeAppHost/protocol';
import type { NativeHostService } from './nativeHostService';

export type NativeHostMethodTable = Record<string, (...args: unknown[]) => unknown>;

/** Build method table keyed by frozen product op names (host.list, …). */
export function nativeHostMethodTable(service: NativeHostService): NativeHostMethodTable {
  return {
    [NATIVE_HOST_IPC.list]: () => service.list(),
    [NATIVE_HOST_IPC.attach]: (req: unknown) => service.attach(req as Parameters<NativeHostService['attach']>[0]),
    [NATIVE_HOST_IPC.detach]: (req: unknown) => service.detach(req as Parameters<NativeHostService['detach']>[0]),
    [NATIVE_HOST_IPC.setBounds]: (req: unknown) => service.setBounds(req as Parameters<NativeHostService['setBounds']>[0]),
    [NATIVE_HOST_IPC.setVisible]: (req: unknown) => service.setVisible(req as Parameters<NativeHostService['setVisible']>[0]),
    [NATIVE_HOST_IPC.activate]: (req: unknown) => service.activate(req as Parameters<NativeHostService['activate']>[0]),
    [NATIVE_HOST_IPC.getState]: (req?: unknown) => service.getState((req ?? {}) as Parameters<NativeHostService['getState']>[0]),
    [NATIVE_HOST_IPC.screenToPanel]: (req: unknown) => service.screenToPanel(req as Parameters<NativeHostService['screenToPanel']>[0]),
    [NATIVE_HOST_IPC.panelToScreen]: (req: unknown) => service.panelToScreen(req as Parameters<NativeHostService['panelToScreen']>[0]),
  };
}

export function listNativeHostIpcMethods(): readonly string[] {
  return NATIVE_HOST_IPC_METHODS;
}

/**
 * Optional standalone registration (if integ chooses not to merge into `api`).
 * Still uses channel `kb` semantics by exposing a second handle is discouraged;
 * prefer merging into existing api table via patch.
 */
export function registerNativeHostIpc(ipcMain: IpcMain, service: NativeHostService): void {
  const table = nativeHostMethodTable(service);
  // Document-only path: callers should merge `table` into main api.
  // Providing a namespaced channel would fork the project IPC style — avoided.
  void ipcMain;
  void table;
}

export { NATIVE_HOST_IPC, NATIVE_HOST_IPC_METHODS };
