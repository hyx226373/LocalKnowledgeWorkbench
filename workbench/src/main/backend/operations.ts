/**
 * 统一操作服务（第 9 轮 E）：界面与 agent 走同一个操作入口。设计见 docs/08-后端接入与统一操作.md。
 *
 *   界面（IPC，渠道固定为 'ui'）──┐
 *                                 ├─► OperationService ─► PlanGateway ─► KbPlanService（现在：KbPlanAdapter(@kb/plan) / LocalPlanService 兜底）
 *   agent（渠道固定为 'agent'）───┘                                         └─► FileOpsBackend（TextEdit 仍用 LocalFileOps；计划执行走 @kb/fileops，见 planAdapter）
 *
 * - 两个入口拿到的是不同的“门面”：UiOps 有 approve；AgentOps 只有 propose / get（没有批准能力，类型上就没有）。
 * - 所有写操作都先成为计划（预览、冲突），批准绑定内容哈希，批准后自动执行；结果与撤销记录写进 op_log。
 * - 产品决定（星图组 C 项）：agent 提出的修改计划必须先显示差异预览——界面先调 review() 拿到每个写入的逐行差异，
 *   批准时内容哈希必须与看过的那份一致，否则拒绝（code 'not-reviewed'）。用户自己保存不受此限（直接保存、可撤销）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { WorkbenchService } from '../service/WorkbenchService';
import type { FileOpsBackend } from './fileOps';
import { ApprovalError, PlanGateway, planContentHash, type KbPlanService, type PlanDto, type PlanOp, type PlanPreview } from './plan';
import { diffLines, type TextDiff } from '../../shared/textDiff';
import { decodeForEdit } from '../service/textEdit';

/** 计划的差异预览：每个写入操作的逐行差异（二进制或过大时为 null，界面显示“无法逐行对比”） */
export interface PlanReview {
  plan: PlanDto;
  preview: PlanPreview;
  diffs: Record<string, { relPath: string; diff: TextDiff | null; note?: string }>;
}
const REVIEW_MAX_BYTES = 2 * 1024 * 1024;

export interface ProposedOp {
  kind: 'write' | 'move' | 'trash';
  resourceId: string;
  /** write：新内容（UTF-8 文本或字节） */
  content?: string | Buffer;
  /** write：调用方看到的当前内容哈希 */
  expectedHash?: string | null;
  /** move：新的相对路径 */
  toRelPath?: string;
  /** move：跨根时的目标根。缺省表示仍在资源当前根内。 */
  toRootId?: string;
}

export interface UiOps {
  propose(title: string, ops: ProposedOp[]): Promise<{ plan: PlanDto; preview: PlanPreview }>;
  get(planId: string): Promise<PlanDto | null>;
  /** 只有界面能批准；seenContentHash = 用户看到的预览里的 contentHash */
  approve(planId: string, approvedOpIds: string[], seenContentHash: string): Promise<PlanDto>;
  /** 只读预览，不记“已看过差异”，也不执行。 */
  preview(planId: string): Promise<PlanPreview>;
  /** 界面拒绝。不执行，也不等于批准。 */
  reject(planId: string, reason: string): Promise<PlanDto>;
  pending(): PlanDto[];
  /** 差异预览（agent 计划批准前必须调用；界面据此显示 DiffView） */
  review(planId: string): Promise<PlanReview>;
}
export interface AgentOps {
  /** agent 只能提出计划；计划在界面里等用户批准 */
  propose(title: string, ops: ProposedOp[]): Promise<{ plan: PlanDto; preview: PlanPreview }>;
  get(planId: string): Promise<PlanDto | null>;
}

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

export class OperationService {
  private gateway: PlanGateway;
  private staged = new Map<string, Buffer>();
  private drafts = new Map<string, PlanDto>();
  /** planId → 用户看过差异预览时的内容哈希 */
  private reviewed = new Map<string, string>();
  constructor(
    private svc: WorkbenchService,
    private plans: KbPlanService & { stageContent?(hash: string, bytes: Buffer): void },
  ) {
    this.gateway = new PlanGateway(plans);
  }

  private toPlanOps(ops: ProposedOp[]): Omit<PlanOp, 'opId'>[] {
    return ops.map((o) => {
      const r = this.svc.getResource(o.resourceId);
      if (!r) throw new Error(`资源不存在: ${o.resourceId}`);
      const base = { kind: o.kind, resourceId: o.resourceId, rootId: r.rootId, relPath: r.relPath } as Omit<PlanOp, 'opId'>;
      if (o.kind === 'write') {
        const bytes = Buffer.isBuffer(o.content) ? o.content : Buffer.from(String(o.content ?? ''), 'utf8');
        const h = sha(bytes);
        this.plans.stageContent?.(h, bytes);
        this.staged.set(h, bytes);
        return { ...base, contentHash: h, expectedHash: o.expectedHash ?? null };
      }
      if (o.kind === 'move') {
        const toRootId = o.toRootId && o.toRootId !== r.rootId ? o.toRootId : undefined;
        return { ...base, toRelPath: String(o.toRelPath ?? ''), ...(toRootId ? { toRootId } : {}) };
      }
      return base;
    });
  }

  private async propose(actor: string, title: string, ops: ProposedOp[]) {
    const r = await this.gateway.create(actor, title, this.toPlanOps(ops));
    this.drafts.set(r.plan.planId, r.plan);
    return r;
  }

  private async review(planId: string): Promise<PlanReview> {
    const plan = await this.gateway.get(planId);
    if (!plan) throw new ApprovalError('计划不存在', 'unknown-op');
    const preview = await this.plans.previewPlan(planId);
    const diffs: PlanReview['diffs'] = {};
    for (const o of plan.ops) {
      if (o.kind !== 'write') continue;
      const next = o.contentHash ? this.staged.get(o.contentHash) : undefined;
      if (!next) {
        diffs[o.opId] = { relPath: o.relPath, diff: null, note: '暂存内容缺失' };
        continue;
      }
      let before = '';
      try {
        const cur = this.svc.getResource(o.resourceId!) ? this.fileOpsRead(o.resourceId!) : null;
        if (cur === 'too-big') {
          diffs[o.opId] = { relPath: o.relPath, diff: null, note: '文件过大，无法逐行对比' };
          continue;
        }
        before = cur ?? '';
      } catch {
        before = '';
      }
      const after = decodeForEdit(next).text;
      if (after.includes('\u0000') || before.includes('\u0000')) diffs[o.opId] = { relPath: o.relPath, diff: null, note: '二进制内容，无法逐行对比' };
      else diffs[o.opId] = { relPath: o.relPath, diff: diffLines(before, after) };
    }
    this.reviewed.set(planId, plan.contentHash);
    return { plan, preview, diffs };
  }
  private fileOpsRead(resourceId: string): string | 'too-big' {
    const abs = this.svc.resolveResourcePath(resourceId);
    const st = fs.statSync(abs);
    if (st.size > REVIEW_MAX_BYTES) return 'too-big';
    return decodeForEdit(fs.readFileSync(abs)).text;
  }

  forUi(): UiOps {
    return {
      propose: (t, ops) => this.propose('user', t, ops),
      get: async (id) => this.gateway.get(id),
      approve: async (id, opIds, h) => {
        const plan = await this.gateway.get(id);
        if (plan && plan.actor.startsWith('agent:') && this.reviewed.get(id) !== h) throw new ApprovalError('agent 提出的修改必须先查看差异预览再批准', 'not-reviewed');
        const p = await this.gateway.approveAndApply(id, opIds, h, 'ui');
        if (p.status === 'applied') {
          for (const o of p.ops) {
            if (o.kind !== 'move' || !o.resourceId || !o.toRelPath) continue;
            if (p.results && p.results.some((r) => r.opId === o.opId && !r.ok)) continue;
            if (!opIds.includes(o.opId)) continue;
            try {
              this.svc.adoptMove(o.resourceId, o.toRelPath, o.toRootId, p.actor === 'user' ? 'user' : p.actor);
            } catch (e) {
              console.error('[ops] 移动已落盘，但资源身份没有跟上', e);
            }
          }
        }
        this.drafts.delete(id);
        this.reviewed.delete(id);
        return p;
      },
      preview: async (id) => this.plans.previewPlan(id),
      reject: async (id, reason) => {
        const plan = await this.gateway.get(id);
        if (!plan) throw new ApprovalError('计划不存在', 'unknown-op');
        if (plan.status !== 'draft') throw new ApprovalError(`计划状态为 ${plan.status}，不能拒绝`, 'not-draft');
        if (!this.plans.discardPlan) throw new ApprovalError('计划服务不能拒绝', 'not-draft');
        const next = await this.plans.discardPlan(id, reason);
        this.drafts.delete(id);
        this.reviewed.delete(id);
        return next;
      },
      pending: () => {
        const maybe = this.plans as unknown as { listDrafts?: () => PlanDto[] };
        const fromAdapter = typeof maybe.listDrafts === 'function' ? maybe.listDrafts() : [];
        const map = new Map<string, PlanDto>();
        for (const p of fromAdapter) map.set(p.planId, p);
        for (const p of this.drafts.values()) map.set(p.planId, p);
        return [...map.values()].filter((p) => p.status === 'draft');
      },
      review: (id) => this.review(id),
    };
  }

  forAgent(name: string): AgentOps {
    const actor = `agent:${name.replace(/[^\p{L}\p{N}_.-]/gu, '').slice(0, 40) || 'unknown'}`;
    return { propose: (t, ops) => this.propose(actor, t, ops), get: async (id) => this.gateway.get(id) };
  }
}

/**
 * 本地计划服务：在 @kb/plan 验收前，用 WorkbenchService 已有的“预览 + 恢复记录”实现 KbPlanService 的形状（计划只存内存）。
 * 语义与磐石组本轮约定一致：批准绑定内容哈希；修改计划（updatePlan）后批准失效；批准由 PlanGateway 限定为界面；approve 后可 apply。
 */
export class LocalPlanService implements KbPlanService {
  private plans = new Map<string, PlanDto>();
  private content = new Map<string, Buffer>();
  constructor(private svc: WorkbenchService, private fileOps: FileOpsBackend) {}
  migrate() {}
  stageContent(hash: string, bytes: Buffer) {
    this.content.set(hash, bytes);
  }
  createPlan(input: { actor: string; title: string; ops: Omit<PlanOp, 'opId'>[] }): PlanDto {
    const planId = crypto.randomUUID();
    const ops = input.ops.map((o, i) => ({ ...o, opId: `op${i + 1}` }));
    const p: PlanDto = { planId, actor: input.actor, title: input.title, ops, status: 'draft', contentHash: planContentHash(ops), approval: null };
    this.plans.set(planId, p);
    return structuredClone(p);
  }
  /** 界面拒绝：只改状态，不执行。 */
  discardPlan(planId: string, reason: string): PlanDto {
    const p = this.must(planId);
    if (p.status !== 'draft') throw new Error(`计划状态为 ${p.status}，不能拒绝`);
    p.status = 'discarded';
    p.approval = null;
    p.error = reason;
    return structuredClone(p);
  }
  /** 修改计划：内容哈希改变，原批准失效 */
  updatePlan(planId: string, ops: PlanOp[]): PlanDto {
    const p = this.must(planId);
    p.ops = ops;
    p.contentHash = planContentHash(ops);
    p.approval = null;
    p.status = 'draft';
    return structuredClone(p);
  }
  previewPlan(planId: string): PlanPreview {
    const p = this.must(planId);
    return {
      planId,
      contentHash: p.contentHash,
      items: p.ops.map((o) => {
        try {
          const pv = o.kind === 'trash' ? this.svc.previewTrash(o.resourceId!) : o.kind === 'move' ? this.svc.previewMove(o.resourceId!, o.toRelPath!, o.toRootId) : this.svc.previewWrite(o.resourceId!, '');
          const conflicts = [...pv.conflicts];
          if (o.kind === 'write' && o.expectedHash !== undefined && o.expectedHash !== null && this.fileOps.stat(o.resourceId!).hash !== o.expectedHash) conflicts.push('文件在提出计划后已被修改');
          return { opId: o.opId, summary: o.kind === 'write' ? `写入「${o.relPath}」` : pv.summary, conflicts };
        } catch (e) {
          return { opId: o.opId, summary: `${o.kind}「${o.relPath}」`, conflicts: [String((e as Error).message)] };
        }
      }),
    };
  }
  approvePlan(planId: string, a: { approvedOpIds: string[]; contentHash: string; channel: 'ui' }): PlanDto {
    const p = this.must(planId);
    if (a.channel !== 'ui') throw new Error('只有用户界面能批准');
    if (a.contentHash !== p.contentHash) throw new Error('计划已修改，原批准失效');
    p.approval = { approvedOpIds: [...a.approvedOpIds], contentHash: a.contentHash, at: Date.now(), channel: 'ui' };
    p.status = 'approved';
    return structuredClone(p);
  }
  applyPlan(planId: string): PlanDto {
    const p = this.must(planId);
    if (p.status !== 'approved' || !p.approval || p.approval.contentHash !== p.contentHash) throw new Error('计划未批准或批准已失效');
    p.status = 'applying';
    const results: NonNullable<PlanDto['results']> = [];
    for (const o of p.ops) {
      if (!p.approval.approvedOpIds.includes(o.opId)) continue;
      try {
        if (o.kind === 'write') {
          const bytes = this.content.get(o.contentHash!);
          if (!bytes) throw new Error('暂存内容缺失');
          const r = this.fileOps.writeBytes(o.resourceId!, bytes, { expectedHash: o.expectedHash ?? this.fileOps.stat(o.resourceId!).hash, actor: p.actor, meta: { planId } });
          if (!r.ok) throw new Error('文件已被修改（冲突），未写入');
          results.push({ opId: o.opId, ok: true, undoToken: String(r.opId) });
        } else if (o.kind === 'move') results.push({ opId: o.opId, ok: true, undoToken: String(this.svc.move(o.resourceId!, o.toRelPath!, p.actor, o.toRootId).id) });
        else if (o.kind === 'trash') results.push({ opId: o.opId, ok: true, undoToken: String(this.svc.trash(o.resourceId!, p.actor).id) });
        else throw new Error(`不支持的操作: ${o.kind}`);
      } catch (e) {
        results.push({ opId: o.opId, ok: false, error: String((e as Error).message) });
      }
    }
    p.results = results;
    p.status = results.every((r) => r.ok) ? 'applied' : 'failed';
    return structuredClone(p);
  }
  getPlan(planId: string): PlanDto | null {
    const p = this.plans.get(planId);
    return p ? structuredClone(p) : null;
  }
  private must(id: string) {
    const p = this.plans.get(id);
    if (!p) throw new Error('计划不存在');
    return p;
  }
}
