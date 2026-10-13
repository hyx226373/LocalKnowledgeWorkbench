import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Actor, Conflict, FileOp } from "@kb/fileops";
import { describeWriteChange, sha256 } from "./diff.ts";
import { PlanError } from "./errors.ts";
import { normalizeRelPath, pathKey } from "./lex.ts";
import type {
  ApprovalCredentialInput,
  ApprovePlanInput,
  CreatePlanInput,
  PlanDeps,
  PlanOp,
  PlanPreview,
  PlanRecord,
  PlanService,
  PlanStatus,
  PlanStepPreview,
  PlanStepRecord,
  ReplaceOpsInput,
  StepStatus,
} from "./types.ts";

interface PlanRow {
  id: string;
  actor: string;
  title: string;
  status: string;
  error: string | null;
}

interface StepRow {
  id: string;
  plan_id: string;
  seq: number;
  op_json: string;
  approved: number;
  status: string;
  op_id: string | null;
  summary: string | null;
  conflicts_json: string | null;
  affected_json: string | null;
  diff: string | null;
  error: string | null;
  after_hashes_json: string | null;
}

interface VFile {
  relPath: string;
  bytes: Buffer;
  resourceId: string | null;
}

type Inspect =
  | { kind: "file"; relPath: string; bytes: Buffer; resourceId: string | null }
  | { kind: "absent"; relPath: string }
  | { kind: "dir"; relPath: string }
  | { kind: "other"; relPath: string }
  | { kind: "bad"; conflict: Conflict };

const STEP_STATUSES = new Set<StepStatus>([
  "pending",
  "skipped",
  "ok",
  "failed",
  "rolled-back",
  "rollback-failed",
  "rollback-conflict",
  "not-run",
]);

const PLAN_STATUSES = new Set<PlanStatus>(["draft", "approved", "applied", "failed-rolled-back"]);

export function createPlanService(deps: PlanDeps): PlanService {
  if (!deps || typeof deps !== "object" || !deps.db) {
    throw new PlanError("invalid", "createPlanService: db 无效");
  }
  if (!deps.fileOps) throw new PlanError("invalid", "createPlanService: fileOps 无效");
  const db = deps.db;

  function migrate(): void {
    const opLog = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'op_log'")
      .get();
    if (!opLog) throw new PlanError("not_migrated", "plan.migrate 需要已有 op_log，请先 fileops.migrate()");
    const cols = db.prepare("PRAGMA table_info(op_log)").all() as Array<{ name: string }>;
    if (!cols.some((col) => col.name === "plan_id")) {
      db.exec("ALTER TABLE op_log ADD COLUMN plan_id TEXT");
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plan_steps (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        op_json TEXT NOT NULL,
        approved INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        op_id TEXT,
        summary TEXT,
        conflicts_json TEXT,
        affected_json TEXT,
        diff TEXT,
        error TEXT,
        after_hashes_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_plan_steps_plan ON plan_steps(plan_id, seq);
      CREATE TABLE IF NOT EXISTS plan_approval_keys (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        key BLOB NOT NULL
      );
    `);
    const stepCols = db.prepare("PRAGMA table_info(plan_steps)").all() as Array<{ name: string }>;
    if (!stepCols.some((col) => col.name === "after_hashes_json")) {
      db.exec("ALTER TABLE plan_steps ADD COLUMN after_hashes_json TEXT");
    }
    const existingKey = db.prepare("SELECT id FROM plan_approval_keys WHERE id = 1").get();
    if (!existingKey) {
      db.prepare("INSERT INTO plan_approval_keys (id, key) VALUES (1, ?)").run(randomBytes(32));
    }
  }

  function assertReady(): void {
    const cols = db.prepare("PRAGMA table_info(op_log)").all() as Array<{ name: string }>;
    const names = new Set(cols.map((col) => col.name));
    if (!names.has("plan_id")) throw new PlanError("not_migrated", "调用前需要先 migrate()");
    const plans = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plans'")
      .get();
    if (!plans) throw new PlanError("not_migrated", "调用前需要先 migrate()");
  }

  function createPlan(input: CreatePlanInput): Promise<PlanRecord> {
    assertReady();
    const actor = input?.actor;
    if (!isActor(actor)) throw new PlanError("invalid", "actor 必须是 ui 或 agent:<name>");
    if (typeof input.title !== "string" || input.title.length === 0) {
      throw new PlanError("invalid", "title 无效");
    }
    if (!Array.isArray(input.ops) || input.ops.length === 0) {
      throw new PlanError("invalid", "ops 不能为空");
    }
    const stored = input.ops.map((op, index) => {
      assertOp(op);
      return { id: randomUUID(), seq: index, json: serializeOp(op) };
    });
    const planId = randomUUID();
    const now = Date.now();
    const first = input.ops[0];
    const rootId = first ? rootIdOf(first) : null;
    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO plans (id, actor, title, status, error, created_at, updated_at)
         VALUES (?, ?, ?, 'draft', NULL, ?, ?)`,
      ).run(planId, actor, input.title, now, now);
      const insertStep = db.prepare(
        `INSERT INTO plan_steps (
           id, plan_id, seq, op_json, approved, status, op_id, summary, conflicts_json, affected_json, diff, error
         ) VALUES (?, ?, ?, ?, 0, 'pending', NULL, NULL, NULL, NULL, NULL, NULL)`,
      );
      for (const step of stored) insertStep.run(step.id, planId, step.seq, step.json);
      // 计划本身记一条 op_log。fileops 的 INSERT 列清单不含 plan_id，所以在这里写。
      db.prepare(
        `INSERT INTO op_log (
           id, ts, actor, op, resource_id, before_json, after_json, backup_ref, status, error, phase, root_id, temp_path, plan_id
         ) VALUES (?, ?, ?, 'plan', NULL, ?, ?, NULL, 'ok', NULL, 'committed', ?, NULL, ?)`,
      ).run(
        randomUUID(),
        now,
        actor,
        JSON.stringify({ title: input.title, steps: stored.length }),
        JSON.stringify({ planId, title: input.title }),
        rootId,
        planId,
      );
    });
    tx();
    return getPlan(planId);
  }

  async function previewPlan(planId: string): Promise<PlanPreview> {
    assertReady();
    const plan = requirePlan(planId);
    const steps = stepRows(plan.id);
    const simulated = await simulate(steps);
    const tx = db.transaction(() => {
      const update = db.prepare(
        `UPDATE plan_steps
         SET summary = ?, conflicts_json = ?, affected_json = ?, diff = ?
         WHERE id = ?`,
      );
      for (const step of simulated) {
        update.run(
          step.summary,
          JSON.stringify(step.conflicts),
          JSON.stringify(step.affectedResourceIds),
          step.diff,
          step.stepId,
        );
      }
    });
    tx();
    return { planId: plan.id, steps: simulated };
  }

  async function getApprovalCredential(input: ApprovalCredentialInput): Promise<{ contentHash: string }> {
    assertReady();
    requireUi(input?.actor);
    const plan = requirePlan(input.planId);
    if (plan.status !== "draft") throw new PlanError("approval_stale", "计划已不在草稿，不能再发批准凭据");
    const steps = stepRows(plan.id);
    const chosen = selectSteps(steps, input.approvedOpIds);
    return { contentHash: signContent(plan.id, steps, chosen) };
  }

  async function approvePlan(input: ApprovePlanInput): Promise<PlanRecord> {
    assertReady();
    requireUi(input?.actor);
    if (typeof input.contentHash !== "string" || input.contentHash.length === 0) {
      throw new PlanError("invalid", "contentHash 无效");
    }
    const plan = requirePlan(input.planId);
    if (plan.status !== "draft") throw new PlanError("approval_stale", "计划已变化或已执行，批准失效");
    const steps = stepRows(plan.id);
    const chosen = selectSteps(steps, input.approvedOpIds);
    const first = signContent(plan.id, steps, chosen);
    if (!sameSecret(first, input.contentHash)) {
      throw new PlanError("approval_stale", "批准内容已变化");
    }
    const second = signContent(plan.id, steps, chosen);
    if (second !== first) throw new PlanError("approval_stale", "目标文件在批准前已变化");
    const tx = db.transaction(() => {
      const update = db.prepare("UPDATE plan_steps SET approved = ? WHERE id = ?");
      for (const step of steps) update.run(chosen.has(step.id) ? 1 : 0, step.id);
      db.prepare("UPDATE plans SET status = 'approved', error = NULL, updated_at = ? WHERE id = ?").run(
        Date.now(),
        plan.id,
      );
    });
    tx();
    return executeApproved(plan.id);
  }

  function replaceOps(input: ReplaceOpsInput): Promise<PlanRecord> {
    assertReady();
    if (!isActor(input?.actor)) throw new PlanError("invalid", "actor 必须是 ui 或 agent:<name>");
    const plan = requirePlan(input.planId);
    if (plan.status !== "draft") throw new PlanError("invalid", "只能修改草稿中的步骤");
    if (!Array.isArray(input.ops) || input.ops.length === 0) throw new PlanError("invalid", "ops 不能为空");
    const stored = input.ops.map((op, index) => {
      assertOp(op);
      return { id: randomUUID(), seq: index, json: serializeOp(op) };
    });
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM plan_steps WHERE plan_id = ?").run(plan.id);
      const insertStep = db.prepare(
        `INSERT INTO plan_steps (
           id, plan_id, seq, op_json, approved, status, op_id, summary, conflicts_json, affected_json, diff, error
         ) VALUES (?, ?, ?, ?, 0, 'pending', NULL, NULL, NULL, NULL, NULL, NULL)`,
      );
      for (const step of stored) insertStep.run(step.id, plan.id, step.seq, step.json);
      db.prepare("UPDATE plans SET error = NULL, updated_at = ? WHERE id = ?").run(Date.now(), plan.id);
    });
    tx();
    return getPlan(plan.id);
  }

  async function rollbackPlan(planId: string): Promise<PlanRecord> {
    assertReady();
    const plan = requirePlan(planId);
    if (plan.status !== "applied") throw new PlanError("invalid", "只能回滚已执行的计划");
    const succeeded = stepRows(plan.id)
      .map(toStep)
      .filter((step) => step.status === "ok" && step.opId)
      .map((step) => ({ stepId: step.id, opId: step.opId as string }));
    const problems = await rollback(plan.id, succeeded);
    finishFailed(plan.id, problems.join("；"));
    if (problems.length === 0) {
      db.prepare("UPDATE plans SET error = NULL WHERE id = ?").run(plan.id);
    }
    return getPlan(plan.id);
  }

  async function executeApproved(planId: string): Promise<PlanRecord> {
    const plan = requirePlan(planId);
    if (plan.status !== "approved") throw new PlanError("invalid", `计划状态是 ${plan.status}，不能执行`);
    const actor: Actor = "ui";
    const steps = stepRows(plan.id).map(toStep);
    const succeeded: Array<{ stepId: string; opId: string }> = [];
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      if (!step) continue;
      if (!step.approved) {
        markStep(step.id, "skipped", null, null);
        continue;
      }
      let opId = "";
      try {
        const applied =
          step.op.type === "restore"
            ? await deps.fileOps.restore(step.op.opId, { actor, onConflict: step.op.onConflict })
            : await deps.fileOps.apply(step.op, { actor });
        opId = applied.opId;
        linkPlan(plan.id, applied.opId);
        if (applied.status !== "ok") {
          const reason = opError(applied.opId) ?? "执行未成功";
          markStep(step.id, "failed", applied.opId, reason);
          const problems = await rollback(plan.id, succeeded);
          markUnreached(steps, index + 1);
          finishFailed(plan.id, problems.length ? `${reason}；${problems.join("；")}` : reason);
          return getPlan(plan.id);
        }
        markOk(step.id, applied.opId, touchedDigests(step.op));
        succeeded.push({ stepId: step.id, opId: applied.opId });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (opId) linkPlan(plan.id, opId);
        markStep(step.id, "failed", opId || null, reason);
        const problems = await rollback(plan.id, succeeded);
        markUnreached(steps, index + 1);
        finishFailed(plan.id, problems.length ? `${reason}；${problems.join("；")}` : reason);
        return getPlan(plan.id);
      }
    }
    db.prepare("UPDATE plans SET status = 'applied', error = NULL, updated_at = ? WHERE id = ?").run(
      Date.now(),
      plan.id,
    );
    return getPlan(plan.id);
  }

  function getPlan(planId: string): Promise<PlanRecord> {
    assertReady();
    const plan = requirePlan(planId);
    return Promise.resolve(toRecord(plan, stepRows(plan.id)));
  }

  async function rollback(
    planId: string,
    succeeded: Array<{ stepId: string; opId: string }>,
  ): Promise<string[]> {
    const problems: string[] = [];
    for (const step of [...succeeded].reverse()) {
      const recorded = recordedDigests(step.stepId);
      const drifted = recorded.filter((item) => digestFile(item.rootId, item.relPath) !== item.sha256);
      if (recorded.length === 0 || drifted.length > 0) {
        const reason =
          recorded.length === 0
            ? "缺少执行后哈希，拒绝用旧备份覆盖"
            : drifted
                .map(
                  (item) =>
                    `${item.relPath} 执行后哈希 ${item.sha256}，当前 ${digestFile(item.rootId, item.relPath)}，保留新内容`,
                )
                .join("；");
        problems.push(`${step.stepId}: ${reason}`);
        markStep(step.stepId, "rollback-conflict", step.opId, reason);
        writeConflict(planId, step.stepId, reason, drifted);
        continue;
      }
      try {
        const restored = await deps.fileOps.restore(step.opId, { actor: "ui", onConflict: "overwrite" });
        linkPlan(planId, restored.opId);
        if (restored.status !== "ok") {
          const reason = opError(restored.opId) ?? "恢复失败";
          problems.push(`${step.stepId}: ${reason}`);
          markStep(step.stepId, "rollback-failed", step.opId, reason);
        } else {
          markStep(step.stepId, "rolled-back", step.opId, null);
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        problems.push(`${step.stepId}: ${reason}`);
        markStep(step.stepId, "rollback-failed", step.opId, reason);
      }
    }
    return problems;
  }

  function markUnreached(steps: PlanStepRecord[], fromIndex: number): void {
    for (let index = fromIndex; index < steps.length; index += 1) {
      const step = steps[index];
      if (!step) continue;
      markStep(step.id, step.approved ? "not-run" : "skipped", null, null);
    }
  }

  function finishFailed(planId: string, error: string): void {
    db.prepare(
      "UPDATE plans SET status = 'failed-rolled-back', error = ?, updated_at = ? WHERE id = ?",
    ).run(error, Date.now(), planId);
  }

  function linkPlan(planId: string, opId: string): void {
    if (!opId) return;
    db.prepare("UPDATE op_log SET plan_id = ? WHERE id = ?").run(planId, opId);
  }

  function opError(opId: string): string | null {
    const row = db.prepare("SELECT error FROM op_log WHERE id = ?").get(opId) as
      | { error: string | null }
      | undefined;
    return row?.error ?? null;
  }

  function markOk(id: string, opId: string, hashes: FileDigest[]): void {
    db.prepare(
      "UPDATE plan_steps SET status = 'ok', op_id = ?, error = NULL, after_hashes_json = ? WHERE id = ?",
    ).run(opId, JSON.stringify(hashes), id);
  }

  function recordedDigests(stepId: string): FileDigest[] {
    const row = db.prepare("SELECT after_hashes_json FROM plan_steps WHERE id = ?").get(stepId) as
      | { after_hashes_json: string | null }
      | undefined;
    return parseDigests(row?.after_hashes_json ?? null);
  }

  function writeConflict(planId: string, stepId: string, reason: string, drifted: FileDigest[]): void {
    const rootId = drifted[0]?.rootId ?? null;
    db.prepare(
      `INSERT INTO op_log (
         id, ts, actor, op, resource_id, before_json, after_json, backup_ref, status, error, phase, root_id, temp_path, plan_id
       ) VALUES (?, ?, 'ui', 'rollback-conflict', NULL, ?, NULL, NULL, 'rejected', ?, 'committed', ?, NULL, ?)`,
    ).run(
      randomUUID(),
      Date.now(),
      JSON.stringify({ stepId, drifted }),
      reason,
      rootId,
      planId,
    );
  }

  function markStep(id: string, status: StepStatus, opId: string | null, error: string | null): void {
    if (opId) {
      db.prepare("UPDATE plan_steps SET status = ?, op_id = ?, error = ? WHERE id = ?").run(
        status,
        opId,
        error,
        id,
      );
      return;
    }
    db.prepare("UPDATE plan_steps SET status = ?, error = ? WHERE id = ?").run(status, error, id);
  }

  function requirePlan(planId: string): PlanRow {
    if (typeof planId !== "string" || planId.length === 0) {
      throw new PlanError("invalid", "planId 无效");
    }
    const row = db.prepare("SELECT id, actor, title, status, error FROM plans WHERE id = ?").get(planId) as
      | PlanRow
      | undefined;
    if (!row) throw new PlanError("not_found", "计划不存在");
    return row;
  }

  function stepRows(planId: string): StepRow[] {
    return db
      .prepare(
        `SELECT id, plan_id, seq, op_json, approved, status, op_id, summary, conflicts_json, affected_json, diff, error, after_hashes_json
         FROM plan_steps WHERE plan_id = ? ORDER BY seq ASC`,
      )
      .all(planId) as StepRow[];
  }

  function toRecord(plan: PlanRow, rows: StepRow[]): PlanRecord {
    if (!isActor(plan.actor)) throw new PlanError("invalid", "计划 actor 无效");
    if (!isPlanStatus(plan.status)) throw new PlanError("invalid", "计划状态无效");
    return {
      id: plan.id,
      actor: plan.actor,
      title: plan.title,
      status: plan.status,
      error: plan.error,
      steps: rows.map(toStep),
    };
  }

  function toStep(row: StepRow): PlanStepRecord {
    return {
      id: row.id,
      seq: row.seq,
      op: deserializeOp(row.op_json),
      approved: row.approved === 1,
      status: isStepStatus(row.status) ? row.status : "pending",
      opId: row.op_id,
      resourceId: resourceIdOfOp(row.op_id),
      summary: row.summary,
      conflicts: parseConflicts(row.conflicts_json),
      affectedResourceIds: parseIds(row.affected_json),
      diff: row.diff,
      error: row.error,
    };
  }

  function resourceIdOfOp(opId: string | null): string | null {
    if (!opId) return null;
    const row = db.prepare("SELECT resource_id FROM op_log WHERE id = ?").get(opId) as
      | { resource_id: string | null }
      | undefined;
    if (typeof row?.resource_id !== "string" || row.resource_id.length === 0) return null;
    return row.resource_id;
  }

  async function simulate(rows: StepRow[]): Promise<PlanStepPreview[]> {
    const files = new Map<string, VFile>();
    const gone = new Set<string>();
    const rootCache = new Map<string, string | null>();
    const hasResources = Boolean(
      db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'resources'").get(),
    );
    const out: PlanStepPreview[] = [];
    for (const row of rows) {
      const op = deserializeOp(row.op_json);
      const preview = await previewOne(op, files, gone, rootCache, hasResources);
      out.push({ stepId: row.id, seq: row.seq, op, ...preview });
    }
    return out;
  }

  async function previewOne(
    op: PlanOp,
    files: Map<string, VFile>,
    gone: Set<string>,
    rootCache: Map<string, string | null>,
    hasResources: boolean,
  ): Promise<Omit<PlanStepPreview, "stepId" | "seq" | "op">> {
    if (op.type === "restore") {
      try {
        const result = await deps.fileOps.previewRestore(op.opId);
        return {
          summary: result.summary,
          conflicts: result.conflicts,
          affectedResourceIds: [],
          diff: null,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return emptyPreview(`无法恢复 ${op.opId}`, [{ code: "conflict", relPath: "", message }]);
      }
    }
    if (op.type === "create" || op.type === "write") {
      return previewPut(op, files, gone, rootCache, hasResources);
    }
    if (op.type === "move" || op.type === "rename") {
      return previewMove(op, files, gone, rootCache, hasResources);
    }
    return previewDelete(op, files, gone, rootCache, hasResources);
  }

  function previewPut(
    op: Extract<FileOp, { type: "create" | "write" }>,
    files: Map<string, VFile>,
    gone: Set<string>,
    rootCache: Map<string, string | null>,
    hasResources: boolean,
  ): Omit<PlanStepPreview, "stepId" | "seq" | "op"> {
    const lex = normalizeRelPath(op.relPath);
    if (!lex.ok) return emptyPreview(`无法${op.type === "create" ? "创建" : "覆盖"} ${op.relPath}`, [lex.conflict]);
    const rel = lex.relPath;
    const current = inspect(op.rootId, rel, files, gone, rootCache, hasResources);
    const conflicts: Conflict[] = [];
    if (current.kind === "bad") conflicts.push(current.conflict);
    const parent = parentConflict(op.rootId, rel, files, gone, rootCache, hasResources);
    if (parent) conflicts.push(parent);
    const bytes = contentBytes(op.content);
    if (!bytes) conflicts.push({ code: "conflict", relPath: rel, message: "内容必须是字符串或字节" });
    if (current.kind !== "bad") {
      if (op.type === "create") {
        if (current.kind === "file") conflicts.push({ code: "exists", relPath: rel, message: "文件已存在" });
        else if (current.kind !== "absent") {
          conflicts.push({ code: "conflict", relPath: rel, message: "路径已存在且不是普通文件" });
        }
      } else if (current.kind === "absent") {
        conflicts.push({ code: "missing", relPath: rel, message: "要覆盖的文件不存在" });
      } else if (current.kind !== "file") {
        conflicts.push({ code: "conflict", relPath: rel, message: "要覆盖的路径不是普通文件" });
      }
    }
    const verb = op.type === "create" ? "创建" : "覆盖写入";
    let diff: string | null = null;
    if (op.type === "write" && current.kind === "file" && bytes) {
      diff = describeWriteChange(rel, current.bytes, bytes);
    }
    const resourceId = current.kind === "file" ? current.resourceId : null;
    if (conflicts.length === 0 && bytes && current.kind !== "bad") {
      putFile(files, gone, op.rootId, rel, bytes, op.type === "create" ? null : resourceId);
    }
    return {
      summary: conflicts.length ? `无法${op.type === "create" ? "创建" : "覆盖"} ${rel}` : `${verb} ${rel}`,
      conflicts,
      affectedResourceIds: op.type === "create" ? [] : ids(resourceId),
      diff,
    };
  }

  function previewMove(
    op: Extract<FileOp, { type: "move" | "rename" }>,
    files: Map<string, VFile>,
    gone: Set<string>,
    rootCache: Map<string, string | null>,
    hasResources: boolean,
  ): Omit<PlanStepPreview, "stepId" | "seq" | "op"> {
    const verb = op.type === "rename" ? "重命名" : "移动";
    const toRootId = op.type === "move" && op.toRootId ? op.toRootId : op.rootId;
    const fromLex = normalizeRelPath(op.fromRelPath);
    const toLex = normalizeRelPath(op.toRelPath);
    const conflicts: Conflict[] = [];
    if (!fromLex.ok) conflicts.push(fromLex.conflict);
    if (!toLex.ok) conflicts.push(toLex.conflict);
    if (!fromLex.ok || !toLex.ok) {
      return emptyPreview(`无法${verb}`, conflicts);
    }
    const fromRel = fromLex.relPath;
    const toRel = toLex.relPath;
    const source = inspect(op.rootId, fromRel, files, gone, rootCache, hasResources);
    const dest = inspect(toRootId, toRel, files, gone, rootCache, hasResources);
    if (source.kind === "bad") conflicts.push(source.conflict);
    if (dest.kind === "bad") conflicts.push(dest.conflict);
    const parent = parentConflict(toRootId, toRel, files, gone, rootCache, hasResources);
    if (parent) conflicts.push(parent);
    const caseOnly = op.rootId === toRootId && fromRel !== toRel && pathKey(fromRel) === pathKey(toRel);
    if (op.rootId === toRootId && fromRel === toRel) {
      conflicts.push({ code: "conflict", relPath: toRel, message: "源路径和目标路径相同" });
    }
    if (source.kind === "absent") {
      conflicts.push({ code: "missing", relPath: fromRel, message: "源文件不存在" });
    } else if (source.kind !== "file" && source.kind !== "bad") {
      conflicts.push({ code: "conflict", relPath: fromRel, message: "源路径不是普通文件" });
    }
    if (!caseOnly && dest.kind === "file") {
      conflicts.push({ code: "exists", relPath: toRel, message: "目标文件已存在" });
    } else if (!caseOnly && (dest.kind === "dir" || dest.kind === "other")) {
      conflicts.push({ code: "conflict", relPath: toRel, message: "目标路径不是普通文件" });
    }
    const sourceId = source.kind === "file" ? source.resourceId : null;
    const destId = dest.kind === "file" ? dest.resourceId : null;
    const affected = ids(sourceId);
    if (destId && destId !== sourceId) affected.push(destId);
    if (conflicts.length === 0 && source.kind === "file") {
      dropFile(files, gone, op.rootId, fromRel);
      putFile(files, gone, toRootId, toRel, source.bytes, source.resourceId);
    }
    return {
      summary: conflicts.length ? `无法${verb} ${fromRel} → ${toRel}` : `${verb} ${fromRel} → ${toRel}`,
      conflicts,
      affectedResourceIds: affected,
      diff: null,
    };
  }

  function previewDelete(
    op: Extract<FileOp, { type: "delete" }>,
    files: Map<string, VFile>,
    gone: Set<string>,
    rootCache: Map<string, string | null>,
    hasResources: boolean,
  ): Omit<PlanStepPreview, "stepId" | "seq" | "op"> {
    const lex = normalizeRelPath(op.relPath);
    if (!lex.ok) return emptyPreview(`无法删除 ${op.relPath}`, [lex.conflict]);
    const rel = lex.relPath;
    const current = inspect(op.rootId, rel, files, gone, rootCache, hasResources);
    const conflicts: Conflict[] = [];
    if (current.kind === "bad") conflicts.push(current.conflict);
    else if (current.kind === "absent") {
      conflicts.push({ code: "missing", relPath: rel, message: "文件不存在" });
    } else if (current.kind !== "file") {
      conflicts.push({ code: "conflict", relPath: rel, message: "只能删除普通文件" });
    }
    const resourceId = current.kind === "file" ? current.resourceId : null;
    if (conflicts.length === 0) dropFile(files, gone, op.rootId, rel);
    return {
      summary: conflicts.length ? `无法删除 ${rel}` : `删除 ${rel}`,
      conflicts,
      affectedResourceIds: ids(resourceId),
      diff: null,
    };
  }

  function parentConflict(
    rootId: string,
    relPath: string,
    files: Map<string, VFile>,
    gone: Set<string>,
    rootCache: Map<string, string | null>,
    hasResources: boolean,
  ): Conflict | null {
    const parts = relPath.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      const parent = parts.slice(0, i).join("/");
      const hit = inspect(rootId, parent, files, gone, rootCache, hasResources);
      if (hit.kind === "bad") return hit.conflict;
      if (hit.kind === "file" || hit.kind === "other") {
        return { code: "conflict", relPath, message: "父路径不是目录" };
      }
    }
    return null;
  }

  function inspect(
    rootId: string,
    relPath: string,
    files: Map<string, VFile>,
    gone: Set<string>,
    rootCache: Map<string, string | null>,
    hasResources: boolean,
  ): Inspect {
    const key = fileKey(rootId, relPath);
    if (gone.has(key)) return { kind: "absent", relPath };
    const virt = files.get(key);
    if (virt) {
      return { kind: "file", relPath: virt.relPath, bytes: virt.bytes, resourceId: virt.resourceId };
    }
    const root = rootReal(rootId, rootCache);
    if (!root) {
      return {
        kind: "bad",
        conflict: { code: "conflict", relPath, message: `无法定位资料根 ${rootId}` },
      };
    }
    const located = locate(root, relPath);
    if (located.outside) {
      return {
        kind: "bad",
        conflict: { code: "outside-root", relPath, message: "路径未通过根目录校验" },
      };
    }
    if (located.kind === "absent") return { kind: "absent", relPath };
    if (located.kind === "dir") return { kind: "dir", relPath };
    if (located.kind !== "file") return { kind: "other", relPath };
    try {
      const bytes = fs.readFileSync(located.abs);
      return { kind: "file", relPath, bytes, resourceId: lookupResource(rootId, relPath, hasResources) };
    } catch {
      return { kind: "bad", conflict: { code: "conflict", relPath, message: "无法读取文件" } };
    }
  }

  function rootReal(rootId: string, cache: Map<string, string | null>): string | null {
    if (cache.has(rootId)) return cache.get(rootId) ?? null;
    let value: string | null = null;
    const table = db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'root_mounts'")
      .get();
    if (table) {
      const row = db
        .prepare(
          "SELECT local_path FROM root_mounts WHERE root_id = ? ORDER BY updated_at DESC LIMIT 1",
        )
        .get(rootId) as { local_path?: unknown } | undefined;
      if (typeof row?.local_path === "string" && row.local_path.length > 0 && fs.existsSync(row.local_path)) {
        try {
          value = fs.realpathSync(row.local_path);
        } catch {
          value = null;
        }
      }
    }
    cache.set(rootId, value);
    return value;
  }

  function lookupResource(rootId: string, relPath: string, hasResources: boolean): string | null {
    if (!hasResources) return null;
    try {
      const row = db
        .prepare("SELECT id FROM resources WHERE root_id = ? AND rel_path_key = ? AND missing = 0")
        .get(rootId, pathKey(relPath)) as { id?: unknown } | undefined;
      return typeof row?.id === "string" && row.id.length > 0 ? row.id : null;
    } catch {
      return null;
    }
  }

  function rootIdOf(op: PlanOp): string | null {
    if (op.type === "restore") {
      const row = db.prepare("SELECT root_id FROM op_log WHERE id = ?").get(op.opId) as
        | { root_id: string | null }
        | undefined;
      return row?.root_id ?? null;
    }
    return op.rootId;
  }

  function requireUi(actor: Actor): void {
    if (actor !== "ui") throw new PlanError("user_approval_required", "只有界面可以批准计划");
  }

  function selectSteps(steps: StepRow[], requested: string[] | undefined): Set<string> {
    const known = new Set(steps.map((step) => step.id));
    if (requested === undefined) return known;
    if (!Array.isArray(requested)) throw new PlanError("invalid", "approvedOpIds 无效");
    for (const id of requested) {
      if (typeof id !== "string" || !known.has(id)) {
        throw new PlanError("unknown_step", `未知 stepId: ${String(id)}`);
      }
    }
    return new Set(requested);
  }

  function signContent(planId: string, steps: StepRow[], chosen: Set<string>): string {
    const selected = steps.filter((step) => chosen.has(step.id));
    const ids = selected.map((step) => step.id).sort();
    const byId = new Map(selected.map((step) => [step.id, step]));
    const lines = ["kb-plan-approval-v1", `plan=${planId}`, `steps=${ids.join(",")}`];
    for (const id of ids) {
      const step = byId.get(id);
      if (!step) continue;
      const op = deserializeOp(step.op_json);
      lines.push("---");
      lines.push(`id=${id}`);
      lines.push(`op=${canonicalJson(step.op_json)}`);
      const files = approvalTargets(op)
        .map((target) => ({
          rootId: target.rootId,
          relPath: target.relPath,
          sha256: digestFile(target.rootId, target.relPath),
        }))
        .sort((a, b) => a.rootId.localeCompare(b.rootId) || a.relPath.localeCompare(b.relPath));
      for (const file of files) lines.push(`file=${file.rootId}|${file.relPath}|${file.sha256}`);
    }
    const key = approvalKey();
    return createHmac("sha256", key).update(lines.join("\n"), "utf8").digest("hex");
  }

  function approvalKey(): Buffer {
    const row = db.prepare("SELECT key FROM plan_approval_keys WHERE id = 1").get() as
      | { key: Buffer | Uint8Array }
      | undefined;
    if (!row?.key) throw new PlanError("not_migrated", "缺少批准密钥");
    return Buffer.from(row.key);
  }

  function approvalTargets(op: PlanOp): Array<{ rootId: string; relPath: string }> {
    if (op.type === "create" || op.type === "write" || op.type === "delete") {
      return [{ rootId: op.rootId, relPath: stableRel(op.relPath) }];
    }
    if (op.type === "rename") {
      return [{ rootId: op.rootId, relPath: stableRel(op.toRelPath) }];
    }
    if (op.type === "move") {
      return [{ rootId: op.toRootId && op.toRootId.length > 0 ? op.toRootId : op.rootId, relPath: stableRel(op.toRelPath) }];
    }
    return restoreTargets(op.opId);
  }

  function touchedPaths(op: PlanOp): Array<{ rootId: string; relPath: string }> {
    if (op.type === "rename" || op.type === "move") {
      const toRoot = op.type === "move" && op.toRootId ? op.toRootId : op.rootId;
      return dedupePaths([
        { rootId: op.rootId, relPath: stableRel(op.fromRelPath) },
        { rootId: toRoot, relPath: stableRel(op.toRelPath) },
      ]);
    }
    return approvalTargets(op);
  }

  function touchedDigests(op: PlanOp): FileDigest[] {
    return touchedPaths(op).map((target) => ({
      rootId: target.rootId,
      relPath: target.relPath,
      sha256: digestFile(target.rootId, target.relPath),
    }));
  }

  function restoreTargets(opId: string): Array<{ rootId: string; relPath: string }> {
    const row = db
      .prepare("SELECT op, root_id, before_json, after_json FROM op_log WHERE id = ?")
      .get(opId) as
      | { op: string; root_id: string | null; before_json: string | null; after_json: string | null }
      | undefined;
    if (!row) return [];
    const before = parseMeta(row.before_json);
    const after = parseMeta(row.after_json);
    const paths: Array<{ rootId: string; relPath: string }> = [];
    if (row.op === "move" || row.op === "rename") {
      if (before?.relPath) paths.push({ rootId: before.rootId || row.root_id || "", relPath: stableRel(before.relPath) });
      if (after?.relPath) paths.push({ rootId: after.rootId || row.root_id || "", relPath: stableRel(after.relPath) });
    } else {
      const relPath = after?.relPath || before?.relPath;
      if (relPath && row.root_id) paths.push({ rootId: row.root_id, relPath: stableRel(relPath) });
    }
    return dedupePaths(paths.filter((item) => item.rootId.length > 0 && item.relPath.length > 0));
  }

  function digestFile(rootId: string, relPath: string): string {
    const root = rootReal(rootId, new Map());
    if (!root) return "missing";
    const lex = normalizeRelPath(relPath);
    if (!lex.ok) return "missing";
    const located = locate(root, lex.relPath);
    if (located.outside || located.kind === "absent") return "missing";
    if (located.kind !== "file") return "not-file";
    try {
      return sha256(fs.readFileSync(located.abs));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return "missing";
      return "not-file";
    }
  }

  return {
    migrate,
    createPlan,
    previewPlan,
    getApprovalCredential,
    approvePlan,
    replaceOps,
    rollbackPlan,
    getPlan,
  };
}

interface FileDigest {
  rootId: string;
  relPath: string;
  sha256: string;
}

function emptyPreview(
  summary: string,
  conflicts: Conflict[],
): Omit<PlanStepPreview, "stepId" | "seq" | "op"> {
  return { summary, conflicts, affectedResourceIds: [], diff: null };
}

function ids(resourceId: string | null): string[] {
  return resourceId ? [resourceId] : [];
}

function fileKey(rootId: string, relPath: string): string {
  return `${rootId}\0${pathKey(relPath)}`;
}

function putFile(
  files: Map<string, VFile>,
  gone: Set<string>,
  rootId: string,
  relPath: string,
  bytes: Buffer,
  resourceId: string | null,
): void {
  const key = fileKey(rootId, relPath);
  gone.delete(key);
  files.set(key, { relPath, bytes, resourceId });
}

function dropFile(files: Map<string, VFile>, gone: Set<string>, rootId: string, relPath: string): void {
  const key = fileKey(rootId, relPath);
  files.delete(key);
  gone.add(key);
}

function locate(
  rootReal: string,
  relPath: string,
): { abs: string; kind: "absent" | "file" | "dir" | "other"; outside: boolean } {
  const segments = relPath.split("/");
  let current = rootReal;
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if (!seg) return { abs: current, kind: "other", outside: true };
    const next = path.join(current, seg);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(next);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") return { abs: next, kind: "other", outside: !insideRoot(rootReal, next) };
      const abs = path.join(current, ...segments.slice(i));
      return { abs, kind: "absent", outside: !insideRoot(rootReal, current) || !insideRoot(rootReal, abs) };
    }
    if (st.isSymbolicLink()) {
      let real: string;
      try {
        real = fs.realpathSync(next);
      } catch {
        return { abs: next, kind: "other", outside: true };
      }
      if (!insideRoot(rootReal, real)) return { abs: real, kind: "other", outside: true };
      if (i === segments.length - 1) return { abs: next, kind: "other", outside: false };
      current = real;
      continue;
    }
    if (!insideRoot(rootReal, next)) return { abs: next, kind: "other", outside: true };
    if (i === segments.length - 1) {
      if (st.isFile()) return { abs: next, kind: "file", outside: false };
      if (st.isDirectory()) return { abs: next, kind: "dir", outside: false };
      return { abs: next, kind: "other", outside: false };
    }
    if (!st.isDirectory()) return { abs: next, kind: st.isFile() ? "file" : "other", outside: false };
    current = next;
  }
  return { abs: current, kind: "dir", outside: false };
}

function insideRoot(rootReal: string, candidate: string): boolean {
  const norm = (value: string) => {
    let normalized = path.normalize(value);
    if (!/^[A-Za-z]:\\$/.test(normalized)) normalized = normalized.replace(/[\\/]+$/, "");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  const rel = path.relative(norm(rootReal), norm(candidate));
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false;
  return !rel.split(/[\\/]/).includes("..");
}

function contentBytes(content: string | Uint8Array): Buffer | null {
  if (typeof content === "string") return Buffer.from(content, "utf8");
  if (content instanceof Uint8Array) {
    return Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  }
  return null;
}

function isActor(actor: unknown): actor is Actor {
  return actor === "ui" || (typeof actor === "string" && /^agent:[^:]+$/.test(actor));
}

function isPlanStatus(status: string): status is PlanStatus {
  return PLAN_STATUSES.has(status as PlanStatus);
}

function isStepStatus(status: string): status is StepStatus {
  return STEP_STATUSES.has(status as StepStatus);
}

function assertOp(op: PlanOp): void {
  if (!op || typeof op !== "object") throw new PlanError("invalid", "步骤无效");
  if (op.type === "restore") {
    if (typeof op.opId !== "string" || op.opId.length === 0) throw new PlanError("invalid", "opId 无效");
    if (op.onConflict !== "cancel" && op.onConflict !== "rename" && op.onConflict !== "overwrite") {
      throw new PlanError("invalid", "onConflict 无效");
    }
    return;
  }
  if (typeof op.rootId !== "string" || op.rootId.length === 0) {
    throw new PlanError("invalid", "rootId 无效");
  }
  if (op.type === "create" || op.type === "write") {
    if (typeof op.relPath !== "string" || op.relPath.length === 0) {
      throw new PlanError("invalid", "relPath 无效");
    }
    if (typeof op.content !== "string" && !(op.content instanceof Uint8Array)) {
      throw new PlanError("invalid", "内容必须是字符串或字节");
    }
    return;
  }
  if (op.type === "move" || op.type === "rename") {
    if (typeof op.fromRelPath !== "string" || op.fromRelPath.length === 0) {
      throw new PlanError("invalid", "fromRelPath 无效");
    }
    if (typeof op.toRelPath !== "string" || op.toRelPath.length === 0) {
      throw new PlanError("invalid", "toRelPath 无效");
    }
    if (op.type === "move" && op.toRootId !== undefined) {
      if (typeof op.toRootId !== "string" || op.toRootId.length === 0) {
        throw new PlanError("invalid", "toRootId 无效");
      }
    }
    return;
  }
  if (op.type === "delete") {
    if (typeof op.relPath !== "string" || op.relPath.length === 0) {
      throw new PlanError("invalid", "relPath 无效");
    }
    return;
  }
  throw new PlanError("invalid", "不支持的步骤类型");
}

interface StoredBytes {
  encoding: "base64";
  data: string;
}

function serializeOp(op: PlanOp): string {
  if (op.type === "restore") return JSON.stringify(op);
  if ((op.type === "create" || op.type === "write") && typeof op.content !== "string") {
    const buf = Buffer.from(op.content.buffer, op.content.byteOffset, op.content.byteLength);
    return JSON.stringify({ ...op, content: { encoding: "base64", data: buf.toString("base64") } satisfies StoredBytes });
  }
  return JSON.stringify(op);
}

function deserializeOp(json: string): PlanOp {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    throw new PlanError("invalid", "步骤内容损坏");
  }
  if (!value || typeof value !== "object") throw new PlanError("invalid", "步骤内容损坏");
  const record = value as { type?: unknown; content?: unknown };
  if (record.type === "restore") {
    const op = record as PlanOp;
    assertOp(op);
    return op;
  }
  if (
    (record.type === "create" || record.type === "write") &&
    record.content &&
    typeof record.content === "object"
  ) {
    const stored = record.content as StoredBytes;
    if (stored.encoding !== "base64" || typeof stored.data !== "string") {
      throw new PlanError("invalid", "步骤内容损坏");
    }
    const revived = { ...record, content: Buffer.from(stored.data, "base64") } as unknown as PlanOp;
    assertOp(revived);
    return revived;
  }
  const op = record as PlanOp;
  assertOp(op);
  return op;
}

function parseConflicts(json: string | null): Conflict[] {
  if (!json) return [];
  try {
    const value = JSON.parse(json) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter(isConflict);
  } catch {
    return [];
  }
}

function isConflict(value: unknown): value is Conflict {
  if (!value || typeof value !== "object") return false;
  const record = value as { code?: unknown; relPath?: unknown; message?: unknown };
  return (
    (record.code === "exists" ||
      record.code === "missing" ||
      record.code === "outside-root" ||
      record.code === "conflict") &&
    typeof record.relPath === "string" &&
    typeof record.message === "string"
  );
}

function sameSecret(expected: string, given: string): boolean {
  if (typeof expected !== "string" || typeof given !== "string") return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(given);
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function canonicalJson(json: string): string {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    throw new PlanError("invalid", "步骤内容损坏");
  }
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) out[key] = sortValue(record[key]);
  return out;
}

function stableRel(relPath: string): string {
  const lex = normalizeRelPath(relPath);
  return lex.ok ? lex.relPath : relPath;
}

function dedupePaths(
  paths: Array<{ rootId: string; relPath: string }>,
): Array<{ rootId: string; relPath: string }> {
  const seen = new Set<string>();
  const out: Array<{ rootId: string; relPath: string }> = [];
  for (const item of paths) {
    const key = `${item.rootId}\0${item.relPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function parseMeta(json: string | null): { rootId?: string; relPath?: string } | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as unknown;
    if (!value || typeof value !== "object") return null;
    const record = value as { rootId?: unknown; relPath?: unknown };
    return {
      rootId: typeof record.rootId === "string" ? record.rootId : undefined,
      relPath: typeof record.relPath === "string" ? record.relPath : undefined,
    };
  } catch {
    return null;
  }
}

function parseDigests(json: string | null): FileDigest[] {
  if (!json) return [];
  try {
    const value = JSON.parse(json) as unknown;
    if (!Array.isArray(value)) return [];
    const out: FileDigest[] = [];
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const record = item as { rootId?: unknown; relPath?: unknown; sha256?: unknown };
      if (
        typeof record.rootId !== "string" ||
        record.rootId.length === 0 ||
        typeof record.relPath !== "string" ||
        record.relPath.length === 0 ||
        typeof record.sha256 !== "string" ||
        record.sha256.length === 0
      ) {
        continue;
      }
      out.push({ rootId: record.rootId, relPath: record.relPath, sha256: record.sha256 });
    }
    return out;
  } catch {
    return [];
  }
}

function parseIds(json: string | null): string[] {
  if (!json) return [];
  try {
    const value = JSON.parse(json) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string" && item.length > 0);
  } catch {
    return [];
  }
}
