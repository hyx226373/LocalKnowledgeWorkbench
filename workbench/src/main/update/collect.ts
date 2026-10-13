import { promises as fs } from 'node:fs';
import path from 'node:path';

const SKIP_DIR = new Set([
  'update-backups',
  'update-downloads',
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'blob_storage',
  'Session Storage',
  'Local Storage',
  'Shared Dictionary',
  'Network',
  'SharedStorage',
  'Service Worker',
  'WebStorage',
  'databases',
  'IndexedDB',
  'logs',
]);

const CONFIG_NAME = new Set(['Preferences', 'Local State', 'canary.json']);
const SQLITE_HEADER = 'SQLite format 3\u0000';

export interface PlannedFile {
  abs: string;
  rel: string;
  kind: 'sqlite' | 'config';
}

async function isSqlite(file: string): Promise<boolean> {
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(16);
    const read = await fh.read(buf, 0, 16, 0);
    return read.bytesRead === 16 && buf.toString('utf8') === SQLITE_HEADER;
  } catch {
    return false;
  } finally {
    await fh.close();
  }
}

function isConfig(name: string, size: number): boolean {
  if (size > 2 * 1024 * 1024) return false;
  if (CONFIG_NAME.has(name)) return true;
  return name.endsWith('.json') || name.endsWith('.txt') || name.endsWith('.yml');
}

async function walk(root: string, dir: string, out: PlannedFile[]): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (SKIP_DIR.has(name)) continue;
    const abs = path.join(dir, name);
    let st: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      st = await fs.lstat(abs);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      await walk(root, abs, out);
      continue;
    }
    if (!st.isFile()) continue;
    const rel = path.relative(root, abs);
    if (await isSqlite(abs)) {
      out.push({ abs, rel, kind: 'sqlite' });
      continue;
    }
    if (isConfig(name, st.size)) out.push({ abs, rel, kind: 'config' });
  }
}

/** 列出要备份的数据库和配置。不包含缓存，也不包含备份目录本身。 */
export async function planBackupFiles(root: string): Promise<PlannedFile[]> {
  const out: PlannedFile[] = [];
  await walk(root, root, out);
  return out;
}
