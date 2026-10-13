# 组 3 接线说明（集成组）

组 3 没有改 `src/main/index.ts`、`src/preload/index.ts`、`src/renderer/App.tsx`、`src/shared/types.ts`、`src/shared/actions/registry.ts`、`watcher.ts`。也没有改 `src/shared/agentLive/types.ts`：这份文件与 `r13-al-4` 的 `96cc3c9` 字节相同（blob `ef705d064b84b55f2687d639e36ebbc0f6170b6f`），只为了本分支能单独做类型检查。下面这些线由集成组接。

## 1. 创建入口写入器

桥根目录确定之后（`resolveBridgeRoot`）创建一份，交给组 4 的 `createLiveRevisionLog({ entryWriter })`。组 4 已经在 `changes/index.json` 落盘之后、`marker.json` 之前调用 `render(workspaceId, rev)`。组 3 不写 marker，也不写 `changes/`。

```ts
import { createLiveEntryWriter } from './agentLive/entry';

const entryWriter = createLiveEntryWriter({
  bridgeRoot,
  appVersion: app.getVersion(),
  loadScene,
  readIndexedText,
  extractText,
  onContentReady,
  isCurrent: (id) => log.currentPointer().workspaceId === id,
});
```

- 未传 `appVersion` 时写成 `0.2.0`（当前 package.json）。不要写死样例里的 `0.2.2`。集成组传 `app.getVersion()`。
- `render` 对非法 `workspaceId` 是同步抛错（`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`）。组 4 在 async 函数里 `await writer.render(...)` 时，这个同步异常仍会变成拒绝。非法 `materialId` 跳过该项，不让整次发布失败。
- 同一工作区的多次 `render` 合成一次，用最后一次的 `rev`。不同工作区在同一条链上排队，不会并行写。
- 模板是 TypeScript 字符串，打进 esbuild 的主进程包。不要为导航再加文本 loader，也不要在旁边放一份不会进包的 `.md`。

## 2. loadScene：只交已经在内存里的现场

`loadScene(workspaceId, rev)` 返回名称、用途、已打开面板、当前阅读、两区资料、可选的资料树和关联。**不得为了填它去遍历根目录，也不得读取全部正文。**

- 资料清单用组 1 的 `list`。缺 `tier` 时入口按 `session`。`status` 只认 `ok`、`missing`、`unreadable`，别的值按 `ok`。
- 资料树用目录栏已经有的内存树。入口最多写 500 个节点。没有树就写「这次没有交来资料树快照」，不自己扫盘。
- 打开面板最多在 ENTRY 里列 20 个，其余只在 snapshot。资料清单在 ENTRY 里先本轮、后固定，合计最多 50 项；snapshot 保留全部，不按 200 项再截（200 是组 1 的存储上限）。
- `bytes`、`estTokens` 由组 1 填。还在算时传 `null`，段头会写「token 估算中」。组 3 不在 `render` 里读原文件来估算，也不跑分词器。
- 名称或路径命中凭据文件（文件名 `agent-token.json`）时，面板、阅读对象、资料项和资料树都改成「（已隐藏）」，不写真实路径，也不建 `content/`。

## 3. 正文：索引点查，提取放后台

`render` 的顺序是：可读正文（仅本次能立刻拿到的）→ 五个 `nav/*.md` → `snapshot.json` → 工作区 `ENTRY.md` → 仅当 `isCurrent` 为真时再写 `live/current/ENTRY.md`。

- 已有 `content/<materialId>/<64位hex>.txt` 就直接标就绪。文件名不带 `sha256:`。json 里的 `contentHash` 仍是 `sha256:<hex>`。组 3 不删除旧副本；保留最近 3 份是组 4 的事。
- 还没有哈希时标「内容生成中」，不提取。
- PDF、Office：先 `readIndexedText`。点查即可，不要扫表：

```sql
SELECT page, body_text FROM fts_content WHERE resource_id = ? ORDER BY page
```

回调形状是 `{ pageTexts: string[], pages?: number }` 或 `{ text: string }`。多页用 `pageTexts`，写入时用换页符 `\f` 连接，组 4 的 `agent.getContent` 才能按页切。`pages` 只对 PDF 写入。这次点查在 `render` 里面 await，慢查询会拖住这一次发布，不要在回调里扫库或读大文件。

- 索引没有、但注入了 `extractText`：写 `meta.json` 的 `status: "generating"`，后台再提。`render` 不等它。图片、音视频、压缩包标「无可读文本」，不提取。
- `extractText` 接 `@kb/indexer` 的 `extractText(absPath)`，把 `TextPage[]` 收成上面的形状。它在加入路径之外，不能挡住 0.10 的点击反馈。
- 后台一批全部落地后调用一次 `onContentReady(workspaceId, materialIds)`。组 3 **不会**因此重写 ENTRY 或 snapshot，否则第一行的 `revision` 会谎称自己已经是新版本。
- 组 4 对哈希没变的 `content.changed` 不升版。集成组在 `onContentReady` 里应 `append` 一条**不带** `snapshotRevision` 的 `snapshot.reset`。只发同哈希的 `content.changed` 时，入口会停在「内容生成中」。50 个 PDF 合成一次回调，不要发 50 个版本。
- 磁盘上已经有正文文件时，以文件为准，并清掉过期的 `noText` / `extractFailed`。提取失败写 `extractFailed` 和 `failedHash`，无文本写 `noText` 和 `noTextHash`。这两个状态不在冻结的 `status` 联合里，所以失败时 `status` 暂用 `missing`，无文本时暂用 `ready`。入口显示的是「内容提取失败」和「无可读文本」，资料项自己的 `status` 不变。

## 4. 活动入口

`isCurrent` 不传或返回 false 时，不碰 `live/current/ENTRY.md`。组 4 在切换工作区时会先改当前指针再 `render`，所以上面的比较是安全的。

`current/ENTRY.md` 不是工作区文件的字节拷贝。导航改成 `../ws/<id>/...`，请求协议改成 `../../AGENT_START_HERE.md`，版本块同时给出本目录 marker、工作区 marker、工作区快照和 `changes/index.json`。不写 `live/current/snapshot.json`，也不写 `live/current/marker.json`（marker 仍由组 4 镜像）。

`AGENT_START_HERE.md` 顶部加「现场入口：live/current/ENTRY.md」是集成组的事。本组不改那个文件。

## 5. 启动和退出

启动时对活动工作区调用 `startup(workspaceId, rev)`。上次入口的前 64 字节是 `<!-- kb-live schemaVersion=1 ` 且 `snapshot.json` 还在，就立刻返回 `'cached'`，旧文件留着给 agent 读，后台再 `render`。没有缓存时这次就写完，返回 `'rendered'`。

`await startup` 返回之后，后台那次 `render` 的 `loadScene` 可能已经开始。旧入口要等这次写完才被替换。

退出前 `await entryWriter.whenIdle()`。它只等本组的渲染和已经排上的提取，**不等**组 4 的 300ms 防抖。没有 `close()`。

## 6. 入口里已经写死、集成组不要再改的口径

- 六块顺序固定。第 6 块接入约定和不可信声明是冻结原文。`nav/guide.md` 和入口都写了 schemaVersion 1 的稳定性承诺，以及「游标小于 `oldestRevision` 时改读 snapshot」。
- 两个资料区的段头用合计，例如「12 项 · 3.4MB · 约 41k tokens」。已知 `estTokens` 合计超过 150k 时只加一句提示，不拦截。等于 150k 不提示。
- `nav/actions.md` 读桥根 `manifest.json` 的 `capabilityDetails`。文件不在或解析失败时仍列出 `AGENT_LIVE_ACTIONS`，并说明下一轮再读。批准表：复制入口、`agent.getContent`、`agent.getDiff` 为否；清单操作（含 pin、unpin、clearSession、addCurrent、addSelection）为是。真正登记 action 仍是组 1、组 2、组 4 的接线，本组只把这张表写进导航。
- 原子替换遇到 `EPERM`、`EBUSY`、`EACCES`、`EEXIST` 按 20/40/80/160ms 退避，最多 5 次。仍失败就留下 `*.tmp`。下一轮 `render` 只提升 snapshot、ENTRY、五个 nav、`content/**/*.txt.tmp` 和 `meta.json.tmp`。残缺 tmp 删除。**不提升** `marker.json.tmp` 和 `changes/` 里的 tmp。
- 监视目录、300ms、5 到 10 秒轮询写在 `nav/guide.md` 里，给组 5 的示例看。本组不建 `fs.watch` / chokidar。
