/**
 * 在选定文件夹新建空白文本：UTF-8、零字节、无 YAML 头、无模板。
 * 同名不覆盖，依次使用「名字.md」「名字(2).md」。
 * 目标在已注册的文件夹根内时只刷新该根索引；否则按单文件来源登记。
 * 不往应用数据目录里写文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { OutOfScopeError } from '../../shared/sourceFilter';
import { blankFileCandidate, completeBlankFileName, type BlankFileCreated } from '../../shared/blankFile';
import { safeName } from '../../shared/rebirth';
import { toRelPath } from './paths';
import type { FsEvent } from './indexer';
import type { WorkbenchService } from './WorkbenchService';

export interface BlankFileRequest {
  dir: string;
  name: string;
  ext: string;
}

export interface CreateFileRequest {
  dir: string;
  name: string;
  ext?: string;
  content: string;
}

const MAX_TRIES = 999;

export async function createFileWithContent(svc: WorkbenchService, input: CreateFileRequest): Promise<BlankFileCreated> {
  const named = completeBlankFileName(input?.name, input?.ext ?? 'md');
  const dirReal = resolveBlankDir(svc, input?.dir);
  const written = writeUniqueFileWithContent(dirReal, named.stem, named.ext, input?.content ?? '');
  try {
    const host = folderHost(svc, dirReal);
    if (host) return await indexInsideRoot(svc, host, written.abs, written.name);
    return await registerOutside(svc, written.abs, written.name);
  } catch (err) {
    if (err instanceof OutOfScopeError) {
      try { fs.unlinkSync(written.abs); } catch { /* 删不掉就留在磁盘，错误里仍说明未入库 */ }
    }
    throw err;
  }
}

export async function createBlankFile(svc: WorkbenchService, input: BlankFileRequest): Promise<BlankFileCreated> {
  return createFileWithContent(svc, { dir: input?.dir, name: input?.name, ext: input?.ext, content: '' });
}

export async function exportRebirthToRoot(
  repo: {
    file(id: string): string;
    read(id: string): { meta: { no: number; title: string } };
    generate(id: string): { text: string };
  },
  svc: WorkbenchService,
  input: { id: string; dir: string; name?: string },
): Promise<BlankFileCreated> {
  repo.file(input.id);
  const d = repo.read(input.id);
  const defaultName = `R${d.meta.no}-${safeName(d.meta.title)}.md`;
  const name = input.name?.trim() ? input.name.trim() : defaultName;
  const content = repo.generate(input.id).text;
  return await createFileWithContent(svc, {
    dir: input.dir,
    name,
    ext: 'md',
    content,
  });
}

export function resolveTargetDir(dataDir: string, dir: string): string {
  const abs = path.resolve(String(dir ?? '').trim());
  if (!abs) throw new Error('请选择文件夹');
  let real: string;
  try {
    real = fs.realpathSync.native(abs);
  } catch {
    throw new Error('文件夹不存在');
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(real);
  } catch {
    throw new Error('文件夹不存在');
  }
  if (!st.isDirectory()) throw new Error('不是文件夹');
  const dataReal = fs.realpathSync.native(dataDir);
  if (toRelPath(dataReal, real) !== null) throw new Error('不能在应用数据目录里新建文件');
  return real;
}

export function resolveBlankDir(svc: WorkbenchService, dir: string): string {
  return resolveTargetDir(svc.dataDir, dir);
}

/** 独占创建。已有同名文件或目录都跳过，绝不覆盖。 */
export function writeUniqueFileWithContent(dir: string, stem: string, ext: 'md' | 'txt', content: string): { name: string; abs: string } {
  for (let n = 1; n <= MAX_TRIES; n++) {
    const name = blankFileCandidate(stem, ext, n);
    const abs = path.join(dir, name);
    try {
      fs.writeFileSync(abs, content, { encoding: 'utf8', flag: 'wx' });
      return { name, abs };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'EISDIR') continue;
      throw err;
    }
  }
  throw new Error('同名文件过多');
}

function writeUniqueBlank(dir: string, stem: string, ext: 'md' | 'txt'): { name: string; abs: string } {
  return writeUniqueFileWithContent(dir, stem, ext, '');
}

function folderHost(svc: WorkbenchService, dirReal: string): { id: string; resourceId: string; path: string } | null {
  let best: { id: string; resourceId: string; path: string; len: number } | null = null;
  for (const root of svc.listRoots()) {
    if (root.kind === 'file' || root.status !== 'ok' || !root.path) continue;
    let rootReal: string;
    try {
      rootReal = fs.realpathSync.native(root.path);
    } catch {
      continue;
    }
    if (toRelPath(rootReal, dirReal) === null) continue;
    if (!best || rootReal.length > best.len) best = { id: root.id, resourceId: root.resourceId, path: root.path, len: rootReal.length };
  }
  return best ? { id: best.id, resourceId: best.resourceId, path: best.path } : null;
}

export async function indexInsideRoot(
  svc: WorkbenchService,
  host: { id: string; resourceId: string; path: string },
  abs: string,
  name: string,
): Promise<BlankFileCreated> {
  const rootReal = fs.realpathSync.native(host.path);
  const fileReal = fs.realpathSync.native(abs);
  const rel = toRelPath(rootReal, fileReal);
  if (!rel) throw new Error('无法确定文件在根目录中的位置');
  const resourceId = svc.resourceIdFor(host.id, rel);
  const events: FsEvent[] = [];
  const parts = rel.split('/').filter(Boolean);
  let acc = '';
  for (let i = 0; i < parts.length - 1; i++) {
    acc = acc ? `${acc}/${parts[i]}` : parts[i];
    events.push({ type: 'addDir', relPath: acc });
  }
  events.push({ type: 'add', relPath: rel });
  await svc.applyFsEvents(host.id, events);
  return {
    resourceId,
    rootId: host.id,
    name,
    absPath: abs,
    placed: 'indexed',
    expandIds: expandChain(svc, host.id, host.resourceId, rel),
  };
}

function expandChain(svc: WorkbenchService, rootId: string, rootResourceId: string, rel: string): string[] {
  const ids: string[] = [];
  const rootKey = rootResourceId || safeResourceId(svc, rootId, '');
  if (rootKey) ids.push(rootKey);
  const parts = rel.split('/').filter(Boolean);
  let acc = '';
  for (let i = 0; i < parts.length - 1; i++) {
    acc = acc ? `${acc}/${parts[i]}` : parts[i];
    const id = safeResourceId(svc, rootId, acc);
    if (id) ids.push(id);
  }
  return ids;
}

function safeResourceId(svc: WorkbenchService, rootId: string, rel: string): string {
  try {
    return svc.resourceIdFor(rootId, rel);
  } catch {
    return '';
  }
}

export async function registerOutside(svc: WorkbenchService, abs: string, name: string): Promise<BlankFileCreated> {
  const added = svc.addFileSource(abs);
  if (added.alias) {
    const info = svc.getResource(added.resourceId);
    const rel = info?.relPath ?? '';
    if (rel) await svc.applyFsEvents(added.id, [{ type: 'add', relPath: rel }]);
    return {
      resourceId: added.resourceId,
      rootId: added.id,
      name: info?.name || name,
      absPath: abs,
      placed: 'indexed',
      expandIds: expandChain(svc, added.id, '', rel),
    };
  }
  return {
    resourceId: added.resourceId,
    rootId: added.id,
    name,
    absPath: abs,
    placed: 'source',
    expandIds: added.resourceId ? [added.resourceId] : [],
  };
}
