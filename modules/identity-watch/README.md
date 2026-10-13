# @kb/identity-watch

v1.1。资料身份是稳定 UUID。位置是 `root_id + 相对路径`。本机绝对路径只写在 `root_mounts`，不写进资料行。

不依赖 Electron。数据库连接由调用方传入（v1 起如此，不是 v1.1 新发明）。`migrate(db)` 只建 `roots`、`root_mounts`、`resources`。

## v1.1

1. `resolveInsideRoot(db, rootId, relPath)` 返回 `{ rootId, relPath, absPath, resourceId }`。越界抛 `PathEscapeError`，不返回字符串。`resourceId` 只取该路径上 `missing = 0` 的行；只有失联行时是 null。
2. `resources` 不再建 `UNIQUE(root_id, rel_path)` 或 `UNIQUE(root_id, rel_path_key)`。活行唯一约束是部分唯一索引，名字 `idx_resources_live_path`：

   ```sql
   CREATE UNIQUE INDEX idx_resources_live_path ON resources(root_id, rel_path_key) WHERE missing = 0
   ```

   失联记录保留原来的 `rel_path`，不再改写成 `//missing/<id>/...`。同一 `rel_path` 可以同时有一条 `missing = 0` 和多条 `missing = 1`。`rel_path_key` 仍保留，Windows 上按小写比较。`migrate` 会重建带旧表级 UNIQUE 的表，并把遗留占位路径改回原相对路径。不要求调用方手工删库。
3. 包外不要自己 `INSERT` `roots` 或 `root_mounts`。`createRoot(db, { id?, name })` 只插入 `roots` 并返回 root id。传入 `id` 就用它，不传就生成 UUID。它不写 `local_path`，也不要求目录已经存在。`setMount(db, rootId, localPath)` 是本包唯一写入 `root_mounts.local_path` 的入口。目录必须存在。
4. W3 移动或改名后调用 `onMoved(resourceId, before, after)`。调用方把这个回调转给 `updateLocation(db, resourceId, before, after)`。`before` 和 `after` 都是 `{ rootId, relPath }`。ID 不变，`missing` 置 0。不新建资源，不改 size、mtime、哈希或 `fs_file_id`，也不读磁盘。行必须已经存在；`before` 要和当前 root、相对路径一致（Windows 上路径比较不区分大小写）。`after.rootId` 能不能换成另一个根，以下面的「稳定接口 v1.2」为准。v1.1 曾经要求必须是同一个 root，那条作废。目标路径上若已有另一条活行，抛错且不改本行。

## 稳定接口 v1.2

`updateLocation` 可以跨根。这一节覆盖 v1.1 里「`after.rootId` 必须是同一个 root」以及「不改 `root_id`」。

- `before.rootId` 必须等于这一行当前的 `root_id`，否则抛错，不改行。
- `after.rootId` 必须是 `roots` 里已有的 id。没有这条根时抛错，错误信息里包含 `after.rootId`，不改行。
- 目标根存在且与当前根不同：更新 `root_id`、`rel_path`、`rel_path_key`，`missing` 置 0，刷新 `updated_at`。资料 ID 不变。不改 size、mtime、`content_hash`、`fs_file_id`。不读磁盘，不插入新行。
- 冲突检查在目标根上：`root_id = after.rootId` 且 `rel_path_key` 是目标路径且 `missing = 0` 且 `id` 不是自己。有活行则抛错，不改本行。
- 同根移动仍只改相对路径（`root_id` 写成同一个值），其余和 v1.1 相同。

## 身份规则

1. 相对路径把 `\` 换成 `/`，做 NFC，去掉 `.` 和重复斜杠。拒绝绝对路径、盘符、UNC、空字节、以及任何 `..` 段（含 `Foo\..\..\outside` 这种反斜杠或大小写伪装）。Windows 上唯一性比较用小写。库里的 `rel_path` 保存规范后的 `/` 路径，保留磁盘上的大小写。
2. `ensureResource`：同一 root 下这条规范路径已有 `missing = 0` 的记录，且不是「旧的 missing 记录碰上一个确实是新文件」，就返回原 id，并更新 size、mtime、`fs_file_id`。大小写或 `\` 不同仍是同一条。
3. `fs_file_id` 是 `fs.stat(path, { bigint: true }).ino` 的十进制字符串，SQLite 里用 TEXT，避免 bigint 进整数列丢精度。ino 为 0 时记 NULL。
4. `reconcile`：已记录文件还在时，先按 `fs_file_id` 在当前树里找。唯一命中就把 `rel_path` 改到新位置，id 不变，`missing = 0`。
5. 按 `fs_file_id` 找不到时，再比 `size`、`mtime_ms`、`content_hash`（sha256）。三者同时相等且只命中一条，才更新 `rel_path`，id 不变。不接受「只比哈希」。
6. 都不匹配：旧记录 `missing = 1`，`rel_path` 保持原值，不删除。该路径上若是新文件（`fs_file_id` 不同，且 size+mtime+哈希对不上任何一条 missing 记录），分配新的 UUID。禁止只凭同名或同大小复用旧 id。
7. 两个同大小、同 mtime、同内容的文件对调时，三条哈希不唯一，必须靠 `fs_file_id` 区分，id 跟着文件走，不得互换。
8. `remapRoot` 只通过 `setMount` 更新 `root_mounts` 里该 root 在本机的 `local_path`，然后跑 `reconcile`。不改 `resources.id`。
9. 整目录复制会得到新的 `fs_file_id`。路径还在且 size+mtime+哈希三者能唯一对上时，按第 5 条保持 id。内容重复、三者不唯一时，不跨路径猜测；同一相对路径仍在且记录还没标 missing，则保持 id（复制后的重复文件靠路径连续性，不靠放宽哈希）。测试里复制后会把每个文件的 mtime 设回原值。
10. `exportPortable` 只有 root id、名称和资料身份、逻辑相对路径、size、mtime、哈希、missing。没有盘符、`local_path`、`fs_file_id`（文件索引随卷变化，带出去会误配）。`importPortable` 用 `createRoot` 导入这些身份，按原 `rel_path` 写入，不把失联行改成占位路径。新的本机路径用参数里的 `localPath`（转给 `setMount`）或之后的 `remapRoot` 单独写进 `root_mounts`。
11. 同一路径上的文件被整个替换（编辑器保存常见做法）按原地修改处理，保留资料 ID。只有先观察到缺失，之后的新文件才分配新 ID。

### 同名新文件

删除后：原行还在，`missing = 1`，`rel_path` 仍是原来的相对路径，id 不变。

之后同一规范路径出现文件时：

- `fs_file_id` 与该行相同：视为原文件回来，复用 id，`missing = 0`。
- `fs_file_id` 不同，但与某一条 missing 记录的 size、mtime_ms、content_hash 三者唯一匹配：把那条记录的路径改过来，id 不变。
- 否则视为新文件：新 UUID。旧行保持 `missing = 1` 且 `rel_path` 不变。快照里 `displaced = true` 只表示这条失联路径上已经有另一条活行，不是库内占位符。

还没被标成 missing 的记录，如果路径一直都在、只是内容或 inode 变了，按身份规则第 11 条作原地修改，保留资料 ID。已经 missing 的记录不走这条。要得到新 ID，必须先观察到缺失。

目录没有内容哈希。同一卷上的目录改名靠 `fs_file_id`。文件索引不可靠时，目录跨路径移动会变成新 id，原目录标 missing。

### 文件索引什么时候不可靠

NTFS 上 `stat.ino` 是 64 位文件索引，同一卷里改名、移动都不变；复制或另存为会变。FAT、exFAT、U 盘上常见的文件系统经常给出 0 或不稳定的索引。网络盘即使报 NTFS，索引也常常不能当身份。

本机 Node 24 的 `fs.statfsSync().type` 对 NTFS 也是 0，不能用来判断文件系统。检测改为查询 `Win32_LogicalDisk` 的 `FileSystem` 和 `DriveType`（PowerShell CIM，失败再试 `wmic`）：只有本地固定盘（DriveType=3）且文件系统名是 `NTFS` 才信任 `fs_file_id`。其它情况把 `fs_file_id` 存成 NULL，匹配退回「唯一的 size+mtime+sha256」；不唯一则不跨路径配对。已经 missing 的记录不会因为同名或同大小被复用。

ReFS 的文件 id 可能是 128 位，Node 的 `ino` 不够用，所以也不信任。

这项没有在真实的非 NTFS 卷、U 盘或网络盘上跑过。验收结论是未测。测试里的 `forceFileIdReliable: false` 只覆盖代码分支，不能代替插上这种卷。

## 监视

优先 `@parcel/watcher`。订阅失败再用 chokidar。实际后端在 `WatchHandle.backend`。本次 Windows 验收里是 `parcel`，chokidar 没有用到。

事件先去抖（默认 50ms）。同一路径的连续抖动合成一次刷新；不同文件不会互相丢掉。安静之后对整棵树做一次与 `reconcile` 相同的匹配，再按前后快照发出：

`onResourceChanged({ type, resourceId, before, after })`

`type` 是 `create`、`modify`、`rename-move`、`delete`。`delete` 的 `after.missing === 1`，行还在，`rel_path` 仍是原路径。`watchRoot()` 返回前会做一次不发事件的对齐，所以只保证返回之后的变化。`whenIdle()` / `flush()` 会等去抖缓冲区刷完。

## reconcile

`reconcile(db, rootId, options)` 在 `worker_threads` 里跑。worker 用数据库文件路径自己 `new Database`，不接收主线程的连接。`options.onProgress` 收到 `{ phase, seen, total }`。`options.signal` 中止后，扫描在下一个文件或哈希分块处停，不提交这一轮写入；若协作取消卡住，大约 700ms 后结束线程。需要文件库，不能是 `:memory:`。

`options.interFileDelayMs`、`forceFileIdReliable`、`forceFileSystemName` 只给测试用。

## API

```ts
migrate(db)
createRoot(db, { id?, name }) => rootId
setMount(db, rootId, localPath) => void
ensureResource(db, rootId, relPath) => id
updateLocation(db, resourceId, before, after) => void
reconcile(db, rootId, options?) => Promise<ReconcileResult>
remapRoot(db, rootId, newLocalPath, options?) => Promise<ReconcileResult>
watchRoot(db, rootId, onResourceChanged, options?) => Promise<WatchHandle>
resolveInsideRoot(db, rootId, relPath) => { rootId, relPath, absPath, resourceId }
exportPortable(db, rootId) => PortableBundle
importPortable(db, bundle, { localPath? }) => rootId
getResource(db, id)
listResources(db, rootId)
detectFileSystem(absPath) => { name, fileIdReliable }
```

`resolveInsideRoot` 先做词法检查，再 `fs.realpath`（解析符号链接和 junction）。真实路径必须仍在该根的真实路径之内，否则抛 `PathEscapeError`，错误信息里不带根外路径。大小写或 `\` 不同但落在根内的路径会命中同一条活资源。根外目标不会被当成返回值。

`npm run build` 先用 tsc 把 `src/` 编到 `dist/`（含 `.d.ts`）。源码相对导入保持 `.ts`，这样 Node 能直接跑 reconcile 的 worker；tsc 把 `.js` 产物里的导入改成 `.js`，构建末尾再把 `.d.ts` 里的相对导入改成 `.js`。`main`、`types`、`exports` 指向 dist。

## 测试

```powershell
npm run build
npx vitest run
```

在临时目录里做，结束删除。建 junction 用 `cmd /c mklink /J`。符号链接若 EPERM，根外链接改用 junction，失败原文记在 REPORT。
