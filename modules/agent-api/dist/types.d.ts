import type { FileOp } from '@kb/fileops';
/** 计划步骤。restore 不是 fileops 的 FileOp，批准后才调用 fileOps.restore。 */
export type PlanStepOp = FileOp | {
    type: 'restore';
    opId: string;
    onConflict: OnConflict;
};
export type Permission = 'read' | 'readwrite';
export type OpName = 'create' | 'write' | 'move' | 'rename' | 'delete' | 'restore';
export interface RootInfo {
    id: string;
    name: string;
    localPath: string;
}
export interface DirEntry {
    name: string;
    relPath: string;
    kind: 'file' | 'dir';
    size: number;
}
export interface PdfPageText {
    page: number;
    text: string;
}
export interface ReadResult {
    rootId: string;
    relPath: string;
    kind: 'text' | 'pdf';
    /** 文本是正文。PDF 是各页 text 按换行接起来，页数组在 pages。 */
    text: string;
    pages?: PdfPageText[];
    truncated: boolean;
    bytesRead: number;
    size: number;
}
/** PDF 锚点只有页。txt / md 锚点只有行。 */
export type SearchAnchor = {
    page: number;
} | {
    line: number;
};
export interface SearchMatch {
    page: number;
    /** PDF 为 null。txt / md 从 1 开始。 */
    line: number | null;
    snippet: string;
    anchor: SearchAnchor;
}
/** 一条资料。同一 PDF 的多页命中合成这一条，matches 最多 3 个。 */
export interface SearchHit {
    resourceId: string;
    rootId: string;
    relPath: string;
    /** 文件名，不含目录。 */
    title: string;
    /** 越大越相关。 */
    score: number;
    /** 文件名或路径命中为 name。同时命中正文也算 name。 */
    matchKind: 'name' | 'body';
    /** 第一条 match 的页。txt / md 为 0。 */
    page: number;
    /** 第一条 match 的摘录。高亮用 `<b>`。 */
    snippet: string;
    matches: SearchMatch[];
    matchesTruncated: boolean;
}
export interface SearchResult {
    hits: SearchHit[];
    truncated: boolean;
}
export interface PreviewRequest {
    op: 'move' | 'rename' | 'restore';
    rootId?: string;
    fromPath?: string;
    toPath?: string;
    opId?: string;
}
export interface PreviewResult {
    previewId: string;
    op: 'move' | 'rename' | 'restore';
    rootId: string;
    fromPath?: string;
    toPath?: string;
    opId?: string;
    willWrite: false;
    actor: string;
    conflicts: string[];
}
export type OnConflict = 'cancel' | 'rename' | 'overwrite';
export interface ApplyRequest {
    previewId: string;
    /** 预览本身是 restore 时必须带上，原样交给 fileops。 */
    onConflict?: OnConflict;
}
export interface ApplyResult {
    opId: string;
    op: 'move' | 'rename' | 'restore';
    actor: string;
    status: 'ok';
    rootId: string;
    /** op_log.resource_id。没有时是 null，不是空字符串。 */
    resourceId: string | null;
    fromPath?: string;
    toPath?: string;
    restoredOpId?: string;
}
export interface RestoreRequest {
    opId?: string;
    previewId?: string;
    onConflict: OnConflict;
}
export interface RestoreResult {
    opId: string;
    op: 'restore';
    actor: string;
    status: 'ok';
    rootId: string;
    resourceId: string | null;
    restoredOpId: string;
    fromPath: string;
    toPath: string;
}
export interface OpLogEntry {
    id: string;
    ts: string;
    actor: string;
    op: OpName;
    resourceId: string | null;
    rootId: string;
    before: unknown;
    after: unknown;
    backupRef: string | null;
    status: 'ok' | 'error';
    error: string | null;
}
export interface ServiceCtx {
    actor: string;
    tokenName: string;
    rootIds: string[];
    permission: Permission;
}
export type PlanRunStatus = 'draft' | 'approved' | 'applied' | 'failed-rolled-back';
export interface PlanStepState {
    id: string;
    seq: number;
    op: PlanStepOp;
    approved: boolean;
    status: string;
    opId: string | null;
    resourceId: string | null;
    summary: string | null;
    conflicts: Array<{
        code: string;
        relPath: string;
        message: string;
    }>;
    affectedResourceIds: string[];
    diff: string | null;
    error: string | null;
}
export interface PlanState {
    id: string;
    actor: string;
    title: string;
    status: PlanRunStatus;
    error: string | null;
    steps: PlanStepState[];
}
export interface PlanPreviewState {
    planId: string;
    steps: Array<{
        stepId: string;
        seq: number;
        op: PlanStepOp;
        summary: string;
        conflicts: Array<{
            code: string;
            relPath: string;
            message: string;
        }>;
        affectedResourceIds: string[];
        diff: string | null;
    }>;
}
/** 列根目录、列目录、读文件、搜索，文件操作，以及计划审批。 */
export interface WorkbenchServices {
    registeredRoots(): Promise<RootInfo[]>;
    listDirectory(ctx: ServiceCtx, rootId: string, relPath: string): Promise<DirEntry[]>;
    readFile(ctx: ServiceCtx, rootId: string, relPath: string, opts: {
        maxBytes: number;
    }): Promise<ReadResult>;
    search(ctx: ServiceCtx, query: string, opts: {
        rootId?: string;
        limit?: number;
    }): Promise<SearchResult>;
    preview(ctx: ServiceCtx, req: PreviewRequest): Promise<PreviewResult>;
    apply(ctx: ServiceCtx, req: ApplyRequest): Promise<ApplyResult>;
    restore(ctx: ServiceCtx, req: RestoreRequest): Promise<RestoreResult>;
    log(ctx: ServiceCtx, opts: {
        limit?: number;
        rootId?: string;
    }): Promise<OpLogEntry[]>;
    plansCreate(ctx: ServiceCtx, req: {
        title: string;
        ops: PlanStepOp[];
    }): Promise<PlanState>;
    plansPreview(ctx: ServiceCtx, planId: string): Promise<PlanPreviewState>;
    plansGet(ctx: ServiceCtx, planId: string): Promise<PlanState>;
    /** 路径必须先经过这一步。生产实现调用 identity-watch 的 resolveInsideRoot。 */
    resolvePath(rootId: string, userPath: string): {
        absolutePath: string;
        relPath: string;
    };
    close(): Promise<void>;
}
export interface TokenSpec {
    name: string;
    rootIds: string[];
    permission: Permission;
}
export interface IssuedToken extends TokenSpec {
    secret: string;
}
export declare const RPC_METHODS: readonly ["roots.list", "fs.list", "fs.read", "search.query", "ops.preview", "ops.apply", "ops.restore", "ops.log", "plans.create", "plans.preview", "plans.approve", "plans.apply", "plans.get", "tokens.rotate"];
export type RpcMethod = (typeof RPC_METHODS)[number];
/** 只读令牌不能调用这些方法。批准、执行和直接 restore 对任何令牌都另外拒绝。 */
export declare const WRITE_METHODS: ReadonlySet<RpcMethod>;
export declare const DEFAULT_MAX_READ_BYTES: number;
export declare const HARD_MAX_READ_BYTES: number;
export declare const TOKEN_FILE_NAME = "agent-tokens.json";
