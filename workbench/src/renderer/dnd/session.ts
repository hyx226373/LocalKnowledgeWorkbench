import { dialogs } from '../ui/dialogs';
import { kb } from '../kb';
import { performDrop, removeFromFolderFlow, removeFromWorkspaceFlow, type FlowPorts, type FlowResult } from './flow';
import { setLiveHint, liveHint } from './hint';
import { askMove } from './MoveDialog';
import { onDropTarget } from './resolve';
import type { DragPayload, DropTarget, Modifiers } from './types';
import { OVERVIEW_BOARDS_KEY, parseOverviewBoards, addWorkspacesToCategory } from '../../shared/workspacePicker/overviewBoards';
import { getAgentLiveBinding, addRefs } from '../agent-live/actions';
import type { MaterialRef } from '../../shared/agentLive/types';

export type OpenPlace = 'tab' | 'left' | 'right' | 'up' | 'down' | 'float';

export interface DndHost {
  open(resourceId: string, place: OpenPlace): Promise<void>;
  openReadonly?(path: string): Promise<void>;
  workspaceId(): string | null;
  closePanels(resourceId: string): Promise<void>;
  isDirty(resourceId: string): boolean;
  reload(): void;
}

let host: DndHost | null = null;
export function setDndHost(h: DndHost | null) {
  host = h;
}
export function getDndHost() {
  return host;
}

export function makePorts(): FlowPorts {
  return {
    propose: async (title, ops) => {
      const r = (await kb.opsPropose(title, ops)) as {
        plan?: { planId: string; contentHash: string; ops: { opId: string }[] };
        planId?: string;
        contentHash?: string;
        ops?: { opId: string }[];
      };
      const plan = r.plan ?? (r.planId ? { planId: r.planId, contentHash: r.contentHash ?? '', ops: r.ops ?? [] } : null);
      if (!plan?.planId) throw new Error('没有得到移动计划');
      return plan;
    },
    approve: async (planId, opIds, hash) => {
      await kb.opsApprove(planId, opIds, hash);
    },
    getLayout: (key) => kb.getLayout(key),
    setLayout: (key, value) => kb.setLayout(key, value),
    addWorkspaceRefs: async (workspaceId, resourceIds) => {
      await kb.addWorkspaceRefs(workspaceId, resourceIds);
    },
    removeWorkspaceRef: async (workspaceId, resourceId) => {
      await kb.removeWorkspaceRef(workspaceId, resourceId);
    },
    open: async (resourceId, place) => {
      if (!host) throw new Error('拖拽宿主还没挂上');
      await host.open(resourceId, place);
    },
    confirmMove: askMove,
    confirm: (title, body, ok) => dialogs.confirm({ title, body, ok, cancel: '取消' }),
    alert: (title, body) => dialogs.alert({ title, body }),
    childNames: async (rootId, relPath) => (await kb.listDir(rootId, relPath)).map((e) => e.name),
    closePanels: (resourceId) => host?.closePanels(resourceId) ?? Promise.resolve(),
    isDirty: (resourceId) => host?.isDirty(resourceId) ?? false,
    otherWorkspaceNames: async (resourceId) => {
      const id = host?.workspaceId() ?? '';
      const all = await kb.workspacesReferencing(resourceId);
      return all.filter((w) => w.id !== id).map((w) => w.name);
    },
    dualDbCheck: async () => {
      const fn = (kb as unknown as { debugDualDbCheck?: () => Promise<unknown> }).debugDualDbCheck;
      if (!fn) return { pending: 'E 未合入 debugDualDbCheck' };
      return fn();
    },
    listMembership: (id) => kb.listVfolderMembership(id),
    setMembership: (id, folderIds) => kb.setVfolderMembership(id, folderIds),
    removeMembership: (id, folderId) => kb.removeVfolderMembership(id, folderId),
    planDrop: async (ops) => {
      if (!ops.length || !kb?.aiWritePlanDrop) return;
      const roots = await kb.listRoots().catch(() => []);
      const root = roots.find((r) => r.id === ops[0].toRootId);
      const targetRootPath = root?.path || '';
      const files = await Promise.all(
        ops.map(async (o) => {
          let sourceAbs = o.sourceAbs;
          if (!sourceAbs && o.resourceId && kb.resourceAbsPath) {
            sourceAbs = await kb.resourceAbsPath(o.resourceId).catch(() => undefined);
          }
          return {
            name: o.name,
            sourceAbs,
            resourceId: o.resourceId,
            entryKind: o.entryKind,
          };
        }),
      );
      return kb.aiWritePlanDrop({
        targetRootPath,
        targetRootId: ops[0].toRootId,
        targetRelPath: ops[0].toRelPath.includes('/') ? ops[0].toRelPath.slice(0, ops[0].toRelPath.lastIndexOf('/')) : '',
        files,
      });
    },
    addAgentRefs: async (workspaceId, refs) => {
      const binding = getAgentLiveBinding();
      if (!binding) return;
      const mRefs: MaterialRef[] = refs.map((r) => ({
        resourceId: r.resourceId,
        absPath: r.absPath ?? '',
        name: r.name,
        relPath: r.relPath,
        sourceId: r.sourceId,
      }));
      await addRefs(binding, mRefs);
    },
    reorderMaterials: async (workspaceId, ids) => {
      const key = 'workspace.refs:' + workspaceId;
      let existing: { id: string; at: number }[] = [];
      try {
        const raw = await kb.getLayout(key);
        if (Array.isArray(raw)) existing = raw;
        else if (typeof raw === 'string') existing = JSON.parse(raw);
      } catch {
        existing = [];
      }
      const map = new Map(existing.map((item) => [item.id, item]));
      const now = Date.now();
      const next = ids.map((id, index) => map.get(id) ?? { id, at: now + index });
      for (const item of existing) {
        if (!ids.includes(item.id)) next.push(item);
      }
      await kb.setLayout(key, next);
    },
    addCategory: async (categoryId, workspaceId) => {
      let rawBoards: unknown = null;
      try {
        rawBoards = await kb.getLayout(OVERVIEW_BOARDS_KEY);
      } catch {
        rawBoards = null;
      }
      const boards = parseOverviewBoards(rawBoards);
      const next = addWorkspacesToCategory(boards, categoryId, [workspaceId]);
      await kb.setLayout(OVERVIEW_BOARDS_KEY, next);
    },
    linkPaths: async (workspaceId, paths) => {
      const allRoots = await kb.listRoots().catch(() => []);
      const rids: string[] = [];
      for (const p of paths) {
        const normP = p.replace(/\\/g, '/').toLowerCase();
        for (const r of allRoots) {
          const normRoot = r.path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
          if (normP === normRoot || normP.startsWith(normRoot + '/')) {
            const rel = p.slice(r.path.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
            if (kb.consoleResolvePath) {
              const rid = await kb.consoleResolvePath(r.id, rel).catch(() => null);
              if (rid) rids.push(rid);
            }
            break;
          }
        }
      }
      if (rids.length) {
        await kb.addWorkspaceRefs(workspaceId, rids);
      }
    },
    openReadonly: async (path) => {
      if (host?.openReadonly) {
        await host.openReadonly(path);
      } else if (typeof (kb as unknown as { openPath?: (p: string) => Promise<unknown> }).openPath === 'function') {
        await (kb as unknown as { openPath: (p: string) => Promise<unknown> }).openPath(path);
      }
    },
  };
}

export async function runDrop(target: DropTarget, payload: DragPayload | null, modifiers: Modifiers = {}): Promise<FlowResult> {
  const decision = onDropTarget(target, payload, modifiers);
  setLiveHint(decision.hint);
  const shown = decision.hint;
  window.setTimeout(() => {
    if (liveHint() === shown) setLiveHint('');
  }, 2500);
  const result = await performDrop(decision, makePorts());
  if (result.status === 'done') host?.reload();
  return result;
}

export async function runRemoveFromFolder(folderId: string | null, resourceId: string, name: string) {
  const result = await removeFromFolderFlow(makePorts(), folderId, resourceId, name);
  host?.reload();
  return result;
}

export async function runRemoveFromWorkspace(resourceId: string, name: string) {
  const id = host?.workspaceId();
  if (!id) return { status: 'rejected' as const, message: '没有当前工作区' };
  const result = await removeFromWorkspaceFlow(makePorts(), id, resourceId, name);
  host?.reload();
  return result;
}
