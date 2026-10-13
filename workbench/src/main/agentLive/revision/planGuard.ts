import type { BoundPlanExecution, BoundWriteOp, FileHashConflict } from '../../../shared/agentLive/types';
import { hashBuffer, hashHex, isSecretPath, sameHash } from './hash';

export interface BindPlanInput {
  requestId: string;
  planId?: string | null;
  /** 工作台在读到请求时的活动工作区。不要改用请求体里的 workspaceId。 */
  workspaceId: string;
  boundAt?: string;
  /** 计划级内容哈希。此处故意不读，避免把已被忽略的 contentHash 当成文件哈希。 */
  contentHash?: string;
  ops: Array<Record<string, unknown>>;
  scope?: { resourceIds?: string[]; materialIds?: string[]; absPaths?: string[] };
  resolvePath?: (resourceId: string) => string | null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function bindPlanSubmission(input: BindPlanInput): BoundPlanExecution {
  const ops: BoundWriteOp[] = input.ops.map((op) => {
    const resourceId = asString(op.resourceId);
    const materialId = asString(op.materialId);
    let absPath = asString(op.absPath);
    if (!absPath && resourceId && input.resolvePath) absPath = input.resolvePath(resourceId) ?? undefined;
    return {
      kind: asString(op.kind) ?? 'write',
      ...(resourceId ? { resourceId } : {}),
      ...(materialId ? { materialId } : {}),
      ...(absPath ? { absPath } : {}),
      ...(asString(op.expectedFileHash) ? { expectedFileHash: asString(op.expectedFileHash) } : {}),
    };
  });
  const resourceIds = [...new Set([...(input.scope?.resourceIds ?? []), ...ops.map((op) => op.resourceId).filter((id): id is string => !!id)])];
  const materialIds = [...new Set([...(input.scope?.materialIds ?? []), ...ops.map((op) => op.materialId).filter((id): id is string => !!id)])];
  const absPaths = [...new Set([...(input.scope?.absPaths ?? []), ...ops.map((op) => op.absPath).filter((id): id is string => !!id)])];
  return {
    requestId: input.requestId,
    planId: input.planId ?? null,
    workspaceId: input.workspaceId,
    boundAt: input.boundAt ?? new Date().toISOString(),
    ops,
    scope: { workspaceId: input.workspaceId, resourceIds, materialIds, absPaths },
  };
}

export interface PlanCheckEnv {
  /**
   * 调用当下的活动工作区。执行对象仍以 binding 为准，这个值不参与选路。
   * 集成组应在切换工作区之后仍把原 binding 传进来。
   */
  activeWorkspaceId?: string;
  readFile: (absPath: string) => Buffer | null;
}

export type PlanCheck = { ok: true; binding: BoundPlanExecution } | FileHashConflict;

function conflict(op: BoundWriteOp, expected: string, actual: string | null, message: string): FileHashConflict {
  return {
    ok: false,
    status: 'conflict',
    suggestedAction: 're-read',
    error: { code: 'conflict', message },
    ...(op.materialId ? { materialId: op.materialId } : {}),
    ...(op.resourceId ? { resourceId: op.resourceId } : {}),
    ...(op.absPath ? { absPath: op.absPath } : {}),
    expectedFileHash: expected,
    actualFileHash: actual,
  };
}

/** 执行前核对 expectedFileHash。目标路径与工作区用提交时绑定的那一份。 */
export function checkBoundExecution(binding: BoundPlanExecution, env: PlanCheckEnv): PlanCheck {
  void env.activeWorkspaceId;
  for (const op of binding.ops) {
    if (op.kind !== 'write' || !op.expectedFileHash) continue;
    const expectedHex = hashHex(op.expectedFileHash);
    if (!expectedHex) {
      return conflict(op, op.expectedFileHash, null, 'expectedFileHash 不是 sha256，请重新读取后再提交');
    }
    if (!op.absPath) {
      return conflict(op, op.expectedFileHash, null, '提交时没有绑定文件路径，请重新读取后再提交');
    }
    if (isSecretPath(op.absPath)) {
      return conflict(op, op.expectedFileHash, null, '该路径不能作为计划的执行对象');
    }
    const bytes = env.readFile(op.absPath);
    if (!bytes) {
      return conflict(op, op.expectedFileHash, null, '原文件读不到，请重新读取后再提交');
    }
    const actual = hashBuffer(bytes);
    if (!sameHash(actual, op.expectedFileHash)) {
      return conflict(op, op.expectedFileHash, actual, '原文件内容已变化，请重新读取后再提交');
    }
  }
  return { ok: true, binding };
}

/** 冲突时不调用 execute。execute 收到的是提交时的 binding，而不是当前工作区。 */
export function runBoundPlan<T>(
  binding: BoundPlanExecution,
  env: PlanCheckEnv,
  execute: (binding: BoundPlanExecution) => T,
): T | FileHashConflict {
  const checked = checkBoundExecution(binding, env);
  if (!checked.ok) return checked;
  return execute(checked.binding);
}
