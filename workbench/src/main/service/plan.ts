/**
 * H8：批量计划引擎接口。真实引擎 @kb/plan 另行开发；这里只定义接口，并提供一个基于现有 fileops 的桩实现。
 *
 * 契约（与 @kb/plan 对接时保持不变）：
 *  - preview(input) 无副作用：逐步校验并给出人类可读的说明与冲突；
 *  - execute(input, actor) 只在用户批准后调用；每步写 op_log（actor = 'plugin:<id>'），返回 opIds（可在操作记录中撤销）。
 *  - 引擎不做授权判断：调用前由 PluginHostService 检查 fileops.write / fs.read 范围。
 */
import type { FileopsPlan, FileopsPlanStep } from '../../shared/adapter-sdk/types';
import type { OpPreview } from '../../shared/types';

export interface PlanEngineHost {
  previewWrite(resourceId: string, content: string): OpPreview;
  previewMove(resourceId: string, newRelPath: string): OpPreview;
  previewTrash(resourceId: string): OpPreview;
  writeText(resourceId: string, content: string, actor: string): { id: number };
  move(resourceId: string, newRelPath: string, actor: string): { id: number };
  trash(resourceId: string, actor: string): { id: number };
  /** 当前内容的 sha256（hex），文件不存在返回 null */
  contentHash(resourceId: string): string | null;
}

export interface PlanStepCheck {
  step: FileopsPlanStep;
  preview: OpPreview | null;
  conflicts: string[];
}

export interface FileopsPlanEngine {
  readonly name: string;
  preview(plan: FileopsPlan): PlanStepCheck[];
  execute(plan: FileopsPlan, actor: string): { ok: true; opIds: number[] } | { ok: false; reason: 'conflict'; detail: string; opIds: number[] };
}

/** 桩引擎：顺序执行，不是事务（中途失败时已执行的步骤保留，可在操作记录中逐条撤销）。@kb/plan 接入后替换。 */
export class StubPlanEngine implements FileopsPlanEngine {
  readonly name = 'stub';
  constructor(private host: PlanEngineHost) {}

  preview(plan: FileopsPlan): PlanStepCheck[] {
    return plan.steps.map((step) => {
      const conflicts: string[] = [];
      let preview: OpPreview | null = null;
      try {
        if (step.op === 'write') preview = this.host.previewWrite(step.resourceId, step.content ?? '');
        else if (step.op === 'move') preview = this.host.previewMove(step.resourceId, step.toRelPath ?? '');
        else preview = this.host.previewTrash(step.resourceId);
        conflicts.push(...preview.conflicts);
        if (step.expectedHash) {
          const cur = this.host.contentHash(step.resourceId);
          if (cur !== step.expectedHash) conflicts.push('文件在计划生成后已被修改（内容哈希不一致）');
        }
      } catch (e) {
        conflicts.push(String((e as Error).message ?? e));
      }
      return { step, preview, conflicts };
    });
  }

  execute(plan: FileopsPlan, actor: string) {
    const opIds: number[] = [];
    for (const c of this.preview(plan)) {
      if (c.conflicts.length) return { ok: false as const, reason: 'conflict' as const, detail: c.conflicts.join('；'), opIds };
      const s = c.step;
      const r = s.op === 'write' ? this.host.writeText(s.resourceId, s.content ?? '', actor) : s.op === 'move' ? this.host.move(s.resourceId, s.toRelPath ?? '', actor) : this.host.trash(s.resourceId, actor);
      opIds.push(r.id);
    }
    return { ok: true as const, opIds };
  }
}
