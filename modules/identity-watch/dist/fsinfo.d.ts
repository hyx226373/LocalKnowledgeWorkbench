import fs from 'node:fs';
import type { FsCapabilities, ResourceKind } from './types.js';
/**
 * Node 24 在本机上 `fs.statfsSync().type` 对 NTFS 也是 0，不能用来区分文件系统。
 * 因此查 Win32_LogicalDisk 的 FileSystem 和 DriveType。
 * 只有本地固定盘（DriveType=3）且文件系统名为 NTFS 时，才把 stat.ino 当作稳定文件索引。
 */
export declare function detectFileSystem(absPath: string): FsCapabilities;
export declare function fileIdFromStat(st: fs.BigIntStats, reliable: boolean): string | null;
export declare function mtimeMsFromStat(st: fs.BigIntStats): number;
export declare function sizeFromStat(st: fs.BigIntStats): number;
export declare function kindFromStat(st: fs.Stats | fs.BigIntStats): ResourceKind;
export declare function hashFile(absPath: string, cancel: () => boolean): string;
//# sourceMappingURL=fsinfo.d.ts.map