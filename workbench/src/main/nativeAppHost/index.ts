export { NativeHostService, filterNotepadPpCandidates } from './nativeHostService';
export type { NativeHostServiceOptions, ParentHwndResolver } from './nativeHostService';
export {
  nativeHostMethodTable,
  listNativeHostIpcMethods,
  registerNativeHostIpc,
  NATIVE_HOST_IPC,
  NATIVE_HOST_IPC_METHODS,
} from './registerIpc';
export type { NativeHostMethodTable } from './registerIpc';
export {
  reduceBinding,
  canOperate,
  canReattach,
  isZombieRisk,
} from './bindingState';
export type { BindingRecord, BindingEvent } from './bindingState';
export {
  createWin32Helper,
  StubWin32Helper,
  FakeWin32Helper,
  NativeHelperError,
} from './win32Helper';
export type { Win32NativeHelper, EmbedParent } from './win32Helper';

export {
  nativeHandleBufferToHwnd,
  hwndFromBrowserWindow,
  createResolveParentHwnd,
} from './resolveParentHwnd';
export type { BrowserWindowLike } from './resolveParentHwnd';
