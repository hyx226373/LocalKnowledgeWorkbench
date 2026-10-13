import { createIntegratedWorkbench } from "./integrated-workbench.js";
/** 生产入口。路径、资料 ID、文件操作和 PDF 正文都走对应的 @kb 包。 */
export function createWorkbench(opts) {
    return createIntegratedWorkbench(opts);
}
//# sourceMappingURL=factory.js.map