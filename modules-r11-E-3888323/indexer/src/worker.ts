import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { disk } from './disk.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, parentPort } from 'node:worker_threads';
import { CancelledError, extractFile, PDF_INDEX_CAP, readPlainFile, setPdfDelegate, textIndexSkip } from './extract.ts';
import { ftsHasLineStart, markTextIndexVersion, migrate, rebuildTextTables } from './migrate.ts';
import {
  fileChanged,
  isIndexableFile,
  relKey,
  shouldSkipDirectory,
  toRelPath,
} from './paths.ts';
import type { BulkWorkerData, MainToWorker, RunMessage } from './protocol.ts';
import { runCompact, runWrite } from './segmentGate.ts';
import { openDatabase, openMemoryDatabase, sqliteFullDetail } from './sqlite.ts';
import {
  FTS_SEGMENT_HARD_LIMIT,
  FTS_SEGMENT_NEAR_LIMIT,
  FTS_SEGMENT_SOFT_LIMIT,
  IndexStore,
  compactTextIndex,
  compactTextIndexUntilWritable,
  ftsSegmentCount,
  restoreFtsMerge,
  suspendFtsMerge,
  textIndexAcceptsWrite,
  type PageText,
} from './store.ts';
import type BetterSqlite3 from 'better-sqlite3';

interface ResolveReply {
  ids: string[];
  errors: Array<{ relPath: string; error: string }>;
}

// 由 index.ts fork 成独立进程（child_process 或 Electron utilityProcess）。不要 process.exit。sqlite 还开着时不能被 terminate。
type IpcPort = {
  postMessage(message: unknown): void;
  on(event: 'message', cb: (message: MainToWorker) => void): void;
  close(): void;
};

function makePort(): IpcPort {
  // worker_threads
  if (parentPort) {
    return {
      postMessage(message: unknown): void {
        parentPort?.postMessage(message);
      },
      on(event: 'message', cb: (message: MainToWorker) => void): void {
        parentPort?.on(event, cb);
      },
      close(): void {
        parentPort?.close();
      },
    };
  }
  // Electron utilityProcess：process.parentPort（与 worker_threads 的 parentPort 不同）
  const epp = (process as NodeJS.Process & { parentPort?: { postMessage(m: unknown): void; on(e: string, cb: (ev: { data: unknown }) => void): void } }).parentPort;
  if (epp && typeof epp.postMessage === 'function' && typeof process.send !== 'function') {
    return {
      postMessage(message: unknown): void {
        try {
          epp.postMessage(message);
        } catch {
          // 父进程已经把 IPC 关掉
        }
      },
      on(event: 'message', cb: (message: MainToWorker) => void): void {
        if (event !== 'message') return;
        epp.on('message', (ev) => {
          const message = ev?.data;
          if (!message || typeof message !== 'object') return;
          cb(message as MainToWorker);
        });
      },
      close(): void {
        epp.postMessage({ type: 'shutdown-complete' });
      },
    };
  }
  // child_process.fork
  return {
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
}

const port = makePort();

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
  worker.on('error', (err) => {
    console.error('[indexer] PDF worker error', err);
    for (const waiter of pdfWaiters.values()) waiter({ reqId: 0, error: err instanceof Error ? err.message : String(err) });
    pdfWaiters.clear();
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
    // This worker never opens SQLite; terminate only the PDF thread if it fails to close.
    const deadline = setTimeout(() => { void worker.terminate().finally(finish); }, 2000);
    worker.once('exit', () => { clearTimeout(deadline); finish(); });
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
    dirents = disk.readdirSync(dir, { withFileTypes: true });
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
      const st = disk.statSync(file.absPath);
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
  bodyReads: number;
}

function worstSegments(db: BetterSqlite3.Database): number {
  return Math.max(ftsSegmentCount(db, 'fts_content'), ftsSegmentCount(db, 'fts_short'));
}

function restoreIfOpen(db: BetterSqlite3.Database | null): void {
  if (!db || !db.open) return;
  try {
    restoreFtsMerge(db);
  } catch {
    // 连接正在关。下次打开再写回 8/16。
  }
}

/** 启动时段数 ≥ 1500：先在本进程压实。搜索仍走别的连接，写入进 segmentGate。 */
async function compactNearLimit(db: BetterSqlite3.Database, dbPath: string): Promise<void> {
  if (!db.open || worstSegments(db) < FTS_SEGMENT_NEAR_LIMIT) return;
  await runCompact(dbPath, async () => {
    let guard = 0;
    while (guard < 8 && db.open && !cancelled && !closing) {
      const result = compactTextIndexUntilWritable(db, 1);
      guard += 1;
      if (worstSegments(db) < FTS_SEGMENT_NEAR_LIMIT && result.ok) return;
      if (result.steps === 0) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
}

/**
 * 扫描返回之后再合并，不挡 result。
 * 段数超过 1000 用 optimize；否则只做有限页的增量合并。
 */
function scheduleBackgroundMerge(dbPath: string): void {
  if (closing) return;
  void runCompact(dbPath, async () => {
    await new Promise((resolve) => setImmediate(resolve));
    if (closing) return;
    let db: BetterSqlite3.Database | null = null;
    try {
      db = openDatabase(dbPath);
      db.pragma('synchronous = NORMAL');
      db.pragma('wal_autocheckpoint = 0');
      restoreFtsMerge(db);
      if (worstSegments(db) >= FTS_SEGMENT_NEAR_LIMIT) {
        let guard = 0;
        while (guard < 8 && !closing && db.open && worstSegments(db) >= FTS_SEGMENT_NEAR_LIMIT) {
          const result = compactTextIndexUntilWritable(db, 1);
          guard += 1;
          if (result.steps === 0) break;
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
      if (!db.open || closing) return;
      if (worstSegments(db) > FTS_SEGMENT_SOFT_LIMIT) {
        for (const table of ['fts_content', 'fts_short'] as const) {
          if (closing || !db.open) return;
          if (ftsSegmentCount(db, table) > FTS_SEGMENT_SOFT_LIMIT) {
            db.prepare(`INSERT INTO ${table}(${table}) VALUES('optimize')`).run();
          }
        }
        return;
      }
      for (const table of ['fts_content', 'fts_short'] as const) {
        db.prepare(`INSERT INTO ${table}(${table}, rank) VALUES('merge', 800)`).run();
      }
    } catch {
      // 后台合并失败不影响已经返回的扫描
    } finally {
      try {
        if (db?.open) db.close();
      } catch {
        // 已经关过
      }
    }
  });
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
  let bodyReads = 0;
  let forceAll = false;
  let mergeTouched = false;
  try {
    if (closing) {
      return {
        status: 'cancelled',
        processed: 0,
        total: 0,
        filesProcessed,
        errors,
        elapsedMs: performance.now() - started,
        bodyReads,
      };
    }
    db.pragma('synchronous = NORMAL');
    db.pragma('temp_store = FILE');
    db.pragma('cache_size = -64000');
    // 写到一半不去截断 WAL。自动 checkpoint 会跟主线程上已经打开的连接抢锁。
    // 批量写入期间不自动 checkpoint。主连接上的查询会跟着等满 busy_timeout。
    db.pragma('wal_autocheckpoint = 0');
    migrate(db);
    if (!ftsHasLineStart(db, 'fts_content') || !ftsHasLineStart(db, 'fts_short')) {
      // 旧表没有行号列。丢掉全文表重建，不把旧行当成已经分块。
      rebuildTextTables(db);
      forceAll = true;
    }
    let store = new IndexStore(db);
    // 默认 crisismerge=16 会在几百个文件后把整层 b-tree 合成一次，写入停几百毫秒，主线程定时器跟着漂。
    // 旧代码因此把 crisismerge 写成 100000、automerge 写成 0，但这两个值会留在库里，段一直堆到写不进去。
    // 先写回 8/16。段数 ≥ 1500 时先在本进程压实。扫描途中只临时 automerge=0，结束前一定恢复。
    mergeTouched = true;
    restoreFtsMerge(db);
    await compactNearLimit(db, job.dbPath);
    if (cancelled || closing) {
      return {
        status: 'cancelled',
        processed,
        total,
        filesProcessed,
        errors,
        elapsedMs: performance.now() - started,
        bodyReads,
      };
    }
    suspendFtsMerge(db);
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
        bodyReads,
      };
    }

    const seen = new Set(found.map((file) => relKey(file.relPath)));
    // 段堆满以后，连一百个字的正文都提交不进去。先按小步合并，再删、再写。
    compactTextIndex(db);
    try {
      store.removeUnseen(job.rootId, seen);
    } catch (err) {
      const msg = errorText(err);
      if (/full/i.test(msg)) throw new Error(`${msg} ${sqliteFullDetail(db, job.dbPath)}`);
      throw err;
    }
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
      // 不在外面再包一层事务。store.write 自己按 32 页提交，外层包住的话分批会失效。
      try {
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
      } catch (err) {
        const msg = errorText(err);
        if (/full/i.test(msg)) throw new Error(`${msg} ${sqliteFullDetail(db, job.dbPath)}`);
        throw err;
      }
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
    // 分批要 id，父进程每片不超过 8ms 就让出。不要一次把整根的路径送回去同步解析。
    const resolvedIds: string[] = [];
    const resolvedErrors: Array<{ relPath: string; error: string }> = [];
    for (let i = 0; i < todo.length; i += 64) {
      if (cancelled || closing) break;
      const part = todo.slice(i, i + 64);
      const resolved = await requestIds(part.map((file) => file.relPath));
      resolvedIds.push(...resolved.ids);
      resolvedErrors.push(...resolved.errors);
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (!cancelled && !closing) {
      const errorByPath = new Map(resolvedErrors.map((item) => [item.relPath, item.error]));
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
        const resourceId = resolvedIds[j] ?? '';
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
          if (file.size > PDF_INDEX_CAP) {
            take(file, resourceId, []);
            continue;
          }
          pendingPdf.push(Promise.resolve().then(async () => {
            try {
              bodyReads += 1;
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
          if (cached === undefined && textIndexSkip(file.absPath, file.size)) {
            take(file, resourceId, []);
            continue;
          }
          const pages = cached === undefined
            ? readPlainFile(file.absPath, file.relPath, () => cancelled)
            : pagesFromBody(file.relPath, cached);
          if (cached === undefined) bodyReads += 1;
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
        if (db.open && worstSegments(db) >= FTS_SEGMENT_HARD_LIMIT) {
          await runCompact(job.dbPath, () => {
            compactTextIndexUntilWritable(db, 8);
          });
        }
        await runWrite(job.dbPath, () => commitWrite(allItems.slice(0, prefixN)));
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
          // 内存库会整文件备份回去。不能把 automerge=0 或 crisismerge=100000 写进备份。
          // 扫描期间只临时关掉自动合并，成功、出错、取消都恢复成 8/16。
          suspendFtsMerge(mem);
          const memStore = new IndexStore(mem);
          memStore.upsertRoot(job.rootId, root);
          const writeMem = (ready: typeof allItems) => {
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
          };
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
            restoreFtsMerge(mem);
            markTextIndexVersion(mem);
            // backup 会盖掉文件。关文件前先写回 8/16，备份失败也不会留下 automerge=0。
            if (db.open) restoreFtsMerge(db);
            if (activeDb === db) closeActiveDb();
            await mem.backup(job.dbPath);
            const file = openDatabase(job.dbPath);
            activeDb = file;
            file.pragma('synchronous = NORMAL');
            file.pragma('temp_store = FILE');
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
            if (mem.open) restoreFtsMerge(mem);
          } catch {
            // 取消或出错时也要回到 8/16；库已经关了就跳过
          }
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
      let commits = 0;
      while (allItems.length > 0 && !stopWrite()) {
        await new Promise((resolve) => setImmediate(resolve));
        if (stopWrite()) break;
        const ready = allItems.splice(0, chunk);
        if (db.open && worstSegments(db) >= FTS_SEGMENT_HARD_LIMIT) {
          await runCompact(job.dbPath, () => {
            compactTextIndexUntilWritable(db, 8);
          });
        }
        await runWrite(job.dbPath, () => commitWrite(ready));
        commits += 1;
        if (commits % 32 === 0 && db.open && !textIndexAcceptsWrite(db)) compactTextIndex(db, 8);
        if (commits % 32 === 0 && db.open) {
          try {
            const wal = statSync(`${job.dbPath}-wal`).size;
            if (wal > 64 * 1024 * 1024) db.pragma('wal_checkpoint(PASSIVE)');
          } catch {
            // 主连接还在读时，PASSIVE 做不完也不要中断索引
          }
        }
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
      bodyReads,
    };
  } finally {
    // 成功、取消、抛错都恢复 automerge=8、crisismerge=16，避免 0 留在库里。
    if (mergeTouched) {
      const live = activeDb && activeDb.open ? activeDb : db.open ? db : null;
      restoreIfOpen(live);
    }
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
        bodyReads: 0,
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
      bodyReads: result.bodyReads,
    });
    // 结果已经发出。增量合并放在后台，不堵在扫描返回前。
    scheduleBackgroundMerge(job.data.dbPath);
  } catch (err) {
    emit({ type: 'fatal', error: errorText(err) });
    if (job.data.kind === 'bulk') scheduleBackgroundMerge(job.data.dbPath);
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

