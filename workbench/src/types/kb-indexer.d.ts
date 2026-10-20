/** Application-side contract for @kb/indexer c19896b. No runtime implementation. */
declare module '@kb/indexer' {
  import type { Database } from 'better-sqlite3';
  export interface ContentScope {
    includeExts: string[];
    includePrefixes: string[];
    excludePrefixes: string[];
    includeRelPaths?: string[];
    maxBytes: number;
  }
  export interface StartIndexOptions {
    rootId: string; localPath: string; dbPath: string;
    resolveResourceId: (rootId: string, relPath: string) => string;
    mode?: 'full' | 'incremental'; skipDirNames?: string[]; contentScope?: ContentScope;
  }
  export interface IndexResult {
    jobId: string; status: 'completed' | 'cancelled'; processed: number; total: number;
    filesProcessed: string[]; errors: { path: string; error: string }[]; elapsedMs: number; bodyReads?: number;
  }
  export interface IndexJob {
    jobId: string; done: Promise<IndexResult>; cancel(): void;
    onProgress(cb: (p: { processed: number; total: number; currentFile: string | null; processedFile: string | null }) => void): () => void;
  }
  export interface GroupedSearchResult {
    hits: { resourceId: string; rootId: string; relPath: string; title: string; score: number;
      matchKind: 'name' | 'body'; page: number; snippet: string;
      matches: { page: number; line: number | null; snippet: string; anchor: { page: number } | { line: number } }[];
      matchesTruncated: boolean }[];
    truncated: boolean; degraded?: boolean; reindexRequired?: boolean; reindexReason?: string;
  }
  export function migrate(db: Database): void;
  export function startIndex(opts: StartIndexOptions): IndexJob;
  export function indexOne(db: Database, resourceId: string, opts?: {
    lookupPath?: (id: string) => { rootId: string; relPath: string; absPath: string; localPath?: string } | null | undefined;
    contentScope?: ContentScope; maxBytes?: number;
  }): Promise<{ resourceId: string; relPath: string; pageCount: number }>;
  export interface IndexManyItem {
    resourceId: string;
    rootId: string;
    relPath: string;
    absPath: string;
    localPath?: string;
  }
  export function indexMany(
    db: Database,
    items: IndexManyItem[],
    opts?: { contentScope?: ContentScope; maxBytes?: number },
  ): Promise<Array<{ resourceId: string; relPath: string; pageCount: number }>>;
  export function compactTextIndexUntilWritable(db: Database): { ok: boolean; steps: number };
  export function removeOne(db: Database, resourceId: string): void;
  export function indexerReady(): Promise<void>;
  export function closeIndexer(): Promise<void>;
  export function extractText(absPath: string): Promise<{ page: number; text: string }[]>;
  export function searchGrouped(db: Database, query: string, opts?: { limit?: number; rootIds?: string[] }): GroupedSearchResult;
}

declare module '@kb/indexer/fork' {
  export interface IndexerForkOptions {
    execArgv?: string[]; env?: NodeJS.ProcessEnv; cwd?: string;
    stdio?: Array<'ignore' | 'inherit' | 'pipe' | 'ipc'> | 'pipe' | 'ignore' | 'inherit'; windowsHide?: boolean;
  }
  export interface IndexerChild {
    send?(message: unknown): boolean; postMessage?(message: unknown): void;
    on(event: string, listener: (...args: any[]) => void): this;
    off(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    stderr?: NodeJS.ReadableStream | null; stdout?: NodeJS.ReadableStream | null; pid?: number;
    unref(): void; ref(): void; kill?(signal?: string): boolean;
  }
  export type IndexerForkFn = (modulePath: string, args: string[], options: IndexerForkOptions) => IndexerChild;
  export function setIndexerFork(fn: IndexerForkFn | null): void;
  export function getIndexerFork(): IndexerForkFn;
}
