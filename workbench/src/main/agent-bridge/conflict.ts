/** 计划状态到桥响应的映射。这里不批准、不执行、不写数据库。 */
import type { BridgeStatus } from './types';

export type SuggestedAction = 're-propose' | 'open-restore-ui' | 'inspect-plan';

export interface WatchedPlan {
  planId: string;
  title: string;
  actor: string;
  status: string;
  contentHash: string;
  results?: { opId: string; ok: boolean; error?: string }[];
  error?: string | null;
}

export interface DecideInput {
  mode: 'watch' | 'recovery';
  currentStatus: BridgeStatus;
  savedHash: string | null;
  plan: WatchedPlan | null;
  previewConflicts: string[];
}

export interface PlanDecision {
  status: 'awaiting_approval' | 'running' | 'success' | 'failed' | 'conflict';
  suggestedAction?: SuggestedAction;
  error?: { code: string; message: string };
  result?: Record<string, unknown>;
  viaRunning: boolean;
  changed: boolean;
}

const TERMINAL = new Set<string>(['success', 'failed', 'conflict']);

function looksExternal(plan: WatchedPlan | null, previewConflicts: string[]): boolean {
  const blob = [plan?.error ?? '', ...(plan?.results ?? []).map((row) => row.error ?? ''), ...previewConflicts].join('\n');
  return /已被修改|哈希|expectedHash|冲突|外改|approval_stale|stale/i.test(blob);
}

function planResult(plan: WatchedPlan | null, savedHash: string | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    planId: plan?.planId ?? null,
    savedContentHash: savedHash,
    contentHash: plan?.contentHash ?? null,
    actor: plan?.actor ?? null,
    title: plan?.title ?? null,
    planStatus: plan?.status ?? null,
    ...extra,
  };
}

function viaRunning(currentStatus: string, next: PlanDecision['status']): boolean {
  if (next === 'awaiting_approval' || next === 'running') return false;
  return currentStatus === 'awaiting_approval' || currentStatus === 'pending';
}

export function decidePlanBridge(input: DecideInput): PlanDecision {
  const { mode, currentStatus, savedHash, plan, previewConflicts } = input;
  if (TERMINAL.has(currentStatus)) {
    return { status: currentStatus as PlanDecision['status'], viaRunning: false, changed: false };
  }

  const finish = (partial: Omit<PlanDecision, 'viaRunning' | 'changed'>): PlanDecision => ({
    ...partial,
    viaRunning: viaRunning(currentStatus, partial.status),
    changed: true,
  });

  if (!savedHash) {
    if (mode === 'watch') {
      return { status: 'awaiting_approval', viaRunning: false, changed: false };
    }
    return finish({
      status: 'conflict',
      suggestedAction: 'inspect-plan',
      error: { code: 'unreconciled', message: '响应里没有已保存的 contentHash，不能对账，未执行。' },
      result: planResult(plan, null, { note: '无法对账，未执行' }),
    });
  }

  if (!plan) {
    if (mode === 'watch' && currentStatus !== 'running') {
      return { status: currentStatus === 'pending' ? 'awaiting_approval' : (currentStatus as PlanDecision['status']), viaRunning: false, changed: currentStatus === 'pending' };
    }
    return finish({
      status: 'conflict',
      suggestedAction: 'inspect-plan',
      error: { code: 'unreconciled', message: '无法与计划服务对账，未执行。请在界面查看；不要假定已经写入。' },
      result: planResult(null, savedHash, { note: '无法对账，未执行' }),
    });
  }

  if (plan.status === 'discarded') {
    return finish({
      status: 'failed',
      error: { code: 'user_rejected', message: plan.error || '用户拒绝了这份计划' },
      result: planResult(plan, savedHash, { note: '用户在界面拒绝。没有执行。本桥没有超时自动拒绝。' }),
    });
  }

  if (savedHash && plan.contentHash !== savedHash) {
    return finish({
      status: 'conflict',
      suggestedAction: 're-propose',
      error: { code: 'plan_changed', message: `计划已变更，请重新查看计划。当前 contentHash 是 ${plan.contentHash}` },
      result: planResult(plan, savedHash, { note: '请重新查看计划' }),
    });
  }

  if (plan.status === 'applied') {
    const bad = (plan.results ?? []).filter((row) => !row.ok);
    if (bad.length && looksExternal(plan, [])) {
      return finish({
        status: 'conflict',
        suggestedAction: 're-propose',
        error: { code: 'external_change', message: bad.map((row) => row.error).filter(Boolean).join('；') || '执行时文件已被修改' },
        result: planResult(plan, savedHash, { opResults: plan.results ?? [], note: '请重新查看计划' }),
      });
    }
    if (bad.length) {
      return finish({
        status: 'failed',
        error: { code: 'apply_failed', message: bad.map((row) => row.error).filter(Boolean).join('；') || '执行失败' },
        result: planResult(plan, savedHash, { opResults: plan.results ?? [] }),
      });
    }
    return finish({
      status: 'success',
      result: planResult(plan, savedHash, {
        status: 'applied',
        opResults: plan.results ?? [],
        summary: (plan.results ?? []).map((row) => `${row.opId}:ok`).join('；') || '已执行',
        note: '界面已批准并执行。',
      }),
    });
  }

  if (plan.status === 'failed' || plan.status === 'failed-rolled-back') {
    const rolled = plan.status === 'failed-rolled-back';
    if (rolled || looksExternal(plan, previewConflicts)) {
      return finish({
        status: 'conflict',
        suggestedAction: rolled ? 'open-restore-ui' : 're-propose',
        error: {
          code: rolled ? 'rolled_back' : 'external_change',
          message: plan.error || (rolled ? '执行后已回滚。请在界面查看恢复。' : '文件在计划生成后已被修改，请重新提交计划。'),
        },
        result: planResult(plan, savedHash, { opResults: plan.results ?? [], note: rolled ? '请打开恢复界面' : '请重新查看计划' }),
      });
    }
    return finish({
      status: 'failed',
      error: { code: 'apply_failed', message: plan.error || '计划执行失败' },
      result: planResult(plan, savedHash, { opResults: plan.results ?? [] }),
    });
  }

  if ((plan.status === 'draft' || plan.status === 'approved') && previewConflicts.length > 0) {
    return finish({
      status: 'conflict',
      suggestedAction: 're-propose',
      error: { code: 'external_change', message: `${previewConflicts.join('；')}。请重新查看计划。` },
      result: planResult(plan, savedHash, { note: '请重新查看计划' }),
    });
  }

  if (plan.status === 'approved' || plan.status === 'applying') {
    const same = currentStatus === 'running';
    return { status: 'running', viaRunning: false, changed: !same, result: planResult(plan, savedHash, { note: '界面已批准，正在执行。' }) };
  }

  if (currentStatus === 'running' && mode === 'recovery') {
    return finish({
      status: 'awaiting_approval',
      result: planResult(plan, savedHash, { note: '重启时计划仍未执行，已回到待批准。没有自动再执行。' }),
    });
  }

  if (currentStatus === 'awaiting_approval') {
    return { status: 'awaiting_approval', viaRunning: false, changed: false };
  }

  return finish({
    status: 'awaiting_approval',
    result: planResult(plan, savedHash, { note: '计划已进入待批准。请在界面查看差异并批准。文件里的 approved 无效。没有超时。' }),
  });
}

export function statusesToWrite(current: string, decision: PlanDecision): string[] {
  if (!decision.changed) return [];
  if (decision.viaRunning && current !== 'running') return ['running', decision.status];
  return [decision.status];
}
