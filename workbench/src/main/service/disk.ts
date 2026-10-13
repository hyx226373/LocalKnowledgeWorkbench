/**
 * 用户资料的文件访问。Electron 改过的 fs 会把路径里的 `.asar` 当成归档并同步解析头。
 * 扫描、目录和打开文件走 original-fs；拿不到时（纯 Node 测试）退回 node:fs。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';

function loadOriginal(): typeof fs | null {
  try {
    const req = createRequire(import.meta.url);
    return req('original-fs') as typeof fs;
  } catch {
    return null;
  }
}

const original = loadOriginal();

export const disk: typeof fs = original ?? fs;
export const diskPromises: typeof fsp = original?.promises ?? fsp;

export function pathHasAsar(p: string): boolean {
  return /(?:^|[\\/])[^\\/]+\.asar(?:$|[\\/])/i.test(p);
}
