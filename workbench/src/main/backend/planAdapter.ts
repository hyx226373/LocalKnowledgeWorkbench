/**
 * 把 @kb/plan 适配成 KbPlanService（第 10 轮）。
 * 差异消化：
 * - 对方 PlanOp 是 FileOp（type/fromRelPath/content），我方是 kind/resourceId/contentHash
 * - 对方 contentHash 是批准凭据（HMAC），我方 UI 绑定的是 ops 规范化哈希；适配层分开存放
 * - 对方 approvePlan 内自动执行，无独立 applyPlan；applyPlan 改为 getPlan
 * - actor：我方 UI 用 'user'，对方要求 'ui'
 */
import type { FileOp } from '@kb/fileops';
import type { PlanOp as KbFilePlanOp, PlanRecord, PlanService, PlanStatus as KbStatus } from '@kb/plan';
import { planContentHash, type KbPlanService, type PlanDto, type PlanOp, type PlanPreview, type PlanStatus } from './plan';

function toActor(actor: string): 'ui' | `agent:${string}` {
  if (actor === 'user' || actor === 'ui') return 'ui';
  if (actor.startsWith('agent:')) return actor as `agent:${string}`;
  return `agent:${actor.replace(/[^\p{L}\p{N}_.-]/gu, '').slice(0, 40) || 'unknown'}`;
}

function mapStatus(s: KbStatus | string): PlanStatus {
  if (s === 'failed-rolled-back') return 'failed';
  if (s === 'draft' || s === 'approved' || s === 'applied' || s === 'failed' || s === 'applying' || s === 'discarded') return s;
  return 'failed';
}

export class KbPlanAdapter implements KbPlanService {
  private staged = new Map<string, Buffer>();
  /** planId → 我方 PlanOp 视图（含 contentHash） */
  private view = new Map<string, PlanDto>();
  /** 界面拒绝只留在适配层，不写 SQLite，也不调用 approve。 */
  private discardedReason = new Map<string, string>();

  constructor(private real: PlanService) {}

  stageContent(hash: string, bytes: Buffer) {
    this.staged.set(hash, bytes);
  }

  migrate() {
    this.real.migrate();
  }

  private toFileOps(ops: Omit<PlanOp, 'opId'>[] | PlanOp[]): KbFilePlanOp[] {
    return ops.map((o) => {
      if (o.kind === 'write') {
        const bytes = o.contentHash ? this.staged.get(o.contentHash) : undefined;
        if (!bytes) throw new Error(`暂存内容缺失: ${o.contentHash ?? '(无哈希)'}`);
        return { type: 'write', rootId: o.rootId, relPath: o.relPath, content: bytes } satisfies FileOp;
      }
      if (o.kind === 'move') {
        return {
          type: 'move',
          rootId: o.rootId,
          fromRelPath: o.relPath,
          toRelPath: String(o.toRelPath ?? ''),
          ...(o.toRootId && o.toRootId !== o.rootId ? { toRootId: o.toRootId } : {}),
        } satisfies FileOp;
      }
      if (o.kind === 'trash') {
        return { type: 'delete', rootId: o.rootId, relPath: o.relPath } satisfies FileOp;
      }
      if (o.kind === 'mkdir') {
        return { type: 'create', rootId: o.rootId, relPath: o.relPath, content: Buffer.alloc(0) } satisfies FileOp;
      }
      if (o.kind === 'copy') {
        throw new Error('@kb/fileops 无 copy；请反馈磐石或改用 create+write');
      }
      throw new Error(`不支持的操作: ${(o as PlanOp).kind}`);
    });
  }

  private fromRecord(rec: PlanRecord, prev?: PlanDto): PlanDto {
    const ops: PlanOp[] = rec.steps.map((s, i) => {
      const prevOp = prev?.ops[i];
      const op = s.op;
      if (op.type === 'write' || op.type === 'create') {
        return {
          opId: s.id,
          kind: 'write' as const,
          rootId: op.rootId,
          relPath: op.relPath,
          resourceId: prevOp?.resourceId ?? s.resourceId ?? undefined,
          contentHash: prevOp?.contentHash,
          expectedHash: prevOp?.expectedHash ?? null,
        };
      }
      if (op.type === 'move' || op.type === 'rename') {
        return {
          opId: s.id,
          kind: 'move' as const,
          rootId: op.rootId,
          relPath: op.fromRelPath,
          toRelPath: op.toRelPath,
          ...(op.type === 'move' && op.toRootId ? { toRootId: op.toRootId } : {}),
          resourceId: prevOp?.resourceId ?? s.resourceId ?? undefined,
        };
      }
      if (op.type === 'delete') {
        return {
          opId: s.id,
          kind: 'trash' as const,
          rootId: op.rootId,
          relPath: op.relPath,
          resourceId: prevOp?.resourceId ?? s.resourceId ?? undefined,
        };
      }
      // restore
      return {
        opId: s.id,
        kind: 'write' as const,
        rootId: prevOp?.rootId ?? '',
        relPath: prevOp?.relPath ?? '',
        resourceId: prevOp?.resourceId,
      };
    });
    const contentHash = prev?.contentHash && prev.ops.length === ops.length ? prev.contentHash : planContentHash(ops);
    const results =
      rec.status === 'applied' || rec.status === 'failed-rolled-back'
        ? rec.steps
            .filter((s) => s.approved)
            .map((s) => ({
              opId: s.id,
              ok: s.status === 'ok',
              error: s.error ?? undefined,
              undoToken: s.opId ?? undefined,
            }))
        : prev?.results;
    const dto: PlanDto = {
      planId: rec.id,
      actor: rec.actor === 'ui' ? (prev?.actor?.startsWith('agent:') ? prev.actor : 'user') : rec.actor,
      title: rec.title,
      ops,
      status: mapStatus(rec.status),
      contentHash,
      approval: prev?.approval ?? null,
      results,
    };
    this.view.set(rec.id, dto);
    return structuredClone(dto);
  }

  async createPlan(input: { actor: string; title: string; ops: Omit<PlanOp, 'opId'>[] }): Promise<PlanDto> {
    const fileOps = this.toFileOps(input.ops);
    const rec = await this.real.createPlan({ actor: toActor(input.actor), title: input.title, ops: fileOps });
    // 用对方 step id 作为 opId，重建我方 ops 视图并计算 contentHash
    const ops: PlanOp[] = rec.steps.map((s, i) => {
      const src = input.ops[i]!;
      return { ...src, opId: s.id };
    });
    const dto: PlanDto = {
      planId: rec.id,
      actor: input.actor,
      title: input.title,
      ops,
      status: 'draft',
      contentHash: planContentHash(ops),
      approval: null,
    };
    this.view.set(rec.id, dto);
    return structuredClone(dto);
  }

  async previewPlan(planId: string): Promise<PlanPreview> {
    const prev = this.view.get(planId);
    const pv = await this.real.previewPlan(planId);
    const contentHash = prev?.contentHash ?? '';
    return {
      planId,
      contentHash,
      items: pv.steps.map((s) => ({
        opId: s.stepId,
        summary: s.summary,
        conflicts: (s.conflicts ?? []).map((c) => (typeof c === 'string' ? c : c.message)),
      })),
    };
  }

  async approvePlan(planId: string, a: { approvedOpIds: string[]; contentHash: string; channel: 'ui' }): Promise<PlanDto> {
    if (a.channel !== 'ui') throw new Error('只有用户界面能批准');
    const prev = this.view.get(planId);
    if (!prev) throw new Error('计划不存在');
    if (a.contentHash !== prev.contentHash) throw new Error('计划已修改，原批准失效');
    // 对方凭据：先向 @kb/plan 取 HMAC，再批准（内部自动执行）
    const cred = await this.real.getApprovalCredential({ planId, approvedOpIds: a.approvedOpIds, actor: 'ui' });
    const rec = await this.real.approvePlan({ planId, approvedOpIds: a.approvedOpIds, contentHash: cred.contentHash, actor: 'ui' });
    const dto = this.fromRecord(rec, {
      ...prev,
      approval: { approvedOpIds: [...a.approvedOpIds], contentHash: a.contentHash, at: Date.now(), channel: 'ui' },
      status: 'approved',
    });
    // approve 已执行完毕；对外先返回 approved 形状再由 Gateway 调 applyPlan（我们让 apply 返回最终态）
    if (dto.status === 'applied' || dto.status === 'failed') {
      // 暂存为 approved 供 Gateway 校验，真实终态在 applyPlan
      const mid = structuredClone(dto);
      mid.status = 'approved';
      mid.approval = { approvedOpIds: [...a.approvedOpIds], contentHash: a.contentHash, at: Date.now(), channel: 'ui' };
      this.view.set(planId, { ...dto, approval: mid.approval });
      return mid;
    }
    return dto;
  }

  async applyPlan(planId: string): Promise<PlanDto> {
    const prev = this.view.get(planId);
    const rec = await this.real.getPlan(planId);
    return this.fromRecord(rec, prev);
  }

  async getPlan(planId: string): Promise<PlanDto | null> {
    const reason = this.discardedReason.get(planId);
    const marked = this.view.get(planId);
    if (reason && marked) return structuredClone({ ...marked, status: 'discarded', approval: null, error: reason });
    try {
      const rec = await this.real.getPlan(planId);
      return this.fromRecord(rec, this.view.get(planId));
    } catch {
      return this.view.get(planId) ? structuredClone(this.view.get(planId)!) : null;
    }
  }

  async discardPlan(planId: string, reason: string): Promise<PlanDto> {
    const prev = this.view.get(planId) ?? (await this.getPlan(planId));
    if (!prev) throw new Error('计划不存在');
    if (prev.status !== 'draft') throw new Error(`计划状态为 ${prev.status}，不能拒绝`);
    const dto: PlanDto = { ...prev, status: 'discarded', approval: null, error: reason };
    this.view.set(planId, dto);
    this.discardedReason.set(planId, reason);
    return structuredClone(dto);
  }

  /** 契约测试用：修改步骤使 contentHash 失效 */
  async updatePlan(planId: string, ops: PlanOp[]): Promise<PlanDto> {
    const fileOps = this.toFileOps(ops);
    const rec = await this.real.replaceOps({ planId, ops: fileOps, actor: 'ui' });
    const mapped: PlanOp[] = rec.steps.map((s, i) => ({ ...ops[i]!, opId: s.id }));
    const dto: PlanDto = {
      planId,
      actor: this.view.get(planId)?.actor ?? 'user',
      title: rec.title,
      ops: mapped,
      status: 'draft',
      contentHash: planContentHash(mapped),
      approval: null,
    };
    this.view.set(planId, dto);
    return structuredClone(dto);
  }

  listDrafts(): PlanDto[] {
    return [...this.view.values()].filter((p) => p.status === 'draft' && !this.discardedReason.has(p.planId)).map((p) => structuredClone(p));
  }
}
