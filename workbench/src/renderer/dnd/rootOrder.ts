/** 根显示顺序。只存 layout，不改 roots 表。 */

export const ROOT_ORDER_KEY = 'ui.rootOrder';

export interface RootOrder {
  v: 1;
  ids: string[];
}

export function parseRootOrder(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { ids?: unknown }).ids)) return [];
  return (raw as { ids: unknown[] }).ids.filter((x): x is string => typeof x === 'string' && x.length > 0);
}

export function orderRoots<T extends { id: string }>(roots: T[], order: string[]): T[] {
  if (order.length === 0) return roots;
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...roots].sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id)! : Number.MAX_SAFE_INTEGER;
    const rb = rank.has(b.id) ? rank.get(b.id)! : Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return 0;
  });
}

export function rootOrderValue(ids: string[]): RootOrder {
  return { v: 1, ids };
}
