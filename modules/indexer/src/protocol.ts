export interface ScannedFile {
  absPath: string;
  relPath: string;
  size: number;
  mtimeMs: number;
}

export interface PreReadFile {
  absPath: string;
  relPath: string;
  size: number;
  mtimeMs: number;
  /** txt / md 正文。PDF 不传，由索引进程自己抽。 */
  body?: string;
  error?: string;
}

export interface BulkWorkerData {
  kind: 'bulk';
  rootId: string;
  localPath: string;
  dbPath: string;
  mode: 'full' | 'incremental';
  skipDirNames: string[];
  batchId: string;
  /** 父进程取消时写成 1。写库时不让出事件循环，靠它停下来。 */
  cancelFlag?: Int32Array;
  /** 调用进程里读好的正文。索引进程不再打开这些小文件。 */
  preRead?: PreReadFile[];
  /** 正文打在一个 json 文件里，避免经父进程 IPC 传全部正文。 */
  preReadPack?: string;
}

export interface ExtractWorkerData {
  kind: 'extract-one';
  absPath: string;
  relPath: string;
}

export type WorkerData = BulkWorkerData | ExtractWorkerData;

export interface ResolveResultMessage {
  type: 'resolve-result';
  reqId: number;
  ids: string[];
  errors: Array<{ relPath: string; error: string }>;
}

export interface RunMessage {
  type: 'run';
  runId: number;
  data: WorkerData;
}

export type MainToWorker =
  | ResolveResultMessage
  | { type: 'cancel'; runId: number }
  | { type: 'shutdown' }
  | { type: 'warm-ping' }
  | RunMessage;
