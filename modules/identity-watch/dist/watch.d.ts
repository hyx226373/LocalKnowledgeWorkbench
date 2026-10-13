import { type Db } from './db.js';
import type { ResourceChange, WatchHandle } from './types.js';
/** 订阅探活用的临时文件。scanTree 会跳过这个前缀，避免它变成资料。 */
export declare const WATCH_ARM_PREFIX = ".kb-watch-arm-";
export interface WatchOptions {
    debounceMs?: number;
}
export declare function watchRoot(db: Db, rootId: string, onResourceChanged: (event: ResourceChange) => void, options?: WatchOptions): Promise<WatchHandle>;
//# sourceMappingURL=watch.d.ts.map