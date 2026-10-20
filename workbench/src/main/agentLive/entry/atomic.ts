import fs from 'node:fs';
import path from 'node:path';

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES', 'EEXIST']);

export interface AtomicHooks {
  rename?: typeof fs.promises.rename;
  delay?: (ms: number) => Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 先写同目录 *.tmp，fsync 后再 rename 覆盖。
 * EPERM、EBUSY、EACCES、EEXIST 按 20/40/80/160ms 退避，最多 5 次。
 * 仍然失败就留下 tmp，调用方下一轮再提升。不把半截文件当成正式文件。
 */
export async function atomicWriteFile(
  dest: string,
  data: string | Buffer,
  hooks?: AtomicHooks,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  const fh = await fs.promises.open(tmp, 'w');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  const rename = hooks?.rename ?? fs.promises.rename;
  const wait = hooks?.delay ?? delay;
  let last: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rename(tmp, dest);
      return;
    } catch (err) {
      last = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (!code || !RETRYABLE.has(code)) break;
      if (attempt === 4) break;
      await wait(20 * 2 ** attempt);
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 只提升完整 tmp。残缺的删掉。marker 和 changes 不在这里处理。 */
export function tmpLooksComplete(file: string, dest: string): boolean {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return false;
  }
  if (!st.isFile() || st.size <= 0) return false;
  const base = path.basename(dest);
  if (base === 'snapshot.json' || base === 'meta.json' || dest.endsWith('.json')) {
    const text = readText(file);
    if (!text) return false;
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  }
  if (base === 'ENTRY.md') {
    const text = readText(file);
    // 规则区可以在版本注释前面。旧文件的注释仍在开头，两种都算完整。
    return !!text && text.includes('<!-- kb-live ') && text.includes('## 6. 接入约定');
  }
  if (dest.endsWith('.md')) {
    const text = readText(file);
    return !!text && text.startsWith('# ');
  }
  if (dest.endsWith('.txt')) return true;
  return false;
}

function promoteOne(tmp: string): void {
  if (!tmp.endsWith('.tmp')) return;
  const dest = tmp.slice(0, -'.tmp'.length);
  if (!tmpLooksComplete(tmp, dest)) {
    fs.rmSync(tmp, { force: true });
    return;
  }
  try {
    fs.renameSync(tmp, dest);
  } catch {
    /* 下一轮再试。不删除正式文件。 */
  }
}

export function promoteIfComplete(dest: string): void {
  const tmp = `${dest}.tmp`;
  if (fs.existsSync(tmp)) promoteOne(tmp);
}

const NAV = ['structure.md', 'relations.md', 'actions.md', 'guide.md', 'architecture.md'];

/**
 * 只提升入口自己的 tmp：snapshot、ENTRY、nav、content 下的 txt 和 meta。
 * 不碰 marker.json，也不碰 changes/，避免在快照写完之前抬出 marker。
 */
export function promoteEntryFiles(wsDir: string): void {
  if (!fs.existsSync(wsDir)) return;
  promoteIfComplete(path.join(wsDir, 'snapshot.json'));
  promoteIfComplete(path.join(wsDir, 'ENTRY.md'));
  for (const name of NAV) promoteIfComplete(path.join(wsDir, 'nav', name));
  const content = path.join(wsDir, 'content');
  if (!fs.existsSync(content)) return;
  const stack = [content];
  while (stack.length) {
    const dir = stack.pop()!;
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name === '.' || name === '..') continue;
      const full = path.join(dir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (name === 'meta.json.tmp' || name.endsWith('.txt.tmp')) promoteOne(full);
    }
  }
}

export function promoteCurrentEntry(currentDir: string): void {
  promoteIfComplete(path.join(currentDir, 'ENTRY.md'));
}
