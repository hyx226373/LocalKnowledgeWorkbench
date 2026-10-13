## 稳定接口 v1.2

agent 只能创建、预览和查看计划。用户在界面里批准后，计划服务立刻执行已批准的步骤。批准凭据是计划内容的 HMAC，只由界面通过计划库的 `getApprovalCredential`（`actor` 为 `ui`）取得。agent-api 不暴露这个方法，也不暴露执行。任何 agent 能读到的响应里都没有批准凭据或密钥。

计划审批走这些 JSON-RPC，MCP 工具同名：

| 方法 | 谁可以调用 | 作用 |
| --- | --- | --- |
| `plans.create` | 只读、读写 | 建立计划，不写用户文件。actor 固定为 `agent:<令牌名>`，忽略请求里的 actor。`ops` 与 fileops 的 `FileOp` 同形，另外可以放 `{ type: "restore", opId, onConflict }`。`create` / `write` 的 `content` 用字符串。`move` 可以带可选 `toRootId`。 |
| `plans.preview` | 只读、读写 | 按顺序预览，不写盘。后面的步骤看得到前面步骤的虚拟结果。响应里没有批准凭据。 |
| `plans.get` | 只读、读写 | 读取计划。响应里没有批准凭据。 |
| `plans.approve` | 任何令牌都拒绝 | HTTP 403，错误 `user_approval_required`。不会批准，也不会执行。 |
| `plans.apply` | 任何令牌都拒绝 | HTTP 403，错误 `user_approval_required`。不会执行。 |

令牌只能操作自己的 `rootIds`。路径仍交给 fileops，本服务不自己重写 realpath。

agent 令牌调用 `ops.apply` 默认拒绝（HTTP 403，错误 `plan_required`），必须走计划。只读令牌调用 `ops.apply` 仍然是 403。直接 `ops.restore` 对所有 agent 令牌都是 HTTP 403，错误 `plan_required`，磁盘不变。恢复只能作为计划里的 `restore` 步骤提出，并且只在界面批准后执行。`ops.preview` 不因此被拒绝。计划一旦修改，或目标文件的基准哈希变了，原批准失效（计划库返回 `approval_stale`）。

`search.query` 返回 `@kb/indexer` 的 `searchGrouped`：`{ hits, truncated }`。每条 hit 是一份资料，必有 `relPath`。同一 PDF 的多页合成一条，`matches` 最多 3 个。PDF 的 `anchor` 是 `{ page }`，txt 和 md 是 `{ line }`。文件名或路径命中（`matchKind: "name"`）排在只命中正文前面。少于 3 个字走 `fts_short` 的重叠二字，不是全文 `LIKE`。`limit` 限制资料条数，默认 20，夹在 1 到 50。

# @kb/agent-api

本机知识工作台的 HTTP JSON-RPC，以及把它转成 stdio MCP 的入口。只监听 `127.0.0.1`，不依赖 Electron。

路径校验、资料身份、文件操作、PDF 正文分别调用 `@kb/identity-watch`、`@kb/fileops`、`@kb/indexer`。只通过包名导入，不改写运行时导入。

## 安装

在本目录执行：

```powershell
npm install
```

需要 Node 20+。旁边三个包的 `exports` 指向各自的 `dist`。dist 过旧时，只在那个包目录执行 `npm run build`，不要改它们的源码。

## 启动 HTTP

```powershell
node src/cli.ts --root notes=D:\notes --data-dir D:\kb-data --token-name demo --permission readwrite
```

- `--root` 格式是 `根ID=本机目录`。目录必须已经存在。同一个 `--data-dir` 再次启动时要沿用原来的根 ID。
- `--permission` 是 `read` 或 `readwrite`。默认 `readwrite`。
- `--data-dir` 是应用数据目录，不要放在资料根目录里面。省略时用 `%APPDATA%\kb-workbench`。
- 端口由系统分配。`0.0.0.0` 和其他非 `127.0.0.1` 的地址会在绑定前直接失败。

启动成功后，标准输出是一段 JSON，里面有 `url`、`port`、明文 `token` 和 `tokenFile`。进程一直留着，直到 Ctrl+C。

程序里也可以 `await createWorkbench(...)` 再调用 `startServer`。根可以不传 `id`，这时由 `createRoot` 生成。传入的 `id` 会交给 `createRoot(db, { id?, name })`，本机目录用 `setMount` 写入。本包不直接插入 `roots` 或 `root_mounts`。

工作台数据库在 `<dataDir>\workbench.db`。`ops.preview` 和 `ops.apply` 走 `@kb/fileops` 的 `createFileOps`。依赖里的 `resolveInsideRoot` 和 `ensureResource` 就是 `@kb/identity-watch` 的同名函数。`onMoved` 转给 `updateLocation(db, resourceId, before, after)`，`before` 和 `after` 是 `{rootId, relPath}`。直接 `ops.restore` 在 HTTP 层拒绝，不调用 fileops。计划里的 `restore` 步骤只在界面批准后执行，并把步骤上的 `onConflict` 原样传给 `fileOps.restore`。`search.query` 第一次会为已登记的根建索引，然后走索引器的 `searchGrouped`。`fs.read` 的 PDF 正文调用 `@kb/indexer` 的 `extractText(absPath)`，结果是 `[{page, text}]`，同时放在 `pages` 里。文本文件仍直接读，默认并且最大 1 MiB。

## 令牌文件

路径是 `<dataDir>\agent-tokens.json`。

文件里每条令牌有 `name`、`secret`、`rootIds`、`permission`（`read` 或 `readwrite`）。Windows 上写入后用 `icacls` 去掉继承，只留给当前用户。

重启服务不会整份覆盖这个文件，也不会重签已经存在的同名令牌。用同一个 `dataDir` 再启动时，旧令牌仍然可以调用 `roots.list`。只有显式调用 `tokens.rotate` 才会作废当前这张令牌并签发新令牌。新令牌在响应的 `token` 字段里，立刻生效；旧令牌随后返回 401。

令牌能看到的根目录只包括它自己的 `rootIds`。写操作记入操作记录时，actor 是 `agent:` 加上令牌名。

只读令牌可以调用 `roots.list`、`fs.list`、`fs.read`、`search.query`、`ops.preview`、`ops.log`，以及 `plans.create`、`plans.preview`、`plans.get`，也可以 `tokens.rotate`（只轮换自己）。`ops.apply` 返回 403。`ops.restore` 对只读和读写都是 403（`plan_required`）。`plans.approve` 和 `plans.apply` 对任何令牌都是 403（`user_approval_required`）。读写令牌直接调用 `ops.apply` 同样返回 403（`plan_required`），必须改走计划。`ops.preview` 不改磁盘。

## 带 Bearer 调用

`Host` 必须是精确的 `127.0.0.1:<实际端口>`。`localhost` 会被拒绝。不要带浏览器 `Origin` 头，服务端也不回 CORS 头。

```powershell
curl.exe -s http://127.0.0.1:PORT/rpc -H "Authorization: Bearer TOKEN" -H "Content-Type: application/json" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"roots.list\",\"params\":{}}"
```

把 `PORT` 和 `TOKEN` 换成启动时打印的值。`curl.exe` 访问 `127.0.0.1` 时会自己带上正确的 Host。

常用方法：

| 方法 | 作用 |
| --- | --- |
| `roots.list` | 列出这个令牌能访问的根 |
| `fs.list` | 参数 `rootId`、`path`（相对路径，`""` 表示根本身） |
| `fs.read` | 文本或 PDF。可用 `maxBytes`，默认并且最大 1 MiB。文本超限截断。PDF 超限返回错误，成功时 `pages` 为 `[{page, text}]` |
| `search.query` | 参数 `query`，可选 `rootId`、`limit`。按资料聚合，带 `matches` 和 `anchor` |
| `ops.preview` | 预览 `move` / `rename` / `restore`，不写磁盘。写操作先 preview |
| `ops.apply` | agent 令牌会被拒绝，必须走计划。错误 `plan_required`。写操作先 preview |
| `ops.restore` | 任何 agent 令牌都是 403 `plan_required`。要恢复就在 `plans.create` 里放 `restore` 步骤，等界面批准 |
| `ops.log` | 操作记录。`resourceId` 是 `op_log.resource_id`，没有时为 JSON `null`，不是空字符串 |
| `tokens.rotate` | 作废当前令牌，返回新令牌。旧令牌立即失效 |

路径必须是根内相对路径。`../`、绝对路径、盘符，以及指向根外的符号链接或 junction，都会被拒绝。越界由 `@kb/identity-watch` 抛 `PathEscapeError`。

移动示例：

```json
{ "jsonrpc": "2.0", "id": 2, "method": "ops.preview", "params": { "op": "move", "rootId": "notes", "fromPath": "a.txt", "toPath": "box/a.txt" } }
```

拿到 `previewId` 后再调用 `ops.apply`。

直接恢复会被拒绝。恢复步骤放进计划：

```json
{ "jsonrpc": "2.0", "id": 3, "method": "plans.create", "params": { "title": "恢复", "ops": [{ "type": "restore", "opId": "操作ID", "onConflict": "rename" }] } }
```

## MCP

MCP 进程不自己开工作台，它用环境变量去调已经启动的 HTTP API。工具名和 JSON-RPC 方法一一对应。`ops.preview`、`ops.apply`、`ops.restore` 的说明里都写了「写操作先 preview」。`ops.apply` 同时写明 agent 令牌会被拒绝、必须走计划。`ops.restore`、`plans.approve`、`plans.apply` 即使留着工具名，调用结果也是拒绝：恢复是 `plan_required`，批准和执行是 `user_approval_required`。`tokens.rotate` 的说明写明这会作废旧令牌。计划方法 `plans.create`、`plans.preview`、`plans.approve`、`plans.apply`、`plans.get` 也有同名工具。

```json
{
  "mcpServers": {
    "kb-agent": {
      "command": "node",
      "args": ["D:\\STUDY MATERIAL\\项目\\知识库\\modules\\agent-api\\src\\mcp.ts"],
      "env": {
        "KB_AGENT_URL": "http://127.0.0.1:PORT/rpc",
        "KB_AGENT_TOKEN": "启动时打印的令牌"
      }
    }
  }
}
```

`KB_AGENT_URL` 的主机必须是 `127.0.0.1`，不能写成 `localhost`。需要编译后再跑时，先 `npm run build`，再把参数换成 `dist\\mcp.js`。

## 演示

演示在临时目录里完成：连接、搜索、用计划移动、核对 `ops.log` 的 actor 和 `resourceId`、用这个 ID 核对 W2 的 `resources` 行、恢复，并检查文件字节与移动前一致。移动和恢复都是界面调用计划库的 `approvePlan`（actor 为 `ui`）后自动执行，不走 HTTP 批准。HTTP 上的 `plans.approve` 和 `ops.restore` 会被拒绝。打印 `resourceId`、移动后的相对路径、恢复后的相对路径。ID 不变，位置先变成 `archive/note.txt`，再变回 `note.txt`。不用假 fileops。

```powershell
node scripts/demo.mjs
```

成功时打印 `demo ok`。

## 测试

```powershell
npx vitest run
```
