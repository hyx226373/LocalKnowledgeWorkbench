# @kb/fileops REPORT

接口已改成 v1.1。README 第一节标题是「稳定接口 v1.1」，代码块下面是 `<!-- INTERFACE_READY -->`，下一行是 `<!-- INTERFACE_V1_1 -->`。

## 做了什么

`createFileOps` 现在必填 `resolveInsideRoot`、`ensureResource`、`onMoved`。`restore` 的 `onConflict` 仍由调用参数决定，库内没有改成固定的 `cancel`。

- 每次访问资料根里的路径之前调用 `resolveInsideRoot(db, rootId, relPath)`。磁盘只用返回的 `absPath`。回调抛错，或 `absPath` 不是绝对路径，记为 `outside-root`，不写文件。词法不通过时不调用它。
- `op_log.resource_id` 写入 `ResolvedInside.resourceId`。已有文件解析到 ID 时不再写 NULL。
- `create` 把新文件写到磁盘之后调用 `ensureResource(db, rootId, relPath)`，把返回的 ID 回填到这条 op。
- `move` / `rename` 成功后调用 `onMoved(resourceId, before, after)`。`before`、`after` 是 `{ rootId, relPath }`，ID 用移动前解析到的那个。撤销这两类操作并把文件移回时也调用。没有 ID 时不调用。本包没有 `UPDATE resources` 或 `INSERT INTO resources`。
- 覆盖前备份、删除进 `dataDir/staging`、移动目标已存在时默认拒绝、三种 `onConflict`、同目录临时文件加 `fsync` 再换名、`recoverIncomplete` 仍在。`KB_FILEOPS_CRASH_POINT=after-backup` 仍在备份提交后、替换目标前退出。
- `npm run build` 用 tsc 把 `src` 编到 `dist/`，并生成 `.d.ts`。`main`、`types`、`exports` 指向 dist。源码仍用 `.js` 说明符。调用方不用再注册导入改写。

## 怎么验证的

在 `D:\workspace\kb\modules\fileops` 执行：

```text
npm run build
npx vitest run
```

`npm run build` 退出码 0。最新一次 vitest 3.2.7：

```text
Test Files  2 passed (2)
     Tests  15 passed (15)
  Duration  5.57s
```

15 通过，0 失败，0 跳过。测试目录在 `os.tmpdir()` 下，备份在测试自己的 `dataDir`。没有改 identity-watch、indexer、agent-api 的源码，也没有改根 `package.json`。

在 identity-watch 目录最后一次 `npm run build` 退出码也是 0。更早有一次 tsc 报 `TS7016`（`better-sqlite3` 缺少声明文件），还有一次本机找不到 `tsc`。那两次我没有改对方文件。联调用的是包名 `@kb/identity-watch`，Node 解析到它的 `dist/index.js`。

## 验收

1. 通过。覆盖写入 `note.bin` 后按该次 op 恢复，文件与覆盖前逐字节一致。备份在 `dataDir/backups`，不在资料根；两份相同原内容只存了一个哈希。
2. 通过（当前进程读得到的回收站目录）。删除后原路径不存在，文件在 `dataDir/staging`，恢复后原路径字节一致。源码没有 `SHFileOperation`、`IFileOperation`、`shell32`、`$Recycle.Bin`、`node-trash`。测试扫描了 `C:\$Recycle.Bin` 下当前进程读得到的目录：文件名，以及不大于 64KB 的 `$I` 文件内容。这次没有重新跑 `whoami`，也没有统计其他 SID。读不到的目录仍算未测。
3. 通过。移动到已存在目标时，preview 的 `conflicts` 含 `exists`；不带 `overwrite` 的 apply 为 `rejected`，源和目标字节都不变。带 `overwrite: true` 时先备份目标再替换。
4. 通过。删除后再在原路径放另一个文件：`cancel` 不改磁盘且记 `rejected`；`rename` 写到 `rename.restored.bin`，原路径仍是新字节；`overwrite` 先备份新字节，再把旧字节写回原路径。`onConflict` 用的是这次传入的值。
5. 通过。`../`、反斜杠、盘符、以 `/` 开头、UNC、`NUL`、`COM1.txt` 都拒绝，`status` 不是 `ok`，测试根外目录没有新文件。词法不通过时不会调用 `resolveInsideRoot`。调用方抛错时也不写文件。fileops 自己仍然不做 realpath。指向根外的 junction 由下面的联调覆盖。
6. 通过。子进程先按 `tsconfig.build.json` 编译到包内的 `.crash-build`（不删 `dist/`），再以 `KB_FILEOPS_CRASH_POINT=after-backup` 运行。退出码 91。父进程看到原文件字节未变，`recoverIncomplete()` 返回 1 条，`status` 为 `incomplete`，`backup_ref` 指向的备份与原文件一致。再调用一次返回空数组。
7. 通过。见下一节。覆盖、删除、移动之后 `op_log.resource_id` 非空，且等于 W2 里该文件的 ID。移动之后用 `getResource` 按这个 ID 查询，ID 不变，`relPath` 已是新位置。

## 与 identity-watch 联调

通过。测试文件 `test/identity-watch-link.test.ts` 只从 `@kb/identity-watch` 导入，没有 `../../identity-watch/src/...`。`onMoved` 调用对方的 `updateLocation(db, resourceId, before, after)`。根用 `createRoot(db, { name })` 和 `setMount(db, rootId, localPath)` 建立。

- 先 `ensureResource` 再覆盖 `note.bin`、删除 `gone.bin`：两条 `op_log.resource_id` 分别等于覆盖前、删除前拿到的 ID。
- 移动 `dir/a.bin` 到 `dir/b.bin` 后，`op_log.resource_id` 仍是移动前的 ID。`getResource(db, id).id` 相同，`relPath` 为 `dir/b.bin`。这是 W2 快照上的逻辑相对路径，对应表里的 `rel_path`。fileops 没有自己改 `resources`。
- 新建 `fresh.txt` 后，这条 op 的 `resource_id` 能被 `getResource` 查到，`relPath` 为 `fresh.txt`。

普通目录 symlink（`fs.symlinkSync(..., "dir")`）仍是 EPERM，原文：

```text
EPERM: operation not permitted, symlink '...\outside' -> '...\root\sym-out'
```

因此仍用 `cmd /c mklink /J`。`preview` 和 `apply` 创建 `jump/escaped.txt` 都被拒绝，冲突码是 `outside-root`，`op_log.status` 不是 `ok`。根外目录仍只有 `marker.txt`。同一套依赖创建根内的 `plain.txt` 成功。没有改 identity-watch 的源码。

不连数据库的词法 `resolveInsideRoot` 还留在 `test/helpers.ts`，只给本包单测和崩溃子进程用。验收联调走的是 W2。

## 没做的

- fileops 自己不解析符号链接和 junction。这次只测了目录 junction，没有测到成功创建的普通 symlink。
- 不处理目录的移动、改名或删除。删除文件时没有回调去把 W2 的行标成 missing，行还在。
- 不恢复一条 `op=restore` 的记录。撤销 `create` 时如果内容已经变了，不能用 `rename`。
- `onMoved` 或 `ensureResource` 在文件已经落盘之后抛错时，不把文件移回去。apply 会把还在 `pending` 的行标成 `incomplete` 并继续抛出。这个失败路径没有单独的测试。
- `recoverIncomplete()` 不自动重写半截的新内容。移动若磁盘上已经完成，补记 `ok` 前会再调一次 `onMoved`；create 若文件已经落盘但还没有 ID，会再调 `ensureResource`。崩溃点测的仍是 `after-backup` 的覆盖写入，没有单独制造「改名已完成、回调还没调用」的进程退出。
- 没有多进程并发写同一数据库的锁。
- 文件读写是调用线程上的同步 IO，没有流式处理大文件。
- 没有 Electron，也没有做 Windows 安装包验收。
- 其他用户 SID 的回收站目录没有权限，未测。

## 需要决定的问题

- v1.1 的签名已经按约定改了。`resource_id` 不再固定为 NULL。
- `write` 总是先备份再覆盖，不看 `overwrite`。`overwrite` 只用于 move / rename 的目标已存在。`create` 在目标已存在时始终拒绝。
- 没有冲突时，`restore` 直接回滚，不因为 `onConflict: "cancel"` 停住。`cancel` 只在已经有冲突时保证不改磁盘。
- `backup_ref` 存的是 sha256，不是备份文件的绝对路径。绝对路径在 `backups.stored_path`。
- 暂存表名是 `staging_entries`。
- `actor` 在运行时必须是 `ui`，或 `agent:` 后面跟一段不含冒号的非空名字。
- 半完成的 write 只标 `incomplete`。调用方要不要据此重试，本包没有代做。

## 根目录复跑（组长，2026-10-03）

在 `D:\workspace\kb` 执行 `npm install`、`npm run build`、`npm test`，退出码 0。本包这次是 2 个文件、15 项通过。其中包含「覆盖、删除、移动后 op_log.resource_id 等于 W2 的资料 ID，移动后 ID 不变」。

## 第 9 轮

新增 `test/cross-root.test.ts`。用的是 `@kb/identity-watch` 的 `createRoot`、`setMount`、`ensureResource`、`resolveInsideRoot`、`updateLocation`。fileops 的 `onMoved` 直接调用 `updateLocation`。没有改生产代码，也没有 `it.skip`。

同卷两个临时根：`move` 带 `toRootId`。资料 ID 不变，`resources.root_id` 变成目标根，源路径没有文件，目标字节一致。再 `restore`，文件回到原根原路径，ID 仍是原来的。

subst：这次挂的是 `X:`，指向临时目录。一个根在原路径，一个根在 `X:\dst`。移动前源文件在原盘符、目标盘符上没有；移动后源没有了，`X:` 上的文件和原卷镜像路径字节一致，ID 不变，inode 也没变。`finally` 执行 `subst X: /d`。控制台是 `SUBST_MOUNTED X: EXDEV=no`。本机 Node 24 上这条 `fs.renameSync` 不抛 `EXDEV`（同一 dev），所以 subst 没有走进复制回退。没有把这次当成测过 EXDEV。

EXDEV：Node 直接启动 `diskpart.exe` 是 `EACCES`。改由 powershell 调 diskpart，建了 64MB VHD 并分到 `Y:`。探测用的 `fs.renameSync` 从临时目录到 `Y:` 抛 `EXDEV`。随后 fileops 跨根 move：字节一致、源消失、ID 不变，目标 inode 与源不同，说明走了复制再删除。`finally` 卸掉 `Y:` 并删除 VHD。控制台是 `EXDEV_RAN vhd Y:`。跑完后盘符只剩 C、D、E，`subst` 列表是空的。

在 `D:\workspace\kb\modules\fileops`：

```text
npm run build
npx vitest run
```

`npm run build` 退出码 0。vitest 3.2.7：

```text
Test Files  3 passed (3)
     Tests  19 passed (19)
  Duration  26.06s
```

19 通过，0 失败，0 跳过。EXDEV 真的跑到了，靠的是 VHD `Y:`，不是 subst。

## 第 9 轮修正 · 跨卷

上面的 subst `X:` 和 64MB `Y:` 不是本条的验收结果。验收盘是 1GB 的 `V:`。

本机没有 `New-VHD`。管理员 PowerShell 用 diskpart `create vdisk file="D:\kb-test-vol.vhdx" maximum=1024 type=expandable` 然后 `attach vdisk`，再 `Initialize-Disk` GPT、`New-Partition -DriveLetter V`、`Format-Volume` NTFS 卷标 `KBTEST`。`D:\kb-vhd-mount.log` 记了 `method=diskpart`、`diskpart_exit=0`、`disk_bus=File Backed Virtual`、`disk_size=1073741824`、`label=KBTEST`、`fs=NTFS`、`V_READY`。`Get-Disk` 的 `Location` 是 `D:\kb-test-vol.vhdx`。

`src\engine.ts` 1900–1911：`copyThenUnlink` 在目标文件就位后，若 `KB_FILEOPS_CRASH_POINT=exdev-before-unlink`，先 `process.exit(91)`，再删源文件。`test\cross-root.test.ts` 用 `KB_TEST_SECOND_VOLUME`。没设置就 `it.skipIf`，并打印 `SKIP_CROSS_VOLUME`，跳过不算通过。

目录 `modules\fileops`。

未设置变量：`npx vitest run test/cross-root.test.ts --reporter=verbose`。22:32:50，1.78s，退出码 0。1 passed、2 skipped。输出含 `SKIP_CROSS_VOLUME 未设置 KB_TEST_SECOND_VOLUME。跨卷 EXDEV 测试已跳过，不算通过。示例：KB_TEST_SECOND_VOLUME=V:\`。

`$env:KB_TEST_SECOND_VOLUME = 'V:\'` 后同一命令。22:50:22，2.58s，`VITEST_EXIT=0`。3 passed。其中「跨卷移动到第二个卷，回滚后回到 D 盘」437ms 通过；「跨卷复制完成后、删除源文件之前失败，两边都还在」556ms 通过，子进程退出码 91，源文件和目标文件都还在且字节一致。

卸盘没有用 `Dismount-VHD`。diskpart `detach vdisk` 的 `detach_exit=0`，随后删除 `D:\kb-test-vol.vhdx`。日志 `V_REMOVED`。复查 `V:` 和该 vhdx 都不存在。
