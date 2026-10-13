import { writeFileSync } from 'node:fs';
import { disk } from './disk.ts';
import os from 'node:os';
import path from 'node:path';
import { isIndexableFile, shouldSkipDirectory, toRelPath } from './paths.ts';
import type { PreReadFile } from './protocol.ts';

/** 只拿大小和 mtime。正文留给确认有变化之后再读，避免无变化重启把全部 md/txt 读进临时 json。 */
function readIndexed(abs: string): { size: number; mtimeMs: number } {
  const fd = disk.openSync(abs, 'r');
  try {
    const st = disk.fstatSync(fd);
    return { size: Number(st.size), mtimeMs: Math.round(st.mtimeMs) };
  } finally {
    disk.closeSync(fd);
  }
}

// 只读小文件，不打开 sqlite，也不加载 pdfjs。由调用进程 fork，读完把正文送回去。
const pace = new Int32Array(new SharedArrayBuffer(4));
let paced = 0;

function walk(dir: string, root: string, skipDirNames: readonly string[], out: PreReadFile[]): void {
  let dirents;
  try {
    dirents = disk.readdirSync(dir, { withFileTypes: true });
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
    try {
      const got = readIndexed(abs);
      const item: PreReadFile = {
        absPath: abs,
        relPath,
        size: got.size,
        mtimeMs: got.mtimeMs,
      };
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

type ReadMsg = { type?: string; root?: string; skipDirNames?: string[] };

function reply(message: unknown): void {
  const epp = (process as NodeJS.Process & { parentPort?: { postMessage(m: unknown): void } }).parentPort;
  if (typeof process.send === 'function') {
    process.send(message);
    return;
  }
  if (epp && typeof epp.postMessage === 'function') {
    epp.postMessage(message);
    return;
  }
}

function onParentMessage(handler: (message: unknown) => void): void {
  const epp = (process as NodeJS.Process & { parentPort?: { on(e: string, cb: (ev: { data: unknown }) => void): void } }).parentPort;
  if (epp && typeof process.send !== 'function') {
    epp.on('message', (ev) => handler(ev?.data));
    return;
  }
  process.on('message', handler);
}

onParentMessage((message: unknown) => {
  if (!message || typeof message !== 'object') return;
  const msg = message as ReadMsg;
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
  reply({ type: 'files', pack });
});
