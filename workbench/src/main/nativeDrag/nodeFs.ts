import fs from 'node:fs';
import type { NativeDragFs, NativeDragStat } from '../../shared/nativeDragPolicy';

function statOf(st: fs.Stats): NativeDragStat {
  return {
    isFile: () => st.isFile(),
    isDirectory: () => st.isDirectory(),
    isSymbolicLink: () => st.isSymbolicLink(),
  };
}

/** lstat 不跟随最后一段符号链接。realpath 跟随，用来拒绝越根链接。 */
export function nodeNativeDragFs(): NativeDragFs {
  return {
    lstat(filePath: string): NativeDragStat | null {
      try {
        return statOf(fs.lstatSync(filePath));
      } catch {
        return null;
      }
    },
    realpath(filePath: string): string | null {
      try {
        return fs.realpathSync.native(filePath);
      } catch {
        return null;
      }
    },
  };
}
