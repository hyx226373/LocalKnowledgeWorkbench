import { createIntegratedWorkbench } from './integrated-workbench.ts';
import type { WorkbenchOptions } from './options.ts';
import type { WorkbenchServices } from './types.ts';

/** 生产入口。路径、资料 ID、文件操作和 PDF 正文都走对应的 @kb 包。 */
export function createWorkbench(opts: WorkbenchOptions): Promise<WorkbenchServices> {
  return createIntegratedWorkbench(opts);
}
