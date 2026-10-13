/** 相对路径用 `/` 和 NFC。拒绝 `..`，避免改名写出根外。 */
export declare function normalizeRel(relPath: string): string;
/** Windows 上 rel_key 小写；展示用的 rel_path 保留大小写。 */
export declare function relKeyOf(relPath: string): string;
export declare function fileTitle(relPath: string): string;
