import { type Db } from './db.js';
import type { DbResource, FsCapabilities, ReconcileProgress, ReconcileResult, ResourceKind } from './types.js';
export interface DiskNode {
    relPath: string;
    pathKey: string;
    kind: ResourceKind;
    size: number;
    mtimeMs: number;
    fsFileId: string | null;
    absPath: string;
}
interface PlanUpdate {
    id: string;
    relPath: string;
    pathKey: string;
    kind: ResourceKind;
    size: number;
    mtimeMs: number;
    hash: string | null;
    fsFileId: string | null;
    pathChanged: boolean;
}
interface PlanMissing {
    id: string;
    wasMissing: boolean;
}
interface PlanInsert {
    relPath: string;
    pathKey: string;
    kind: ResourceKind;
    size: number;
    mtimeMs: number;
    hash: string | null;
    fsFileId: string | null;
}
interface Plan {
    updates: PlanUpdate[];
    missing: PlanMissing[];
    inserts: PlanInsert[];
}
export interface JobOptions {
    caps: FsCapabilities;
    cancel?: () => boolean;
    delayMs?: number;
    onProgress?: (progress: ReconcileProgress) => void;
    /** 与另一次对账共用。不传则按数据库文件取进程内的锁。 */
    lock?: Int32Array;
}
export declare function scanTree(rootAbs: string, caps: FsCapabilities, options: JobOptions): DiskNode[];
export declare function buildPlan(rows: DbResource[], disk: DiskNode[], caps: FsCapabilities, options: JobOptions): Plan;
export declare function applyPlan(db: Db, rootId: string, plan: Plan): void;
export declare function runJob(db: Db, rootId: string, options: JobOptions): ReconcileResult;
export {};
//# sourceMappingURL=engine.d.ts.map