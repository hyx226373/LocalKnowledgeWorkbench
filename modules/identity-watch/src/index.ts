export { migrate, createRoot, setMount, machineId, getResource, listResources } from './db.ts';
export type { CreateRootInput } from './db.ts';
export { PathEscapeError, ReconcileCancelledError } from './errors.ts';
export { ensureResource } from './ensure.ts';
export { detectFileSystem } from './fsinfo.ts';
export { updateLocation } from './location.ts';
export { exportPortable, importPortable } from './portable.ts';
export { reconcile } from './reconcile.ts';
export { remapRoot } from './remap.ts';
export { resolveInsideRoot } from './resolve.ts';
export { watchRoot } from './watch.ts';
export type { WatchOptions } from './watch.ts';
export type {
  FsCapabilities,
  PortableBundle,
  PortableResource,
  ReconcileOptions,
  ReconcileProgress,
  ReconcileResult,
  ResolvedInside,
  ResourceChange,
  ResourceKind,
  ResourceLocation,
  ResourceSnapshot,
  WatchHandle,
} from './types.ts';
