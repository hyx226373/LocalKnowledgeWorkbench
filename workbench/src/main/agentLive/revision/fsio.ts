import fs from 'node:fs';
import path from 'node:path';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 先写同目录 *.tmp，fsync 后 rename 覆盖。失败重试 3 次。 */
export async function atomicWriteFile(dest: string, data: string | Buffer): Promise<void> {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  const fh = await fs.promises.open(tmp, 'w');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  let last: unknown;
  const retryable = new Set(['EPERM', 'EEXIST', 'EACCES', 'EBUSY']);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.promises.rename(tmp, dest);
      return;
    } catch (err) {
      last = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (!code || !retryable.has(code)) break;
      if (attempt === 4) {
        try {
          await fs.promises.rm(dest, { force: true });
          await fs.promises.rename(tmp, dest);
          return;
        } catch (err2) {
          last = err2;
        }
        break;
      }
      await delay(20 * 2 ** attempt);
    }
  }
  // 仍然失败就留下 *.tmp，下次启动再提升，不把半截文件当成正式文件。
  throw last instanceof Error ? last : new Error(String(last));
}

function tmpLooksComplete(file: string, dest: string): boolean {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return false;
  }
  if (!st.isFile() || st.size <= 0) return false;
  const text = () => fs.readFileSync(file, 'utf8');
  if (dest.endsWith('.json')) {
    try {
      JSON.parse(text());
      return true;
    } catch {
      return false;
    }
  }
  if (dest.endsWith('.jsonl')) {
    const raw = text();
    const lines = raw.split(/\n/).filter((line) => line.length > 0);
    if (lines.length === 0) return false;
    try {
      for (const line of lines) JSON.parse(line);
      return true;
    } catch {
      return false;
    }
  }
  return true;
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
    try {
      fs.rmSync(dest, { force: true });
      fs.renameSync(tmp, dest);
    } catch {
      /* 下次启动再试 */
    }
  }
}

/** 把完整的 *.tmp 提升为正式文件。残缺的 tmp 删掉。 */
export function promoteTmpTree(root: string): void {
  if (!fs.existsSync(root)) return;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(full);
      else if (name.endsWith('.tmp')) promoteOne(full);
    }
  }
}

export function promoteTmpFile(dest: string): void {
  const tmp = `${dest}.tmp`;
  if (fs.existsSync(tmp)) promoteOne(tmp);
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}
