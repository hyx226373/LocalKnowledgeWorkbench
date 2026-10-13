/**
 * 与 `@kb/indexer` 的 `bigramTokenize` 相同：连续汉字切成重叠二字，其余原样。
 * indexer 没有导出这个函数，改名时要在本包里用同一套切法。
 */
export declare function bigramTokenize(input: string): string;
/** 与 indexer 写入 fts_short.title 的切法相同：文件名、换行、相对路径，再做重叠二字。 */
export declare function ftsShortTitle(filename: string, relPath: string): string;
