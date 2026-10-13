import { attachCatalogHost } from './catalogActions';
import { readSavedWorkbenchState, type WorkspaceStateSource } from './workbenchState';
import { startPlanBridge, type PlanPorts } from './planBridge';
import { startAgentBridge, type BridgeOptions, type RunningBridge } from './pump';
import type { AgentOpsPort, BridgeHost, IndexHealth, PlanOpInput, ProposedPlan } from './types';
import type { WatchedPlan } from './conflict';
import type { StateSnapshot } from '../../shared/actions/types';

/**
 * wire.ts 只追加下面这一段（r11-G）。不要给 AgentOps 加 approve，不要在这里打开数据库。
 *
 *   // ---- r11-G 文件 Agent 桥
 *   void mountFileAgentBridge({
 *     userDataDir,
 *     svc,
 *     ops,
 *     getIndexHealth: () => null,
 *   }).then((bridge) => {
 *     bundle.fileAgentBridge = bridge;
 *   }).catch((err) => console.error('[agent-bridge] 启动失败', err));
 *
 * bundle.close 里在关掉 HTTP agent 之前补：`await bundle.fileAgentBridge?.close()`。
 *
 * index.ts 在 `await wireBackend(...)` 返回后的同一轮同步代码里挂监听，泵会先让出一次微任务：
 *
 *   // ---- r11-G 文件 Agent 桥
 *   svc.on('agent-bridge', (msg: { channel: string; payload: unknown }) => send(msg.channel, msg.payload));
 *
 * 打开事件频道是 `kb:agent-bridge-open`，呼出是 `kb:agent-bridge-invoke`。
 * F2 未合入时，渲染进程用现有 openItem 处理该事件；不要另写一套打开协议。
 */

export interface WireLikeSvc {
  listRoots(): Array<{ id: string; name: string; path?: string }>;
  getResource(resourceId: string): {
    resourceId: string;
    rootId: string;
    relPath: string;
    name: string;
    kind: 'file' | 'dir';
    ext?: string;
    path?: string;
  } | null;
  listDir?(rootId: string, relPath: string, opts?: { showIgnored?: boolean }): Array<{
    resourceId: string;
    rootId: string;
    relPath: string;
    name: string;
    kind: 'file' | 'dir';
    ext?: string;
    path?: string;
  }>;
  emit?(event: string, payload: unknown): void;
}

export interface WireLikeOps {
  forAgent(name: string): {
    propose(title: string, ops: PlanOpInput[]): Promise<{ plan: ProposedPlan; preview?: unknown }>;
    get(planId: string): Promise<ProposedPlan | null>;
  };
  forUi(): {
    pending(): Array<{ planId: string; title: string; status: string; actor?: string; contentHash?: string }>;
    /** 只读。不调用 review，因此不会把计划标成“已看过差异”。 */
    get?(planId: string): Promise<WatchedPlan | null>;
    preview?(planId: string): Promise<{ contentHash: string; items: { opId: string; summary: string; conflicts: string[] }[] } | null>;
  };
}

export interface MountOptions {
  userDataDir: string;
  svc: WireLikeSvc;
  ops: WireLikeOps;
  bridgeRoot?: string;
  appCommit?: string;
  modulesCommit?: string;
  getIndexHealth?: () => IndexHealth | null;
  readState?: () => StateSnapshot | Promise<StateSnapshot>;
  buildConsoleDraft?: BridgeHost['buildConsoleDraft'];
  classify?: BridgeHost['classify'];
  workspaceRef?: BridgeHost['workspaceRef'];
  pollMs?: number;
  useChokidar?: boolean;
  stableMs?: number;
}

function agentOnly(ops: WireLikeOps, name: string): AgentOpsPort {
  const raw = ops.forAgent(name);
  return {
    propose: (title, planOps) => raw.propose(title, planOps),
    get: (planId) => raw.get(planId),
  };
}

function metaOf<T extends { resourceId: string; rootId: string; relPath: string; name: string; kind: 'file' | 'dir'; ext?: string }>(row: T) {
  return { resourceId: row.resourceId, rootId: row.rootId, relPath: row.relPath, name: row.name, kind: row.kind, ext: row.ext ?? '' };
}

export async function mountFileAgentBridge(opts: MountOptions): Promise<RunningBridge> {
  await Promise.resolve();
  const catalogHost = attachCatalogHost(opts.svc);
  const host: BridgeHost = {
    forAgent: (name) => agentOnly(opts.ops, name),
    listRoots: () => opts.svc.listRoots().map((root) => ({ id: root.id, name: root.name })),
    getResource: (resourceId) => {
      const row = opts.svc.getResource(resourceId);
      return row ? metaOf(row) : null;
    },
    listDir: opts.svc.listDir
      ? (rootId, relPath) => (opts.svc.listDir!(rootId, relPath) ?? []).map((row) => metaOf(row))
      : undefined,
    open: async (input) => {
      if (!opts.svc.emit) return { ok: false, error: '界面打开通道未挂上' };
      opts.svc.emit('agent-bridge', { channel: 'kb:agent-bridge-open', payload: input });
      return { ok: true };
    },
    listPendingPlans: () => opts.ops.forUi().pending().map((plan) => ({
      planId: plan.planId,
      title: plan.title,
      status: plan.status,
      actor: plan.actor,
      contentHash: plan.contentHash,
    })),
    getIndexHealth: opts.getIndexHealth,
    readState: opts.readState ?? readStateFromSvc(opts.svc),
    buildConsoleDraft: opts.buildConsoleDraft,
    classify: opts.classify,
    workspaceRef: opts.workspaceRef,
    catalog: catalogHost.catalog,
    previewRemap: catalogHost.previewRemap,
    notifyCommand: async (commandId: string, args?: Record<string, unknown>) => {
      opts.svc.emit?.('agent-bridge', {
        channel: 'kb:agent-bridge-invoke',
        payload: { commandId, actionId: commandId, ...(args ? { args } : {}) },
      });
    },
    currentWorkspaceId: () => {
      const svc = opts.svc as WireLikeSvc & { getCurrentWorkspaceId?: () => string };
      try { return svc.getCurrentWorkspaceId?.() ?? null; } catch { return null; }
    },
    resolveResourcePath: (resourceId) => {
      const svc = opts.svc as WireLikeSvc & { resolveResourcePath?: (id: string) => string };
      try { return svc.resolveResourcePath?.(resourceId) ?? null; } catch { return null; }
    },
  };
  const bridgeOpts: BridgeOptions = {
    userDataDir: opts.userDataDir,
    bridgeRoot: opts.bridgeRoot,
    appCommit: opts.appCommit,
    modulesCommit: opts.modulesCommit,
    host,
    pollMs: opts.pollMs,
    useChokidar: opts.useChokidar,
    stableMs: opts.stableMs,
  };
  const bridge = await startAgentBridge(bridgeOpts);
  const ports = planPorts(opts.ops);
  const plans = ports
    ? startPlanBridge({ root: bridge.root, ports, pollMs: opts.pollMs ?? 400 })
    : null;
  if (plans) await plans.syncOnce();
  return {
    root: bridge.root,
    pumpOnce: () => bridge.pumpOnce(),
    syncPlans: async () => {
      await plans?.syncOnce();
    },
    async close() {
      await plans?.close();
      await bridge.close();
    },
  };
}

function readStateFromSvc(svc: WireLikeSvc): BridgeHost['readState'] | undefined {
  const src = svc as WireLikeSvc & Partial<WorkspaceStateSource>;
  if (typeof src.getLayout !== 'function' || typeof src.getWorkspace !== 'function') return undefined;
  return () => readSavedWorkbenchState(src as WorkspaceStateSource);
}

function planPorts(ops: WireLikeOps): PlanPorts | null {
  const ui = ops.forUi();
  if (!ui.get || !ui.preview) return null;
  return {
    getPlan: (planId) => ui.get!(planId),
    previewPlan: (planId) => ui.preview!(planId),
  };
}
