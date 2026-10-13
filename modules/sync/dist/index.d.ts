import type { SyncController, SyncDeps } from './types.js';
export { ftsShortTitle, relocateResource } from './relocate.js';
export type { SyncController, SyncDeps, SyncDone, SyncHandle, SyncPhase, SyncProgress, SqliteDb, } from './types.js';
export declare function createSync(deps: SyncDeps): SyncController;
