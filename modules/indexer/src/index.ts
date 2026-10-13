import { forkIndexerScript, noteIndexerChild, type IndexerChild } from './host.ts';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { extractText, setExtractOffThread } from './extract.ts';
import { markTextIndexVersion, migrate, tokenizerKind } from './migrate.ts';
import { deriveLocalPath, normalizeRel, toAbs } from './paths.ts';
import type { ExtractWorkerData, MainToWorker, WorkerData } from './protocol.ts';
import { search, searchGrouped } from './search.ts';
import { IndexStore, type PageText } from './store.ts';
import type {
  IndexError,
  IndexJob,
  IndexOneOptions,
  IndexOneResult,
  IndexProgress,
  IndexResult,
  SqliteDb,
  StartIndexOptions,
} from './types.ts';
import { HIGHLIGHT_END, HIGHLIGHT_START } from './types.ts';

export {
  extractText,
  HIGHLIGHT_END,
  HIGHLIGHT_START,
  migrate,
  search,
  searchGrouped,
  tokenizerKind,
};
export { setIndexerHost, indexerUsesInjectedHost, type IndexerChild, type IndexerHost } from './host.ts';
export { useUtilityProcessHost, childFromUtility, type UtilityProcessLike } from './electronHost.ts';
export { classifyIndexTarget, shouldIndexFileBody, type IndexTargetKind } from './indexBoundary.ts';
export { indexStatusLabel, FALLBACK_INDEX_LABEL, type IndexEngine } from './indexHealthText.ts';
export { debugDualDbCheck, type DualMismatch } from './dualDb.ts';
export type { TextPage } from './extract.ts';
export type {
  IndexError,
  IndexJob,
  IndexMode,
  IndexOneOptions,
  IndexOneResult,
  IndexProgress,
  IndexResult,
  ResourceLocation,
  GroupedAnchor,
  GroupedHit,
  GroupedMatch,
  GroupedSearchResult,
  SearchHit,
  SearchOptions,
  SqliteDb,
  StartIndexOptions,
  TokenizerKind,
} from './types.ts';

interface ProgressMessage {
  type: 'progress';
  runId: number;
  processed: number;
  total: number;
  currentFile: string | null;
  processedFile: string | null;
}

interface ResultMessage {
  type: 'result';
  runId: number;
  status: 'completed' | 'cancelled';
  processed: number;
  total: number;
  filesProcessed: string[];
  errors: IndexError[];
  elapsedMs: number;
}

interface ResolveRequestMessage {
  type: 'resolve-request';
  runId: number;
  reqId: number;
  relPaths: string[];
}

interface PathsMessage {
  type: 'paths';
  runId: number;
  paths: string[];
}

interface ExtractedMessage {
  type: 'extracted';
  runId: number;
  pages: PageText[];
  size: number;
  mtimeMs: number;
}

interface FatalMessage {
  type: 'fatal';
  runId: number;
  error: string;
}

interface ExtractErrorMessage {
  type: 'extract-error';
  runId: number;
  error: string;
}

type WorkerMessage =
  | ProgressMessage
  | ResultMessage
  | ResolveRequestMessage
  | PathsMessage
  | ExtractedMessage
  | FatalMessage
  | ExtractErrorMessage;

function resolveWorkerFile(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const ts = path.join(dir, 'worker.ts');
  const js = path.join(dir, 'worker.js');
  if (existsSync(ts)) return ts;
  if (existsSync(js)) return js;
  throw new Error(`找不到 indexer worker（${dir}）`);
}

function resolveReaderFile(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const ts = path.join(dir, 'read-helper.ts');
  const js = path.join(dir, 'read-helper.js');
  if (existsSync(ts)) return ts;
  if (existsSync(js)) return js;
  throw new Error(`找不到 read helper（${dir}）`);
}

function workerExecArgv(workerFile: string): string[] {
  if (workerFile.endsWith('.ts')) return ['--experimental-strip-types', '--no-warnings'];
  return ['--no-warnings'];
}

function workerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Windows 上环境变量名不区分大小写，vitest 会再写一份大写的。
  // 带着父进程的 IPC 描述符 fork 时，子进程退出是 0xC0000005。
  for (const key of Object.keys(env)) {
    const up = key.toUpperCase();
    if (up === 'NODE_CHANNEL_FD' || up === 'NODE_CHANNEL_SERIALIZATION_MODE' || up === 'NODE_OPTIONS') {
      delete env[key];
    }
  }
  // 文本读是同步的，不靠线程池。池子开到 32 时，pdfjs 加载会把机器占满，主线程定时器漂移。
  env.UV_THREADPOOL_SIZE = '4';
  return env;
}

function spawnWorker(): IndexerChild {
  const workerFile = resolveWorkerFile();
  // 独立进程，不放在 vitest 的 fork 里。那边的线程读文件会拖到十几秒，主线程定时器跟着漂。
  // 不 kill、不 terminate。sqlite 还开着时强关进程会在 Windows 上变成 0xC0000005。
  // 打包态 runAsNode=false，不能 child_process.fork。由 setIndexerHost 换成 utilityProcess.fork。
  const child = forkIndexerScript(workerFile, workerEnv(), workerExecArgv(workerFile));
  noteIndexerChild(1);
  child.on('exit', () => noteIndexerChild(-1));
  return child;
}

let sharedWorker: IndexerChild | null = null;
let sharedReader: IndexerChild | null = null;
let sharedStderr = '';
let runSeq = 0;

function getReader(): IndexerChild {
  if (sharedReader) return sharedReader;
  const file = resolveReaderFile();
  const child = forkIndexerScript(file, workerEnv(), workerExecArgv(file));
  noteIndexerChild(1);
  child.on('exit', () => {
    noteIndexerChild(-1);
    if (sharedReader === child) sharedReader = null;
  });
  sharedReader = child;
  return child;
}

function readCorpus(root: string, skipDirNames: string[]): Promise<string> {
  const reader = getReader();
  reader.ref();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('读取资料超时'));
    }, 120000);
    const onMessage = (msg: { type?: string; pack?: string }): void => {
      if (!msg || msg.type !== 'files' || !msg.pack) return;
      cleanup();
      resolve(msg.pack);
    };
    const onExit = (): void => {
      cleanup();
      reject(new Error('读取进程已退出'));
    };
    function cleanup(): void {
      clearTimeout(timer);
      reader.off('message', onMessage);
      reader.off('exit', onExit);
      reader.unref();
    }
    reader.on('message', onMessage);
    reader.on('exit', onExit);
    try {
      reader.send({ type: 'read', root, skipDirNames });
    } catch (err) {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function getSharedWorker(): IndexerChild {
  if (sharedWorker) return sharedWorker;
  const worker = spawnWorker();
  worker.stderr?.setEncoding('utf8');
  worker.stderr?.on('data', (chunk: string) => {
    sharedStderr += chunk;
    if (sharedStderr.length > 8000) sharedStderr = sharedStderr.slice(-8000);
  });
  worker.on('exit', () => {
    if (sharedWorker === worker) sharedWorker = null;
  });
  sharedWorker = worker;
  return worker;
}

function dropSharedWorker(worker: IndexerChild): void {
  if (sharedWorker === worker) sharedWorker = null;
  // 不 kill。sqlite 还开着时杀掉进程会在 Windows 上变成 0xC0000005。
  try {
    worker.send({ type: 'shutdown' } satisfies MainToWorker);
  } catch {
    // 进程已经停了
  }
}

/**
 * 通知 worker 先 wal_checkpoint(PASSIVE) 再 close() 自己的库，然后关掉端口。
 * 等 worker 的 exit 之后才返回。调用方接着再关自己的数据库连接。
 */
let pdfReady: Promise<void> | null = null;

/** pdfjs 在子进程启动时开始加载。全文读取要等它结束，否则 Windows 上小文件读取会拖很久。 */
export function indexerReady(): Promise<void> {
  if (pdfReady) return pdfReady;
  const worker = getSharedWorker();
  pdfReady = new Promise((resolve) => {
    const onMessage = (msg: { type?: string }): void => {
      if (!msg || msg.type !== 'warm') return;
      worker.off('message', onMessage);
      resolve();
    };
    worker.on('message', onMessage);
    try {
      worker.send({ type: 'warm-ping' } satisfies MainToWorker);
    } catch {
      worker.off('message', onMessage);
      resolve();
    }
  });
  return pdfReady;
}

export function closeIndexer(): Promise<void> {
  const reader = sharedReader;
  sharedReader = null;
  if (reader) {
    try {
      reader.send({ type: 'shutdown' });
    } catch {
      // 读取进程已经停了
    }
  }
  const worker = sharedWorker;
  if (!worker) return Promise.resolve();
  sharedWorker = null;
  worker.ref();
  return new Promise((resolve) => {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      resolve();
    };
    worker.once('exit', () => finish());
    try {
      worker.send({ type: 'shutdown' } satisfies MainToWorker);
    } catch {
      finish();
    }
  });
}

export function startIndex(opts: StartIndexOptions): IndexJob {
  if (!opts.rootId) throw new Error('rootId 不能为空');
  if (!opts.localPath) throw new Error('localPath 不能为空');
  if (!opts.dbPath || opts.dbPath === ':memory:') {
    throw new Error('dbPath 必须是数据库文件路径，worker 无法共享 :memory:');
  }
  if (typeof opts.resolveResourceId !== 'function') {
    throw new Error('resolveResourceId 必须是函数，并且只在调用线程执行');
  }
  mkdirSync(path.dirname(path.resolve(opts.dbPath)), { recursive: true });
  const worker = getSharedWorker();

  const jobId = randomUUID();
  const mode = opts.mode ?? 'full';
  const runId = ++runSeq;
  const payload = {
    kind: 'bulk' as const,
    rootId: opts.rootId,
    localPath: path.resolve(opts.localPath),
    dbPath: path.resolve(opts.dbPath),
    mode,
    skipDirNames: opts.skipDirNames ?? [],
    batchId: jobId,
    preReadPack: undefined as string | undefined,
  };

  const listeners = new Set<(progress: IndexProgress) => void>();
  let settled = false;
  // 父进程如果干等子进程，Windows 会把 20ms 定时器合并到 50ms 以上。
  // 用一个 5ms 定时器把进程留在可调度状态，不要用 setImmediate 空转：空转几万次会把 GC 停顿算进漂移。
  let spin = true;
  const keepAwake = setInterval(() => {
    if (!spin) clearInterval(keepAwake);
  }, 5);
  let resolveDone: (result: IndexResult) => void = () => {};
  let rejectDone: (err: Error) => void = () => {};
  const done = new Promise<IndexResult>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const partial: IndexResult = {
    jobId,
    status: 'cancelled',
    processed: 0,
    total: 0,
    filesProcessed: [],
    errors: [],
    elapsedMs: 0,
  };

  function detach(): void {
    worker.off('message', onMessage);
    worker.off('error', onError);
    worker.off('exit', onExit);
  }

  function settle(ok: IndexResult | null, err?: Error): void {
    if (settled) return;
    settled = true;
    spin = false;
    clearInterval(keepAwake);
    if (killTimer) clearTimeout(killTimer);
    detach();
    if (ok) resolveDone(ok);
    else rejectDone(err ?? new Error('indexer worker 失败'));
  }

  function onMessage(msg: WorkerMessage): void {
    try {
      if (msg.runId !== runId) return;
      if (msg.type === 'resolve-request') {
        const ids: string[] = [];
        const errors: Array<{ relPath: string; error: string }> = [];
        for (const relPath of msg.relPaths) {
          try {
            const id = opts.resolveResourceId(opts.rootId, relPath);
            if (typeof id !== 'string' || !id) throw new Error('resolveResourceId 返回了空 ID');
            ids.push(id);
          } catch (err) {
            ids.push('');
            errors.push({
              relPath,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        const reply: MainToWorker = { type: 'resolve-result', reqId: msg.reqId, ids, errors };
        try {
          worker.send(reply);
        } catch {
          // worker 已经退出
        }
        return;
      }
      if (msg.type === 'progress') {
        partial.processed = msg.processed;
        partial.total = msg.total;
        const progress: IndexProgress = {
          processed: msg.processed,
          total: msg.total,
          currentFile: msg.currentFile,
          processedFile: msg.processedFile,
        };
        for (const cb of listeners) {
          try {
            cb(progress);
          } catch {
            // 进度回调不能拖垮索引任务
          }
        }
        return;
      }
      if (msg.type === 'paths') {
        for (const relPath of msg.paths) partial.filesProcessed.push(relPath);
        return;
      }
      if (msg.type === 'result') {
        const filesProcessed = (
          msg.filesProcessed.length > 0 ? msg.filesProcessed : partial.filesProcessed
        ).slice();
        settle({
          jobId,
          status: msg.status,
          processed: msg.processed,
          total: msg.total,
          filesProcessed,
          errors: msg.errors.slice(),
          elapsedMs: msg.elapsedMs,
        });
        return;
      }
      if (msg.type === 'fatal') {
        const extra = sharedStderr.trim();
        settle(null, new Error(extra ? `${msg.error}\n${extra}` : msg.error));
      }
    } catch (err) {
      settle(null, err instanceof Error ? err : new Error(String(err)));
    }
  }

  function onError(err: Error): void {
    settle(null, err instanceof Error ? err : new Error(String(err)));
  }

  function onExit(code: number | null): void {
    const extra = sharedStderr.trim();
    settle(
      null,
      new Error(extra ? `indexer worker 退出码 ${code}\n${extra}` : `indexer worker 退出码 ${code}`),
    );
  }

  worker.on('message', onMessage);
  worker.on('error', onError);
  worker.on('exit', onExit);
  void readCorpus(payload.localPath, payload.skipDirNames)
    .then((preReadPack) => {
      if (settled) return;
      payload.preReadPack = preReadPack;
      try {
        worker.send({ type: 'run', runId, data: payload } satisfies MainToWorker);
      } catch (err) {
        settle(null, err instanceof Error ? err : new Error(String(err)));
      }
    })
    .catch((err: unknown) => {
      settle(null, err instanceof Error ? err : new Error(String(err)));
    });

  const job: IndexJob = {
    jobId,
    onProgress(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    cancel() {
      if (settled) return;
      try {
        worker.send({ type: 'cancel', runId } satisfies MainToWorker);
      } catch {
        // worker 已经退出
      }
      if (killTimer) return;
      killTimer = setTimeout(() => {
        if (settled) return;
        settle({
          ...partial,
          status: 'cancelled',
          filesProcessed: partial.filesProcessed.slice(),
          errors: partial.errors.slice(),
        });
        dropSharedWorker(worker);
      }, 900);
    },
    done,
  };
  job.done.catch(() => {});
  return job;
}

function locationFromDb(db: SqliteDb, resourceId: string) {
  const row = db
    .prepare(
      `SELECT f.root_id AS rootId, f.rel_path AS relPath, r.local_path AS localPath
       FROM indexer_files f
       JOIN indexer_roots r ON r.root_id = f.root_id
       WHERE f.resource_id = ?`,
    )
    .get(resourceId) as { rootId: string; relPath: string; localPath: string } | undefined;
  if (!row) {
    throw new Error(`未知资料，无法 indexOne: ${resourceId}。请先 startIndex，或传入 lookupPath。`);
  }
  return {
    rootId: row.rootId,
    relPath: normalizeRel(row.relPath),
    localPath: row.localPath,
    absPath: toAbs(row.localPath, row.relPath),
  };
}

function runExtractWorker(
  absPath: string,
  relPath: string,
): Promise<{ pages: PageText[]; size: number; mtimeMs: number }> {
  const runId = ++runSeq;
  const worker = getSharedWorker();
  const payload: ExtractWorkerData = { kind: 'extract-one', absPath, relPath };
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error, value?: { pages: PageText[]; size: number; mtimeMs: number }) => {
      if (settled) return;
      settled = true;
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
      if (err) reject(err);
      else resolve(value!);
    };
    const onMessage = (msg: WorkerMessage) => {
      if (msg.runId !== runId) return;
      if (msg.type === 'extracted') {
        finish(undefined, { pages: msg.pages, size: msg.size, mtimeMs: msg.mtimeMs });
      } else if (msg.type === 'fatal' || msg.type === 'extract-error') {
        const extra = sharedStderr.trim();
        finish(new Error(extra ? `${msg.error}\n${extra}` : msg.error));
      }
    };
    const onError = (err: Error) => finish(err instanceof Error ? err : new Error(String(err)));
    const onExit = (code: number) => {
      const extra = sharedStderr.trim();
      finish(new Error(extra || `extract worker 退出码 ${code}`));
    };
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    try {
      worker.send({ type: 'run', runId, data: payload } satisfies MainToWorker);
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

setExtractOffThread(async (absPath) => {
  const extracted = await runExtractWorker(absPath, path.basename(absPath));
  return extracted.pages.map((page) => ({ page: page.page, text: page.body }));
});

export async function indexOne(
  db: SqliteDb,
  resourceId: string,
  opts: IndexOneOptions = {},
): Promise<IndexOneResult> {
  if (!resourceId) throw new Error('resourceId 不能为空');
  let loc: { rootId: string; relPath: string; absPath: string; localPath: string };
  if (opts.lookupPath) {
    const found = opts.lookupPath(resourceId);
    if (!found) throw new Error(`lookupPath 未返回路径: ${resourceId}`);
    const relPath = normalizeRel(found.relPath);
    const absPath = path.resolve(found.absPath);
    const localPath = path.resolve(found.localPath ?? deriveLocalPath(absPath, relPath));
    loc = { rootId: found.rootId, relPath, absPath, localPath };
  } else {
    loc = locationFromDb(db, resourceId);
  }
  const extracted = await runExtractWorker(loc.absPath, loc.relPath);
  const store = new IndexStore(db);
  store.upsertRoot(loc.rootId, loc.localPath);
  store.write(
    {
      resourceId,
      rootId: loc.rootId,
      relPath: loc.relPath,
      size: extracted.size,
      mtimeMs: extracted.mtimeMs,
      pages: extracted.pages,
    },
    undefined,
    `one:${randomUUID()}`,
  );
  markTextIndexVersion(db);
  return { resourceId, relPath: loc.relPath, pageCount: extracted.pages.length };
}

export function removeOne(db: SqliteDb, resourceId: string): void {
  if (!resourceId) throw new Error('resourceId 不能为空');
  new IndexStore(db).removeResource(resourceId);
}

// 测试文件一 import 就会走到这里，pdfjs 的加载和语料生成叠在一起，不占索引计时。
getSharedWorker();
getReader();
