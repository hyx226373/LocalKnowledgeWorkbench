import { dialogs } from '../ui/dialogs';
import { kb } from '../kb';
import { performDrop, removeFromFolderFlow, removeFromWorkspaceFlow, type FlowPorts, type FlowResult } from './flow';
import { setLiveHint, liveHint } from './hint';
import { askMove } from './MoveDialog';
import { onDropTarget } from './resolve';
import type { DragPayload, DropTarget, Modifiers } from './types';

export type OpenPlace = 'tab' | 'left' | 'right' | 'up' | 'down' | 'float';

export interface DndHost {
  open(resourceId: string, place: OpenPlace): Promise<void>;
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
