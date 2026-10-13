# 13 控制台与 Agent 桥

> 本文按职责拼接：前半为控制台（F1/F2：格式、索引、打开与拖入），后半为文件 Agent 桥（G1/G2：目录、请求泵、计划审批与对账）。  
> 权威：`14-控制台与Agent桥-总包.md`。基线 `r11-base` = `30f956d`。基础能力不依赖模型 API Key、HTTP、MCP 或浏览器自动化。  
> 术语统一：命令 id / ActionId 同值（如 `console.openItem`、`workbench.pendingPlans`）；定义在控制台 Markdown，运行状态在 workspace layout；桥根在 `userData/agent-bridge/`，不进 `.kblayout.json`。

---

## 第一篇 · 控制台（F）

## 1. 文件是什么

控制台是普通 Markdown。它描述「打开哪些资料、以什么方式打开」。文件本身是资料库里的一等文件，有 `resourceId`。

识别条件（满足任一即可）：

- 文件名以 `.kbconsole.md` 结尾
- front matter 含 `kbConsole: 1`
- 正文里有一个有效的 `kind: "console"` 功能块

编码 UTF-8。围栏语言标签是 `kb-console`，同一行可以写 `v=1`。围栏里是**单一 JSON 对象**：不允许注释，不允许尾逗号。

```markdown
---
kbConsole: 1
title: 论文周复盘
description: 打开本周 PDF 与笔记
---

# 论文周复盘

```kb-console v=1
{
  "kind": "console",
  "version": 1,
  "index": {
    "titleNote": "本周材料",
    "items": []
  }
}
```
```

`kind` 与 `version` 必填。`version` 是正整数。`kind: "console"` 每个文件至多一个，它是主定义。其它围栏是插件块。

## 2. 索引 schema（version 1）

与 14 号 §二一致。

| 字段 | 含义 |
| --- | --- |
| `index.titleNote` | 给人看的总说明 |
| `index.items[]` | 条目。`order` 升序；相同 `order` 保持数组原序 |
| `id` / `title` | 条目稳定 id 与显示标题 |
| `ref` | `resource`（resourceId）、`workspace-ref`、或草稿期 `path-hint` |
| `openAs` | `tab` / `split-left` / `split-right` / `split-up` / `split-down` / `float` / `reveal-only` |
| `targetPanel` | 可选。已有 `itemId` 则聚焦；`adapterId` 可缺省 |
| `includeInGroupOpen` | 默认 true。false 的条目不进「开整组」 |
| `openGroup.mode` | `sequential` 或 `simultaneous`；后者 `maxConcurrent` 默认 8 |

`path-hint` 可以出现在草稿和文件里。正式打开前由 `resolveConsoleRef` 换成 `resourceId`（主进程 `consoleResolvePath` → `resourceIdFor`）。解析失败只让这一条失败。

未知 `openAs` 在打开时跳过并提示，不隐含成别的动作。

## 3. 坏块与未知版本

| 情况 | 行为 |
| --- | --- |
| 坏 JSON、缺字段、围栏未闭合、围栏版本与体内 version 不一致 | 该块无效。界面给出错误摘要。其它块继续 |
| `kind: "console"` 且体内 `version` 不是 1 | 整块只读，提示「未知控制台版本」，不执行打开。围栏写成 `v=1` 也不改这条 |
| 第二个 `kind: "console"` | 该块无效，提示每个文件至多一个 |
| 没有插件注册的 `kind` | 降级展示 JSON，不执行 |
| 插件 `version` 高于它声明的最高版本 | 只读，提示「未知控制台版本」 |
| JSON 里出现 `approved` / `approve` | 忽略并提示。不会批准任何计划 |

打开控制台文件**不会**自动开整组。阅读模式给出按 `order` 排列的列表和「开单项 / 开整组」按钮。编辑模式改的是文本定义。

命令 id：`console.openItem`、`console.openGroup`。打开实现在 `src/renderer/console/open/`。

- `tab`：同一资源已有面板则置前，否则新标签。
- `split-left` / `split-right` / `split-up` / `split-down`：相对当前活动面板分屏，并再开一份。
- `float`：先建面板，再调用现有 `panelManager.float`（自由窗口，`layout.windows`）。
- `reveal-only`：展开侧栏到该资料，不建面板。
- `targetPanel.itemId` 已在工作区里则只聚焦。
- 未知 `openAs` 跳过并写入失败摘要。
- 开整组默认按 `order` 顺序执行；`simultaneous` 时并发不超过 `maxConcurrent`（默认 8）。一条失败不挡住其它条。结果是 `{ ok, failed }`。
- 同 `resourceId` 用分屏或自由窗口可以再开一份。`tab` 才复用已有面板。

拖入索引只在编辑态改这份 Markdown，经现有 `textSave` 写回。悬停和拖过时的文案是「加入控制台索引（不移动原文件）」。阅读态放下同一 MIME 不会写文件，并提示先切换到编辑。操作系统直接拖来的文件被忽略。网页适配器（A）还没接到这个打开路径时，该条失败并说明原因，不另造打开方式。

## 4. 定义与运行状态

| 存在哪里 | 内容 | 谁写 |
| --- | --- | --- |
| 控制台 Markdown | 标题、说明、索引、打开方式 | 用户、草稿服务、以后的桥 |
| workspace layout（schema 4 / `layout.windows`） | 已打开的面板、分屏、浮窗、阅读状态 | 壳层。打开时写入，不把几何回写进控制台文件 |
| `agent-bridge/` | 请求与响应 | G1。不是控制台定义本身 |

控制台文件丢失时，已经打开的面板不因此被强制关闭。

## 5. 插件功能块

`pluginApi.consoleBlocks.register(ConsoleBlockContribution)`。

贡献包含 `kind`、能渲染的最高 `version`、`render`、可选 `actions`。`render` 返回带 `dispose` 的结果。

动作上下文只有：

- `ctx.commands.execute`
- `ctx.ops.propose`
- `ctx.log`

没有 `approve`。贡献里如果出现带 `approve` 的动作名，注册被拒绝并写入日志。运行时调用未声明的动作或 `approve`，记日志并空操作。

## 6. 草稿

`buildConsoleDraft({ title, description, items })` 返回可再解析的 Markdown 和一个 `kb-console` 围栏。

`writeConsoleDraft(svc, { rootId, relPath, ... })`（`src/main/console/draft.ts`）把文本写成根目录里的普通文件，再调用 `WorkbenchService.resourceIdFor` 得到 `resourceId`。它不自己写 SQLite 表，也不覆盖已有文件。渲染进程走 IPC `consoleWriteDraft`。G1 的 `console-draft` 应调用同一函数。

改已有控制台的索引用 `withIndexItems` / `replacePrimaryIndex` 得到新文本，再走现有 `textSave`（带基线哈希），避免未保存编辑和外部修改互相覆盖。

## 7. 与 14 号的对齐

| 14 号 | 本实现 |
| --- | --- |
| §1.2 文件形态、`kb-console`、严格 JSON | `parseConsoleDocument` |
| §1.3 未知 version / 坏块不执行 | 块状态 `unknown-version` / `invalid` |
| §1.4 定义在文件，运行状态在 layout | 本包不把窗口几何写回 Markdown |
| §2 索引字段、`openAs`、`ref` | `ConsoleIndex` / `ConsoleIndexItem` |
| §2.1 开单项 / 开整组 | `createConsoleOpener`，由 App 挂到上述命令 |
| §六 插件块 | `consoleBlocks.register` |
| 不直写 SQLite、无自批 | 草稿走 `resourceIdFor`；`approved` 只忽略 |

## 8. 代码位置

| 路径 | 职责 |
| --- | --- |
| `src/shared/consoleSchema.ts` | 类型、解析、排序、草稿文本、索引写回、拖拽 MIME 只读解析 |
| `src/main/console/draft.ts` | 落盘并入库 |
| `src/renderer/console/` | 渲染壳、命令登记、插件块上下文 |
| `src/renderer/console/open/` | F2：打开与拖入索引 |

---

## 第二篇 · 文件 Agent 桥（G）

## 9. 桥根（路径写死）

默认桥根：

```text
<userData>/agent-bridge/
```

`userData` 是应用 `app.getPath('userData')`。启动早期若 `src/main/userDataDir.ts` 把目录迁走，桥跟着新的 `userData`，不另选一套目录名。

覆盖（没有设置界面）：

- 环境变量 `KB_AGENT_BRIDGE_ROOT`（绝对路径，或相对 `userData`）
- `mountFileAgentBridge({ bridgeRoot })`

两者都空时用默认路径。桥根不能等于 `userData` 本身。

卸载仍按已定取舍保留 userData，桥目录一起留下。

## 10. 目录

名称固定，启动时创建。说明、`manifest.json`、`schemas/` 每次启动重写。`requests/`、`responses/`、`drafts/`、`snapshots/` 不因启动被清空。

```text
agent-bridge/
  AGENT_START_HERE.md
  manifest.json
  schemas/
    request.schema.json
    response.schema.json
    plan-draft.schema.json
    console-draft.schema.json
  snapshots/
  drafts/
  requests/
  responses/
```

`manifest.json` 字段：`bridgeVersion`、`appCommit`、`modulesCommit`、`capabilities`、`requestStates`、`notes`。默认 commit 为 `30f956d` / `c391925`，挂载时可以传入实际值。

## 11. 请求泵

监视 `requests/*.json`。优先用独立的 chokidar 实例（不接 identity-watch 的错误处理）；chokidar 加载失败则只轮询。文件名必须是 UUID v4。

状态：`pending` | `awaiting_approval` | `running` | `success` | `failed` | `conflict`。

- 缺字段、JSON 非法、文件名与 `requestId` 不一致、`type` 不在能力表里：立刻 `failed`，`error.code = incomplete_request`，不调用服务层。
- 请求类型写成 `approve` / `plans.approve` / `plans.apply`：`failed`，`error.code = approval_ui_only`。
- 同一 `requestId` 已有响应：返回该文件，不第二次执行。进程重启后也不自动重跑未终态请求（避免二次 `propose`）。对账留给 G2。
- 字段 `approved`、`approve`、`contentHash`（任意嵌套）删除并记入 `ignoredFields`。`expectedHash` 保留，它是写入乐观锁，不是批准凭据。

`plan-submit` 以及 `classify` 的磁盘移动：`pending` 然后 `awaiting_approval`。其它已受理请求：`pending` → `running` → 终态。

响应至少含 `requestId`、`status`、`updatedAt`。有计划时含 `planId`。

## 12. 能力与降级

| type | G1 行为 | 依赖未合入时 |
| --- | --- | --- |
| query | 列根、按 resourceId、按 rootId+relPath 列目录。快照在 `snapshots/<requestId>.json`，没有绝对路径 | 没有 `listDir` 时，目录列举返回 `not_available` |
| search-help | 中文说明如何用界面搜索 | 没有 `getIndexHealth` 时只给说明，健康字段为 null |
| console-draft | 写 `drafts/<requestId>.kbconsole.md`，不打开 | 没有 F1 `buildConsoleDraft` 时用内置最小模板 |
| open | 交给与 UI 相同的打开通道 | F2 未合入时发 `kb:agent-bridge-open`，由渲染进程用现有 openItem 处理 |
| invoke | 仅 `workbench.pendingPlans`、`index.showHealth` | 健康接口缺失时仍返回说明，不运行命令 |
| plan-submit | `forAgent(name).propose`。状态必须仍是 `draft`，否则 `conflict` | — |
| plan-status | `forAgent(name).get`，或经 `sourceRequestId` 读已有响应里的 `planId` | — |
| classify | `add` / `remove` 只改归类 | 自建目录服务未合入则 `not_available`，不改磁盘 |
| workspace-ref | `add` 只加引用，不复制文件。`remove` **本轮不执行** | 见下 |

`classify` 带 `action: "move"` 或 `toRelPath`：转成一条 `move` 计划并进入 `awaiting_approval`，不直接移动文件。

`workspace-ref` 的移除：响应 `success`，`result.executed = false`，说明「要在界面确认；不删原文件、不关面板、不动其它工作区」。没有对应的文件 op，所以不 `propose`。G2 或后续若要执行，必须走界面确认，不能在文件里写 `approved`。

操作种类只有 `write` | `move` | `trash`。

## 13. 批准

文件桥调用 `ops.forAgent(name)` 时只保留 `propose` 和 `get`。不调用 `approve`，也不给 `AgentOps` 增加 `approve`。若拿到的对象上已经有 `approve`，该请求 `failed` / `approval_ui_only`，并且不提案。

用户批准仍是 UI 的 `UiOps.approve(planId, opIds, seenContentHash)`。G1 不订阅批准结果。G2 把 `awaiting_approval` 接到 `success` / `failed` / `conflict`。

## 14. 挂到 wire.ts

只追加，不改 `approve` 签名，不打开 SQLite：

```ts
// ---- r11-G 文件 Agent 桥
void mountFileAgentBridge({
  userDataDir,
  svc,
  ops,
  getIndexHealth: () => getIndexHealth(), // E 已合入：只读健康
}).then((bridge) => {
  bundle.fileAgentBridge = bridge;
}).catch((err) => console.error('[agent-bridge] 启动失败', err));
```

`bundle.close` 里补 `await bundle.fileAgentBridge?.close()`。

`index.ts` 在 `await wireBackend(...)` 返回后的同一段同步代码里：

```ts
// ---- r11-G 文件 Agent 桥
svc.on('agent-bridge', (msg: { channel: string; payload: unknown }) => send(msg.channel, msg.payload));
```

频道：`kb:agent-bridge-open`、`kb:agent-bridge-invoke`。泵在第一次让出微任务之后才扫请求，所以上面的监听要赶在那之前挂上。

实现目录：`src/main/agent-bridge/`。模板嵌在 `embedded.ts`（由 `scripts/embed-templates.mjs` 从 `templates/` 生成），打包进主进程包时不依赖额外的 markdown loader。

## 15. 迁移与备份

- `.kbconsole.md` 是普通资料，走资料库备份。桥草稿在 `drafts/`，不是已经打开的布局。
- `agent-bridge/` 在 userData，**不要**写进工作区 `.kblayout.json`。本包不导出 `requests/`。
- 备份恢复之后，未终态请求不要自动再 `propose`。具体对账见 §17。
- 桥不写 `workbench.db`，不写 `modules.sqlite`。

## 16. 怎么验证

在包含本目录的树上：

```text
node e2e/e2e-agent-bridge.mjs
node e2e/e2e-agent-plan.mjs
```

两个脚本都不发起 HTTP。G1 写请求、读响应。G2 在此之上检查人批回写、伪 `approved`、哈希冲突、外改、拒绝和重启不执行。真实 `op_log` actor 见 `tests/agent-plan-bridge.test.ts`（与界面 `opsApprove` 同一 `UiOps.approve`）。

## 17. 迁移 / 备份（G2）

桥目录在 userData 的 `agent-bridge/`。它**不是**工作区的一部分。

| 备份 | 桥怎么处理 |
| --- | --- |
| 工作区 `.kblayout.json` | **默认不进入**。导出时走 `omitAgentBridgeFromLayout`，路径或字段里出现 `agent-bridge` 会被丢掉。布局里没有请求、没有令牌、没有绝对路径。 |
| docs/12 迁移备份（`migration-backups/<时间>-before-import/` 与 `-manual/`） | 只含 `workbench.db`、`themes/`、`plugins/`。**不含** `agent-bridge/`。和现有策略一样，导入前备份和手动备份一共保留最近 **5** 份。恢复这种备份不会把未完成请求重新执行。 |
| 整份 userData 被拷回（连 `agent-bridge/` 一起） | 启动时对账，**不重放**。见下。 |
| 卸载 | 仍保留 userData，桥目录留在里面，不会自动执行。 |

启动对账只读计划服务，不调用 `approve`，不写 SQLite：

- 响应已经是 `success` / `failed` / `conflict`：原样留下。同一 `requestId` 再次出现也不再 `propose`、不再执行。
- 计划已执行成功，且 `contentHash` 仍是响应里保存的那一版：把响应写成 `success`，带上 op 摘要。这是补写结果，不是第二次执行。
- 计划已失败，且原因是外改 / 哈希 / 冲突：写成 `conflict`，`suggestedAction` 为 `re-propose`。回滚则是 `open-restore-ui`。
- 计划仍是草稿，哈希一致：保持 `awaiting_approval`。如果上次停在 `running`，改回 `awaiting_approval`，并写明没有自动再执行。
- 计划哈希和响应里保存的不一致：`conflict`，带上当前哈希和「请重新查看计划」。
- 对不上计划，或响应里没有保存的哈希：`conflict`，`suggestedAction` 为 `inspect-plan`。不执行。

批准绑定的是**提出时写入响应的 contentHash**（计划 ops 的规范化哈希，不是请求文件里的字段；请求里的 `contentHash` 仍会被忽略）。用户在界面点「批准并执行」时，`UiOps.approve(planId, opIds, seenContentHash)` 必须等于这一版。`updatePlan` 或内容变化之后，旧哈希不能批准，桥把该请求标成 `conflict`。

预览或执行时发现文件被外改、`expectedHash` 不符：`conflict`，建议 `re-propose`。桥不会自动再批准。

拒绝：待批准窗口里的「拒绝」调用 `UiOps.reject`，只把计划标成 `discarded`，不执行。响应变为 `failed`，`error.code` 为 `user_rejected`。**没有超时**。只关掉窗口不算拒绝，请求继续 `awaiting_approval`。

人批成功时响应会先记 `running` 再记 `success`。`success.result` 含保存的 `contentHash`、`opResults` 和摘要。op_log 的 actor 仍是 `agent:<名>`，因为执行走的是原来的计划，不是桥自己写的库。
