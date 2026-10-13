import fs from 'node:fs';
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

/** 资料文件。Electron 里避开会同步解析 .asar 的补丁 fs。 */
export const disk: typeof fs = original ?? fs;
