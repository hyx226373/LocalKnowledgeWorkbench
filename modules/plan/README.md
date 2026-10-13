## 稳定接口 v1.2

本包只导出 `createPlanService`、`PlanError` 和下面这些类型。建表只通过 `migrate()`。`db` 由调用方传入，并且必须先完成 `@kb/fileops` 的 `migrate()`。

```ts
import type { Database } from "better-sqlite3";
import type { Actor, FileOp, FileOps, OnConflict } from "@kb/fileops";

export function createPlanService(deps: { db: Database; fileOps: FileOps }): PlanService;

export type PlanOp =
  | FileOp
  | { type: "restore"; opId: string; onConflict: OnConflict };

export interface PlanService {
  migrate(): void;
  createPlan(input: { actor: Actor; title: string; ops: PlanOp[] }): Promise<PlanRecord>;
  previewPlan(planId: string): Promise<PlanPreview>;
  getApprovalCredential(input: {
    planId: string;
    approvedOpIds?: string[];
    actor: Actor;
  }): Promise<{ contentHash: string }>;
  approvePlan(input: {
    planId: string;
    approvedOpIds?: string[];
    contentHash: string;
    actor: Actor;
  }): Promise<PlanRecord>;
  replaceOps(input: { planId: string; ops: PlanOp[]; actor: Actor }): Promise<PlanRecord>;
  rollbackPlan(planId: string): Promise<PlanRecord>;
  getPlan(planId: string): Promise<PlanRecord>;
}
```

`actor` 用 fileops 的 `Actor`（`ui` 或 `agent:<name>`）。`ops` 是 `PlanOp[]`：fileops 的 `FileOp`，或 `{ type: "restore", opId, onConflict }`。`move` 可以带可选 `toRootId`。`create` / `write` 的 `content` 在库内可以是字符串或 `Uint8Array`。

agent 只能创建、预览和查看计划。`approvePlan` 只接受上面这一种调用，并且只有 `actor === "ui"` 能批准。其他 actor 抛 `PlanError`，`code` 为 `user_approval_required`，不执行任何步骤。

批准凭据是 HMAC-SHA256。`migrate()` 把随机 32 字节密钥写入 `plan_approval_keys`，已有则不换。`getPlan`、`previewPlan`、`createPlan` 的对象里没有 `contentHash`、`approvalCredential` 或密钥。`getApprovalCredential` 也只有 `actor === "ui"` 能调用，只返回 `{ contentHash }`。agent 调用抛 `user_approval_required`。

规范串覆盖计划 id、将要批准的步骤 id（排序后）、这些步骤的完整 op 参数，以及每个目标文件当前内容的 sha256。文件不存在用字面量 `missing`。目标路径按 op 的 root 和相对路径确定。跨根 `move` 用目标根。`approvePlan` 用同一算法重算。提交的 `contentHash` 不一致，或执行前再算一次时文件哈希变了，都抛 `approval_stale`，不执行。

核对通过后服务立刻执行已批准步骤，调用方不用再执行第二次。再用旧 `contentHash` 执行会得到 `approval_stale`。`replaceOps` 给测试和界面改草稿步骤，改完后旧 `contentHash` 失效。`rollbackPlan` 只给测试显式回滚已执行的计划。这两个方法都不进 agent-api。

`approvedOpIds` 是计划步骤 id，不是 fileops 的 `opId`。不传这个字段表示全部批准。传入未知步骤 id 会抛 `PlanError`，并且不改批准状态。

## 行为

`createPlan` 不写用户文件。它把计划和步骤存进自己的表，并另写一条 `op_log`：`op` 为 `plan`，`plan_id` 为本计划 id。fileops 的 INSERT 列清单没有 `plan_id`，这一列由 `migrate()` 用 `ALTER TABLE op_log ADD COLUMN plan_id` 加上，可空。

`previewPlan` 不写盘，也不调用会插入 `resources` 的 `ensureResource`。按步骤顺序做虚拟模拟，后面的步骤看得到前面步骤的创建、覆盖、改名、移动和删除。每步返回摘要、冲突和受影响资料 ID。新建且库里还没有资料 ID 时，这个列表为空。资料 ID 只从已有的 `resources` 行读取（`root_id + rel_path_key`，`missing = 0`）。读文件字节时用 `root_mounts.local_path`，不另写一套给调用方用的 realpath 结果，路径文本仍按原样交给 fileops。

覆盖（`write`）附带 `diff`：

- 前后内容都是严格 UTF-8 且没有 NUL：统一 diff，含 `---`、`+++`、`@@`。
- 否则 `diff` 含「二进制文件，显示大小和哈希变化」，并带前后大小和 sha256。

`approvePlan` 核对凭据后按原顺序执行已批准步骤。`fileOps.apply` 不传 `overwrite: true`，actor 为 `ui`。`restore` 步骤调用 `fileOps.restore(opId, { actor: "ui", onConflict })`。任一步抛错，或返回的 `status` 不是 `ok`：停止，对已成功且执行后哈希仍一致的步骤按相反顺序 `fileOps.restore(opId, { actor: "ui", onConflict: "overwrite" })`，计划状态为 `failed-rolled-back`。全部成功为 `applied`。fileops 每返回一个 `opId`（含拒绝和恢复），都 `UPDATE op_log SET plan_id = ? WHERE id = ?`。

执行成功时把每个被改文件的执行后 sha256 记在步骤上。回滚前先算当前哈希。不一致就不调用会覆盖内容的 restore，保留新字节，该步骤状态为 `rollback-conflict`，并写一条 `op_log`：`op` 为 `rollback-conflict`，`plan_id` 为本计划，`error` 说明冲突。其余已成功文件照常回滚。

未批准的步骤不执行。状态取值：`draft`、`approved`、`applied`、`failed-rolled-back`。步骤还可以是 `rollback-conflict`。

## 表

| 表 | 说明 |
| --- | --- |
| `plans` | 计划头：actor、title、status、error |
| `plan_steps` | 有序步骤、批准标记、fileops 的 op id、预览摘要、执行后哈希 |
| `plan_approval_keys` | 一行 HMAC 密钥。只在库内，不出现在返回值里 |
| `op_log.plan_id` | 可空列。计划行和该计划触发的 fileops 行共用同一个值 |

不改 `op_log` 已有列名，不建 `roots` / `resources`。

## 开发

不依赖 Electron。测试可以 import 源码。

```powershell
npm install
npm run build
npx vitest run
```

`npm run build` 是 `tsc -p tsconfig.json`，然后 `node scripts/fix-dts.mjs`，把 `dist/**/*.d.ts` 里的相对 `./xxx.ts` 导入改成 `./xxx.js`。`main`、`types`、`exports` 指向 `dist`。
