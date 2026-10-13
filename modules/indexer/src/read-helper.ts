import { closeSync, fstatSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isIndexableFile, shouldSkipDirectory, toRelPath } from './paths.ts';
import type { PreReadFile } from './protocol.ts';

/** 一次打开同时拿大小、mtime 和正文。再 stat 一次会让 Windows 在约 1500 次打开后把后面的文件拖到十几秒。 */
function readIndexed(abs: string, ext: string): { size: number; mtimeMs: number; body?: string } {
  const fd = openSync(abs, 'r');
  try {
    const st = fstatSync(fd);
    const size = Number(st.size);
    const mtimeMs = Math.round(st.mtimeMs);
    if (ext !== '.txt' && ext !== '.md') return { size, mtimeMs };
    if (size <= 0) return { size, mtimeMs, body: '' };
    return { size, mtimeMs, body: readFileSync(fd, 'utf8') };
  } finally {
    closeSync(fd);
  }
}

// 只读小文件，不打开 sqlite，也不加载 pdfjs。由调用进程 fork，读完把正文送回去。
const pace = new Int32Array(new SharedArrayBuffer(4));
let paced = 0;

function walk(dir: string, root: string, skipDirNames: readonly string[], out: PreReadFile[]): void {
  let dirents;
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    out.push({
      absPath: dir,
      relPath: safeRel(root, dir),
      size: 0,
      mtimeMs: 0,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  for (const dirent of dirents) {
    if (dirent.isSymbolicLink()) continue;
    const abs = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      if (shouldSkipDirectory(dirent.name, skipDirNames)) continue;
      walk(abs, root, skipDirNames, out);
      continue;
    }
    if (!dirent.isFile()) continue;
    if (!isIndexableFile(dirent.name)) continue;
    const relPath = toRelPath(root, abs);
    const ext = path.extname(abs).toLowerCase();
    try {
      const got = readIndexed(abs, ext);
      const item: PreReadFile = {
        absPath: abs,
        relPath,
        size: got.size,
        mtimeMs: got.mtimeMs,
      };
      if (got.body !== undefined) item.body = got.body;
      out.push(item);
      paced += 1;
      // 连续打开太多小文件时，Windows 会把主线程定时器拖过 50ms。隔一段让出磁盘。
      if (paced % 80 === 0) Atomics.wait(pace, 0, 0, 15);
    } catch (err) {
      out.push({
        absPath: abs,
        relPath,
        size: 0,
        mtimeMs: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function safeRel(root: string, abs: string): string {
  try {
    return toRelPath(root, abs);
  } catch {
    return abs;
  }
}

process.on('message', (message: unknown) => {
  if (!message || typeof message !== 'object') return;
  const msg = message as { type?: string; root?: string; skipDirNames?: string[] };
  if (msg.type === 'shutdown') {
    process.disconnect?.();
    return;
  }
  if (msg.type !== 'read' || !msg.root) return;
  const files: PreReadFile[] = [];
  walk(path.resolve(msg.root), path.resolve(msg.root), msg.skipDirNames ?? [], files);
  // 不把正文经父进程 IPC 送回去。那一下结构化克隆会让主线程定时器漂过 50ms。
  const pack = path.join(os.tmpdir(), `kb-read-${process.pid}-${Date.now()}.json`);
  writeFileSync(pack, JSON.stringify(files));
  if (typeof process.send === 'function') process.send({ type: 'files', pack });
});
