import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkbenchService, type ServiceOptions } from '../src/main/service/WorkbenchService';

export function tmpDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 目录链接：Windows 上用 junction（不需要管理员/开发者模式），其他平台用普通符号链接 */
export function linkDir(target: string, link: string) {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

/** 文件符号链接：Windows 未开开发者模式/非管理员时会 EPERM，返回 false 让测试跳过（并说明原因） */
export const FILE_SYMLINK_SKIP_REASON = '本机不允许创建文件符号链接（EPERM：Windows 需要开发者模式或管理员权限），跳过';
export function tryFileSymlink(target: string, link: string): boolean {
  try {
    fs.symlinkSync(target, link, 'file');
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM' || (e as NodeJS.ErrnoException).code === 'EACCES') return false;
    throw e;
  }
}

export function write(p: string, content: string | Buffer = 'x') {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

export function makeRoot() {
  const dir = tmpDir('kbroot-');
  write(path.join(dir, '笔记/读书笔记.md'), '# 标题\n内容');
  write(path.join(dir, '笔记/待办.txt'), '待办事项');
  write(path.join(dir, '资料/论文/paper.pdf'), '%PDF-1.4 fake');
  write(path.join(dir, '资料/图片/a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  write(path.join(dir, '资料/报告.docx'), 'PK');
  return dir;
}

export async function makeService(extra: Partial<ServiceOptions> = {}) {
  const dataDir = tmpDir('kbdata-');
  const svc = new WorkbenchService({ dataDir, ...extra });
  return { svc, dataDir };
}

export async function waitFor<T>(fn: () => T | Promise<T>, ms = 8000, step = 50): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error('waitFor 超时 ' + (last ? String(last) : ''));
}
