/**
 * 把根路径移入应用暂存区。调用方在拿到 ok 之后才更新任务阶段。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { RootDiskDeleteRequest, RootDiskDeleteResult } from '../../shared/rootTask';

const SIMULATED_FAIL = new Set(['EPERM', 'EBUSY', 'EIO']);

function codeOf(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return '';
}

function refused(error: string): RootDiskDeleteResult {
  return { ok: false, opId: null, error };
}

function moveError(err: unknown): string {
  const code = codeOf(err);
  if (code === 'EBUSY') return `${code} 文件占用`;
  if (code === 'EPERM' || code === 'EACCES') return `${code} 权限不足`;
  const msg = err instanceof Error ? err.message : String(err);
  return code ? `${code} ${msg}` : msg;
}

function countTree(abs: string): { files: number; bytes: number } {
  const st = fs.lstatSync(abs);
  if (!st.isDirectory()) return { files: 1, bytes: st.size };
  let files = 0;
  let bytes = 0;
  for (const name of fs.readdirSync(abs)) {
    const child = countTree(path.join(abs, name));
    files += child.files;
    bytes += child.bytes;
  }
  return { files, bytes };
}

/** 删掉半成品。uuid 目录空了才去掉，不动 staging 根。 */
function discardPartial(dst: string): void {
  try {
    fs.rmSync(dst, { recursive: true, force: true });
    const bucket = path.dirname(dst);
    if (fs.existsSync(bucket) && fs.readdirSync(bucket).length === 0) fs.rmdirSync(bucket);
  } catch {
    // 清不掉时留下，不掩盖原来的失败
  }
}

function restoreSource(src: string, dst: string): void {
  if (!fs.existsSync(dst)) return;
  if (!fs.existsSync(src)) {
    fs.renameSync(dst, src);
    return;
  }
  fs.cpSync(dst, src, { recursive: true, force: false, errorOnExist: false });
}

function rollback(src: string, dst: string): void {
  try {
    restoreSource(src, dst);
    discardPartial(dst);
  } catch {
    // 源已不完整时保留暂存副本
  }
}

/**
 * 同卷 rename。跨卷先复制，复制失败删半成品；源删不掉时把副本拷回。
 */
function moveOnto(src: string, dst: string): void {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    fs.renameSync(src, dst);
    return;
  } catch (err) {
    if (codeOf(err) !== 'EXDEV') {
      discardPartial(dst);
      throw err;
    }
  }
  try {
    fs.cpSync(src, dst, { recursive: true, preserveTimestamps: true, errorOnExist: true });
  } catch (err) {
    discardPartial(dst);
    throw err;
  }
  try {
    fs.rmSync(src, { recursive: true });
  } catch (err) {
    rollback(src, dst);
    throw err;
  }
  if (fs.existsSync(src)) {
    rollback(src, dst);
    throw Object.assign(new Error('权限不足'), { code: 'EPERM' });
  }
}

function stagingPosix(dataDir: string, abs: string): string {
  const rel = path.relative(dataDir, abs);
  const escaped = !rel || rel === '.' || rel === '..' || rel.startsWith(`..${path.sep}`) || rel.startsWith('../') || path.isAbsolute(rel);
  if (escaped) throw new Error('暂存路径不在数据目录内');
  return rel.split(path.sep).join('/');
}

export async function runRootDiskDelete(req: RootDiskDeleteRequest): Promise<RootDiskDeleteResult> {
  let kind: 'dir' | 'file';
  try {
    kind = fs.lstatSync(req.absPath).isDirectory() ? 'dir' : 'file';
  } catch (err) {
    if (codeOf(err) === 'ENOENT') return refused('文件夹不在原处');
    return refused(moveError(err));
  }

  const simulated = process.env.KB_ROOT_DELETE_FAIL ?? '';
  if (SIMULATED_FAIL.has(simulated)) return refused('模拟失败 ' + simulated);

  const base = path.basename(req.absPath);
  if (!base || base === '.' || base === '..') return refused('文件夹不在原处');

  let counted: { files: number; bytes: number };
  try {
    counted = countTree(req.absPath);
  } catch (err) {
    return refused(moveError(err));
  }

  const dst = path.join(req.stagingDir, crypto.randomUUID(), base);
  try {
    moveOnto(req.absPath, dst);
  } catch (err) {
    return refused(moveError(err));
  }

  let staging: string;
  try {
    staging = stagingPosix(req.dataDir, dst);
  } catch (err) {
    rollback(req.absPath, dst);
    return refused(moveError(err));
  }

  let opId: number;
  try {
    opId = req.record({
      staging,
      kind,
      fileCount: counted.files,
      totalBytes: counted.bytes,
      rootDelete: true,
    });
  } catch (err) {
    rollback(req.absPath, dst);
    return refused(moveError(err));
  }

  return { ok: true, opId, error: null };
}
