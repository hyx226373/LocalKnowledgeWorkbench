/** 外贴 27 冻结。各组只导入，不改这个文件。 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const ATOMIC_RENAME_ATTEMPTS = 5;
export const ATOMIC_RENAME_DELAYS_MS = [200, 400, 800, 1600] as const;

const RETRY = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST']);

export class LayoutError extends Error {
  readonly code: string;
  constructor(message: string, code = 'LAYOUT') {
    super(message);
    this.name = 'LayoutError';
    this.code = code;
  }
}

export interface AtomicIo {
  mkdir?: (dir: string) => Promise<void>;
  writeFile?: (file: string, data: string) => Promise<void>;
  readFile?: (file: string) => Promise<string>;
  rename?: (from: string, to: string) => Promise<void>;
  rm?: (target: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

function codeOf(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && code ? code : 'UNKNOWN';
}

/**
 * 先写临时文件再改名。第一次改名失败且是占用类错误时，才删除目标并按 200/400/800/1600 ms 重试。
 * 最终失败会删掉临时文件；若目标已被删掉，把改名前的原文写回去。
 */
export async function writeAtomicJson(file: string, value: unknown, io?: AtomicIo, label = 'current.json'): Promise<void> {
  const mkdir = io?.mkdir ?? ((dir: string) => fs.mkdir(dir, { recursive: true }).then(() => undefined));
  const writeFile = io?.writeFile ?? ((target: string, data: string) => fs.writeFile(target, data, 'utf8'));
  const readFile = io?.readFile ?? ((target: string) => fs.readFile(target, 'utf8'));
  const rename = io?.rename ?? ((from: string, to: string) => fs.rename(from, to));
  const rm = io?.rm ?? ((target: string) => fs.rm(target, { force: true }).then(() => undefined));
  const sleep = io?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  const readOrNull = async (): Promise<string | null> => {
    try {
      return await readFile(file);
    } catch {
      return null;
    }
  };

  const old = await readOrNull();
  await mkdir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2));

  let last = 'UNKNOWN';
  for (let attempt = 1; attempt <= ATOMIC_RENAME_ATTEMPTS; attempt++) {
    try {
      await rename(tmp, file);
      return;
    } catch (err) {
      last = codeOf(err);
      if (!RETRY.has(last) || attempt === ATOMIC_RENAME_ATTEMPTS) break;
      await rm(file).catch(() => undefined);
      await sleep(ATOMIC_RENAME_DELAYS_MS[attempt - 1] ?? 1600);
    }
  }

  await rm(tmp).catch(() => undefined);
  if ((await readOrNull()) === null && old !== null) {
    try {
      await writeFile(file, old);
    } catch (err) {
      const restore = codeOf(err);
      throw new LayoutError(
        `版本指针写入失败（${last}）。${label} 被占用，恢复原文也失败（${restore}）。`,
        last,
      );
    }
  }
  throw new LayoutError(`版本指针写入失败（${last}）。${label} 被占用，没有切换版本。`, last);
}
