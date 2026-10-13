/**
 * 从已保存的工作区读状态导出的前四键。不创建工作区，不写数据库。
 * unsaved 留空：未保存草稿在渲染进程，主进程没有这份内存。
 */
import { panelItemId, type SerializedDock, type SerializedPanel } from '../../shared/items';
import type { StateSnapshot } from '../../shared/actions/types';

const CURRENT_WS_KEY = 'workspace.current';

export interface WorkspaceStateSource {
  getLayout(key: string): unknown;
  getWorkspace(id: string): {
    id: string;
    name: string;
    items: { itemId: string; sourceKind: string; ref: string; adapterId: string; title?: string }[];
    layout: unknown;
  };
}

function fileResourceId(sourceKind: string, ref: string): string | null {
  if (sourceKind !== 'file') return null;
  if (!ref || ref.includes('/') || ref.includes('\\') || /^[a-zA-Z]:/.test(ref)) return null;
  return ref;
}

export function readSavedWorkbenchState(src: WorkspaceStateSource): StateSnapshot {
  const empty: StateSnapshot = { workspace: null, resources: [], panels: [], unsaved: [] };
  const cur = src.getLayout(CURRENT_WS_KEY);
  if (typeof cur !== 'string' || !cur) return empty;
  let ws: ReturnType<WorkspaceStateSource['getWorkspace']>;
  try {
    ws = src.getWorkspace(cur);
  } catch {
    return empty;
  }
  const resources: StateSnapshot['resources'] = [];
  const seen = new Set<string>();
  const byItem = new Map(ws.items.map((item) => [item.itemId, item]));
  for (const item of ws.items) {
    const resourceId = fileResourceId(item.sourceKind, item.ref);
    if (!resourceId || seen.has(resourceId)) continue;
    seen.add(resourceId);
    resources.push({
      resourceId,
      title: item.title?.trim() || resourceId,
      sourceKind: item.sourceKind,
    });
  }
  const dock = (ws.layout as { dock?: SerializedDock | null } | null)?.dock;
  const panels: StateSnapshot['panels'] = [];
  const table = dock?.panels ?? {};
  for (const [id, panel] of Object.entries(table) as [string, SerializedPanel][]) {
    const itemId = panelItemId(id, panel);
    const item = byItem.get(itemId);
    const row: StateSnapshot['panels'][number] = { itemId };
    const resourceId = item ? fileResourceId(item.sourceKind, item.ref) : null;
    if (resourceId) row.resourceId = resourceId;
    if (item?.adapterId) row.adapterId = item.adapterId;
    panels.push(row);
  }
  return {
    workspace: { workspaceId: ws.id, title: ws.name },
    resources,
    panels,
    unsaved: [],
  };
}
