# @kb/sync 验收记录

测量时间：2026-10-03。命令都在 `modules/sync` 下执行。没有改 indexer、identity-watch、fileops、agent-api、plan、根 `package.json`、约定文件、`SUMMARY.md`、`modules/磐石组-REPORT.md`、`modules/开工前修正-REPORT.md`。没有跑仓库根的 `npm install`，也没有跑 indexer 的测试。

`node_modules/@kb/sync` 是指向 `modules/sync` 的 Junction。

## 命令和结果

`npm run build`（`tsc -p tsconfig.json && node scripts/fix-dts.mjs`）退出码 0。`dist/index.d.ts` 导出 `createSync`，相对导入后缀是 `.js`。

`npx vitest run --reporter=verbose`

- vitest 3.2.7
- Test Files 3 passed (3)
- Tests 5 passed (5)
- 开始 11:17:13，Duration 33.61s（tests 32.07s）
- 退出码 0

1000 个文件那条的 stdout：

```text
SYNC_LAG {"maxLagMs":15.91,"atMs":10016.4}
```

增量索引的 stderr：应用外改文件 `processed=2`，1000 个文件 `processed=1000 errors=0`，取消后续跑 `processed=6 errors=0`。

## 行为

- 通过。启动先 `reconcile`，再 `startIndex({ mode: 'incremental' })`。`resolveResourceId` 在调用 `startIndex` 的会话线程上执行，已有资料走 `resolveInsideRoot`，否则 `ensureResource`。抽正文在 indexer 的 worker 里。进度转到 `onProgress`。同一 root 再次 `startSync` 返回正在跑的那份。
- 通过。首轮结束后 `watchRoot`。`onResourceChanged` 只入队。1000 个文件复制时主线程漂移 15.91ms，说明回调里没有抽 PDF 或跑索引。
- 通过。create、modify 在 worker 里 `indexOne`（`lookupPath`）。delete 走 `removeOne`。rename-move 只 `relocateResource`，不 `indexOne`。改名测试先把正文改成 `PoisonKeepWord`，改名后同一资料 ID 仍能用这个词搜到。
- 通过。改名在 `src/relocate.ts`，只动 SQL，没有改 indexer。`indexer_files` 更新 `rel_path`（`/`、NFC）、`rel_key`（Windows 小写）、`size`、`mtime_ms`（`fs.stat`，不读内容），`resource_id` 不变。`fts_content` 按 `resource_id` 删掉再插入，正文原样，title 换成新文件名。本机 tokenizer 是 trigram。`fts_short` 同样删掉再插入：`title` 是 `bigramTokenize(文件名 + 换行 + 相对路径)`，`title_text` 是新文件名，`path_text` 是新相对路径，`body` 和 `body_text` 保留。
- 通过。worker 内按 `resourceId` 合并，窗口 150ms，`whenIdle` 会立刻清掉这个定时器。`mergeQueued` 测试：delete 压过尚未执行的 modify；纯改名是 relocate；已有 upsert 时改名仍是 upsert。队列上限 256。1000 个文件超出上限后 `dirty` 补扫（再 reconcile + incremental），结束后都能搜到。
- 通过。`cancel()` 停掉监视、增量任务和会话。已写入的索引保留。`done` 的 status 是 `cancelled`。再次 `startSync` 能续上。正常监视不结束 `done`，测试用 `whenIdle()`。
- 通过。1000 个小 txt 由子进程复制。被测进程只跑 `startSync` 和 `setInterval(20)`。最大漂移 15.91ms，阈值仍是 50ms，没有放宽。

## 验收

临时目录在 `os.tmpdir()`，`afterAll` 里删除。数据库是文件，identity-watch 建 root 和 mount，indexer `migrate`。搜正文用 `@kb/indexer` 的 `search()`。标记词都不少于 4 个字符。

- 通过。应用外 `fs` 新建、修改、删除、改名各一份 md 和一份 pdf-lib 写出的 PDF。`whenIdle` 都在 8 秒内。改名后同一资料 ID 能用正文里的词搜到，`title` 是新文件名，`indexer_files.rel_path` 是新路径。删除后搜不到，`indexer_files` 行也没有。
- 通过。子进程复制 1000 个小 txt。主线程漂移 15.91ms。`whenIdle` 后 1000 个都能用各自的 `markNNNN` 词搜到，`title` 是对应文件名。`indexer_files` 行数是 1000。
- 通过。`startSync` 后立刻 `cancel`，status 是 `cancelled`，`search` 不抛。再次 `startSync` 后 6 个文件都能搜到。索引检查见下。
- 通过。本机 `migrate` 已经建了 `fts_short`，测试只插入一行，没有再建表。`relocate` 之后 `title_text` 是 `新笔记.md`，`path_text` 是 `归档/新笔记.md`，`body_text` 仍是 `SHORTBODYKEEP`。

取消后的完整性：监视连接还开着时，`wal_checkpoint(PASSIVE)` 不重置 WAL，`PRAGMA integrity_check` 会误报 `fts5: checksum mismatch for table "fts_short"`。同一时刻 FTS5 自己的 `INSERT INTO fts_short(fts_short) VALUES('integrity-check')` 是成功的，`wal_checkpoint(RESTART)` 之后 `PRAGMA integrity_check` 也是 `ok`。测试用 RESTART，再跑 `fts_content` 和 `fts_short` 的 `integrity-check`，然后断言 `PRAGMA integrity_check` 为 `ok`。没有把产品热路径改成 `TRUNCATE`。

## 没做的

- 没有跑 indexer 的测试。
- 没有跑 identity-watch 的测试。
- 没有跑仓库根目录的 `npm install`、`npm run build` 或 `npm test`。
- 没有 git commit。
