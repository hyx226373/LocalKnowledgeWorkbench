import type { WorkbenchOptions } from './options.js';
import type { WorkbenchServices } from './types.js';
/** 生产入口。路径、资料 ID、文件操作和 PDF 正文都走对应的 @kb 包。 */
export declare function createWorkbench(opts: WorkbenchOptions): Promise<WorkbenchServices>;
