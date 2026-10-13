import { createHash, randomUUID } from 'node:crypto';
import type { AgentOpsPort, BridgeHost, PlanOpInput, ProposedPlan } from '../src/main/agent-bridge/types';

export interface MemoryStats {
  proposeCount: number;
  approveCount: number;
  openCount: number;
  classifyCount: number;
  workspaceAdds: number;
  workspaceRemoves: number;
  plans: ProposedPlan[];
  secretPath: string;
}

export function createMemoryHost(opts?: { withApprove?: boolean; classify?: boolean; workspaceRef?: boolean }): { host: BridgeHost; stats: MemoryStats } {
  const stats: MemoryStats = {
    proposeCount: 0,
    approveCount: 0,
    openCount: 0,
    classifyCount: 0,
    workspaceAdds: 0,
    workspaceRemoves: 0,
    plans: [],
    secretPath: 'D:\\secret\\should-not-leak\\a.md',
  };
  const resourceId = '22222222-2222-4222-8222-222222222222';
  const host: BridgeHost = {
    forAgent(name: string): AgentOpsPort {
      const port: AgentOpsPort & { approve?: () => void } = {
        propose: async (title: string, ops: PlanOpInput[]) => {
          stats.proposeCount += 1;
          const plan: ProposedPlan = {
            planId: randomUUID(),
            title,
            actor: `agent:${name}`,
            status: 'draft',
            contentHash: createHash('sha256').update(JSON.stringify(ops)).digest('hex'),
            ops: ops.map((op, i) => ({ opId: `op${i + 1}`, kind: op.kind, resourceId: op.resourceId, relPath: 'notes/a.md' })),
          };
          stats.plans.push(plan);
          return { plan, preview: { items: [] } };
        },
        get: async (id: string) => stats.plans.find((plan) => plan.planId === id) ?? null,
      };
      if (opts?.withApprove) port.approve = () => { stats.approveCount += 1; };
      return port;
    },
    listRoots: () => [{ id: 'root-1', name: '资料' }],
    getResource: (id) => id === resourceId
      ? { resourceId, rootId: 'root-1', relPath: 'notes/a.md', name: 'a.md', kind: 'file', ext: 'md' }
      : null,
    listDir: () => [{ resourceId, rootId: 'root-1', relPath: 'notes/a.md', name: 'a.md', kind: 'file', ext: 'md' }],
    open: async () => {
      stats.openCount += 1;
      return { ok: true, itemId: 'item-1' };
    },
    listPendingPlans: () => stats.plans
      .filter((plan) => plan.status === 'draft')
      .map((plan) => ({ planId: plan.planId, title: plan.title, status: plan.status, actor: plan.actor, contentHash: plan.contentHash })),
    getIndexHealth: () => ({ engine: 'local-fallback', contentSearch: false, reason: '测试替身', since: 1 }),
  };
  if (opts?.classify !== false) host.classify = async () => { stats.classifyCount += 1; };
  if (opts?.workspaceRef !== false) {
    host.workspaceRef = async (action) => {
      if (action === 'add') stats.workspaceAdds += 1;
      else stats.workspaceRemoves += 1;
    };
  }
  return { host, stats };
}
