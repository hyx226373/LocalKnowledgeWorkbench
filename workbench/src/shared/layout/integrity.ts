/** 外贴 27 冻结。候选目录缺任一必需文件，或大小为 0，都不得切换 current.json。 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { VERSION_TREE_REQUIRED } from './names';

export interface TreeCheck {
  ok: boolean;
  missing: string[];
}

export async function verifyVersionTree(
  dir: string,
  stat: (abs: string) => Promise<number | null> = async (abs) => {
    try {
      const info = await fs.stat(abs);
      return info.isFile() ? info.size : null;
    } catch {
      return null;
    }
  },
): Promise<TreeCheck> {
  const missing: string[] = [];
  for (const rel of VERSION_TREE_REQUIRED) {
    const size = await stat(path.win32.join(dir, ...rel.split('/')));
    if (size === null || size <= 0) missing.push(rel);
  }
  return { ok: missing.length === 0, missing };
}
