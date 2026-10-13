import type BetterSqlite3 from 'better-sqlite3';

export type SqliteDb = BetterSqlite3.Database;

export type IndexMode = 'full' | 'incremental';

export type TokenizerKind = 'trigram' | 'bigram';

/** 高亮标记。snippet 用这对标记包住命中的原文。 */
export const HIGHLIGHT_START = '<b>';
export const HIGHLIGHT_END = '</b>';

export interface StartIndexOptions {
  rootId: string;
  /** 资料根在本机的绝对路径。扫描只读这里，不把数据库写进这个目录。 */
  localPath: string;
  /** 索引数据库文件路径。worker 会自己打开，不能是 :memory:。 */
  dbPath: string;
  /**
   * 在调用 startIndex 的线程上执行，把相对路径换成稳定资料 ID。
   * 同一 rootId + relPath 必须稳定返回同一个 ID。
   */
  resolveResourceId: (rootId: string, relPath: string) => string;
  /**
   * 一次解析一批相对路径。有它时父进程按时间片调用，不再对整批同步逐个解析。
   * 返回数组必须和 relPaths 等长，未知路径用空字符串。
   */
  resolveResourceIds?: (rootId: string, relPaths: string[]) => string[];
  /** 默认 full。incremental 只处理 size 或 mtime 变化的文件。 */
  mode?: IndexMode;
  /** 额外要跳过的目录名（大小写不敏感），会并进默认跳过列表。 */
  skipDirNames?: string[];
}

export interface IndexProgress {
  processed: number;
  total: number;
  currentFile: string | null;
  /** 本事件刚刚成功写入的相对路径；否则为 null。 */
  processedFile: string | null;
}

export interface IndexError {
  path: string;
  error: string;
}

export interface IndexResult {
  jobId: string;
  status: 'completed' | 'cancelled';
  processed: number;
  total: number;
  /** 本次成功抽正文并写入的相对路径（/、NFC）。增量测试用它判断处理了哪些文件。 */
  filesProcessed: string[];
  errors: IndexError[];
  elapsedMs: number;
  /** 本次真正读过正文的文件数。无变化的增量运行应接近 0。 */
  bodyReads?: number;
}

export interface IndexJob {
  jobId: string;
  onProgress(cb: (progress: IndexProgress) => void): () => void;
  cancel(): void;
  done: Promise<IndexResult>;
}

export interface SearchHit {
  resourceId: string;
  page: number;
  title: string;
  snippet: string;
  /** 越大越相关（FTS5 bm25 取反）。 */
  score: number;
}

export interface SearchOptions {
  limit?: number;
  rootIds?: string[];
}

/** PDF 锚点只有页；txt / md 锚点只有行。两者不会同时出现。 */
export type GroupedAnchor = { page: number } | { line: number };

export interface GroupedMatch {
  page: number;
  /** PDF 为 null。txt / md 从 1 开始。 */
  line: number | null;
  snippet: string;
  anchor: GroupedAnchor;
}

export interface GroupedHit {
  resourceId: string;
  rootId: string;
  relPath: string;
  /** 文件名，不含目录。 */
  title: string;
  /** 越大越相关。 */
  score: number;
  /** 文件名或相对路径命中为 name；同时命中正文也算 name。 */
  matchKind: 'name' | 'body';
  /** 第一条 match 的页。txt / md 为 0。 */
  page: number;
  /** 第一条 match 的摘录。高亮用 `<b>`。 */
  snippet: string;
  /** 最多 3 条，按页码升序。 */
  matches: GroupedMatch[];
  matchesTruncated: boolean;
}

export interface GroupedSearchResult {
  hits: GroupedHit[];
  truncated: boolean;
  /**
   * 库里已有 fts_content 行，但 indexer_meta.text_index_version 不是 2。
   * 为 true 时不要把空的 hits 当成「没有这份资料」。
   * 新库完成索引后为 false。空查询、rootIds 为空这些短路结果不带这个字段。
   */
  reindexRequired?: boolean;
  /** reindexRequired 为 true 时的中文说明。 */
  reindexReason?: string;
}

export interface ResourceLocation {
  rootId: string;
  relPath: string;
  absPath: string;
  /** 不传则用 absPath 和 relPath 反推。 */
  localPath?: string;
}

export interface IndexOneOptions {
  lookupPath?: (resourceId: string) => ResourceLocation | null | undefined;
}

export interface IndexOneResult {
  resourceId: string;
  relPath: string;
  pageCount: number;
}
