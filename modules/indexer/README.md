# @kb/indexer

## 稳定接口 v1.2

`search(db, query, opts)` 的签名、`SearchHit` 和排序都不改。少于 3 个码点时，`search()` 仍然返回空数组：trigram 下 `buildMatchQuery` 对短查询返回 null，不会改成全表扫描。

`searchGrouped(db, query, opts?)` 返回 `{ hits, truncated, reindexRequired?, reindexReason? }`。空查询和 `rootIds: []` 仍是 `{ hits: [], truncated: false }`，不带后两个字段。其余情况带 `reindexRequired`。索引完成后它是 `false`。库里已有 `fts_content` 行但 `indexer_meta.text_index_version` 不是 `2` 时为 `true`，并带中文 `reindexReason`。这时不要把空的 `hits` 当成没有这份资料。`migrate` 不会把旧行标成新分块。

- `opts.limit` 默认 20，限制资料条数，不是页数。组数超过 limit 时 `truncated` 为 true。
- `opts.rootIds` 与 `search()` 相同。不传表示不按根过滤；空数组返回 `{ hits: [], truncated: false }`。
- 每条 hit：`resourceId`、`rootId`、`relPath`、`title`（文件名）、`score`（越大越相关）、`matchKind`（`'name'` 或 `'body'`）、`page`（第一条的页，txt/md 为 0）、`snippet`（第一条，高亮是 `<b>`…`</b>`）、`matches`（最多 3 条）、`matchesTruncated`。
- 每条 match：`page`、`line`（PDF 为 null，txt/md 为从 1 开始的行号）、`snippet`、`anchor`。PDF 的 anchor 是 `{ page }`，txt/md 是 `{ line }`。
- 同一 `resourceId` 合成一条。同一 PDF 的第 3 页和第 7 页命中时，hits 只有这一条，matches 里两条，锚点分别是 `{ page: 3 }` 和 `{ page: 7 }`。
- 文件名或相对路径命中（`matchKind: 'name'`）排在只命中正文前面。两边都命中算 name。判断用已经命中的那一行的文件名和相对路径是否包含查询串，不对全表正文做 `LIKE`。
- 码点长度小于 3：只查 `fts_short`。入库时汉字串写重叠二字，再为每个字写一个单字 token。查询仍用 FTS5 `MATCH`。长度为 1 的查询短语就是这个单字；更长的查询短语只含重叠二字，避免单字把短语打断。这不是全文 `LIKE '%词%'`，也不是把短查询扩成全表扫描。`search()` 在 trigram 下少于 3 个码点仍然返回空数组。
- 码点长度大于等于 3：正文仍用和 `search()` 同一套 tokenizer 对 `fts_content` 做 `MATCH`。文件名和相对路径（含目录名）再对 `fts_short.title` 做 FTS5 `MATCH`（重叠二字，列过滤是 `title : …`），然后按 `resourceId` 合并。不是对正文或全表做 `LIKE '%词%'`。`search()` 本身不查路径。
- txt / md 入库按每 20 行切一块（末尾换行不算额外的空行）。每个文件最多 3 处命中。锚点是该处在原文件里的行号，不是块号。词在第 40 行时 `anchor` 是 `{ line: 40 }`。PDF 仍按页，不切行。`extractText` 不按块拆开，txt / md 仍是一条、`page` 为 0。
- 查 `fts_content` / `fts_short` 的 SQL 都有 `ORDER BY` 和 `LIMIT ?`。`LIMIT` 是绑定参数，等于调用方的资料条数上限乘 3，再加 8。不把全部命中读进内存再截断。
- 只有路径命中、没有正文页时，只留一条 match，snippet 是相对路径里的高亮。txt/md 的 `page` 为 0，`line` 为 1，`anchor` 为 `{ line: 1 }`。PDF 的 `line` 为 null，`page` 和 `anchor.page` 是同一个已索引页码 N（该文件命中行里的最小页，通常是 1），不编造没有抽取过的页。同一资料只出现一次；文件名或路径命中仍是 `matchKind: 'name'`，排在只命中正文前面。
- `searchGrouped` 的查询路径不会重建全库。`fts_content.title` 仍然只是文件名。新写入并完成索引后 `text_index_version` 为 `2`。旧库要重新跑一遍 `startIndex`，行块和单字才齐全。

`@kb/agent-api` 的 `search.query` 应原样返回上面的 `{ hits, truncated }`，不要再包一层，hit 上必须有 `relPath`。本包不把 `search.query` 接到 agent-api。响应 JSON：

```json
{
  "hits": [
    {
      "resourceId": "6f1c0b3e-9a4d-4e7a-8c2b-1d0e5f6a7b8c",
      "rootId": "root-docs",
      "relPath": "special/qinglan.pdf",
      "title": "qinglan.pdf",
      "score": 2.4,
      "matchKind": "body",
      "page": 3,
      "snippet": "第三页 出现目标 <b>青岚索引词</b> 只在这里。",
      "matches": [
        {
          "page": 3,
          "line": null,
          "snippet": "第三页 出现目标 <b>青岚索引词</b> 只在这里。",
          "anchor": { "page": 3 }
        },
        {
          "page": 7,
          "line": null,
          "snippet": "第七页还有 <b>青岚索引词</b>。",
          "anchor": { "page": 7 }
        }
      ],
      "matchesTruncated": false
    }
  ],
  "truncated": false
}
```

txt / md 的 match 则是 `"line": 4`、`"anchor": { "line": 4 }`，`page` 为 0。

本地知识库的全文索引。只读资料根目录，索引写到调用方给的数据库文件，不往资料根里写任何东西。不依赖 `@kb/identity-watch`、`@kb/fileops`、`@kb/agent-api`。

## 做什么

- `migrate(db)` 建 `fts_content`、`fts_short` 和本包自己的进度表。`fts_content` 的列是 `resource_id UNINDEXED, page UNINDEXED, title, body, root_id UNINDEXED`，另加 `line_start UNINDEXED`（txt/md 块的起始行，PDF 为 0）。PDF 每一页一行。txt 和 md 的 `page` 为 0，每 20 行一块。`fts_short` 用 `unicode61` 存重叠二字和单字。少于 3 个码点的 `searchGrouped` 只 MATCH `fts_short`；不少于 3 个码点时，正文走 `fts_content`，文件名和相对路径只 MATCH `fts_short.title`。已有库调用 `migrate` 不改旧全文表，也不把 `text_index_version` 写成 2。下次 `startIndex` 发现没有 `line_start` 列时会丢掉全文表重建，已有 `indexer_files` 仍按变更判断；列已经是新的则不丢数据。
- 扫描在 `worker_threads` 里做。跳过点开头的隐藏目录、`$RECYCLE.BIN`、`System Volume Information`、`node_modules`，以及 `skipDirNames`。只收 `.txt`、`.md`、`.pdf`。符号链接不跟。单个文件失败记进 `errors`，任务继续。
- PDF 用 `pdfjs-dist` 传统构建按页抽文本。汉字之间被插进的空格会收掉。
- `startIndex({ rootId, localPath, dbPath, resolveResourceId, mode })` 返回 `{ jobId, onProgress(cb), cancel(), done }`。进度里有已处理数、总数、当前文件。`resolveResourceId` 只在调用 `startIndex` 的线程上执行。`dbPath` 不能是 `:memory:`，worker 会自己打开这个文件。
- `cancel()` 之后，worker 在当前文件的检查点停下来。大约 1 秒内若还没停，调用方按已收到的进度结束，并给线程发 `shutdown`，不 `terminate`。已经写入的页保留。
- `closeIndexer()` 通知 worker：若自己还开着数据库，先 `wal_checkpoint(PASSIVE)` 再 `close()`，然后 `port.close()`。父进程等 worker 的 `exit` 再返回。调用方要先 `await closeIndexer()`，再关自己的数据库。进程退出不再从 `beforeExit` 碰 worker。worker 里不调用 `process.exit`。
- `mode: 'incremental'` 只处理 size 或 mtime 变了的文件，以及上次没写完的文件。磁盘上已经不在扫描范围内的资料会从索引里删掉。
- `indexOne(db, resourceId, { lookupPath })` 和 `removeOne(db, resourceId)` 按资料 ID 补一条或删一条。
- `search(db, query, { limit, rootIds })` 返回 `{ resourceId, page, title, snippet, score }`。`snippet` 用 `<b>` 和 `</b>` 包住命中的原文。`score` 是 FTS5 `bm25` 取反，越大越相关。
- `extractText(absPath)` 给 `@kb/agent-api` 用，返回 `Promise<{ page, text }[]>`。PDF 每页一条，`page` 从 1 开始；txt 和 md 一条，`page` 为 0。对方不用再接一套 PDF 解析。`extractText` 只能在 worker 里执行，主线程不准同步调用 pdfjs，也不准在主线程读全文。对外函数会把工作丢进已有的索引 worker。调用时如果已经在 worker 线程里，就直接抽，避免自己等自己。

批量写入把该连接设成 `synchronous = NORMAL`，并把 `wal_autocheckpoint` 设为 0，避免写到一半去截断 WAL。任务结束时，无论成功、取消还是失败，都在 `db.close()` 之前做一次 `wal_checkpoint(PASSIVE)`。不用 `wal_checkpoint(TRUNCATE)`：截断会跟调用方已经打开的连接抢锁，主线程 `setInterval` 会停几十毫秒。PASSIVE 不截断 WAL 文件。已提交的内容，别的连接可以直接读。不调进程优先级。

全量且库里只有索引表时：先把前 2 个文件写入调用方的库，其余在 `:memory:` 里按 400 条一批写入，批与批之间 `setImmediate`。写完再 `backup` 到 `dbPath`，然后重新打开文件库并做 `wal_checkpoint(PASSIVE)`。库里还有别的表、别的根，或这次不是整库替换时，在原库上按 8 条一批写入，批与批之间同样 `setImmediate`。读取进程每 80 个文件让出 15ms，避免连续打开把主线程定时器拖过 50ms。txt/md 正文由单独的读取进程打开（一次打开同时拿大小、mtime 和正文），打成一个 json 文件，只把路径送回调用进程，避免把两千份正文经 IPC 克隆进主线程。调用进程在等读取和写入时留一个 5ms 定时器，避免空闲时 Windows 把 20ms 定时器合并到 50ms 以上。不用 `setImmediate` 空转，避免长时间空转把 GC 停顿算进漂移。PDF 仍在不打开 sqlite 的线程里抽，并且在读正文之前完成预热（`indexerReady()`）。

## 中文为什么这样切

优先用 SQLite FTS5 自带的 `trigram`（`case_sensitive 0`）。它按任意连续三个字符建索引，中文不用词典，短语查询能对上正文里的连续汉字。`migrate` 会在临时表上用「青岚索引词」试一次。能建表并且引号短语能命中，就用 trigram。

链上的 SQLite 没有 trigram 时，退回 `unicode61` 加自己的切分。原文放在不参与检索的列里，摘录和高亮仍用原文。

长度 n 的汉字串，入库 token 从 n-1 个重叠二字变成 2n-1 个（n-1 个重叠二字，再加 n 个单字；n=1 时只有那一个字）。例如「庚辛」入库是 `庚辛`、`庚`、`辛`，所以查询「庚」能命中。查询短语在 n≥2 时只带重叠二字，单字只在查询本身长度为 1 时使用，否则二字短语会对不上。这不是 `LIKE`。多出来的单字主要进 `fts_short`（trigram 主索引仍存原文）。少于三个字符时，`search()` 在 trigram 下直接返回空。一个字或两个字的 `searchGrouped` 查 `fts_short` 的 FTS5 `MATCH`。

第 9 轮实测（`npx vitest run`，2026-10-04）：样本「庚辛壬癸甲乙丙丁戊己」重复 10 次，n=100。只做二字是 99 个 token，加上单字是 199 个 token，正好是 2n-1。同样 300 条正文放进 `unicode61` 的 FTS5 表，只有二字的库文件 315392 字节，二字加单字的库文件 516096 字节，增加 200704 字节，约为 1.64 倍。2000 个小文件索引完成后的 sqlite 文件是 3171312 字节。`searchGrouped` 查「庚」耗时 1.09ms。

## 样例

```text
node scripts/make-corpus.mjs <目录> [填充文件数]
```

默认再写 2000 个中英文 md 和 txt，另加 1 份 4 页 PDF 和 3 个专项文件。中文 PDF 用 `C:\Windows\Fonts\simhei.ttf`（不用 ttc）。只出现在 PDF 第 3 页的词是「青岚索引词」。

## 构建

`npm run build` 用 tsc 输出 `dist/`（含 `.d.ts`）。源码导入带 `.ts` 后缀，方便 Node 直接跑 worker；tsc 会把 `.js` 里的后缀改成 `.js`，`scripts/fix-dts.mjs` 再把声明文件里的相对 `.ts` 改成 `.js`，否则 `NodeNext` 找不到类型。

`main`、`types`、`exports` 指向 `dist`。
