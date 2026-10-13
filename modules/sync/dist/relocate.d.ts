import { ftsShortTitle } from './bigram.js';
import type { SqliteDb } from './types.js';
export { ftsShortTitle };
/**
 * 改名或移动只更新索引里的位置。不读文件内容，不重新抽正文。
 * `resource_id` 保持不变。
 */
export declare function relocateResource(db: SqliteDb, input: {
    resourceId: string;
    absPath: string;
    relPath: string;
}): void;
