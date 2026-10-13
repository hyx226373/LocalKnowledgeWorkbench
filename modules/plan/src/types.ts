import type { Database } from "better-sqlite3";
import type { Actor, Conflict, FileOp, FileOps, OnConflict } from "@kb/fileops";

export interface PlanDeps {
  db: Database;
  fileOps: FileOps;
}

/** 计划里的恢复步骤。FileOp 没有 restore，执行时才调用 fileOps.restore。 */
export interface RestorePlanOp {
  type: "restore";
  opId: string;
  onConflict: OnConflict;
}

export type PlanOp = FileOp | RestorePlanOp;

export interface CreatePlanInput {
  actor: Actor;
  title: string;
  ops: PlanOp[];
}

export interface ApprovePlanInput {
  planId: string;
  approvedOpIds?: string[];
  contentHash: string;
  actor: Actor;
}

export interface ApprovalCredentialInput {
  planId: string;
  approvedOpIds?: string[];
  actor: Actor;
}

export interface ReplaceOpsInput {
  planId: string;
  ops: PlanOp[];
  actor: Actor;
}

export type PlanStatus = "draft" | "approved" | "applied" | "failed-rolled-back";

export type StepStatus =
  | "pending"
  | "skipped"
  | "ok"
  | "failed"
  | "rolled-back"
  | "rollback-failed"
  | "rollback-conflict"
  | "not-run";

export interface PlanStepRecord {
  id: string;
  seq: number;
  op: PlanOp;
  approved: boolean;
  status: StepStatus;
  opId: string | null;
  resourceId: string | null;
  summary: string | null;
  conflicts: Conflict[];
  affectedResourceIds: string[];
  diff: string | null;
  error: string | null;
}

export interface PlanRecord {
  id: string;
  actor: Actor;
  title: string;
  status: PlanStatus;
  error: string | null;
  steps: PlanStepRecord[];
}

export interface PlanStepPreview {
  stepId: string;
  seq: number;
  op: PlanOp;
  summary: string;
  conflicts: Conflict[];
  affectedResourceIds: string[];
  diff: string | null;
}

export interface PlanPreview {
  planId: string;
  steps: PlanStepPreview[];
}

export interface PlanService {
  migrate(): void;
  createPlan(input: CreatePlanInput): Promise<PlanRecord>;
  previewPlan(planId: string): Promise<PlanPreview>;
  /** 只有 actor 为 ui。返回的 contentHash 是批准凭据，agent-api 不暴露此方法。 */
  getApprovalCredential(input: ApprovalCredentialInput): Promise<{ contentHash: string }>;
  /** 只接受界面调用。核对凭据后立刻执行已批准步骤。 */
  approvePlan(input: ApprovePlanInput): Promise<PlanRecord>;
  /** 测试和界面改步骤。agent-api 不暴露。旧 contentHash 因此失效。 */
  replaceOps(input: ReplaceOpsInput): Promise<PlanRecord>;
  /** 测试用的显式回滚。agent-api 不暴露。 */
  rollbackPlan(planId: string): Promise<PlanRecord>;
  getPlan(planId: string): Promise<PlanRecord>;
}
