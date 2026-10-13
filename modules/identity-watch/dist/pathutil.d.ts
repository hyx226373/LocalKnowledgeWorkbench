/** 旧库才有的占位前缀。migrate 把它改回原 rel_path；新写入不再使用。 */
export declare function isTombstone(relPath: string): boolean;
export declare function logicalRelPath(relPath: string): string;
/**
 * `\` → `/`，NFC，去掉 `.` 和重复斜杠。
 * 拒绝绝对路径、盘符、UNC、空字节和 `..`（含大小写、反斜杠伪装）。
 * 空字符串表示根目录本身。
 */
export declare function normalizeRelPath(input: string): string;
/** Windows 上唯一性比较用小写；库里的 rel_path 仍保留规范后的大小写。 */
export declare function pathKey(relPath: string): string;
export declare function isInsideRoot(rootReal: string, candidate: string): boolean;
export declare function joinRel(rootAbs: string, relPath: string): string;
//# sourceMappingURL=pathutil.d.ts.map