现场入口：live/current/ENTRY.md

# 文件 Agent 桥 · 从这里开始

本文件是外部 agent 的唯一入口说明。基础接入只做三件事：读本说明、把请求写成 `requests/<requestId>.json`、读 `responses/<requestId>.json`。

不需要模型 API Key，不需要 HTTP，不需要 MCP，不需要浏览器自动化。不要连接回环 RPC，也不要读 `agent-token.json`。

## 目录（名称固定）

| 路径 | 谁写 | 你要做什么 |
| --- | --- | --- |
| `AGENT_START_HERE.md` | 工作台 | 只读 |
| `manifest.json` | 工作台 | 只读。看 `capabilities`、`capabilityDetails` 与 `requestStates` |
| `schemas/` | 工作台 | 只读。请求形状以这里的 JSON Schema 为准 |
| `requests/<requestId>.json` | 你 | 投入请求。`requestId` 必须是 UUID v4，且与文件名一致 |
| `responses/<requestId>.json` | 工作台 | 只读。不要创建、不要修改、不要删除 |
| `snapshots/` | 工作台 | 查询结果。只读，不要手改 |
| `drafts/` | 工作台 | 控制台草稿。不要把它当成已经打开的布局 |

桥根默认在应用用户数据目录下的 `agent-bridge/`。`manifest.json` 的 `notes` 与本文不一致时，以「批准只在界面」为准。

## 三步

1. 读 `manifest.json`，确认 `bridgeVersion` 为 1，且你要的 `type` 在 `capabilities` 里。每条能力的明细在 `capabilityDetails`，字段是 `name`、`description`、`params`、`availability`、`approvalRequired`、`resultSchema`。`availability` 不是 `available` 的项不要当成已经能用。
2. 写一个完整的 `requests/<requestId>.json`（UTF-8，单个 JSON 对象，不要尾逗号）。
3. 等到出现 `responses/<requestId>.json`，看 `status`。进行中会先看到 `pending` 或 `running`。写操作成功提案后是 `awaiting_approval`，这时去界面批准。

同一 `requestId` 只会执行一次。失败了要换一个新的 UUID，不要覆盖旧文件指望重跑。

## 状态

`pending` 已受理，还没有副作用。  
`running` 正在执行读、打开、草稿或呼出。  
`awaiting_approval` 计划已提出，等用户在界面批准。文件桥不会自己批准，也不会自己执行写盘。  
`success` 终态成功。  
`failed` 终态失败。不完整请求的 `error.code` 是 `incomplete_request`，并且没有任何副作用。  
`conflict` 计划内容变了、文件被外改，或重启后对不上。看 `suggestedAction`：`re-propose` 就换一个新的 requestId 重新提交；`inspect-plan` 先到界面看计划；`open-restore-ui` 到界面做恢复。不要在文件里自己把状态改成 `success`。桥不会自动再批准。

没有超时。关掉「待批准」窗口不算拒绝。只有界面上的「拒绝」才会变成 `failed`。批准绑定提出时响应里的 `contentHash`；计划被改过以后，旧的批准无效，响应变成 `conflict`。

## 能力

| type | 作用 | 会不会等人批 |
| --- | --- | --- |
| `query` | 列根，或按 `resourceId` / `rootId` 取元数据 | 否 |
| `search-help` | 说明如何在界面搜索，并附带索引健康摘要（若有） | 否 |
| `console-draft` | 在 `drafts/` 写 `.kbconsole.md`，不打开 | 否 |
| `classify` | 加入或移出全局自建目录（不改磁盘路径） | 真移动时会变成计划 |
| `workspace-ref` | 加入本工作区引用。移除只返回说明，不关面板、不删文件 | 否 |
| `open` | 按 `resourceId` + `openAs` 打开 | 否 |
| `invoke` | 只执行登记表里 `bridgeInvokable` 的 ActionId。当前是 `workbench.pendingPlans` 与 `index.showHealth` | 目标若 `approvalRequired` 则拒绝 |
| `plan-submit` | 提出 `write` / `move` / `trash` 计划 | 是 |
| `plan-status` | 按 `planId` 或 `sourceRequestId` 只读查询 | 否 |
| `state-export` | 只读导出 `workspace`、`resources`、`panels`、`unsaved`、`pendingPlans`、`results` | 否 |

`openAs` 只能是 `tab`、`split-left`、`split-right`、`split-up`、`split-down`、`float`、`reveal-only`。其它值不会打开任何东西。

## 硬规则

- 不要在请求或草稿里写 `approved`、`approve`、`contentHash`。这些字段会被忽略，响应里用 `ignoredFields` 列出，**不会**批准或执行计划。
- 批准只在工作台界面。桥没有批准入口。
- 不要改 `responses/`、`snapshots/`、`manifest.json`、本文件。
- 不要直接写 SQLite，不要改 `workbench.db` 或 `modules.sqlite`。
- 不要执行命令行。`invoke` 不是 shell。
- 计划里的操作只能是 `write`、`move`、`trash`。没有 `copy`。
- 真移动文件必须用 `plan-submit`（或 `classify` 里带 `toRelPath`，那也会转成计划）。分类本身不会移动磁盘文件。
- 快照和响应里不会给你绝对路径。引用资料只用 `resourceId`。
- 请求不完整（缺 `requestId`、缺 `type`、缺该 type 的必填字段、JSON 不合法、文件名与 `requestId` 不一致）会立刻 `failed`，不会执行。

## 示例：查询根

`requests/11111111-1111-4111-8111-111111111111.json`

```json
{
  "requestId": "11111111-1111-4111-8111-111111111111",
  "type": "query",
  "agentName": "file",
  "query": { "scope": "roots" }
}
```

成功时 `responses/11111111-1111-4111-8111-111111111111.json` 的 `status` 为 `success`，`result.roots` 是 `{ "id", "name" }` 数组。

按资料查询把 `query` 换成 `{ "resourceId": "<UUID>" }`。需要目录列举时用 `{ "rootId": "<根 id>", "relPath": "notes" }`。

## 示例：提交计划（不会自动执行）

`requests/33333333-3333-4333-8333-333333333333.json`

```json
{
  "requestId": "33333333-3333-4333-8333-333333333333",
  "type": "plan-submit",
  "agentName": "file",
  "title": "修正笔记标题",
  "ops": [
    {
      "kind": "write",
      "resourceId": "22222222-2222-4222-8222-222222222222",
      "content": "# 标题\n",
      "expectedHash": null
    }
  ]
}
```

不要加 `"approved": true`。加上也会被忽略，计划仍然停在待批准。

响应里看 `status: "awaiting_approval"` 和 `planId`。然后在工作台的「待批准」里查看差异并批准。批准绑定的是界面上看到的内容哈希，不是你写在文件里的任何字段。

移动示例：`{ "kind": "move", "resourceId": "<UUID>", "toRelPath": "archive/a.md" }`。  
移入暂存：`{ "kind": "trash", "resourceId": "<UUID>" }`。这不是「从自建目录取消归类」。取消归类用 `classify`。

## 示例：查计划

```json
{
  "requestId": "44444444-4444-4444-8444-444444444444",
  "type": "plan-status",
  "planId": "<上一步返回的 planId>"
}
```

也可以用 `"sourceRequestId": "33333333-3333-4333-8333-333333333333"` 代替 `planId`。

## 呼出与搜索

```json
{
  "requestId": "55555555-5555-4555-8555-555555555555",
  "type": "invoke",
  "invoke": { "actionId": "workbench.pendingPlans" }
}
```

旧请求仍可写 `invoke.commandId`。两个字段都写时必须是同一个 id。`index.showHealth` 返回只读健康摘要。其它 id 会失败，且不会运行。`approvalRequired` 为真的操作返回 `awaiting_approval`，不会执行。批准只在界面。

状态导出：

```json
{
  "requestId": "66666666-6666-4666-8666-666666666666",
  "type": "state-export"
}
```

`result` 含 `workspace`、`resources`、`panels`、`unsaved`、`pendingPlans`、`results`。身份用 `workspaceId`、`resourceId`、`itemId`、`planId`、`requestId`，不用绝对路径。`unsaved` 在这份主进程快照里是空数组。快照落在 `snapshots/state-<时间>.json`。

搜索正文请用工作台搜索框。`search-help` 只解释怎么搜，以及当前索引是否能搜正文。
