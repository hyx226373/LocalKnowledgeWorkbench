import type { Conflict } from "@kb/fileops";
export type LexOk = {
    ok: true;
    relPath: string;
};
export type LexBad = {
    ok: false;
    conflict: Conflict;
};
/**
 * 与 fileops 的词法拒绝一致，这样预览里的虚拟路径和稍后 apply 用的是同一套相对路径。
 * 符号链接和 junction 不在这里展开。
 */
export declare function normalizeRelPath(input: string): LexOk | LexBad;
export declare function pathKey(relPath: string): string;
