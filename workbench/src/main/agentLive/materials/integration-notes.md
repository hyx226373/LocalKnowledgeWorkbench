# 组 1 接线说明（集成组）

组 1 没有改 `src/main/index.ts`、`src/preload/index.ts`、`src/renderer/App.tsx`、`src/shared/types.ts`、`src/shared/actions/registry.ts`、`watcher.ts`。`src/shared/agentLive/types.ts` 与组 4 提交 `96cc3c9` 字节相同，不要在集成时再改这一份。

## 1. 创建资料清单

桥目录和用户数据目录确定之后创建一份。不要再创建根目录监视，也不要 `npm install`。

```ts
import { createAgentMaterialsStore, onMaterialsChange } from './agentLive/materials';
import { createLiveRevisionLog } from './agentLive/revision';

const materials = createAgentMaterialsStore({
  userDataDir, // app.getPath('userData')，测试用 KB_USER_DATA
  feed,        // 0.2.1 的 ResourceChangeFeed。7d8730a 里还没有这层，先包住现有根监视
  identity: {
    resolve(absPath) {
      // 已登记来源返回 { resourceId, sourceId: rootId, relPath }
      // 不在任何来源里返回 null。不要在这里扫整棵目录。
      return svc.resolveMaterialIdentity(absPath);
    },
  },
  pinned: layoutPinnedStore(svc),
  repairMs: 30_000,
});

onMaterialsChange(materials, (event) => {
  void log.append(event.workspaceId, [event]);
});
```

- `add` 仍返回冻结的 `'added' | 'duplicate'`。重复时用 `materials.find(workspaceId, ref)` 看 `tier`，界面才能区分「已在本轮资料中」和「已在固定资料中」。
- `pin` / `unpin` / `clearSession` 在具体类上。`clearSession` 返回被清掉的 `materialId`，并发出 `session.cleared`。冻结的 `MaterialEventType` 还没有这一条，运行时事件就是它；`onMaterialsChange` 已把类型补上。
- 第 201 项抛 `MaterialStoreError`，`code === 'limit'`。界面提示「每个工作区最多 200 项」。不要自动删旧项。
- 目录、`http(s)` 等没有原文件的内容、以及 `agent-token.json` 会抛错，`code` 分别是 `not_a_file` 和 `secret`。
- 退出时 `await materials.close()`。它会等后台哈希和粗估结束。

`reconcileSource` 可以直接包 `materials.list`。组 4 的 30 秒对账只补修订日志；清单自己的 `repairMs` 也是 30 秒，只 `stat` 已经在清单里的文件（最多 200 个），不扫资料库。

## 2. 固定资料进现有 layout 表，本轮资料不进工作区

固定资料是永久编排。集成组用现有 `layout` 键，不要新开 SQLite 表，也不要写进 `layout_json` / 工作区模板：

- 键：`agent.materials.pinned:<workspaceId>`
- 值：`{ schemaVersion: 1, items: [...] }`
- 旧数据如果是数组，组 1 会当成 v0 读入，下次保存写成 v1

```ts
const PREFIX = 'agent.materials.pinned:';

function layoutPinnedStore(svc: WorkbenchService): WorkspaceRecordStore {
  return {
    read: (id) => svc.getLayout(PREFIX + id),
    write: (id, value) => svc.setLayout(PREFIX + id, value),
    keys: () => svc.layoutKeys(PREFIX).map((key) => key.slice(PREFIX.length)),
  };
}
```

`layoutKeys` 现在没有。按 `workspaceRefs.ts` 的前缀查询加一个只读方法即可，不要改收藏和虚拟目录的键。

导出工作区时带上这个键。导入时写回。**不要**把 `agent-live-state.json` 里的 `sessionMaterials` 放进导出、模板或工作区配置。删除工作区时删掉对应的 pinned 键；本轮资料留在状态文件里无妨，清单按工作区 id 取不到就不会显示。

没有注入 `pinned` 时，默认文件是 `<userData>/agent-materials/pinned.json`。那只给测试和未接线的进程用，集成后不要两处同时写。

## 3. 和组 4 共用 agent-live-state.json

本轮资料只写顶层 `sessionMaterials`：

```json
{ "v": 1, "byWorkspace": { "<workspaceId>": [ /* tier 恒为 session */ ] } }
```

- 组 4 拥有 `schemaVersion`、`current`、`workspaces.<id>` 里的修订字段。组 1 保存时整文件重读，只替换 `sessionMaterials`。
- 文件还不存在时，组 1 会补上 `schemaVersion: 1` 以及空的 `current` / `workspaces`，避免组 4 把缺字段的文件隔离掉。
- 组 4 的未知字段会原样留着。组 1 不会写 `current` 或 `workspaces.<id>` 里面的修订字段。
- 两边都没有跨进程文件锁。组 1 用同目录的 `agent-live-state.json.lock`（独占 mkdir）。请组 4 保存前也拿这把锁，或者由集成组串成同一个写队列。现在同时写会丢其中一边的更新。
- `schemaVersion` 不是 1，或 `sessionMaterials.v` 大于 1：抛 `unsupported_schema`，不改文件。

## 4. 加入时序和后台字段

`add` 在返回前只做身份、真实路径、`stat` 的大小和修改时间，并发出 `material.added`（带 `tier: "session"`）。哈希、正文粗估、PDF 页数在返回之后按文件排队。

- 排队期间 `contentHash === null` 且 `status === 'ok'` 表示还在算。组 3 据此显示「内容生成中」。
- 算完发一条 `content.changed`，带 `contentHash`、`size`、`mtimeMs`。第一次没有 `prevContentHash`。
- 文本（UTF-8、无 NUL、不超过 2MB）写 `readable: content/<materialId>/<64位hex>.txt`，不写 `diffSupported`。正文文件仍由组 4 在发布时落盘。组 1 不在资料区保存内容副本。
- PDF、Office、图片、超过 2MB 的文本：`diffSupported: false`。PDF 另给 `pages`（只扫 `/Count` 或 `/Type /Page`，扫不到是 null）。`estTokens` 只对能解码的文本有数字，其余保持 null。
- 粗估：每个中日韩字符计 1，其余字符计 0.25，向上取整。不跑分词器。合计超过 150k 只提示，组 1 不拦截。
- 大小、修改时间、哈希都没变，不发 `content.changed`。只改修改时间会发，`contentVersion` 不加。

## 5. 失效保留和根外单文件

- `unlink`、目录删除、`stat` 失败：条目留在清单里，`status: "missing"`，发 `material.missing`。不删原文件，也不从清单移除。
- 文件回到原路径或同一 `resourceId`：发 `material.restored`。路径变了同时发 `path.changed`。
- 根内文件只吃 `ResourceChangeFeed`。根外文件（`resourceId == null`）用 `fs.watch` 监视那一个文件，最多 200 个，防抖 300ms。不监视目录，不用 chokidar。
- 编辑器的 `.tmp`、`~`、`.swp` 目标被丢掉。`agent-token.json` 不接收、不监视。

## 6. ActionId

常量已在 `AGENT_LIVE_ACTIONS`。请登记，不要改 `registry.ts` 的原有逻辑：

| ActionId | 调用 | 界面 | 桥 |
| --- | --- | --- | --- |
| `agent.materials.add` | `add(workspaceId, ref, { purpose, index })` | 直接 | 要批准 |
| `agent.materials.remove` | `remove` | 直接 | 要批准 |
| `agent.materials.reorder` | `reorder` | 直接 | 要批准 |
| `agent.materials.setPurpose` | `setPurpose` | 直接 | 要批准 |
| `agent.materials.addCurrent` | 用当前阅读文件的真实路径调用 `add` | 直接 | 要批准 |
| `agent.materials.addSelection` | 对选中项逐个 `add`，同一轮里组 4 会合成一个版本 | 直接 | 要批准 |
| `agent.materials.pin` | `pin` | 直接 | 要批准 |
| `agent.materials.unpin` | `unpin` | 直接 | 要批准 |
| `agent.materials.clearSession` | `clearSession` | 直接，二次确认，说明不删文件 | 要批准 |

`addCurrent` 的默认快捷键候选是 `Ctrl+Shift+A`。先查冲突，不覆盖用户绑定，托管态不抢原应用按键。不要用 `Ctrl+Alt+A`。

`agent.copyBridgeLink` 和 `agent.copyWorkspaceLink` 不在组 1。组 1 不复制路径，也不写 ENTRY.md。

## 7. 清单顺序

`list` 先本轮、后固定，`order` 是这个合并列表里的下标。`reorder` 的数组按这个顺序解释；只给出一部分时，被点名的项在各自区内提前，其余保持原相对顺序。固定 / 取消固定不改变 `materialId`。
