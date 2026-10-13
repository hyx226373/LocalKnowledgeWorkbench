import type { AgentMaterial, MaterialRef } from '../../shared/agentLive/types';
import type { AgentLiveAddReturn, AgentLiveClient } from './client';
import { tierOf } from './format';
import { MaterialLimitError, MAX_MATERIALS } from './limits';
import { byOrder } from './order';
import { baseName, pathKey } from './paths';

interface Bucket {
  items: AgentMaterial[];
  listeners: Set<() => void>;
}

function match(items: readonly AgentMaterial[], ref: MaterialRef): AgentMaterial | undefined {
  if (ref.resourceId) return items.find((item) => item.resourceId === ref.resourceId);
  if (!ref.absPath) return undefined;
  const key = pathKey(ref.absPath);
  return items.find((item) => !item.resourceId && pathKey(item.absPath) === key);
}

/**
 * 预览和单测用的清单。只存引用，不读文件、不写副本。
 * 行为对齐 0.10：跨区去重、固定保持固定、清空本轮不动固定资料和原文件。
 */
export function createMemoryAgentLive(initial?: Record<string, AgentMaterial[]>): AgentLiveClient & {
  snapshot(workspaceId: string): AgentMaterial[];
} {
  const buckets = new Map<string, Bucket>();
  let seq = 1;

  const bucket = (workspaceId: string): Bucket => {
    let found = buckets.get(workspaceId);
    if (!found) {
      found = { items: (initial?.[workspaceId] ?? []).map((item) => ({ ...item })), listeners: new Set() };
      buckets.set(workspaceId, found);
    }
    return found;
  };
  const emit = (workspaceId: string) => {
    for (const listener of bucket(workspaceId).listeners) listener();
  };
  const detail = (item: AgentMaterial, result: 'added' | 'duplicate'): AgentLiveAddReturn => ({
    result,
    tier: tierOf(item),
    materialId: item.materialId,
  });

  const addOne = (workspaceId: string, ref: MaterialRef, opts?: { purpose?: string; index?: number }): AgentLiveAddReturn => {
    const box = bucket(workspaceId);
    const existing = match(box.items, ref);
    if (existing) {
      if (opts?.purpose !== undefined) existing.purpose = opts.purpose;
      return detail(existing, 'duplicate');
    }
    if (box.items.length >= MAX_MATERIALS) throw new MaterialLimitError();
    const session = box.items.filter((item) => tierOf(item) === 'session').sort(byOrder);
    const order = session.length ? Math.max(...session.map((item) => item.order)) + 1 : 1;
    const item: AgentMaterial = {
      materialId: `m-${seq++}`,
      resourceId: ref.resourceId ?? null,
      sourceId: ref.sourceId ?? null,
      relPath: ref.relPath || baseName(ref.absPath),
      absPath: ref.absPath,
      name: ref.name || baseName(ref.absPath),
      purpose: opts?.purpose ?? null,
      order,
      status: 'ok',
      contentHash: null,
      contentVersion: 0,
      readable: null,
      addedAt: new Date().toISOString(),
      tier: 'session',
      bytes: null,
      estTokens: null,
      hasText: false,
      pages: null,
    };
    if (opts?.index != null && opts.index >= 0 && opts.index < session.length) {
      const target = session[opts.index];
      if (target) item.order = target.order - 0.5;
    }
    box.items.push(item);
    return detail(item, 'added');
  };

  return {
    snapshot(workspaceId: string) {
      return bucket(workspaceId).items.map((item) => ({ ...item }));
    },
    async list(workspaceId: string) {
      return bucket(workspaceId).items.map((item) => ({ ...item })).sort(byOrder);
    },
    async add(workspaceId, ref, opts) {
      const result = addOne(workspaceId, ref, opts);
      emit(workspaceId);
      return result;
    },
    async addMany(workspaceId, refs) {
      const results = refs.map((ref) => addOne(workspaceId, ref));
      emit(workspaceId);
      return results;
    },
    async remove(workspaceId, materialId) {
      const box = bucket(workspaceId);
      box.items = box.items.filter((item) => item.materialId !== materialId);
      emit(workspaceId);
    },
    async reorder(workspaceId, order) {
      const box = bucket(workspaceId);
      const rank = new Map(order.map((id, index) => [id, index]));
      for (const item of box.items) {
        const next = rank.get(item.materialId);
        if (next != null) item.order = next + 1;
      }
      emit(workspaceId);
    },
    async setPurpose(workspaceId, materialId, purpose) {
      const item = bucket(workspaceId).items.find((row) => row.materialId === materialId);
      if (item) item.purpose = purpose;
      emit(workspaceId);
    },
    async pin(workspaceId, materialId) {
      const item = bucket(workspaceId).items.find((row) => row.materialId === materialId);
      if (!item) return;
      item.tier = 'pinned';
      emit(workspaceId);
    },
    async unpin(workspaceId, materialId) {
      const item = bucket(workspaceId).items.find((row) => row.materialId === materialId);
      if (!item) return;
      item.tier = 'session';
      emit(workspaceId);
    },
    async clearSession(workspaceId) {
      const box = bucket(workspaceId);
      const cleared = box.items.filter((item) => tierOf(item) === 'session').map((item) => item.materialId);
      box.items = box.items.filter((item) => tierOf(item) === 'pinned');
      emit(workspaceId);
      return cleared;
    },
    async relocate(workspaceId, materialId, ref) {
      const item = bucket(workspaceId).items.find((row) => row.materialId === materialId);
      if (!item) return;
      item.absPath = ref.absPath;
      item.relPath = ref.relPath || ref.absPath;
      item.name = ref.name || item.name;
      item.resourceId = ref.resourceId ?? null;
      item.sourceId = ref.sourceId ?? null;
      item.status = 'ok';
      item.contentHash = null;
      item.bytes = null;
      item.estTokens = null;
      item.readable = null;
      emit(workspaceId);
    },
    subscribe(workspaceId, cb) {
      const box = bucket(workspaceId);
      box.listeners.add(cb);
      return () => box.listeners.delete(cb);
    },
  };
}
