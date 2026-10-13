/**
 * @kb/plan 适配层（第 9 轮 E）。磐石组交付的接口：
 *   createPlanService({ db, fileOps }) → { migrate, createPlan, previewPlan, approvePlan({ approvedOpIds }), applyPlan, getPlan }
 * 本轮约定（磐石组正在改）：批准绑定确定的操作内容（内容哈希）；计划修改后原批准失效；只有用户界面能批准；批准后服务层自动执行。
 *
 * 这里只定义“我们需要的形状”（KbPlanService）与一个包装 PlanGateway：
 *  - 在我们这一侧再校验一遍以上四条（不依赖对方实现是否已经做到），不满足即拒绝；
 *  - 真模块验收后：`new PlanGateway(createPlanService({ db, fileOps }))`，调用方（OperationService）不用改。
 * 契约测试：tests/backend-contract.test.ts（mock 实现；真模块到位后同一套用例跑真模块）。
 */
import crypto from 'node:crypto';

export type PlanOpKind = 'write' | 'move' | 'trash' | 'mkdir' | 'copy';
export interface PlanOp {
  opId: string;
  kind: PlanOpKind;
  resourceId?: string;
  rootId: string;
  relPath: string;
  /** move/copy 目标（相对路径，在 rootId 或 toRootId 下） */
  toRelPath?: string;
  /** 跨根移动的目标根。缺省或等于 rootId 时哈希与旧计划一致。 */
  toRootId?: string;
  /** write：新内容的 sha256（内容本身由 fileOps 暂存） */
  contentHash?: string;
  /** 调用方看到的当前文件哈希（防止对着已变化的文件执行） */
  expectedHash?: string | null;
}
export type PlanStatus = 'draft' | 'approved' | 'applying' | 'applied' | 'failed' | 'discarded';
export interface PlanDto {
  planId: string;
  actor: string;
  title: string;
  ops: PlanOp[];
  status: PlanStatus;
  /** 计划内容哈希（ops 的规范化 JSON）。任何修改都会改变它 */
  contentHash: string;
  approval?: { approvedOpIds: string[]; contentHash: string; at: number; channel: 'ui' } | null;
  results?: { opId: string; ok: boolean; error?: string; undoToken?: string }[];
  /** 拒绝或执行失败时的说明。不是批准凭据。 */
  error?: string | null;
}
export interface PlanPreview {
  planId: string;
  contentHash: string;
  items: { opId: string; summary: string; conflicts: string[] }[];
}

/** 磐石组模块需要满足的接口（按交付说明整理；字段名以对方最终版本为准，差异在本文件内消化） */
export interface KbPlanService {
  migrate(): void | Promise<void>;
  createPlan(input: { actor: string; title: string; ops: Omit<PlanOp, 'opId'>[] }): PlanDto | Promise<PlanDto>;
  previewPlan(planId: string): PlanPreview | Promise<PlanPreview>;
  approvePlan(planId: string, a: { approvedOpIds: string[]; contentHash: string; channel: 'ui' }): PlanDto | Promise<PlanDto>;
  applyPlan(planId: string): PlanDto | Promise<PlanDto>;
  getPlan(planId: string): PlanDto | null | Promise<PlanDto | null>;
  /** 界面拒绝。不执行。agent 入口不暴露。 */
  discardPlan?(planId: string, reason: string): PlanDto | Promise<PlanDto>;
}

export function planContentHash(ops: PlanOp[]): string {
  const canon = [...ops]
    .sort((a, b) => a.opId.localeCompare(b.opId))
    .map((o) => {
      const row = [o.opId, o.kind, o.resourceId ?? '', o.rootId, o.relPath, o.toRelPath ?? '', o.contentHash ?? '', o.expectedHash ?? ''];
      if (o.toRootId && o.toRootId !== o.rootId) row.push(o.toRootId);
      return row;
    });
  return crypto.createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

export class ApprovalError extends Error {
  constructor(msg: string, public code: 'not-ui' | 'stale' | 'unknown-op' | 'not-draft' | 'empty' | 'not-reviewed') {
    super(msg);
    this.name = 'ApprovalError';
  }
}

export type Channel = 'ui' | 'agent' | 'plugin';

/** 我们这一侧的守门：只有界面渠道能批准；批准绑定内容哈希；批准后自动执行 */
export class PlanGateway {
  constructor(private plans: KbPlanService) {}

  async create(actor: string, title: string, ops: Omit<PlanOp, 'opId'>[]): Promise<{ plan: PlanDto; preview: PlanPreview }> {
    const plan = await this.plans.createPlan({ actor, title, ops });
    if (plan.contentHash !== planContentHash(plan.ops)) throw new Error('计划服务返回的内容哈希与操作内容不一致');
    return { plan, preview: await this.plans.previewPlan(plan.planId) };
  }

  async get(planId: string) {
    return this.plans.getPlan(planId);
  }

  /**
   * 批准并执行。channel 由调用方的“来源”决定（IPC 处理函数里固定写 'ui'；agent 入口固定写 'agent'），不能由参数伪造：
   * OperationService 对 agent/插件入口根本不暴露这个方法。
   */
  async approveAndApply(planId: string, approvedOpIds: string[], seenContentHash: string, channel: Channel): Promise<PlanDto> {
    if (channel !== 'ui') throw new ApprovalError('只有用户界面能批准计划', 'not-ui');
    const plan = await this.plans.getPlan(planId);
    if (!plan) throw new ApprovalError('计划不存在', 'unknown-op');
    if (plan.status !== 'draft') throw new ApprovalError(`计划状态为 ${plan.status}，不能批准`, 'not-draft');
    const current = planContentHash(plan.ops);
    if (current !== seenContentHash || plan.contentHash !== seenContentHash) throw new ApprovalError('计划在你查看之后被修改过，请重新查看后再批准', 'stale');
    if (!approvedOpIds.length) throw new ApprovalError('没有选择任何操作', 'empty');
    const ids = new Set(plan.ops.map((o) => o.opId));
    for (const id of approvedOpIds) if (!ids.has(id)) throw new ApprovalError(`操作不在计划中：${id}`, 'unknown-op');
    const approved = await this.plans.approvePlan(planId, { approvedOpIds, contentHash: seenContentHash, channel: 'ui' });
    // @kb/plan 的 approvePlan 内部会直接执行，可能直接回到 applied/failed；本地实现先回到 approved 再 apply
    if (approved.approval?.contentHash !== seenContentHash) throw new ApprovalError('计划服务没有按内容哈希记录批准', 'stale');
    if (approved.status === 'applied' || approved.status === 'failed') return approved;
    if (approved.status !== 'approved') throw new ApprovalError('计划服务没有按内容哈希记录批准', 'stale');
    // 批准后服务层自动执行（不需要再有人点“执行”）
    return this.plans.applyPlan(planId);
  }
}
