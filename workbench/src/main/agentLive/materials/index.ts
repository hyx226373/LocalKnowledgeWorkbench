export { MATERIAL_LIMIT, LOOSE_WATCH_LIMIT, MaterialStoreError } from './errors';
export { estimateTokens, countPdfPages, pathKey, displayPath } from './identity';
export { createFilePinnedStore, createMemoryPinnedStore, type WorkspaceRecordStore } from './persist';
export {
  createAgentMaterialsStore,
  onMaterialsChange,
  statPath,
  type AgentMaterialsApi,
  type CreateMaterialsOptions,
  type MaterialIdentitySource,
  type MaterialsChange,
  type SessionClearedEvent,
  type StatResult,
} from './store';
