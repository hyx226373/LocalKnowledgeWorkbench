/** 外贴 27 冻结。current.json 只由更新器、迁移器，以及允许回退时的启动器写入。 */
import { promises as fs } from 'node:fs';
import { type AtomicIo, LayoutError, writeAtomicJson } from './atomicJson';
import { CURRENT_SCHEMA, VERSION_DIR_RE } from './names';
import { assertVersionDirName, currentFile } from './paths';

export interface CurrentPointer {
  schema: 1;
  current: string;
  previous: string | null;
  updatedAt: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

export function parseCurrent(text: string): CurrentPointer {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new LayoutError('current.json 无法解析');
  }
  if (!raw || typeof raw !== 'object') throw new LayoutError('current.json 无法解析');
  const row = raw as Record<string, unknown>;
  if (row.schema !== CURRENT_SCHEMA) throw new LayoutError('current.json schema 不是 1');
  if (typeof row.current !== 'string' || !VERSION_DIR_RE.test(row.current)) {
    throw new LayoutError('current.json 的 current 不合法');
  }
  if (row.previous !== null && (typeof row.previous !== 'string' || !VERSION_DIR_RE.test(row.previous))) {
    throw new LayoutError('current.json 的 previous 不合法');
  }
  if (row.previous === row.current) throw new LayoutError('current.json 的 previous 不能等于 current');
  if (typeof row.updatedAt !== 'string' || !ISO.test(row.updatedAt)) {
    throw new LayoutError('current.json 的 updatedAt 不合法');
  }
  return {
    schema: 1,
    current: row.current,
    previous: row.previous as string | null,
    updatedAt: row.updatedAt,
  };
}

export async function readCurrent(installRoot: string, readFile?: (file: string) => Promise<string>): Promise<CurrentPointer> {
  const file = currentFile(installRoot);
  try {
    const text = readFile ? await readFile(file) : await fs.readFile(file, 'utf8');
    return parseCurrent(text);
  } catch (err) {
    if (err instanceof LayoutError) throw err;
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new LayoutError('current.json 不存在');
    throw err;
  }
}

export async function writeCurrent(installRoot: string, pointer: CurrentPointer, io?: AtomicIo): Promise<void> {
  parseCurrent(JSON.stringify(pointer));
  await writeAtomicJson(currentFile(installRoot), pointer, io, 'current.json');
}

/** 切换到下一版。previous 记下切换前的 current。不删除目录。 */
export function pointAt(pointer: CurrentPointer, next: string, at: string): CurrentPointer {
  assertVersionDirName(next);
  if (next === pointer.current) throw new LayoutError('目标版本与当前版本相同');
  return { schema: 1, current: next, previous: pointer.current, updatedAt: at };
}

/** 与 pointAt 对调。失败的候选留在 previous，便于再试。不删除目录。 */
export function pointBack(pointer: CurrentPointer, at: string): CurrentPointer {
  if (!pointer.previous) throw new LayoutError('没有上一版可恢复');
  return { schema: 1, current: pointer.previous, previous: pointer.current, updatedAt: at };
}
