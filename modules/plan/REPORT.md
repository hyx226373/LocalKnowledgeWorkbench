# @kb/plan P1 批量计划审批

## 结论

通过。`@kb/plan` 6 项、`@kb/agent-api` 10 项、`@kb/fileops` 17 项。未通过 0。indexer 按要求未跑。

## 库

1. `createPlanService({ db, fileOps })`：通过。
2. `migrate()` 只 `ALTER TABLE op_log ADD COLUMN plan_id`（可空），并建 `plans`、`plan_steps`。重复调用不改已有表：通过。测试「migrate 只给 op_log 加 plan_id，并建自己的表」。
3. fileops 的 INSERT 列清单未改。每步拿到 `opId` 后 `UPDATE op_log SET plan_id=? WHERE id=?`：通过。回滚测试里全部 `op_log.plan_id` 相同。
4. 计划本身另写一条 `op_log`，`op='plan'`，`plan_id` 为本计划 id：通过。
5. `createPlan` 不写用户文件。`actor` 用 fileops 的 Actor。`ops` 是 `FileOp[]`。`move` 可带 `toRootId`：通过。同根五步与跨根移动都测了。
6. `previewPlan` 不写盘。按顺序模拟，后步看得到前步的虚拟结果。新建且尚无资料 ID 时受影响列表为空。预览不调用 `ensureResource`：通过。`ensureCalls` 为 0，`op_log` 仍只有那一条 `plan`。
7. 覆盖已有文本给出统一 diff，含 `---`、`+++`、`@@`，能看到旧行和新行：通过。
8. 含 NUL 的覆盖，diff 含「二进制文件，显示大小和哈希变化」，并带前后大小和 sha256：通过。
9. `approvePlan` 不传 `approvedOpIds` 表示全部批准。未知 stepId 抛 `PlanError`，计划保持 `draft`：通过。
10. `applyPlan` 未批准时拒绝，消息含「必须先批准」，磁盘不变：通过。
11. 只按原顺序执行已批准步骤。`fileOps.apply` 不传 `overwrite: true`：通过。部分批准测试里 `sawOverwrite` 为 false。
12. 任一步失败则停，已成功步骤按相反顺序 `restore(opId, { actor, onConflict: 'overwrite' })`，状态 `failed-rolled-back`。全部成功为 `applied`：通过。
13. `getPlan`：通过。未知步骤被拒后用它读回 `draft`。

## 新验收

1. 五步（新建、覆盖 txt、改名、移动、删除）。预览无冲突，覆盖步是统一 diff，能看到「旧行乙」和「新行乙」：通过。
2. 部分批准只执行被批准的步骤。未批准的 `b.txt` 不出现，状态 `ok` / `skipped` / `ok`：通过。
3. 先全部批准。apply 前把第 4 步移动目标写成不同内容。第 4 步失败，前 3 步回滚，资料根与 apply 前逐字节一致，状态 `failed-rolled-back`，`op_log` 带同一个 `planId`。恢复三次都是 `overwrite`，移动那条是 `rejected`：通过。
4. readwrite 令牌直接 `ops.apply` 得到 403，响应含 `plan_required`，磁盘不变。只读令牌可以 `plans.create` + `plans.preview`，不能 `plans.approve` / `plans.apply`。越权 root 的 create 为 403，对方文件不变：通过。`modules\agent-api\test\plans.test.ts`。

## agent-api

1. JSON-RPC 与同名 MCP 工具 `plans.create`、`plans.preview`、`plans.approve`、`plans.apply`、`plans.get`：通过。`mcp.test.ts` 的工具名断言包含这五项。
2. 只读令牌可以 create、preview、get。`plans.approve` 和 `plans.apply` 在 `WRITE_METHODS` 里：通过。只读调用这两项为 403。
3. create 的 actor 固定为 `agent:<令牌名>`，请求里的 `actor: 'ui'` 被忽略：通过。`server.test.ts` 期望 `agent:writer`，演示期望 `agent:demo`。
4. create / write 的 `content` 用字符串，README 已写明：通过（验收请求用的是字符串）。非字符串 content 返回 400：未测。
5. 令牌只能操作自己的 `rootIds`。路径原样交给 fileops，没有自己重写 realpath：通过（越权 root 403；移动路径由 fileops 落盘）。
6. readwrite 的 `ops.apply` 改为 403，错误为 `plan_required`。只读令牌的 `ops.apply` 仍是 403：通过。`server.test.ts` 里只读 403 的断言还在。
7. 不拒绝 `ops.preview` 和 `ops.restore`：通过。移动前仍 preview；v11 的 cancel / rename / overwrite 磁盘断言保持；演示在计划移动之后 `ops.restore`。
8. MCP 里 `ops.preview`、`ops.apply`、`ops.restore` 的描述仍含「写操作先 preview」。`ops.apply` 同时写明 agent 令牌会被拒绝、必须走计划：通过。
9. `integrated-workbench.ts` 在 `fileops.migrate()` 之后调用 `plan.migrate()`。`search()` 和 `SearchHit` 未改。演示仍用 `hits[].relPath` 对 `note.txt`：通过。
10. README 最前面是 `## 稳定接口 v1.2`，写了计划方法和「agent 令牌调用 ops.apply 默认拒绝，必须走计划」：通过。
11. build 仍是 `tsc -p tsconfig.json && node scripts/fix-dts.mjs`。`scripts\fix-dts.mjs` 还在。公开 `dist/**/*.d.ts` 不引用 `@kb/plan`：通过。

## 已有测试（未放宽、未删场景）

1. `server.test.ts`：移动改为 plans.create + approve + apply。actor `agent:writer`、resourceId 非空、文件到 `archive/hello.txt`、`ops.log` 的 move、随后 `ops.restore` 还原字节和路径、没有 actor 为 `ui` 的记录：通过。
2. `v11.test.ts`：移动走计划，再 `ops.restore`。cancel / rename / overwrite 的磁盘断言保持：通过。
3. `scripts/demo.mjs`：移动改成计划。打印 `resourceId ...`、`movedRel archive/note.txt`、`restoredRel note.txt`、`demo ok`：通过。`demo.test.ts` 1 项。
4. `mcp.test.ts` 的工具名和「写操作先 preview」：通过。
5. 只读令牌 `ops.apply` 期望 403：通过。

## 验证

在各包目录执行，没有跑仓库根的 `npm install`，没有跑 indexer。

`modules\plan`：

```
npm run build
npx vitest run
```

Test Files 1 passed，Tests 6 passed。

`modules\agent-api`：

```
npm run build
npx vitest run
```

Test Files 5 passed，Tests 10 passed。

`modules\fileops`（源码和测试未改）：

```
npm run build
npx vitest run
```

Test Files 2 passed，Tests 17 passed。

`node_modules\@kb\plan` 与 `modules\agent-api\node_modules\@kb\plan` 都联接到 `modules\plan`。本包测试 import 源码，agent-api 通过包名用 dist。

## 未测

- 空数组 `approvedOpIds`（一步都不批准）未测。
- RPC 里 create/write 的 content 不是字符串时的 400 未测。
- 回滚时 `restore` 本身失败（步骤 `rollback-failed`）未测。
- indexer 未测。

## 需要决定的问题

统筹方是否接受 `op_log.op='plan'`。计划本身用这一条记录自己，`plan_id` 指向本计划。fileops 的 INSERT 列清单没有改。

## 第 9 轮

没有跑仓库根的 `npm test`。fileops、indexer、sync、identity-watch 源码未改。

`modules\plan`：

```
npm run build
npx vitest run
```

`npm run build` 通过（`tsc` 之后 `scripts/fix-dts.mjs`）。`npx vitest run`：Test Files 1 passed，Tests 12 passed。失败 0。

`modules\agent-api`：

```
npm run build
npx vitest run
```

`npm run build` 通过。`npx vitest run`：Test Files 5 passed，Tests 11 passed。失败 0。其中 `demo.test.ts` 打印了 `demo ok`，退出码 0。
