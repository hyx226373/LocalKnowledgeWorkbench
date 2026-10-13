# @kb/agent-api 报告（v1.1）

只改了本包。没有改约定、根 `package.json`、indexer / identity-watch / fileops 的源码，也没有 git commit。收尾前在这三个包目录各执行了一次 `npm run build`（它们的 `exports` 指向各自 `dist`），然后在本包执行 `npm run build`、`npx vitest run`、`node scripts/demo.mjs`。

## 逐条

1. 删除未使用的 `src/local-workbench.ts`，生产入口、测试、演示不再引用：通过。
2. 删除本包自己的 `resolveInsideRoot`（原 `src/paths.ts`）和只覆盖它的测试。路径只调用 `@kb/identity-watch` 的 `resolveInsideRoot(db, rootId, relPath)`，越界是 `PathEscapeError`：通过。`../`、绝对路径、盘符、根外 junction 的 HTTP 测试拒绝写盘。
3. 删除 `src/fileops-hook.ts`、`module.registerHooks`，以及把 `./engine.js` 改写成 `.ts` 的逻辑。不再运行时改写导入，也不再用跨包相对路径。只通过 `@kb/indexer`、`@kb/identity-watch`、`@kb/fileops` 导入：通过。
4. `fs.read` 的 PDF 正文改用 `@kb/indexer` 的 `extractText(absPath)`，响应里 `pages` 为 `[{page, text}]`，`text` 是按页用换行拼起来的字符串。本包 PDF 解析器和只覆盖它的测试已删。文本仍直接读，默认并且最大 1 MiB，超限截断；PDF 超限在调用 `extractText` 之前返回 413：通过。服务端测试读到 `Hello PDF`。
5. 不再直接 INSERT `roots` 或 `root_mounts`。用 `createRoot(db, { id?, name })` 和 `setMount(db, rootId, localPath)`。同一 `dataDir` 再次启动时若根 id 已在，只 `setMount`，不再 `createRoot`：通过（源码如此；令牌重启测试用同一根 id 再次 `roots.list` 成功）。
6. `createFileOps` 的 `resolveInsideRoot`、`ensureResource` 传 identity-watch 的同名函数。`onMoved` 转给 `updateLocation(db, resourceId, before, after)`，`before` / `after` 是 `{rootId, relPath}`：通过。演示里移动后 `resources.rel_path` 为 `archive/note.txt`，恢复后为 `note.txt`，id 不变。
7. `ops.restore` 把请求里的 `onConflict`（`cancel` | `rename` | `overwrite`）原样传给 fileops，不写死 `cancel`。缺省是 400：通过。三种都能经 HTTP 触发：`cancel` 返回 409 且原文件和已移走的文件都不变；`rename` 把旧字节写到 `conflict-rename.restored.txt`，原路径仍是新字节；`overwrite` 原路径变回旧字节，已移走的路径不存在。
8. 返回给调用方的 `resourceId` 用 `op_log.resource_id` 的真实值。NULL 或空串都变成 JSON `null`，不再写成 `""`：通过。演示和移动测试里的移动记录是非空 UUID。
9. 令牌持久化：同一 `dataDir`、同一规格再次 `startServer` 不重写 `agent-tokens.json`，旧令牌仍能 `roots.list`。`tokens.rotate` 之后旧令牌 401，新令牌 200：通过。令牌文件是 `<dataDir>\agent-tokens.json`，README 写了位置和这个方法。
10. 只绑 `127.0.0.1`，拒绝 `0.0.0.0`（以及 `localhost`、`::1`、局域网地址），拒绝发生在 listen 之前，且不写令牌文件。网卡上的非内部 IPv4 连不上：通过。
11. 无令牌、错令牌 401；错 Host、带 Origin 403；响应没有 `access-control-allow-*`：通过。
12. 只读令牌不能 `ops.apply` / `ops.restore`（403），可以 `ops.preview`，预览不改磁盘：通过。
13. 未授权根不可见：`roots.list` 没有 `root-b`；对 `root-b` 的列表、读取、搜索、预览是 403；不带 `rootId` 搜索 `secret-b-only-zz` 没有命中：通过。
14. MCP 工具与方法同名。`ops.preview`、`ops.apply`、`ops.restore` 的描述含「写操作先 preview」。`tokens.rotate` 的描述写明会作废旧令牌：通过。stdio 测试能搜到 `hello.txt`，预览不移动文件。
15. 演示：连接、搜索、预览移动、执行移动、看 `ops.log`。移动记录的 `resourceId` 非空，只读打开 `workbench.db` 能对上 W2 的同一行。恢复后文件字节与移动前一致。打印 `resourceId`、`movedRel archive/note.txt`、`restoredRel note.txt`。不用假 fileops：通过。
16. 本包 `npm run build`（`tsc -p tsconfig.json`）：通过，退出码 0。
17. `npx vitest run`：通过。4 个文件，9 个测试，退出码 0。约 72.8 秒（2026-10-03 09:20 那一次）。server 5、v11 2、mcp 1、demo 1。
18. `node scripts/demo.mjs`：通过，退出码 0。标准输出：

```
resourceId e78b64af-2219-4e46-808e-12911b766230
movedRel archive/note.txt
restoredRel note.txt
demo ok
```

19. 目录符号链接：通过（按「仍是 EPERM 就用 junction，并保留失败原文」）。本机建不了目录符号链接，测试改用 `mklink /J`，根外 junction 被拒绝。单独探测的原文：
    - Node `fs.symlinkSync(outside, link, 'dir')`：`Error: EPERM: operation not permitted, symlink 'C:\Users\sana2\AppData\Local\Temp\kb-sym-wYIFgz\out' -> 'C:\Users\sana2\AppData\Local\Temp\kb-sym-wYIFgz\root\symdir'`
    - PowerShell `New-Item -ItemType SymbolicLink`：`System.UnauthorizedAccessException: 此操作需要管理员权限。 ---> System.ComponentModel.Win32Exception: 客户端没有所需的特权。`
    - 同一探测里 `mklink /J` 退出码 0。
    - 未测：符号链接创建成功之后再被拒绝。当前权限下建不出来。

## resourceId 仍会是 null 的路径

- `ops.preview` 的结果里没有 `resourceId` 字段。
- `ops.apply`、`ops.restore` 的成功结果，以及 `ops.log` 的每条记录，只读该行 `op_log.resource_id`。数据库是 NULL 或空串时，JSON 是 `null`。
- fileops 的 `reject()` 插入记录时不写 `resource_id`。因此目标已存在且 `onConflict` 为 `cancel` 时，那条被拒绝的 restore 在 `ops.log` 里的 `resourceId` 是 `null`。HTTP 本身是 409，错误体里没有 `result.resourceId`。v11 只断言了 409 和磁盘未改，没有再读这条日志。这一条日志字段记为未测。
- 预览移动时若源文件不存在，`ensureKnown` 不会调用 `ensureResource`。fileops 在 `resolveInsideRoot` 没有资料 ID、且这次不是新建回填时，也会把 `resource_id` 留空。本次移动、演示和无冲突恢复走的是已存在文件，测到的 `resourceId` 都是非空 UUID。

## 通过数

上面 1–18 通过，19 的 junction / EPERM 原文通过。另有两条未测：符号链接创建成功后的拒绝；`onConflict=cancel` 那条被拒绝恢复在 `ops.log` 里的 `resourceId` 是否为 JSON `null`。未通过 0。

计数：通过 19，未测 2，未通过 0。vitest 9/9。

## 根目录复跑（组长，2026-10-03）

在 `D:\STUDY MATERIAL\项目\知识库` 执行 `npm install`、`npm run build`、`npm test`，退出码 0。本包这次是 4 个文件、9 项通过。随后在 `modules\agent-api` 执行 `node scripts/demo.mjs`，退出码 0，约 61s。输出：

```text
resourceId 2931e368-92af-4b73-949f-dc464c50a7a6
movedRel archive/note.txt
restoredRel note.txt
demo ok
```

脚本用这个 ID 读 `resources`。移动后 `rel_path` 为 `archive/note.txt`，恢复后仍是这个 ID，`rel_path` 为 `note.txt`。

## 过程里的一次失败

在改测试环境之前，有一次 `npx vitest run` 里演示子进程已经打印 `demo ok` 和三条路径，随后退出码 `3221225477`（`0xC0000005`），那一轮是 8 通过、1 失败。紧接着单独执行 `node scripts/demo.mjs` 退出码 0。测试改为不把 vitest 的 `NODE_CHANNEL_FD`、`NODE_OPTIONS` 传给子进程后，完整 9 项通过，并再次单独跑演示，退出码 0。当前结果以上面这一次为准。
