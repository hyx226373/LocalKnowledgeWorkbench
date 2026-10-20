/**
 * host-r1 Helper IPC product op table — 1:1 with 01-共用接口.md §3.
 * Method strings are used on the existing `kb` invoke channel
 * (ipcMain.handle('kb', method, ...args)).
 */

export const NATIVE_HOST_IPC = {
  list: 'host.list',
  attach: 'host.attach',
  detach: 'host.detach',
  setBounds: 'host.setBounds',
  setVisible: 'host.setVisible',
  activate: 'host.activate',
  getState: 'host.getState',
  screenToPanel: 'host.screenToPanel',
  panelToScreen: 'host.panelToScreen',
} as const;

export type NativeHostIpcMethod = (typeof NATIVE_HOST_IPC)[keyof typeof NATIVE_HOST_IPC];

/** Ordered product ops for coverage tests / docs. */
export const NATIVE_HOST_IPC_METHODS: readonly NativeHostIpcMethod[] = [
  NATIVE_HOST_IPC.list,
  NATIVE_HOST_IPC.attach,
  NATIVE_HOST_IPC.detach,
  NATIVE_HOST_IPC.setBounds,
  NATIVE_HOST_IPC.setVisible,
  NATIVE_HOST_IPC.activate,
  NATIVE_HOST_IPC.getState,
  NATIVE_HOST_IPC.screenToPanel,
  NATIVE_HOST_IPC.panelToScreen,
];

/** Agent ActionId draft (01 §6) — plugin group wires these; listed for contract. */
export const NATIVE_HOST_ACTION_IDS = {
  createHostPanel: 'createHostPanel',
  listHosts: 'listHosts',
  proposeAttach: 'proposeAttach',
  layoutAdjust: 'layoutAdjust',
  proposeDetach: 'proposeDetach',
} as const;
