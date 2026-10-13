# @kb/sync

## 稳定接口 v1.2

把 `@kb/identity-watch` 的对账、监视和 `@kb/indexer` 的增量索引接在一起。不依赖 Electron。数据库连接由调用方传入，并且必须是文件库，不能是 `:memory:`。

监视回调里会同步扫整棵资料树。会话因此跑在 `worker_threads` 里，主线程只收进度、取消和 `whenIdle`。正文提取仍走 indexer 自己的 worker，不在主线程上抽。

```ts
createSync(deps: {
  db: Database;
  dbPath: string;
  resolveLocalPath(rootId: string): string;
}): { startSync(rootId: string): SyncHandle }

SyncHandle:
  onProgress(cb: (p: SyncProgress) => void): () => void
  cancel(): void
  whenIdle(): Promise<void>
  done: Promise<{ status: 'cancelled' | 'error' }>
```

`SyncProgress.phase` 是 `reconcile | index | catchup | idle | cancelled | error`，另外有 `seen`、`total`、`currentFile`、`pending`、`dirty`。`total` 在对账扫描时可能是 `null`。

同一 root 上重复 `startSync` 返回正在跑的那份。`done` 只在 `cancel()` 或不可恢复错误时结束。正常监视不结束，用 `whenIdle()` 等这一轮做完。

`resolveLocalPath` 必须和该 root 的 `setMount` 指向同一目录。

### 启动和事件

1. 先 `reconcile`，再 `startIndex({ mode: 'incremental' })`。`resolveResourceId` 在调用 `startIndex` 的线程上执行：路径上已有活记录就用它的 ID，没有才 `ensureResource`。
2. 首轮结束后 `watchRoot`。监视返回前落盘、但不会再发事件的文件，会再补一次增量。
3. `onResourceChanged` 只入队。`create` / `modify` 在会话 worker 里 `indexOne`（带 `lookupPath`）。`delete` 用 `removeOne`。`rename-move` 只改位置，不调用 `indexOne`，不重抽正文。
4. 队列按 `resourceId` 合并，安静约 150ms 再执行。尚未执行的 `modify` 会被 `delete` 盖掉。超过 256 条就丢掉细事件，`dirty = true`，稍后重新 `reconcile` 加增量索引，补扫结束 `dirty = false`。
5. `cancel()` 停掉监视、增量任务和会话 worker。已经写入的索引保留。再次 `startSync` 可以续上。

### 改名

`relocateResource(db, { resourceId, absPath, relPath })` 在 `src/relocate.ts`。只动索引表，不改 indexer 的代码，也不读文件内容。`size` / `mtime_ms` 来自 `fs.stat`。`resource_id` 不变。`rel_path` 用 `/` 和 NFC；Windows 上 `rel_key` 小写。

`fts_content` 按 `resource_id` 读出每一行，删掉再插入。`body`（bigram 还有 `body_text`）原样拷回。trigram 的 `title` 换成新文件名；bigram 的 `title` 写入文件名的重叠二字，`title_text` 是新文件名。用 `indexer_meta.tokenizer` 区分。

若存在 `fts_short`，同样删掉再插入：保留 `body` 和 `body_text`，`title` 换成 `bigramTokenize(文件名 + 换行 + 相对路径)`（与 indexer 写入这列的切法相同），`title_text` 是新文件名，`path_text` 是新相对路径。表不存在就跳过。

## 构建

`npm run build` 用 tsc 输出 `dist/`（含 `.d.ts`）。源码导入带 `.ts` 后缀。`scripts/fix-dts.mjs` 把声明文件里的相对 `.ts` 改成 `.js`。`main`、`types`、`exports` 指向 dist。

## 测试

```powershell
npm run build
npx vitest run
```

在临时目录里做，结束删除。
