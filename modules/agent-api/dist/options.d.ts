export interface WorkbenchRootInput {
    /** 省略时由 identity-watch 的 createRoot 生成。同一 dataDir 再次启动要沿用原 id。 */
    id?: string;
    name: string;
    localPath: string;
}
export interface WorkbenchOptions {
    dataDir: string;
    roots: WorkbenchRootInput[];
}
