import type { Conflict } from "./types.js";
export type LexOk = {
    ok: true;
    relPath: string;
};
export type LexBad = {
    ok: false;
    conflict: Conflict;
};
/** 只做词法检查。符号链接和 junction 由调用方的 resolveInsideRoot 负责。 */
export declare function normalizeRelPath(input: string): LexOk | LexBad;
/** parent 本身不算在内部。Windows 下不区分大小写。 */
export declare function isWithinDir(parent: string, target: string): boolean;
