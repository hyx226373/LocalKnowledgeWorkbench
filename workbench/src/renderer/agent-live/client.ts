import type { AddResult, AgentMaterial, MaterialRef } from '../../shared/agentLive/types';

/** 冻结的 add() 只返回 added | duplicate。带上 tier 时 UI 不用再查一次清单。 */
export interface AgentLiveAddDetail {
  result: AddResult;
  tier: 'session' | 'pinned';
  materialId: string;
}

export type AgentLiveAddReturn = AddResult | AgentLiveAddDetail;

export interface AgentLiveClient {
  list(workspaceId: string): Promise<AgentMaterial[]>;
  /** 先完成引用登记再返回。哈希、正文、token 不在这条路径上算。 */
  add(workspaceId: string, ref: MaterialRef, opts?: { purpose?: string; index?: number }): Promise<AgentLiveAddReturn>;
  /** 一次批量登记，由组 4 合并成一个版本。没有实现时 UI 逐项 add。 */
  addMany?(workspaceId: string, refs: MaterialRef[]): Promise<AgentLiveAddReturn[]>;
  remove(workspaceId: string, materialId: string): Promise<void>;
  reorder(workspaceId: string, order: string[]): Promise<void>;
  setPurpose(workspaceId: string, materialId: string, purpose: string | null): Promise<void>;
  pin(workspaceId: string, materialId: string): Promise<void>;
  unpin(workspaceId: string, materialId: string): Promise<void>;
  /** 只解除本轮引用，返回被清掉的 materialId。 */
  clearSession(workspaceId: string): Promise<string[]>;
  /** 同一个 materialId 改指向新路径，不复制文件内容。 */
  relocate(workspaceId: string, materialId: string, ref: MaterialRef): Promise<void>;
  subscribe?(workspaceId: string, cb: () => void): () => void;
}

export function isAddDetail(value: AgentLiveAddReturn): value is AgentLiveAddDetail {
  return typeof value === 'object' && value !== null && (value.result === 'added' || value.result === 'duplicate');
}
