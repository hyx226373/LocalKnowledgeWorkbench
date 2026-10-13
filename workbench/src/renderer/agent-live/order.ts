import type { AgentMaterial } from '../../shared/agentLive/types';
import { tierOf } from './format';

export function byOrder(a: AgentMaterial, b: AgentMaterial): number {
  return a.order - b.order || a.addedAt.localeCompare(b.addedAt) || a.materialId.localeCompare(b.materialId);
}

export function splitTiers(materials: readonly AgentMaterial[]): { session: AgentMaterial[]; pinned: AgentMaterial[] } {
  const session: AgentMaterial[] = [];
  const pinned: AgentMaterial[] = [];
  for (const material of materials) {
    if (tierOf(material) === 'pinned') pinned.push(material);
    else session.push(material);
  }
  session.sort(byOrder);
  pinned.sort(byOrder);
  return { session, pinned };
}

/**
 * 只重排同一区。该区沿用自己原来的 order 数字，另一区不动。
 * 返回值是 0.3 material.reordered 要的完整 materialId 顺序。
 */
export function reorderWithinTier(
  materials: readonly AgentMaterial[],
  tier: 'session' | 'pinned',
  draggedId: string,
  beforeId: string | null,
): string[] {
  const items = materials.map((material) => ({ ...material }));
  const group = items.filter((material) => tierOf(material) === tier).sort(byOrder);
  const from = group.findIndex((material) => material.materialId === draggedId);
  if (from < 0) return items.slice().sort(byOrder).map((material) => material.materialId);
  const [moved] = group.splice(from, 1);
  if (!moved) return items.slice().sort(byOrder).map((material) => material.materialId);
  let to = group.length;
  if (beforeId) {
    const index = group.findIndex((material) => material.materialId === beforeId);
    if (index >= 0) to = index;
  }
  group.splice(to, 0, moved);
  const slots = items
    .filter((material) => tierOf(material) === tier)
    .map((material) => material.order)
    .sort((a, b) => a - b);
  group.forEach((material, index) => {
    material.order = slots[index] ?? index;
  });
  return items.slice().sort(byOrder).map((material) => material.materialId);
}
