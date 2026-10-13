export type ResourceKind = 'file' | 'dir';
export interface ResourceLocation {
    rootId: string;
    relPath: string;
}
export interface ResourceSnapshot {
    id: string;
    rootId: string;
    /** 规范相对路径（`/`、NFC）。失联行也保留这条原路径。 */
    relPath: string;
    /** 失联，且已有另一条 missing=0 的记录占用同一路径。rel_path 本身不是占位符。 */
    displaced: boolean;
    kind: ResourceKind;
    size: number | null;
    mtimeMs: number | null;
    contentHash: string | null;
    fsFileId: string | null;
    missing: number;
}
export interface ResourceChange {
    type: 'create' | 'modify' | 'rename-move' | 'delete';
    resourceId: string;
    before: ResourceSnapshot | null;
    after: ResourceSnapshot | null;
}
export interface ReconcileProgress {
    phase: 'scan' | 'hash' | 'write' | 'done';
    seen: number;
    total: number | null;
}
export interface ReconcileResult {
    scanned: number;
    moved: number;
    updated: number;
    missing: number;
    created: number;
    fileSystem: string;
    fileIdReliable: boolean;
}
export interface ReconcileOptions {
    signal?: AbortSignal;
    onProgress?: (progress: ReconcileProgress) => void;
    /**
     * 测试用：每个目录项扫描前暂停。生产调用不要传。
     * 用来观察取消能在 1 秒内停住。
     */
    interFileDelayMs?: number;
    /** 测试用：覆盖文件系统检测。生产调用不要传。 */
    forceFileIdReliable?: boolean;
    forceFileSystemName?: string;
}
export interface FsCapabilities {
    name: string;
    fileIdReliable: boolean;
}
export interface ResolvedInside {
    rootId: string;
    relPath: string;
    absPath: string;
    resourceId: string | null;
}
export interface WatchHandle {
    backend: 'parcel' | 'chokidar';
    flush(): Promise<void>;
    whenIdle(): Promise<void>;
    close(): Promise<void>;
}
export interface PortableResource {
    id: string;
    rel_path: string;
    displaced: boolean;
    kind: ResourceKind;
    size: number | null;
    mtime_ms: number | null;
    content_hash: string | null;
    missing: number;
    created_at: number;
    updated_at: number;
}
export interface PortableBundle {
    format: 'kb-identity-portable-v1';
    root: {
        id: string;
        name: string | null;
        created_at: number | null;
    };
    resources: PortableResource[];
}
export interface DbResource {
    id: string;
    root_id: string;
    rel_path: string;
    rel_path_key: string;
    kind: ResourceKind;
    size: number | null;
    mtime_ms: number | null;
    content_hash: string | null;
    fs_file_id: string | null;
    missing: number;
    created_at: number;
    updated_at: number;
}
//# sourceMappingURL=types.d.ts.map