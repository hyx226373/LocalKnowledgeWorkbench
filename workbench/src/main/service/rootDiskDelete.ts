/**
 * 把根路径移到系统回收站。只调用注入的 trashItem。
 * 失败只返回错误。不调用 fs.rm / unlink，也不回退到永久删除。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { RootDiskDeleteRequest, RootDiskDeleteResult } from '../../shared/rootTask';

const SIMULATED_FAIL = new Set(['EPERM', 'EBUSY', 'EIO']);

function refused(error: string): RootDiskDeleteResult {
  return { ok: false, opId: null, error };
}

function messageOf(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  const text = String(err ?? '').trim();
  return text || '移到回收站失败';
}

export async function runRootDiskDelete(
  req: RootDiskDeleteRequest,
  trashItem?: (absPath: string) => Promise<void>,
): Promise<RootDiskDeleteResult> {
  const abs = String(req.absPath ?? '').trim();
  if (!abs) return refused('文件夹不在原处');
  const base = path.basename(abs);
  if (!base || base === '.' || base === '..') return refused('文件夹不在原处');
  const parsed = path.parse(abs);
  if (parsed.root && (abs === parsed.root || path.resolve(abs) === parsed.root)) return refused('不能移走文件系统根');

  const simulated = process.env.KB_ROOT_DELETE_FAIL ?? '';
  if (SIMULATED_FAIL.has(simulated)) return refused(`模拟失败 ${simulated}`);

  if (!fs.existsSync(abs)) return refused('文件夹不在原处');
  if (!trashItem) return refused('无法移到回收站');
  try {
    await trashItem(abs);
  } catch (err) {
    return refused(messageOf(err));
  }
  return { ok: true, opId: null, error: null };
}
