import type { AgentMaterial, MaterialRef } from '../../shared/agentLive/types';
import type { AgentLiveAddReturn, AgentLiveClient } from './client';

/** 预加载尚未接线时缺这些方法。集成组按这个名字挂到 window.kb。 */
export interface AgentLiveIpc {
  agentLiveList?(workspaceId: string): Promise<AgentMaterial[]>;
  agentLiveAdd?(workspaceId: string, ref: MaterialRef, opts?: { purpose?: string; index?: number }): Promise<AgentLiveAddReturn>;
  agentLiveAddMany?(workspaceId: string, refs: MaterialRef[]): Promise<AgentLiveAddReturn[]>;
  agentLiveRemove?(workspaceId: string, materialId: string): Promise<void>;
  agentLiveReorder?(workspaceId: string, order: string[]): Promise<void>;
  agentLiveSetPurpose?(workspaceId: string, materialId: string, purpose: string | null): Promise<void>;
  agentLivePin?(workspaceId: string, materialId: string): Promise<void>;
  agentLiveUnpin?(workspaceId: string, materialId: string): Promise<void>;
  agentLiveClearSession?(workspaceId: string): Promise<string[]>;
  agentLiveRelocate?(workspaceId: string, materialId: string, ref: MaterialRef): Promise<void>;
  onAgentLiveChanged?(cb: (workspaceId: string) => void): () => void;
}

function missing(name: string): never {
  throw new Error(`agent live IPC 尚未接线: ${name}`);
}

export function createIpcAgentLiveClient(ipc: AgentLiveIpc): AgentLiveClient {
  return {
    list: (workspaceId) => ipc.agentLiveList?.(workspaceId) ?? missing('agentLiveList'),
    add: (workspaceId, ref, opts) => ipc.agentLiveAdd?.(workspaceId, ref, opts) ?? missing('agentLiveAdd'),
    addMany: ipc.agentLiveAddMany ? (workspaceId, refs) => ipc.agentLiveAddMany!(workspaceId, refs) : undefined,
    remove: (workspaceId, materialId) => ipc.agentLiveRemove?.(workspaceId, materialId) ?? missing('agentLiveRemove'),
    reorder: (workspaceId, order) => ipc.agentLiveReorder?.(workspaceId, order) ?? missing('agentLiveReorder'),
    setPurpose: (workspaceId, materialId, purpose) => ipc.agentLiveSetPurpose?.(workspaceId, materialId, purpose) ?? missing('agentLiveSetPurpose'),
    pin: (workspaceId, materialId) => ipc.agentLivePin?.(workspaceId, materialId) ?? missing('agentLivePin'),
    unpin: (workspaceId, materialId) => ipc.agentLiveUnpin?.(workspaceId, materialId) ?? missing('agentLiveUnpin'),
    clearSession: (workspaceId) => ipc.agentLiveClearSession?.(workspaceId) ?? missing('agentLiveClearSession'),
    relocate: (workspaceId, materialId, ref) => ipc.agentLiveRelocate?.(workspaceId, materialId, ref) ?? missing('agentLiveRelocate'),
    subscribe: ipc.onAgentLiveChanged
      ? (workspaceId, cb) => {
          const dispose = ipc.onAgentLiveChanged!((id) => {
            if (id === workspaceId) cb();
          });
          return dispose;
        }
      : undefined,
  };
}
