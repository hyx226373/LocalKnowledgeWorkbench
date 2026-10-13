# @kb/identity-watch 报告

## 做了什么

在现有包上落实 v1.1 第 2、4、5 条。没有改约定文件，没有改根 `package.json`，没有改其他包。

- `resolveInsideRoot(db, rootId, relPath)` 仍返回 `{ rootId, relPath, absPath, resourceId }`，越界抛 `PathEscapeError`。`resourceId` 只取 `missing = 0` 的行；只有失联行时是 null。
- 去掉 `resources` 上的 `UNIQUE(root_id, rel_path)` 和 `UNIQUE(root_id, rel_path_key)`。不再把失联行改写成 `//missing/<id>/...`。失联记录保留原来的 `rel_path`。活行唯一约束是部分唯一索引：

  ```sql
  CREATE UNIQUE INDEX idx_resources_live_path ON resources(root_id, rel_path_key) WHERE missing = 0
  ```

  `rel_path_key` 仍在，供 Windows 小写比较。`migrate` 若看到旧表级 UNIQUE，会重建表，并把遗留的 `//missing/...` 改回原相对路径，然后只建上面这个部分唯一索引。测试用新库；另外用一张按旧语句建的表跑过 migrate，不要求手工删库。
- `createRoot(db, { id?, name })` 只插入 `roots` 并返回 root id。传入 `id` 就用它，不传就生成 UUID。不写 `local_path`，不要求目录已经存在。`setMount(db, rootId, localPath)` 是本包唯一写入 `root_mounts.local_path` 的地方，目录必须存在。两个都从 `src/index.ts` 导出。包内原来的 `createRoot(db, name, localPath)` 已改成先 `createRoot` 再 `setMount`。`importPortable` 插入 root 也走 `createRoot`。
- 导出 `updateLocation(db, resourceId, before, after)`。`before` 和 `after` 都是 `{ rootId, relPath }`。只更新这一条的 `rel_path`、`rel_path_key`，并刷新 `updated_at`，`missing` 置 0，ID 不变，不插入新行。不改 `root_id`、size、mtime、哈希、`fs_file_id`。README 写明：W3 的 `onMoved(resourceId, before, after)` 由调用方转给这个函数。
- `npm run build` 用 tsc 输出 `dist/` 和 `.d.ts`。`main`、`types`、`exports` 指向 dist。没有 `noEmit`。worker 在源码里仍用 `.ts` 导入，否则本机 Node 直接跑 `reconcile-worker.ts` 时找不到旁边的 `.js`。tsc 会把 `.js` 产物的导入改成 `.js`；构建后再把 `.d.ts` 里的相对导入改成 `.js`。

## 怎么验证的

在 `modules/identity-watch` 执行：

`npm run build`

通过。`dist/index.js`、`dist/index.d.ts` 存在，`updateLocation`、`createRoot`、`setMount`、`resolveInsideRoot` 都从入口导出。声明文件里的相对导入是 `.js`。

`npx vitest run`

结果：Test Files 1 passed（1），Tests 17 passed（17）。耗时约 18.6s。临时目录在测试结束时删除。文件系统检测结果：`{"name":"NTFS","fileIdReliable":true}`。监视后端是 `parcel`。

### 验收清单

1. 应用外改名、移到子目录、再移回，id 不变。开着监视器测了，关掉监视器只跑 reconcile 也测了。通过。
2. 同时改名两个同大小、同 mtime、同内容的文件，id 不互换（核对了 `fs_file_id` 仍跟原文件）。reconcile 和监视器各测了一次。通过。
3. 删除后该行 `missing = 1` 且行还在，`rel_path` 仍是原路径。随后同名、内容不同的新文件是新 id。旧行仍然 missing，两条的 `rel_path` 都是原文件名，没有 `//missing/`。reconcile 和监视器都测了删除后的新 id。另有一条明确用 `same.txt`：先 reconcile 到 `missing = 1` 且 `rel_path` 仍是 `same.txt`，再写入内容不同的新文件，`ensureResource` 得到新 id。两行同时在，ID 不同，路径都是 `same.txt`。可移植导出再导入后仍是这两条，没有占位路径。通过。
4. 整个根目录复制到新路径，把每个文件的 mtime 设回库里的值，再 `remapRoot`。全部 id 不变，missing 都是 0，哈希和 mtime 与复制前一致，`fs_file_id` 变了。通过。另有一条：mtime 被拨后的副本不会只凭哈希接过旧 id。通过。
5. `../`、反斜杠穿越、大小写伪装穿越、盘符、空字节被 `resolveInsideRoot` 拒绝。指向根外的 junction（`cmd /c mklink /J`）在 `junc-out`、`junc-out/secret.txt`、`junc-out\secret.txt` 上都被拒绝，没有把根外真实路径当返回值。通过。符号链接未测，见下。
6. 一次新建 500 个文件，监视事件里这 500 个 resourceId 都出现了。通过。后端是 parcel。
7. NTFS 以外的盘（U 盘、网络盘、FAT/exFAT）：未测。本机这次跑到的检测结果是本地 NTFS，`fileIdReliable` 为 true。没有在真实的非 NTFS 卷上验收。

非 NTFS 时 `fs_file_id` 为什么不可靠：FAT/exFAT 的 `stat.ino` 经常是 0 或换个目录项就变；网络盘即使报告 NTFS，索引也不保证跨重命名稳定。检测仍不靠 `fs.statfsSync().type`（本机 Node 对 NTFS 会得到 0）。代码查 `Win32_LogicalDisk` 的 `FileSystem` 和 `DriveType`。只有 DriveType=3 且文件系统名是 NTFS 才信任文件索引；否则 `fs_file_id` 存 NULL，匹配退回唯一的 size+mtime+sha256，不唯一就不跨路径配对。测试里用 `forceFileIdReliable: false` 走过这条分支。这不是第 7 条验收，第 7 条仍是未测。

v1.1 另外测了：`createRoot` 传入 id 时用该 id，且不写 `root_mounts`；目录不存在时 `setMount` 抛错且不插入挂载；旧表带两个 UNIQUE 时 `migrate` 能改成部分唯一索引，并把 `//missing/old/same.txt` 改回 `same.txt`，与活行并存。第二条 `missing = 0` 的同路径插入会撞上这个索引。`updateLocation` 在失联行上改路径后 ID 不变、`missing` 变为 0、不新增行；未知 id、`before` 对不上、跨 root、`../`、目标路径已有活行都会抛错且不改行。通过。

取消：`AbortSignal` 之后 1 秒内停止的测试通过（40 个文件、每项延迟 150ms，中止后约 1 秒内抛 `ReconcileCancelledError`）。这不是上面 7 条里的单独一项。

符号链接创建失败原文（未把 symlink 写成已测）：

`Error: EPERM: operation not permitted, symlink 'C:\Users\sana2\AppData\Local\Temp\kb-id-B50u7L\outside-secret' -> 'C:\Users\sana2\AppData\Local\Temp\kb-id-B50u7L\root\sym-out'`

根外链接这一项是用 junction 做完的。

## 没做的

- 没有真实 U 盘、网络盘或非 NTFS 卷上的验收。
- 没有测到真正的符号链接（权限 EPERM）。
- 硬链接不会合并成同一个资源。
- 目录没有内容哈希；文件索引不可靠时，目录跨路径移动会得到新 id。这条没有在非 NTFS 卷上验证。
- 不包含 Electron、全文索引、文件操作日志。
- `updateLocation` 不读磁盘，也不改 size、mtime、哈希、`fs_file_id`。文件若还没真正移过去，要等下一次 reconcile 再对齐。

## 需要决定的问题

- 可移植导出故意不带 `fs_file_id`。若希望同卷导出再导入仍用文件索引，需要另说。
- 一次 reconcile 如果只看到「路径上已经是另一个文件」，而旧记录还没被标成 missing，会当成原地修改，保留 id。新 id 只出现在先观察到 `missing = 1` 之后。
- 网络盘和可移动盘即使文件系统名是 NTFS 也不信任文件索引；ReFS 也不信任。若这些卷应该信任 `ino`，需要改检测条件。
- `updateLocation` 不改 `root_id`。跨根移动没有在这里做。

## 根目录复跑（组长，2026-10-03）

在 `D:\STUDY MATERIAL\项目\知识库` 执行 `npm install`、`npm run build`、`npm test`，退出码 0。本包这次是 1 个文件、17 项通过，耗时 14.79s。监视后端仍是 parcel。符号链接创建仍是 `EPERM`。非 NTFS 真实卷仍未测。
