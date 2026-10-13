/** 启动器单实例锁。独占创建；对方还活着则让开；pid 已死则覆盖。 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type LauncherLockStatus = 'acquired' | 'held';

function lockBody(pid: number, at: string): string {
  return JSON.stringify({ pid, at });
}

function readLockPid(text: string): number | null {
  try {
    const raw = JSON.parse(text) as { pid?: unknown };
    if (typeof raw.pid === 'number' && Number.isInteger(raw.pid) && raw.pid > 0) return raw.pid;
  } catch {
    /* 坏锁当成死进程，允许覆盖 */
  }
  return null;
}

/**
 * 独占创建 `{pid, at}`。
 * 文件已在且 `isAlive(pid)` 为真则返回 `held`；pid 已死或锁损坏则覆盖并返回 `acquired`。
 * `isAlive` 由调用方注入，这里不查进程表。
 */
export async function acquireLauncherLock(
  file: string,
  selfPid: number,
  isAlive: (pid: number) => boolean,
  now: () => string = () => new Date().toISOString(),
): Promise<LauncherLockStatus> {
  await mkdir(path.dirname(file), { recursive: true });
  const body = lockBody(selfPid, now());
  try {
    await writeFile(file, body, { encoding: 'utf8', flag: 'wx' });
    return 'acquired';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  let text = await readFile(file, 'utf8');
  // 对方刚独占创建、正文还没落地时会读到空文件，稍等再判，避免把活锁当成死进程覆盖掉。
  if (!text.trim()) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    text = await readFile(file, 'utf8');
  }
  const pid = readLockPid(text);
  if (pid !== null && isAlive(pid)) return 'held';
  await writeFile(file, body, 'utf8');
  return 'acquired';
}
