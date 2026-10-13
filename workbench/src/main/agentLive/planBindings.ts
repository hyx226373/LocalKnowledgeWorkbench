import type { BoundPlanExecution } from '../../shared/agentLive/types';

const bindings = new Map<string, BoundPlanExecution>();

/** 计划提交时记下执行对象。批准仍只在界面，这里只供执行前核对 expectedFileHash。 */
export function rememberPlanBinding(planId: string, binding: BoundPlanExecution): void {
  if (!planId) return;
  bindings.set(planId, { ...binding, planId });
  if (bindings.size <= 200) return;
  const oldest = bindings.keys().next().value;
  if (oldest) bindings.delete(oldest);
}

export function peekPlanBinding(planId: string): BoundPlanExecution | null {
  return bindings.get(planId) ?? null;
}
