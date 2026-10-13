# @kb/indexer 验收记录

测量时间：2026-10-03。命令都在 `modules/indexer` 下执行。

## 命令和结果

`npx vitest run --reporter=verbose --no-color`

- vitest 3.2.7
- Test Files 2 passed (2)
- Tests 13 passed (13)
- 开始 09:23:23，Duration 28.38s（tests 27.61s）
- 退出码 0
- 没有 `ERR_IPC_CHANNEL_CLOSED`

全量那条的 stdout：

```text
INDEXER_LAG_AT 7607.5
INDEXER_METRICS {"files":2004,"fileCount":2004,"elapsedMs":15790,"maxLagMs":43.55,"tokenizer":"trigram","errors":[],"status":"completed"}
```

取消那条的 stdout：

```text
CANCEL_METRICS {"stopMs":3,"processedBeforeStop":2,"total":404,"resumed":402}
```

`npm run build`（`tsc -p tsconfig.json && node scripts/fix-dts.mjs`）退出码 0。`dist/` 里有 `.js` 和 `.d.ts`。`dist/index.d.ts` 导出 `extractText`，相对导入后缀是 `.js`。

## 验收

- 通过。`migrate(db)` 建 `fts_content`。本机走 FTS5 `trigram case_sensitive 0`。列是约定里的 `resource_id UNINDEXED, page UNINDEXED, title, body`，另加 `root_id UNINDEXED`。中文检索在「青岚索引词」那条测试里命中。理由写在 README。bigram 只在探测失败时启用，这次运行没有走到。
- 通过。扫描在 `worker_threads` 里。测试覆盖跳过隐藏目录、`node_modules`、`$RECYCLE.BIN`、`System Volume Information` 和额外目录名。txt、md、PDF 正文写入 FTS。PDF 用 pdfjs-dist 按页抽，青岚那份 4 页、第 3 页命中。坏 PDF 记入 `errors`，任务仍是 `completed`。
- 通过。`startIndex` 返回 `jobId`、`onProgress`、`cancel`，另外还有 `done`。进度里有 `processed`、`total`、`currentFile`。取消测试用了 `processed`；`currentFile` 有发出，没有单独断言非空。取消到结束 3ms，已写入的文件还能搜到。增量测试改一个文件后 `filesProcessed` 只有那一条。`indexOne(db, resourceId, { lookupPath })` 和 `removeOne(db, resourceId)` 有测试。签名比「只传 resourceId」多了数据库和路径查找，本包没有资料表。
- 通过。`search` 返回 `resourceId`、`page`、`title`、`snippet`、`score`。snippet 含 `<b>…</b>`。高亮是自己拼的，不是 FTS `snippet()`。
- 通过。资料 ID 只通过传入的 `resolveResourceId(rootId, relPath)` 取得。测试里是 `Map` 加 `randomUUID` 的假实现。
- 通过。`scripts/make-corpus.mjs` 仍在。全量测试调用它，`fileCount` 为 2004（2000 个填充文件加 1 份 PDF 和 3 个专项文件）。中文 PDF 字体是 `C:\Windows\Fonts\simhei.ttf`。只在该 PDF 第 3 页出现的词是「青岚索引词」。
- 通过。2004 个文件全量索引，状态 `completed`，`errors` 为空。耗时 15790ms。主线程 `setInterval(20)` 最大漂移 43.55ms，出现在开始后约 7607ms。断言仍是 `<= 50`，没有放宽。余量大约 6ms。
- 通过。取消后增量续完：停前 2 个，续上 402 个，合计 404。搜索「青岚索引词」第一条是那份 PDF，`page` 为 3，snippet 有高亮。英文词、中文短语、只在正文里的词都命中。改一个文件后增量只处理它。
- 通过。包入口导出 `extractText(absPath)`。测试确认 PDF 按页且 page 从 1 开始，txt 和 md 一条且 page 为 0。

测试崩溃：`vitest.config.ts` 使用 `pool: 'forks'` 和 `poolOptions.forks.singleFork: true`。索引线程不接管 stdout/stderr，成功后不退出，进程 `beforeExit` 时再让它退出。这次 13 个测试都跑完了，没有把用例改到独立 `node` 子进程，也没有跳过测试。

## 没做的

- 没有在任务结束后做 WAL checkpoint。
- 没有把索引测试拆到 vitest 外面的 `node` 进程。这次套件没有再崩，所以没做。
- 没有在关掉 trigram 的 SQLite 上跑完整索引。bigram 只测了切分函数。
- 没有跑仓库根目录的 `npm test` 或 `npm run build`。
- 没有 git commit。

## 需要决定的问题

- 批量写入使用 `synchronous = OFF`，并关掉这条连接的 WAL 自动 checkpoint，结束时也不 `TRUNCATE`。已提交的内容别的连接能读。断电或操作系统崩溃时，这个同步级别有损坏数据库的风险。WAL 会一直留到别的连接去做 checkpoint。要不要在 `job.done` 之后由调用方 checkpoint，需要定。
- `extractText` 在调用它的线程里抽文本（pdfjs 在 Node 里用假 worker）。批量扫描仍在 `worker_threads`。如果抽文本也不能占主线程，要再包一层，可能重新碰到 vitest 的 IPC。
- 索引线程为了不拆掉 vitest 的 fork IPC，成功后一直留到进程要退出。只有取消超过 900ms 才 `terminate`。
- `indexOne` / `removeOne` 都要调用方传入已经打开的数据库。`indexOne` 在库里没有路径时还要 `lookupPath`。

## 根目录复跑（组长，2026-10-03）

在 `D:\STUDY MATERIAL\项目\知识库` 执行 `npm install`、`npm run build`、`npm test`，退出码 0。本包这次是 2 个文件、13 项通过。全量索引 stdout：`files` 2004，`elapsedMs` 14700，`maxLagMs` 42.04。取消 stdout：`stopMs` 2。上面「没有跑仓库根目录的 npm test」已被这次复跑补上。

## v1.2

测量时间：2026-10-03。正式命令都在 `modules/indexer` 下执行。没有改 agent-api、sync、plan、identity-watch、fileops，也没有把 `search.query` 接到 agent-api。`search.query` 应返回的 JSON 写在 README 的「稳定接口 v1.2」。

### 命令和结果

`npm run build`（`tsc -p tsconfig.json && node scripts/fix-dts.mjs`）退出码 0。`dist/index.d.ts` 导出 `searchGrouped`，相对导入后缀是 `.js`。`scripts/fix-dts.mjs` 仍在 build 末尾。

`npx vitest run --reporter=verbose`

- vitest 3.2.7
- Test Files 3 passed (3)
- Tests 17 passed (17)
- Duration 82.60s（tests 81.41s）
- 退出码 0

全量那条的 stdout：

```text
INDEXER_LAG_AT 12374.5
INDEXER_METRICS {"files":2004,"fileCount":2004,"elapsedMs":14563,"maxLagMs":16.64,"tokenizer":"trigram","errors":[],"status":"completed"}
```

取消那条的 stdout：

```text
CANCEL_METRICS {"stopMs":14,"processedBeforeStop":2,"total":404,"resumed":402}
```

二字查询那条的 stdout：

```text
SHORT_QUERY_MS 1.25
```

在这之前单独跑过 `test/search-v12.test.ts`（当时工作目录误在仓库根，vitest 仍跑的是 indexer 这份测试），4 项通过，`SHORT_QUERY_MS 93.01`。两次都 ≤ 300ms。全量套件里的 1.25ms 是同一进程里前面已经查过库之后的数字；93.01ms 更接近索引刚结束时的第一次查询。

### 验收

- 通过。`migrate(db)` 在新建和已有 `fts_content` 时都执行 `CREATE VIRTUAL TABLE IF NOT EXISTS fts_short`，列和 `tokenize = 'unicode61'` 与任务里的 SQL 一致。`search-v12` 里那份 7 页 PDF 在 `fts_content` 和 `fts_short` 各有 7 行。
- 通过。`IndexStore` 写页和 `deleteFts` 都在原事务里同时写删 `fts_short`。`removeOne`、`removeUnseen`、增量覆盖走的是 `deleteFts`。`fts_content.title` 仍只是文件名；路径只放进 `fts_short`。本机 tokenizer 是 trigram，这条路径实测写了 `fts_short`。
- 通过。`search(db, query, opts)` 的签名、`SearchHit` 和 `ORDER BY bm` 没改。`buildMatchQuery` 对 trigram 短查询仍返回 null。`search(db, '戊己')` 在 trigram 下是空数组。原测试「青岚索引词」第一条仍是 PDF 第 3 页，`title === 'qinglan.pdf'`，高亮是 `<b>`…`</b>`。
- 通过。至少 7 页的 PDF，第 3 页和第 7 页都有「页码聚合词」。`searchGrouped` 只返回一条，`matches` 两条，页码 3 和 7，锚点 `{ page: 3 }` 和 `{ page: 7 }`，`line` 为 null，`title` 是 `pages.pdf`。
- 通过。`docs/fourth-line.md` 里「行号定位词」在第 4 行。`anchor` 是 `{ line: 4 }`，`page` 是 0。
- 通过。`rank/文件名优先词.md` 只在文件名里有这个词，`rank/plain-body.md` 只在正文里有。前者 `matchKind` 为 `name`，排在前面。判断用的是已命中行的文件名和相对路径，不是全文 `LIKE`。
- 通过。2000 个很小的 md，另加 `pad/wuji.md` 含「戊己」。全量套件里 `searchGrouped(db, '戊己')` 耗时 1.25ms，单独跑该文件时 93.01ms，都 ≤ 300ms，且只命中这一个文件。短查询走 `fts_short` 的 FTS5 `MATCH`（入库时重叠二字），不是正文 `LIKE '%戊己%'`。
- 通过。原有 indexer 测试都在这 17 条里，没有删断言，也没有放宽 `<= 50`。主线程 `setInterval(20)` 最大漂移 16.64ms。取消到结束 14ms。
- 通过。批量写入仍是 `synchronous = NORMAL`，结束时 `wal_checkpoint(PASSIVE)`，没有改回 OFF，也没有用 TRUNCATE。`startIndex` 仍会临时提高进程优先级，结束时恢复。`extractText` 仍由主线程丢进 worker。没有加回 `package-lock.json` 或 probe 脚本。
- 通过。`searchGrouped` 的查询路径没有重建全库。README 写了旧库要再 `migrate` 并重新索引，新写入的文件当时进 `fts_short`。
- 通过。`rootIds: []` 返回 `{ hits: [], truncated: false }`，写在 PDF 那条测试里。
- 未测。没有造一份 v1.2 之前的数据库文件，再调用新的 `migrate` 看空表是否补上。代码走的是 `IF NOT EXISTS`，重复 `migrate` 的旧测试仍然通过。
- 未测。bigram 主索引的整库写入。本机探测结果是 trigram，bigram 只在切分函数的旧断言里碰到。`fts_short` 的插入不看主索引种类，但 bigram 那条 `insertBigram` 分支这次没跑到。
- 未测。`limit` 把资料条数截断后 `truncated === true`，以及一份资料超过 3 个 match 时 `matchesTruncated === true`。
- 未测。两个字的查询里，文件名命中是否排在正文前面。排序测试用的是不少于 3 个字的词，走 `fts_content`。聚合代码是同一段。
- 未测。仓库根目录的 `npm test` 或 `npm run build`。第一次误在仓库根执行了 `npm run build`，根脚本把四个包都编了一遍；indexer 源码之外的包没有手改。正式记录用的是后面在 `modules/indexer` 里重跑的 build 和 vitest。

### 没做的

- 没有把 `search.query` 接到 `@kb/agent-api`。
- 没有在 `searchGrouped` 里给旧库回填 `fts_short`。
- 没有 git commit。
- 没有写 `modules/磐石组-REPORT.md`。

### 需要决定的问题

- 旧库短查询在重新索引之前是空的。长查询仍走原来的 `fts_content`。
- 一个汉字不会从「重叠二字」里命中更长的词。`fts_short` 只在汉字串长度为 1 时留下单字。
- 不少于 3 个字的查询只 MATCH `fts_content`。目录名本身不在这张表里，只有文件名和正文。只出现在目录名里的长词，`searchGrouped` 找不到。少于 3 个字时，相对路径会进 `fts_short` 的 title。

### 路径命中（补）

上面第三条「需要决定」已改掉：不少于 3 个码点时，正文仍 MATCH `fts_content`，文件名和相对路径再 MATCH `fts_short.title`（重叠二字，列过滤 `title : …`），按资料合并。不是正文或全表 `LIKE`。`search()` 仍然不查路径。只有路径命中时一条 match，`page` 为 0；txt/md 的 anchor 是 `{ line: 1 }`；PDF 的 anchor 用已索引的最小页码，不编造没有抽取过的页。

`npm run build` 退出码 0（`tsc -p tsconfig.json && node scripts/fix-dts.mjs`）。

`npx vitest run --reporter=verbose`：vitest 3.2.7，3 个文件，**18 passed（18）**，退出码 0，Duration 113.74s。原先 17 条都在里面。全量索引 `maxLagMs` 22.26，`elapsedMs` 15764，`files` 2004，`errors` 空。取消 `stopMs` 24。`SHORT_QUERY_MS` 0.87。`search(db, '青岚索引词')` 第一条仍是 PDF 第 3 页，`title === 'qinglan.pdf'`。

新测试「目录名命中且排在只命中正文前面」通过：目录 `路径目录专名/` 下的 `note.md` 文件名和正文都没有这个词，`matchKind` 为 `name`，排在只在正文出现的 `misc/only-body.md` 前面。`search()` 只返回 `only-body.md`。

`synchronous = NORMAL`、`wal_checkpoint(PASSIVE)`、`extractText` 走 worker、进程优先级都没有改。没有接 `search.query`。

