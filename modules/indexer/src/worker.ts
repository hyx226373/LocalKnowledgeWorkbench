import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, parentPort } from 'node:worker_threads';
import { CancelledError, extractFile, readPlainFile, setPdfDelegate } from './extract.ts';
import { ftsHasLineStart, markTextIndexVersion, migrate, rebuildTextTables } from './migrate.ts';
import {
  fileChanged,
  isIndexableFile,
  relKey,
  shouldSkipDirectory,
  toRelPath,
} from './paths.ts';
import type { BulkWorkerData, MainToWorker, RunMessage } from './protocol.ts';
import { openDatabase, openMemoryDatabase } from './sqlite.ts';
import { IndexStore, type PageText } from './store.ts';
import type BetterSqlite3 from 'better-sqlite3';

interface ResolveReply {
  ids: string[];
  errors: Array<{ relPath: string; error: string }>;
}

// 由 index.ts fork 成独立进程。不要 process.exit。sqlite 还开着时不能被 terminate。
const port = parentPort
  ? {
      postMessage(message: unknown): void {
        parentPort?.postMessage(message);
      },
      on(event: 'message', cb: (message: MainToWorker) => void): void {
        parentPort?.on(event, cb);
      },
      close(): void {
        parentPort?.close();
      },
    }
  : {
      postMessage(message: unknown): void {
        try {
          if (typeof process.send === 'function') process.send(message);
        } catch {
          // 父进程已经把 IPC 关掉
        }
      },
      on(event: 'message', cb: (message: MainToWorker) => void): void {
        process.on(event, (message) => {
          if (!message || typeof message !== 'object') return;
          cb(message as MainToWorker);
        });
      },
      close(): void {
        process.disconnect?.();
      },
    };

interface PdfReply {
  reqId: number;
  pages?: PageText[];
  error?: string;
}

let pdfWorker: Worker | null = null;
let pdfReq = 0;
const pdfWaiters = new Map<number, (reply: PdfReply) => void>();

function pdfWorkerPath(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const ts = path.join(dir, 'pdf-worker.ts');
  if (existsSync(ts)) return ts;
  return path.join(dir, 'pdf-worker.js');
}

function pdfThreadEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    const up = key.toUpperCase();
    if (up === 'NODE_CHANNEL_FD' || up === 'NODE_CHANNEL_SERIALIZATION_MODE' || up === 'NODE_OPTIONS') {
      delete env[key];
    }
  }
  return env;
}

function getPdfWorker(): Worker {
  if (pdfWorker) return pdfWorker;
  const file = pdfWorkerPath();
  const worker = new Worker(file, {
    execArgv: file.endsWith('.ts') ? ['--experimental-strip-types', '--no-warnings'] : ['--no-warnings'],
    env: pdfThreadEnv(),
  });
  worker.unref();
  worker.on('message', (msg: PdfReply) => {
    if (msg.reqId === -1) {
      pdfWarm = true;
      try {
        port.postMessage({ type: 'warm' });
      } catch {
        // 父进程还没在听
      }
      return;
    }
    const waiter = pdfWaiters.get(msg.reqId);
    if (!waiter) return;
    pdfWaiters.delete(msg.reqId);
    waiter(msg);
  });
  worker.on('exit', () => {
    if (pdfWorker === worker) pdfWorker = null;
    for (const waiter of pdfWaiters.values()) waiter({ reqId: 0, error: 'pdf worker 已退出' });
    pdfWaiters.clear();
  });
  pdfWorker = worker;
  return worker;
}

function closePdfWorker(): Promise<void> {
  const worker = pdfWorker;
  pdfWorker = null;
  if (!worker) return Promise.resolve();
  return new Promise((resolve) => {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      resolve();
    };
    worker.once('exit', () => finish());
    try {
      worker.postMessage({ type: 'shutdown' });
    } catch {
      finish();
    }
  });
}

setPdfDelegate((absPath, relPath, isCancelled) => {
  if (isCancelled?.()) return Promise.reject(new CancelledError());
  const reqId = ++pdfReq;
  const worker = getPdfWorker();
  return new Promise((resolve, reject) => {
    pdfWaiters.set(reqId, (reply) => {
      if (isCancelled?.()) {
        reject(new CancelledError());
        return;
      }
      if (reply.error) reject(new Error(reply.error));
      else resolve(reply.pages ?? []);
    });
    try {
      worker.postMessage({ type: 'extract', reqId, absPath, relPath });
    } catch (err) {
      pdfWaiters.delete(reqId);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
});

let pdfWarm = false;
let cancelled = false;
let closing = false;
let currentRunId = 0;
let reqSeq = 0;
let activeDb: BetterSqlite3.Database | null = null;
const waiters = new Map<number, (reply: ResolveReply) => void>();
const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
const cancelSet = new Set<number>();
const jobs: RunMessage[] = [];
let pumping = false;

function emit(message: Record<string, unknown>): void {
  if (closing) return;
  try {
    port.postMessage({ ...message, runId: currentRunId });
  } catch {
    // 端口已经关了
  }
}

function closeActiveDb(): void {
  const db = activeDb;
  activeDb = null;
  if (!db || !db.open) return;
  try {
    db.pragma('wal_checkpoint(PASSIVE)');
  } catch {
    // 连接可能已经不能执行
  }
  try {
    if (db.open) db.close();
  } catch {
    // 已经关过
  }
}

port.on('message', (msg: MainToWorker) => {
  if (msg.type === 'shutdown') {
    // 不要 process.exit，也不要 terminate。先关 PDF 线程，再关自己的 sqlite，最后关端口。
    closing = true;
    cancelled = true;
    for (const timer of pendingTimers) clearTimeout(timer);
    pendingTimers.clear();
    void closePdfWorker().finally(() => {
      closeActiveDb();
      try {
        port.close();
      } catch {
        // 端口已经关了
      }
    });
    return;
  }
  if (msg.type === 'warm-ping') {
    if (pdfWarm) {
      try {
        port.postMessage({ type: 'warm' });
      } catch {
        // 父进程已经停了
      }
    }
    return;
  }
  if (closing) return;
  if (msg.type === 'cancel') {
    cancelSet.add(msg.runId);
    if (msg.runId === currentRunId) cancelled = true;
    return;
  }
  if (msg.type === 'resolve-result') {
    const waiter = waiters.get(msg.reqId);
    if (!waiter) return;
    waiters.delete(msg.reqId);
    waiter({ ids: msg.ids, errors: msg.errors });
    return;
  }
  jobs.push(msg);
  void pump();
});

function requestIds(relPaths: string[]): Promise<ResolveReply> {
  const reqId = ++reqSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingTimers.delete(timer);
      waiters.delete(reqId);
      reject(new Error('resolveResourceId 超时'));
    }, 120000);
    pendingTimers.add(timer);
    waiters.set(reqId, (reply) => {
      clearTimeout(timer);
      pendingTimers.delete(timer);
      resolve(reply);
    });
    emit({ type: 'resolve-request', reqId, relPaths });
  });
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

interface FoundFile {
  absPath: string;
  relPath: string;
  size: number;
  mtimeMs: number;
}

function walk(
  dir: string,
  root: string,
  skipDirNames: readonly string[],
  out: FoundFile[],
  errors: Array<{ path: string; error: string }>,
): void {
  if (cancelled) return;
  let dirents;
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    errors.push({ path: safeRel(root, dir), error: errorText(err) });
    return;
  }
  for (const dirent of dirents) {
    if (cancelled) return;
    if (dirent.isSymbolicLink()) continue;
    const abs = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      if (shouldSkipDirectory(dirent.name, skipDirNames)) continue;
      walk(abs, root, skipDirNames, out, errors);
      continue;
    }
    if (!dirent.isFile()) continue;
    if (!isIndexableFile(dirent.name)) continue;
    out.push({
      absPath: abs,
      relPath: toRelPath(root, abs),
      size: 0,
      mtimeMs: 0,
    });
  }
}

async function fillStats(files: FoundFile[], errors: Array<{ path: string; error: string }>): Promise<void> {
  const failed = new Set<number>();
  for (let index = 0; index < files.length; index += 1) {
    if (cancelled || closing) break;
    const file = files[index]!;
    try {
      const st = statSync(file.absPath);
      file.size = st.size;
      file.mtimeMs = Math.round(st.mtimeMs);
    } catch (err) {
      failed.add(index);
      errors.push({ path: file.relPath, error: errorText(err) });
    }
  }
  if (failed.size === 0) return;
  let write = 0;
  for (let read = 0; read < files.length; read += 1) {
    if (failed.has(read)) continue;
    files[write] = files[read]!;
    write += 1;
  }
  files.length = write;
}

function isIndexerOnly(db: BetterSqlite3.Database): boolean {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'`,
    )
    .all() as Array<{ name: string }>;
  return rows.every((row) => {
    const name = row.name;
    return (
      name.startsWith('indexer_') ||
      name.startsWith('fts_content') ||
      name.startsWith('fts_short') ||
      name === 'kb_idx_probe'
    );
  });
}

function pagesFromBody(relPath: string, body: string): PageText[] {
  const rel = relPath.replace(/\\/g, '/');
  const title = (rel.split('/').pop() ?? rel).normalize('NFC');
  return [{ page: 0, title, body: body.normalize('NFC') }];
}

function safeRel(root: string, abs: string): string {
  try {
    return toRelPath(root, abs);
  } catch {
    return abs;
  }
}

interface BulkOutcome {
  status: 'completed' | 'cancelled';
  processed: number;
  total: number;
  filesProcessed: string[];
  errors: Array<{ path: string; error: string }>;
  elapsedMs: number;
}

async function runBulk(job: BulkWorkerData): Promise<BulkOutcome> {
  const started = performance.now();
  const errors: Array<{ path: string; error: string }> = [];
  const filesProcessed: string[] = [];
  let pathChunk: string[] = [];
  const flushPaths = (): void => {
    if (pathChunk.length === 0) return;
    const paths = pathChunk.slice();
    pathChunk = [];
    emit({ type: 'paths', paths });
  };
  const root = path.resolve(job.localPath);
  let db = openDatabase(job.dbPath);
  activeDb = db;
  let processed = 0;
  let total = 0;
  let forceAll = false;
  try {
    if (closing) {
      return {
        status: 'cancelled',
        processed: 0,
        total: 0,
        filesProcessed,
        errors,
        elapsedMs: performance.now() - started,
      };
    }
    db.pragma('synchronous = NORMAL');
    db.pragma('temp_store = MEMORY');
    db.pragma('cache_size = -64000');
    // 写到一半不去截断 WAL。自动 checkpoint 会跟主线程上已经打开的连接抢锁。
    db.pragma('wal_autocheckpoint = 0');
    migrate(db);
    if (!ftsHasLineStart(db, 'fts_content') || !ftsHasLineStart(db, 'fts_short')) {
      // 旧表没有行号列。丢掉全文表重建，不把旧行当成已经分块。
      rebuildTextTables(db);
      forceAll = true;
    }
    let store = new IndexStore(db);
    // 默认 crisismerge=16 会在几百个文件后把整层 b-tree 合成一次，写入停几百毫秒，主线程定时器跟着漂。
    // 大批量索引进程里关掉自动合并。查询仍走 FTS5，不在这里做 optimize。
    for (const table of ['fts_content', 'fts_short'] as const) {
      db.prepare(`INSERT INTO ${table}(${table}, rank) VALUES('crisismerge', 100000)`).run();
      db.prepare(`INSERT INTO ${table}(${table}, rank) VALUES('automerge', 0)`).run();
    }
    store.upsertRoot(job.rootId, root);

    const found: FoundFile[] = [];
    const bodyByRel = new Map<string, string>();
    const packed = job.preReadPack
      ? (JSON.parse(readFileSync(job.preReadPack, 'utf8')) as Array<{
          absPath: string;
          relPath: string;
          size: number;
          mtimeMs: number;
          body?: string;
          error?: string;
        }>)
      : job.preRead;
    if (job.preReadPack) {
      try {
        unlinkSync(job.preReadPack);
      } catch {
        // 调用方可能已经删了
      }
    }
    if (packed) {
      for (const item of packed) {
        if (item.error) {
          errors.push({ path: item.relPath, error: item.error });
          continue;
        }
        found.push({
          absPath: item.absPath,
          relPath: item.relPath,
          size: item.size,
          mtimeMs: item.mtimeMs,
        });
        if (typeof item.body === 'string') bodyByRel.set(relKey(item.relPath), item.body);
      }
    } else {
      walk(root, root, job.skipDirNames, found, errors);
      await fillStats(found, errors);
    }
    if (cancelled) {
      return {
        status: 'cancelled',
        processed,
        total,
        filesProcessed,
        errors,
        elapsedMs: performance.now() - started,
      };
    }

    const seen = new Set(found.map((file) => relKey(file.relPath)));
    store.removeUnseen(job.rootId, seen);
    const known = store.loadFiles(job.rootId);
    const todo =
      job.mode === 'incremental' && !forceAll
        ? found.filter((file) => fileChanged(known.get(relKey(file.relPath)), file))
        : found;

    total = todo.length;
    emit({
      type: 'progress',
      processed,
      total,
      currentFile: null,
      processedFile: null,
    });

    const commitWrite = (ready: Array<{
      resourceId: string;
      relPath: string;
      size: number;
      mtimeMs: number;
      pages: PageText[];
      previousResourceId: string | undefined;
    }>): void => {
      const tx = db.transaction(() => {
        for (const item of ready) {
          store.write(
            {
              resourceId: item.resourceId,
              rootId: job.rootId,
              relPath: item.relPath,
              size: item.size,
              mtimeMs: item.mtimeMs,
              pages: item.pages,
            },
            item.previousResourceId,
            job.batchId,
          );
        }
      });
      tx();
    };
    const prepared: Array<{
      resourceId: string;
      relPath: string;
      size: number;
      mtimeMs: number;
      pages: PageText[];
      previousResourceId: string | undefined;
    }> = [];
    const account = (relPath: string): void => {
      filesProcessed.push(relPath);
      pathChunk.push(relPath);
      processed += 1;
      if (processed === 2 || processed === total) {
        emit({
          type: 'progress',
          processed,
          total,
          currentFile: relPath,
          processedFile: relPath,
        });
      }
    };
    // 一次要回全部 id，然后同步读完文本。中间不让出，避免读一小段就被实时扫描拖进长等待。
    const resolved = await requestIds(todo.map((file) => file.relPath));
    if (!cancelled && !closing) {
      const errorByPath = new Map(resolved.errors.map((item) => [item.relPath, item.error]));
      const pendingPdf: Array<Promise<void>> = [];
      const take = (file: FoundFile, resourceId: string, pages: PageText[]): void => {
        const previous = known.get(relKey(file.relPath));
        prepared.push({
          resourceId,
          relPath: file.relPath,
          size: file.size,
          mtimeMs: file.mtimeMs,
          pages,
          previousResourceId: previous?.resourceId,
        });
      };
      for (let j = 0; j < todo.length; j += 1) {
        if (cancelled || closing) break;
        const file = todo[j]!;
        const resourceId = resolved.ids[j] ?? '';
        if (!resourceId) {
          errors.push({
            path: file.relPath,
            error: errorByPath.get(file.relPath) ?? 'resolveResourceId 返回了空 ID',
          });
          processed += 1;
          emit({
            type: 'progress',
            processed,
            total,
            currentFile: file.relPath,
            processedFile: null,
          });
          continue;
        }
        if (path.extname(file.absPath).toLowerCase() === '.pdf') {
          pendingPdf.push(Promise.resolve().then(async () => {
            try {
              const pages = await extractFile(file.absPath, file.relPath, () => cancelled);
              if (cancelled || closing) return;
              take(file, resourceId, pages);
            } catch (err) {
              if (err instanceof CancelledError || cancelled) {
                cancelled = true;
                return;
              }
              errors.push({ path: file.relPath, error: errorText(err) });
              processed += 1;
              emit({
                type: 'progress',
                processed,
                total,
                currentFile: file.relPath,
                processedFile: null,
              });
            }
          }));
          continue;
        }
        try {
          const cached = bodyByRel.get(relKey(file.relPath));
          const pages = cached === undefined
            ? readPlainFile(file.absPath, file.relPath, () => cancelled)
            : pagesFromBody(file.relPath, cached);
          take(file, resourceId, pages);
        } catch (err) {
          if (err instanceof CancelledError || cancelled) {
            cancelled = true;
            break;
          }
          errors.push({ path: file.relPath, error: errorText(err) });
          processed += 1;
          emit({
            type: 'progress',
            processed,
            total,
            currentFile: file.relPath,
            processedFile: null,
          });
        }
      }
      // 正文读完再抽 PDF。pdfjs 已在进程启动时加载完。
      await Promise.all(pendingPdf);
    }
    const stopWrite = (): boolean =>
      cancelled || closing || (job.cancelFlag !== undefined && Atomics.load(job.cancelFlag, 0) === 1);
    const allItems = prepared.splice(0, prepared.length);
    const otherRoot = db
      .prepare(
        `SELECT 1 AS ok FROM indexer_roots WHERE root_id != ?
         UNION ALL
         SELECT 1 AS ok FROM indexer_files WHERE root_id != ?
         LIMIT 1`,
      )
      .get(job.rootId, job.rootId) as { ok: number } | undefined;
    // 整库 backup 会覆盖文件里的其他表和其他根。只有这份库只属于索引、且这次会写完全部文件时才用。
    const indexerOnly = isIndexerOnly(db);
    const replaceFile =
      (job.mode === 'full' || forceAll) &&
      errors.length === 0 &&
      allItems.length > 0 &&
      allItems.length === todo.length &&
      !otherRoot &&
      indexerOnly;
    if (replaceFile) {
      // 先落 2 个文件。取消在这之后停下时，库里已经有可搜索的部分。后面的全文写在内存里。
      const prefixN = Math.min(2, allItems.length);
      if (!stopWrite()) {
        commitWrite(allItems.slice(0, prefixN));
        for (const item of allItems.slice(0, prefixN)) account(item.relPath);
      }
      let aborted = stopWrite();
      if (!aborted) {
        const mem = openMemoryDatabase();
        try {
          // 临时库。落到文件上的连接仍是 synchronous=NORMAL，结束时 wal_checkpoint(PASSIVE)。
          mem.pragma('synchronous = OFF');
          mem.pragma('temp_store = MEMORY');
          migrate(mem);
          for (const table of ['fts_content', 'fts_short'] as const) {
            mem.prepare(`INSERT INTO ${table}(${table}, rank) VALUES('crisismerge', 100000)`).run();
            mem.prepare(`INSERT INTO ${table}(${table}, rank) VALUES('automerge', 0)`).run();
          }
          const memStore = new IndexStore(mem);
          memStore.upsertRoot(job.rootId, root);
          const writeMem = mem.transaction((ready: typeof allItems) => {
            for (const item of ready) {
              memStore.write(
                {
                  resourceId: item.resourceId,
                  rootId: job.rootId,
                  relPath: item.relPath,
                  size: item.size,
                  mtimeMs: item.mtimeMs,
                  pages: item.pages,
                },
                item.previousResourceId,
                job.batchId,
              );
            }
          });
          const memChunk = 400;
          for (let i = 0; i < allItems.length; i += memChunk) {
            // 子进程收不到共享内存上的取消标记。每批让出一次，取消消息才能进来。
            await new Promise((resolve) => setImmediate(resolve));
            if (stopWrite()) {
              aborted = true;
              break;
            }
            writeMem(allItems.slice(i, i + memChunk));
          }
          if (!aborted && !stopWrite()) {
            markTextIndexVersion(mem);
            if (activeDb === db) closeActiveDb();
            await mem.backup(job.dbPath);
            const file = openDatabase(job.dbPath);
            activeDb = file;
            file.pragma('synchronous = NORMAL');
            file.pragma('temp_store = MEMORY');
            file.pragma('cache_size = -64000');
            file.pragma('wal_autocheckpoint = 0');
            try {
              file.pragma('wal_checkpoint(PASSIVE)');
            } catch {
              // 刚换过文件
            }
            for (const item of allItems.slice(prefixN)) account(item.relPath);
          } else {
            aborted = true;
          }
        } finally {
          try {
            if (mem.open) mem.close();
          } catch {
            // 已经关过
          }
        }
      }
      if (aborted) cancelled = true;
    } else {
      // 知识库里还有别的表，或这次只改一部分文件。分批提交，批与批之间看取消标记。
      const chunk = 8;
      while (allItems.length > 0 && !stopWrite()) {
        await new Promise((resolve) => setImmediate(resolve));
        if (stopWrite()) break;
        const ready = allItems.splice(0, chunk);
        commitWrite(ready);
        for (const item of ready) account(item.relPath);
      }
      if (stopWrite()) cancelled = true;
    }

    flushPaths();
    const status = cancelled || closing ? 'cancelled' : 'completed';
    if (status === 'completed' && db.open) markTextIndexVersion(db);
    return {
      status,
      processed,
      total,
      filesProcessed,
      errors,
      elapsedMs: performance.now() - started,
    };
  } finally {
    // PASSIVE 不截断。TRUNCATE 会卡住主线程定时器。成功、取消、失败都做一次。
    // shutdown 可能已经关过这条连接。backup 之后 activeDb 是新打开的文件连接。
    if (activeDb) closeActiveDb();
    else if (db.open) {
      try {
        db.pragma('wal_checkpoint(PASSIVE)');
      } catch {
        // shutdown 已经查过
      }
      try {
        if (db.open) db.close();
      } catch {
        // 已经关过
      }
    }
  }
}

async function runExtract(absPath: string, relPath: string): Promise<void> {
  const st = statSync(absPath);
  const pages: PageText[] = await extractFile(absPath, relPath);
  emit({
    type: 'extracted',
    pages,
    size: st.size,
    mtimeMs: Math.round(st.mtimeMs),
  });
}

async function runOne(job: RunMessage): Promise<void> {
  currentRunId = job.runId;
  cancelled = cancelSet.has(job.runId);
  try {
    if (job.data.kind === 'extract-one') {
      await runExtract(job.data.absPath, job.data.relPath);
      return;
    }
    if (cancelled) {
      emit({
        type: 'result',
        status: 'cancelled',
        processed: 0,
        total: 0,
        filesProcessed: [],
        errors: [],
        elapsedMs: 0,
      });
      return;
    }
    const result = await runBulk(job.data);
    emit({
      type: 'result',
      status: result.status,
      processed: result.processed,
      total: result.total,
      filesProcessed: result.filesProcessed,
      errors: result.errors,
      elapsedMs: result.elapsedMs,
    });
  } catch (err) {
    emit({ type: 'fatal', error: errorText(err) });
  } finally {
    cancelSet.delete(job.runId);
  }
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (jobs.length > 0) {
      const job = jobs.shift();
      if (!job) break;
      await runOne(job);
    }
  } finally {
    pumping = false;
    if (jobs.length > 0) void pump();
  }
}

getPdfWorker();

