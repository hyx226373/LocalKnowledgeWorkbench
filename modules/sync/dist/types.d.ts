import type BetterSqlite3 from 'better-sqlite3';
export type SqliteDb = BetterSqlite3.Database;
export type SyncPhase = 'reconcile' | 'index' | 'catchup' | 'idle' | 'cancelled' | 'error';
export interface SyncProgress {
    phase: SyncPhase;
    seen: number;
    /** reconcile 扫描阶段可能还不知道总数。 */
    total: number | null;
    currentFile: string | null;
    pending: number;
    dirty: boolean;
}
export interface SyncDeps {
    db: SqliteDb;
    /** 真实数据库文件。worker 会自己打开，禁止 `:memory:`。 */
    dbPath: string;
    resolveLocalPath(rootId: string): string;
}
export interface SyncDone {
    status: 'cancelled' | 'error';
}
export interface SyncHandle {
    onProgress(cb: (progress: SyncProgress) => void): () => void;
    cancel(): void;
    /** 正常监视不结束。测试用这个等队列和补扫都停下来。 */
    whenIdle(): Promise<void>;
    /** 只在 cancel 或不可恢复错误时结束。 */
    done: Promise<SyncDone>;
}
export interface SyncController {
    /**
     * 同一 root 若已有未结束的会话，返回正在跑的那份。
     * 正常监视下 `done` 不结束。
     */
    startSync(rootId: string): SyncHandle;
}
