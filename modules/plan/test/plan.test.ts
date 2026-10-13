import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { FileOp } from "@kb/fileops";
import { PlanError } from "../src/index.ts";
import { openFixture, seedResource, snapshot, type Fixture } from "./helpers.ts";

async function approveUi(fx: Fixture, planId: string, approvedOpIds?: string[]) {
  const cred = await fx.svc.getApprovalCredential({ planId, approvedOpIds, actor: "ui" });
  return fx.svc.approvePlan({ planId, approvedOpIds, contentHash: cred.contentHash, actor: "ui" });
}

const open: Fixture[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

it("migrate 只给 op_log 加 plan_id，并建自己的表", () => {
  const fx = openFixture("schema", { migratePlan: false });
  open.push(fx);
  fx.db.exec("CREATE TABLE roots (id TEXT)");
  fx.db.prepare("INSERT INTO roots (id) VALUES ('keep')").run();
  const before = columnNames(fx, "op_log");
  fx.svc.migrate();
  const key1 = fx.db.prepare("SELECT key FROM plan_approval_keys WHERE id = 1").get() as { key: Buffer };
  expect(Buffer.from(key1.key).length).toBe(32);
  fx.svc.migrate();
  const key2 = fx.db.prepare("SELECT key FROM plan_approval_keys WHERE id = 1").get() as { key: Buffer };
  expect(Buffer.from(key2.key).equals(Buffer.from(key1.key))).toBe(true);
  const after = columnNames(fx, "op_log");
  expect(after.filter((name) => !before.includes(name))).toEqual(["plan_id"]);
  const info = fx.db.prepare("PRAGMA table_info(op_log)").all() as Array<{ name: string; notnull: number }>;
  expect(info.find((col) => col.name === "plan_id")?.notnull).toBe(0);
  const tables = tableNames(fx);
  expect(tables).toEqual(expect.arrayContaining(["plans", "plan_steps", "op_log", "roots"]));
  expect(fx.db.prepare("SELECT id FROM roots").get()).toEqual({ id: "keep" });
});

it("五步预览无冲突，覆盖步是统一 diff，且不写盘也不调用 ensureResource", async () => {
  const fx = openFixture("preview");
  open.push(fx);
  const keepId = "res-keep";
  fs.writeFileSync(path.join(fx.root, "keep.txt"), "旧行甲\n旧行乙\n", "utf8");
  seedResource(fx.db, fx.rootId, "keep.txt", keepId);
  const before = snapshot(fx.root);
  const ops: FileOp[] = [
    { type: "create", rootId: fx.rootId, relPath: "fresh.txt", content: "新建正文\n" },
    { type: "write", rootId: fx.rootId, relPath: "keep.txt", content: "旧行甲\n新行乙\n" },
    { type: "rename", rootId: fx.rootId, fromRelPath: "fresh.txt", toRelPath: "renamed.txt" },
    { type: "move", rootId: fx.rootId, fromRelPath: "renamed.txt", toRelPath: "archive/renamed.txt" },
    { type: "delete", rootId: fx.rootId, relPath: "keep.txt" },
  ];
  const plan = await fx.svc.createPlan({ actor: "agent:planner", title: "五步", ops });
  expect(plan.status).toBe("draft");
  const opRows = fx.db.prepare("SELECT op, plan_id FROM op_log").all() as Array<{ op: string; plan_id: string }>;
  expect(opRows).toEqual([{ op: "plan", plan_id: plan.id }]);
  const preview = await fx.svc.previewPlan(plan.id);
  expect(preview.steps).toHaveLength(5);
  for (const step of preview.steps) {
    expect(step.conflicts, step.summary).toEqual([]);
  }
  expect(preview.steps[0]?.affectedResourceIds).toEqual([]);
  expect(preview.steps[1]?.affectedResourceIds).toEqual([keepId]);
  const diff = preview.steps[1]?.diff ?? "";
  expect(diff).toContain("---");
  expect(diff).toContain("+++");
  expect(diff).toContain("@@");
  expect(diff).toContain("旧行乙");
  expect(diff).toContain("新行乙");
  expect(diff).not.toContain("二进制文件");
  expect(preview.steps[4]?.affectedResourceIds).toEqual([keepId]);
  expect(snapshot(fx.root)).toEqual(before);
  expect(fx.ensureCalls()).toBe(0);
  const afterOps = fx.db.prepare("SELECT COUNT(*) AS n FROM op_log").get() as { n: number };
  expect(afterOps.n).toBe(1);
});

it("部分批准只执行被批准的步骤", async () => {
  const fx = openFixture("partial");
  open.push(fx);
  fs.writeFileSync(path.join(fx.root, "c.txt"), "C0", "utf8");
  const plan = await fx.svc.createPlan({
    actor: "ui",
    title: "部分",
    ops: [
      { type: "create", rootId: fx.rootId, relPath: "a.txt", content: "A" },
      { type: "create", rootId: fx.rootId, relPath: "b.txt", content: "B" },
      { type: "write", rootId: fx.rootId, relPath: "c.txt", content: "C2" },
    ],
  });
  const first = plan.steps[0]?.id;
  const third = plan.steps[2]?.id;
  if (!first || !third) throw new Error("steps missing");
  const applied = await approveUi(fx, plan.id, [first, third]);
  expect(applied.status).toBe("applied");
  expect(applied.steps.map((step) => step.approved)).toEqual([true, false, true]);
  expect(applied.steps.map((step) => step.status)).toEqual(["ok", "skipped", "ok"]);
  expect(fs.readFileSync(path.join(fx.root, "a.txt"), "utf8")).toBe("A");
  expect(fs.existsSync(path.join(fx.root, "b.txt"))).toBe(false);
  expect(fs.readFileSync(path.join(fx.root, "c.txt"), "utf8")).toBe("C2");
  expect(fx.sawOverwrite()).toBe(false);
});

it("第 4 步移动失败时回滚前 3 步，资料根与 apply 前一致", async () => {
  const fx = openFixture("rollback");
  open.push(fx);
  const oldKeep = Buffer.from("旧行甲\n旧行乙\n", "utf8");
  fs.writeFileSync(path.join(fx.root, "keep.txt"), oldKeep);
  const plan = await fx.svc.createPlan({
    actor: "agent:planner",
    title: "会失败",
    ops: [
      { type: "create", rootId: fx.rootId, relPath: "fresh.txt", content: "新建正文\n" },
      { type: "write", rootId: fx.rootId, relPath: "keep.txt", content: "旧行甲\n新行乙\n" },
      { type: "rename", rootId: fx.rootId, fromRelPath: "fresh.txt", toRelPath: "renamed.txt" },
      { type: "move", rootId: fx.rootId, fromRelPath: "renamed.txt", toRelPath: "blocked.txt" },
      { type: "delete", rootId: fx.rootId, relPath: "keep.txt" },
    ],
  });
  const preview = await fx.svc.previewPlan(plan.id);
  for (const step of preview.steps) expect(step.conflicts, step.summary).toEqual([]);
  const blocker = Buffer.from("别的内容\n", "utf8");
  fs.writeFileSync(path.join(fx.root, "blocked.txt"), blocker);
  const before = snapshot(fx.root);
  const applied = await approveUi(fx, plan.id);
  expect(applied.status).toBe("failed-rolled-back");
  expect(applied.steps.map((step) => step.status)).toEqual([
    "rolled-back",
    "rolled-back",
    "rolled-back",
    "failed",
    "not-run",
  ]);
  expect(snapshot(fx.root)).toEqual(before);
  expect(fs.readFileSync(path.join(fx.root, "blocked.txt"))).toEqual(blocker);
  expect(fs.readFileSync(path.join(fx.root, "keep.txt"))).toEqual(oldKeep);
  expect(fs.existsSync(path.join(fx.root, "fresh.txt"))).toBe(false);
  expect(fs.existsSync(path.join(fx.root, "renamed.txt"))).toBe(false);
  expect(fx.sawOverwrite()).toBe(false);
  expect(fx.restoreModes()).toEqual(["overwrite", "overwrite", "overwrite"]);
  const rows = fx.db.prepare("SELECT op, status, plan_id FROM op_log").all() as Array<{
    op: string;
    status: string;
    plan_id: string | null;
  }>;
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) expect(row.plan_id).toBe(plan.id);
  expect(rows.filter((row) => row.op === "plan")).toHaveLength(1);
  expect(rows.filter((row) => row.op === "move" && row.status === "rejected")).toHaveLength(1);
  expect(rows.filter((row) => row.op === "restore" && row.status === "ok").length).toBeGreaterThanOrEqual(3);
});

it("二进制覆盖说明大小和哈希，未知步骤不改变批准状态", async () => {
  const fx = openFixture("binary");
  open.push(fx);
  const before = Buffer.from([0, 255, 1]);
  const after = Buffer.from("text-ok");
  fs.writeFileSync(path.join(fx.root, "blob.bin"), before);
  const plan = await fx.svc.createPlan({
    actor: "agent:planner",
    title: "二进制",
    ops: [{ type: "write", rootId: fx.rootId, relPath: "blob.bin", content: after }],
  });
  const preview = await fx.svc.previewPlan(plan.id);
  const diff = preview.steps[0]?.diff ?? "";
  expect(preview.steps[0]?.conflicts).toEqual([]);
  expect(diff).toContain("二进制文件，显示大小和哈希变化");
  expect(diff).toContain(String(before.length));
  expect(diff).toContain(String(after.length));
  expect(diff).toContain(createHash("sha256").update(before).digest("hex"));
  expect(diff).toContain(createHash("sha256").update(after).digest("hex"));
  expect(fs.readFileSync(path.join(fx.root, "blob.bin"))).toEqual(before);

  await expect(
    fx.svc.approvePlan({
      planId: plan.id,
      approvedOpIds: ["missing-step"],
      contentHash: "00",
      actor: "ui",
    }),
  ).rejects.toBeInstanceOf(PlanError);
  const still = await fx.svc.getPlan(plan.id);
  expect(still.status).toBe("draft");
  expect(still.steps.every((step) => step.approved === false)).toBe(true);
  const disk = snapshot(fx.root);
  const cred = await fx.svc.getApprovalCredential({ planId: plan.id, actor: "ui" });
  const stale = cred.contentHash.slice(0, -1) + (cred.contentHash.endsWith("a") ? "b" : "a");
  await expect(
    fx.svc.approvePlan({ planId: plan.id, contentHash: stale, actor: "ui" }),
  ).rejects.toMatchObject({ code: "approval_stale" });
  expect(snapshot(fx.root)).toEqual(disk);
});

it("跨根 move 把 toRootId 交给 fileops", async () => {
  const fx = openFixture("cross");
  open.push(fx);
  const other = fx.addRoot("root-b", path.join(fx.base, "other"));
  fs.writeFileSync(path.join(fx.root, "a.txt"), "cross");
  const plan = await fx.svc.createPlan({
    actor: "agent:planner",
    title: "跨根",
    ops: [
      {
        type: "move",
        rootId: fx.rootId,
        fromRelPath: "a.txt",
        toRelPath: "dest/a.txt",
        toRootId: "root-b",
      },
    ],
  });
  const preview = await fx.svc.previewPlan(plan.id);
  expect(preview.steps[0]?.conflicts).toEqual([]);
  const applied = await approveUi(fx, plan.id);
  expect(applied.status).toBe("applied");
  expect(fs.existsSync(path.join(fx.root, "a.txt"))).toBe(false);
  expect(fs.readFileSync(path.join(other, "dest", "a.txt"), "utf8")).toBe("cross");
  expect(fx.sawOverwrite()).toBe(false);
});

it("读写身份不能批准，磁盘不变", async () => {
  const fx = openFixture("agent-deny");
  open.push(fx);
  fs.writeFileSync(path.join(fx.root, "note.txt"), "原字节", "utf8");
  const before = snapshot(fx.root);
  const plan = await fx.svc.createPlan({
    actor: "agent:writer",
    title: "agent 想直接批准",
    ops: [{ type: "write", rootId: fx.rootId, relPath: "note.txt", content: "被改掉" }],
  });
  await expect(
    fx.svc.getApprovalCredential({ planId: plan.id, actor: "agent:writer" }),
  ).rejects.toMatchObject({ code: "user_approval_required" });
  await expect(
    fx.svc.approvePlan({ planId: plan.id, contentHash: "not-a-credential", actor: "agent:writer" }),
  ).rejects.toMatchObject({ code: "user_approval_required" });
  expect(snapshot(fx.root)).toEqual(before);
  const still = await fx.svc.getPlan(plan.id);
  expect(still.status).toBe("draft");
  expect(still.steps.every((step) => step.status === "pending")).toBe(true);
});

it("修改步骤后旧 contentHash 不能批准", async () => {
  const fx = openFixture("stale-ops");
  open.push(fx);
  fs.writeFileSync(path.join(fx.root, "note.txt"), "原字节", "utf8");
  const plan = await fx.svc.createPlan({
    actor: "ui",
    title: "会被改掉",
    ops: [{ type: "write", rootId: fx.rootId, relPath: "note.txt", content: "第一版" }],
  });
  const cred = await fx.svc.getApprovalCredential({ planId: plan.id, actor: "ui" });
  await fx.svc.replaceOps({
    planId: plan.id,
    actor: "ui",
    ops: [{ type: "write", rootId: fx.rootId, relPath: "note.txt", content: "第二版" }],
  });
  const before = snapshot(fx.root);
  await expect(
    fx.svc.approvePlan({ planId: plan.id, contentHash: cred.contentHash, actor: "ui" }),
  ).rejects.toMatchObject({ code: "approval_stale" });
  expect(snapshot(fx.root)).toEqual(before);
  expect(fs.readFileSync(path.join(fx.root, "note.txt"), "utf8")).toBe("原字节");
});

it("界面拿凭据后批准会自动执行", async () => {
  const fx = openFixture("ui-run");
  open.push(fx);
  fs.writeFileSync(path.join(fx.root, "note.txt"), "旧", "utf8");
  const plan = await fx.svc.createPlan({
    actor: "agent:writer",
    title: "界面执行",
    ops: [{ type: "write", rootId: fx.rootId, relPath: "note.txt", content: "新" }],
  });
  const cred = await fx.svc.getApprovalCredential({ planId: plan.id, actor: "ui" });
  const applied = await fx.svc.approvePlan({
    planId: plan.id,
    contentHash: cred.contentHash,
    actor: "ui",
  });
  expect(applied.status).toBe("applied");
  expect(applied.steps[0]?.status).toBe("ok");
  expect(fs.readFileSync(path.join(fx.root, "note.txt"), "utf8")).toBe("新");
  await expect(
    fx.svc.approvePlan({ planId: plan.id, contentHash: cred.contentHash, actor: "ui" }),
  ).rejects.toMatchObject({ code: "approval_stale" });
  expect(fs.readFileSync(path.join(fx.root, "note.txt"), "utf8")).toBe("新");
});

it("getPlan 和 previewPlan 的 JSON 不含批准凭据", async () => {
  const fx = openFixture("no-leak");
  open.push(fx);
  fs.writeFileSync(path.join(fx.root, "note.txt"), "可见正文", "utf8");
  const created = await fx.svc.createPlan({
    actor: "agent:writer",
    title: "不泄漏",
    ops: [{ type: "write", rootId: fx.rootId, relPath: "note.txt", content: "下一版" }],
  });
  const cred = await fx.svc.getApprovalCredential({ planId: created.id, actor: "ui" });
  const preview = await fx.svc.previewPlan(created.id);
  const loaded = await fx.svc.getPlan(created.id);
  const keyRow = fx.db.prepare("SELECT key FROM plan_approval_keys WHERE id = 1").get() as { key: Buffer };
  const keyHex = Buffer.from(keyRow.key).toString("hex");
  for (const value of [created, preview, loaded]) {
    const json = JSON.stringify(value);
    expect(json).not.toContain(cred.contentHash);
    expect(json).not.toContain("approvalCredential");
    expect(json).not.toContain(keyHex);
    expect(json).not.toContain("contentHash");
  }
});

it("执行前目标文件被改则旧凭据失效", async () => {
  const fx = openFixture("stale-bytes");
  open.push(fx);
  const file = path.join(fx.root, "note.txt");
  fs.writeFileSync(file, "批准前");
  const plan = await fx.svc.createPlan({
    actor: "agent:writer",
    title: "字节变了",
    ops: [{ type: "write", rootId: fx.rootId, relPath: "note.txt", content: "计划内容" }],
  });
  const cred = await fx.svc.getApprovalCredential({ planId: plan.id, actor: "ui" });
  fs.writeFileSync(file, "外部改过");
  await expect(
    fx.svc.approvePlan({ planId: plan.id, contentHash: cred.contentHash, actor: "ui" }),
  ).rejects.toMatchObject({ code: "approval_stale" });
  expect(fs.readFileSync(file)).toEqual(Buffer.from("外部改过"));
  const still = await fx.svc.getPlan(plan.id);
  expect(still.status).toBe("draft");
});

it("回滚时外部改过的文件保留新字节，另一个文件回到执行前", async () => {
  const fx = openFixture("rollback-external");
  open.push(fx);
  const fileA = path.join(fx.root, "a.txt");
  const fileB = path.join(fx.root, "b.txt");
  fs.writeFileSync(fileA, "A0");
  fs.writeFileSync(fileB, "B0");
  const plan = await fx.svc.createPlan({
    actor: "ui",
    title: "两个覆盖",
    ops: [
      { type: "write", rootId: fx.rootId, relPath: "a.txt", content: "A1" },
      { type: "write", rootId: fx.rootId, relPath: "b.txt", content: "B1" },
    ],
  });
  const applied = await approveUi(fx, plan.id);
  expect(applied.status).toBe("applied");
  expect(fs.readFileSync(fileA)).toEqual(Buffer.from("A1"));
  expect(fs.readFileSync(fileB)).toEqual(Buffer.from("B1"));
  const child = spawnSync(
    process.execPath,
    ["-e", "require('node:fs').writeFileSync(process.argv[1], process.argv[2])", fileA, "A-external"],
    { encoding: "utf8" },
  );
  expect(child.status, child.stderr || child.stdout).toBe(0);
  const rolled = await fx.svc.rollbackPlan(plan.id);
  expect(fs.readFileSync(fileA)).toEqual(Buffer.from("A-external"));
  expect(fs.readFileSync(fileB)).toEqual(Buffer.from("B0"));
  const conflict = rolled.steps.find((step) => step.op.type === "write" && step.op.relPath === "a.txt");
  const restored = rolled.steps.find((step) => step.op.type === "write" && step.op.relPath === "b.txt");
  expect(conflict?.status).toBe("rollback-conflict");
  expect(conflict?.error ?? "").toContain("a.txt");
  expect(restored?.status).toBe("rolled-back");
  expect(rolled.error ?? "").toContain("a.txt");
  const rows = fx.db
    .prepare("SELECT op, error, plan_id, status FROM op_log WHERE op = 'rollback-conflict'")
    .all() as Array<{ op: string; error: string | null; plan_id: string | null; status: string }>;
  expect(rows).toHaveLength(1);
  expect(rows[0]?.plan_id).toBe(plan.id);
  expect(rows[0]?.error ?? "").toContain("a.txt");
  expect(rows[0]?.error ?? "").toContain("保留新内容");
});

function columnNames(fx: Fixture, table: string): string[] {
  return (fx.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((col) => col.name);
}

function tableNames(fx: Fixture): string[] {
  return (
    fx.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
  ).map((row) => row.name);
}
