import Database from 'better-sqlite3';
import type { DbResource, ResourceSnapshot } from './types.js';
export type Db = Database.Database;
export interface CreateRootInput {
    id?: string;
    name: string;
}
export declare function machineId(): string;
export declare function migrate(db: Db): void;
/** 只插入 roots。不写 local_path，也不要求目录已经存在。 */
export declare function createRoot(db: Db, input: CreateRootInput): string;
export declare function getMount(db: Db, rootId: string): string;
/** 本包唯一写入 root_mounts.local_path 的入口。目录必须已经存在。 */
export declare function setMount(db: Db, rootId: string, localPath: string): void;
export declare function loadResources(db: Db, rootId: string): DbResource[];
export declare function rowById(db: Db, id: string): DbResource | undefined;
/** 同一路径可以有多条 missing=1。这里只要当前还在的那条。 */
export declare function rowByPathKey(db: Db, rootId: string, key: string): DbResource | undefined;
export declare function toSnapshot(row: DbResource, displaced?: boolean): ResourceSnapshot;
export declare function snapshotById(db: Db, rootId: string): Map<string, ResourceSnapshot>;
export declare function getResource(db: Db, id: string): ResourceSnapshot | null;
export declare function listResources(db: Db, rootId: string): ResourceSnapshot[];
export declare function rootRow(db: Db, rootId: string): {
    id: string;
    name: string | null;
    created_at: number | null;
} | undefined;
export declare function databasePath(db: Db): string;
//# sourceMappingURL=db.d.ts.map