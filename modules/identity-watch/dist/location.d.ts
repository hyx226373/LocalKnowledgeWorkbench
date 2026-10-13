import { type Db } from './db.js';
import type { ResourceLocation } from './types.js';
/**
 * 调用方把 W3 的 onMoved(resourceId, before, after) 转到这里。
 * 更新这一条的 root_id、rel_path、rel_path_key，missing 置 0，并刷新 updated_at。
 * 不插入新行，不改 size、mtime、哈希、fs_file_id，不读磁盘。跨根规则见 README v1.2。
 */
export declare function updateLocation(db: Db, resourceId: string, before: ResourceLocation, after: ResourceLocation): void;
//# sourceMappingURL=location.d.ts.map