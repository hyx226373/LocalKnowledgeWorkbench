# 组 4 接线说明（集成组）

组 4 没有改 `src/main/index.ts`、`src/preload/index.ts`、`src/renderer/App.tsx`、`src/shared/types.ts`、`src/shared/actions/registry.ts`、`watcher.ts`、`planBridge.ts`、`handlers.ts`、`validate.ts`、`operations.ts`、`WorkbenchService.ts`。下面这些线由集成组接。

## 1. 创建修订日志

桥根目录确定之后（`resolveBridgeRoot`）创建一份，退出时 `close()`。不要再创建目录监视。

```ts
import { createLiveRevisionLog } from './agentLive/revision';

const log = createLiveRevisionLog({
  bridgeRoot,
  appVersion: app.getVersion(),
  entryWriter,       // 组 3 LiveEntryWriter
  reconcileSource,   // 组 1 的资料清单，见下
  reconcileMs: 30_000,
});
```

- 默认 `appVersion` 在未传入时写成 `0.2.0`（当前 package.json）。不要写死样例里的 `0.2.2`。集成组传 `app.getVersion()`。
- 防抖默认 **300ms**（0.11 取代 0.2 的 250ms）。窗口从该工作区第一笔事件起算，中间再来的事件不把窗口往后推。`debounceMs: 0` 时用微任务把同一次同步调用合并掉。
- 发布同一时间只跑一个。发布过程中新来的事件只记进待发桶，当前这次发完立刻补发一次，不再等一轮 300ms。
- 组 1 订阅 `ResourceChangeFeed`（0.2.1 的 RootWatchers，不在 `7d8730a` 里）后调用 `log.append(workspaceId, events)`。组 4 不 import 组 1，也不创建 `fs.watch` / chokidar。
- 对账最长 30 秒，只补已经进过修订日志的资料（有指纹的才查）。新文件仍由组 1 发 `material.added`。`reconcileMs: 0` 关闭对账。

`reconcileSource.list(workspaceId)` 返回 `{ materialId, resourceId, sourceId, relPath, absPath }`。可直接包一层组 1 的 `AgentMaterialsStore.list`。

## 2. 活动工作区

`WorkbenchService.setCurrentWorkspace` 成功之后调用：

```ts
await log.setActiveWorkspace(id, name);
```

- 只改名称、id 不变：重写 marker，**不**增加 revision，也不增加 `currentRevision`。
- 换工作区：只在 `live/current/changes/` 追加一条 `workspace.switched`。这条的 `rev` 用 `currentRevision`（切换时 +1），不是工作区 revision。`toRevision` 才是目标工作区当时的 revision。
- 工作区自己的 jsonl 不写 `workspace.switched`。
- 活动工作区每次发布后，会把工作区 revision、oldest、snapshot、名称镜像到 `live/current/marker.json`，不因此增加 `currentRevision`。
- `wsDir` 为 `../ws/<workspaceId>`（正斜杠）。

## 3. 登记 agent.getContent / agent.getDiff

不要改 `registry.ts` 的逻辑。在 `src/shared/actions/install.ts`（或集成组自己的包文件）注册：

```ts
import { createRevisionHandlers, revisionActions } from '../main/agentLive/revision';

const handlers = createRevisionHandlers(log);
registerActions('agentLive.revision', revisionActions);
registerInvokeExecutor(AGENT_LIVE_ACTIONS.getContent, (args, signal) => handlers.getContent(args, signal));
registerInvokeExecutor(AGENT_LIVE_ACTIONS.getDiff, (args, signal) => handlers.getDiff(args, signal));
```

两条都是 `approvalRequired: false`、`bridgeInvokable: true`。

`agent.copyBridgeLink`、`agent.copyWorkspaceLink`、`agent.materials.*`（含 0.10 的 addCurrent、addSelection、pin、unpin、clearSession）不属于组 4。常量已经写在 `src/shared/agentLive/types.ts` 的 `AGENT_LIVE_ACTIONS` 里，由组 1、组 2 登记。

## 4. expectedFileHash（不要改 planBridge 核心）

`planBridge.ts` 只同步响应状态。执行在 `operations.applyPlan` / `planAdapter.approvePlan` / `index.ts` 的 `opsApprove`。组 4 的包装在 `src/main/agentLive/revision/planGuard.ts`。

1. `validate.ts` 的 `opOf` 必须把 `expectedFileHash`、`materialId`、`absPath` 原样留下。计划级 `contentHash` 继续忽略，不要把它当成文件哈希。已有的 `expectedHash` 是另一套字段，不要混用。
2. `handlers.ts` 的 `submitPlan` 在请求被接受之后、真正执行之前：

```ts
import { bindPlanSubmission, runBoundPlan } from '../agentLive/revision';

const binding = bindPlanSubmission({
  requestId,
  planId,
  workspaceId, // 读到请求时工作台的活动工作区，不要用请求 JSON 里的 workspaceId
  contentHash, // 可以传入，包装会故意不读
  ops,         // 校验前的原始 op，这样 expectedFileHash 还在
  resolvePath, // 用目录把 resourceId 解成 absPath，只在绑定这一刻调用
});
```

按 `requestId` / `planId` 放在内存里。

3. 在 `planAdapter.approvePlan` 调用 `real.approvePlan` 之前，以及 agent 计划走到 `operations.applyPlan` / `opsApprove` 之前：

```ts
const checked = runBoundPlan(binding, {
  activeWorkspaceId, // 只作废，不参与选路
  readFile: (absPath) => { try { return fs.readFileSync(absPath); } catch { return null; } },
}, (bound) => real.approvePlan(/* 必须用 bound.ops 里提交时的 absPath / resourceId / workspaceId */));

if (checked && typeof checked === 'object' && 'ok' in checked && checked.ok === false) {
  // 写桥响应：status 'conflict'，suggestedAction 're-read'，error 用 checked.error
  // 不要批准，不要写文件
}
```

缺少 `expectedFileHash` 的 write 不检查，照常执行。`agent-token.json` 直接拒绝，不读内容。`expectedFileHash` 接受裸 64 位 hex，也接受 `sha256:` 前缀。

4. `src/main/agent-bridge/types.ts` 的 `BridgeResponse.suggestedAction` 要加上 `'re-read'`。组 4 的包装用了自己的结果类型，所以不改那个文件也能通过本目录的类型检查。不改的话，集成组写成 `'re-read'` 时会被现有联合类型挡住。

## 5. 组 3 的 render

发布顺序已经在 `LiveRevisionLog` 里：

`content` → `diff` → `changes` 分段 → `changes/index.json` → **`entryWriter.render`** → `marker.json` → 再删除退役或过期分段。

`render(workspaceId, rev)` 必须写出 `snapshot.json`、`ENTRY.md`、`nav`，并可以刷新 PDF 文本。**不要写 `marker.json`。** 组 4 不会在 `render` 里面写 marker。

- 文本资料的 UTF-8 副本组 4 已经放进 `content/<materialId>/<64位hex>.txt`。`meta.json` 的未知字段会保留。组 4 在自己写入文本时把 `status: 'generating'` 改成 `ready`。组 3 可以先写 `status: 'generating'`。
- `snapshot.json` 顶层按 0.11 写上 `schemaVersion`、`appVersion`、`generatedAt`、`sections`。类型在 `LiveSnapshot`。
- 没有注入 `entryWriter` 时，`snapshotRevision` 停在上次成功的值（从未成功就是 0）。`snapshot.reset` 若带了 `snapshotRevision`，用事件里的值。
- `render` 抛错时，分段和状态文件已经写下，marker 不更新，这次 `append` 拒绝。下次打开会再 `render` 并补 marker，**不会**多写一行 jsonl。

## 6. 状态文件（与组 1 共用）

路径：`<bridgeRoot 的上一级>/agent-live-state.json`，也就是用户数据目录里、`agent-bridge` 旁边。`schemaVersion` 为 1。不要为修订号另开 SQLite 表。

组 4 拥有的字段：

- 顶层 `schemaVersion`、`current`、`workspaces`
- `current`：`workspaceId`、`currentRevision`、`revision`、`oldestRevision`、`segments`、`revisionTimes`、`pendingUnlinks`
- `workspaces.<id>`：`workspaceName`、`revision`、`oldestRevision`、`snapshotRevision`、`segments`、`revisionTimes`、`fingerprints`、`texts`、`pendingUnlinks`

其它顶层字段（建议组 1 用 `sessionMaterials`）和上述对象里的未知字段，组 4 保存时会从磁盘再读一次并原样写回。组 1 不要把资料清单塞进上面这些已知字段里。两边不要并发写同一个文件；组 4 的 `save` 不是跨进程锁。

`schemaVersion` 大于 1 时直接抛 `unsupported_schema`，不把文件改掉、也不把修订号归零。JSON 损坏才会改名为 `agent-live-state.json.bad`，再从桥目录的 marker 和分段把修订号抬回来。

## 7. 组 5

- 监视 `live/<scope>/` 目录，不要只监视 `marker.json` 这一个文件（原子替换会让单文件监视失效）。
- 看到新 marker 时，它点名的文件已经写完。再读 `changes/index.json`。
- 游标文件 `cursors/<agentId>.json` 由监听示例写。工作台只读。形状：`{ schemaVersion, agentId, workspaceId, revision, updatedAt }`。`revision < marker.oldestRevision` 时改读 `snapshot.json`。
- `live/current/changes/` 里只有 `workspace.switched`。
- 差异头是 `--- fromHash <hash>` 和 `+++ toHash <hash>`，hash 带 `sha256:` 前缀。文件名本身没有冒号：`diff/<materialId>/<fromHex>__<toHex>.diff`，文本是 `content/<materialId>/<hex>.txt`。
- 大于等于 64KB 的文本差异，jsonl 里不放 `diff` 字段，也不写 `diffSupported: false`。agent 用 `agent.getDiff` 现算。PDF、Office 才写 `diffSupported: false`。

## 8. 其它

- `AGENT_START_HERE.md` 顶部加「现场入口：live/current/ENTRY.md」是集成组的事。
- 不要改 `watcher.ts`。
- 清理时先把 `oldestRevision` 写进 index 和 marker，再删过期分段。保留规则是「最近 1000 版」和「最近 14 天」里留得更多的那一边：某一版要同时老于 14 天、又不在最近 1000 版里，才会丢掉。
- 0.10 的 `material.pinned`、`material.unpinned`、`session.cleared` 会原样进 jsonl。`material.added` 可带 `tier`，`session.cleared` 可带 `materialIds`。`size`、`mtimeMs`、`workspaceName` 不进 jsonl。
- 批量加入：组 1 同步登记并给出界面反馈之后再 `append`。同一 300ms 窗口里的多次加入合成一个版本。`material.added` 不读文件。哈希和差异走 `content.changed`（可与加入落在同一窗口，或之后另发一版）。
- 原子替换遇到 `EPERM`、`EEXIST`、`EACCES`、`EBUSY` 时按 20ms、40ms、80ms、160ms 退避，最多 5 次。仍失败就留下 `*.tmp`，下次启动再提升。残缺 tmp 会删掉。
- 入口和导航不要写凭据，不要读出 `agent-token.json`。
