/**
 * 资料根目录的文件名树。只 readdir / lstat，不读文件正文，不跟随符号链接或 junction。
 * 调用方把结果放进 EntryScene.structure，并写入 snapshot.json 的 libraryTree。
 */
import type { Dirent, Stats } from 'node:fs';
import path from 'node:path';
import { readerTypeOf } from '../../../shared/types';
import { diskPromises } from '../../service/disk';
import { isIgnoredName } from '../../service/indexer';
import { extOf } from '../../service/paths';
import type { EntryTreeNode } from './docs';
import { isSecretPath } from './text';

/** 根下最多这么多层。根本身不算一层。 */
export const LIBRARY_TREE_MAX_DEPTH = 6;
/** 全部根加起来的节点数，含每个根节点。 */
export const LIBRARY_TREE_MAX_ENTRIES = 5000;
/** 根目录增删改名后刷新入口的防抖。 */
export const LIBRARY_TREE_REFRESH_MS = 1500;

/** 与侧栏偏好里的字段同名。缺省、缺失或类型不对时视为开。 */
export const HIDE_UNOPENABLE_FILES_KEY = 'hideUnopenableFiles';

export type LibraryTreeTruncation = 'depth' | 'entries' | 'depth+entries';

export interface LibraryTreeNode {
  name: string;
  kind: 'dir' | 'file';
  relPath: string;
  children?: LibraryTreeNode[];
  truncated?: true;
  /** 本机真实绝对路径。资料根 path.resolve 后再 path.join 相对路径，用系统分隔符，不越出该根。 */
  path: string;
}

export interface LibraryTreeError {
  path: string;
  message: string;
}

export interface LibraryTreeSnapshot {
  hideUnopenableFiles: boolean;
  maxDepth: number;
  maxEntries: number;
  roots: LibraryTreeNode[];
  truncated?: true;
  truncatedReason?: LibraryTreeTruncation;
  errors?: LibraryTreeError[];
}

export interface LibraryRootInput {
  name: string;
  path: string;
  kind?: 'folder' | 'file';
  status?: 'ok' | 'missing';
}

export interface LibraryTreeIO {
  readdir(dir: string): Promise<Dirent[]>;
  lstat(file: string): Promise<Stats>;
}

export interface CollectLibraryTreeOptions {
  hideUnopenableFiles?: boolean;
  maxDepth?: number;
  maxEntries?: number;
  /** 开着「隐藏无法打开的文件」时用。缺省走 readerTypeOf，与内置阅读器分类一致。 */
  canOpenFile?: (name: string) => boolean;
  io?: LibraryTreeIO;
}

interface Budget {
  count: number;
  depth: boolean;
  entries: boolean;
  errors: LibraryTreeError[];
}

interface ListedChild {
  name: string;
  abs: string;
  rel: string;
  isDir: boolean;
}

const defaultIo: LibraryTreeIO = {
  readdir: (dir) => diskPromises.readdir(dir, { withFileTypes: true }) as Promise<Dirent[]>,
  lstat: (file) => diskPromises.lstat(file),
};

/** 侧栏「隐藏无法打开的文件」。raw 是 kb.sidebar.ui 的对象；默认开。 */
export function hideUnopenableFilesEnabled(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return true;
  const value = (raw as { hideUnopenableFiles?: unknown }).hideUnopenableFiles;
  return typeof value === 'boolean' ? value : true;
}

/** 与主进程资料分类相同：readerTypeOf 不是 unsupported 才算打得开。不读正文。 */
export function fileCanOpen(name: string): boolean {
  return readerTypeOf(extOf(name), 'file') !== 'unsupported';
}

function errMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
    if (err instanceof Error && err.message) return err.message;
  }
  return 'read-failed';
}

function joinRel(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/**
 * 资料根的真实绝对路径拼上相对路径（段以 / 分隔）。
 * path.join 保留本机分隔符。拼完必须仍在根内，否则返回 null。
 */
function pathUnderRoot(rootAbs: string, rel: string): string | null {
  if (!path.isAbsolute(rootAbs)) return null;
  const parts = rel ? rel.split('/') : [];
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0'))) {
    return null;
  }
  const joined = parts.length ? path.join(rootAbs, ...parts) : rootAbs;
  const back = path.relative(rootAbs, joined);
  if (rel && !back) return null;
  if (path.isAbsolute(back)) return null;
  if (back.split(path.sep).includes('..')) return null;
  return joined;
}

function badName(name: string): boolean {
  return !name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0');
}

function compareChild(a: ListedChild, b: ListedChild): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  return a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
}

export function libraryTreeToEntryNodes(tree: LibraryTreeSnapshot): EntryTreeNode[] {
  const mapNode = (node: LibraryTreeNode): EntryTreeNode => ({
    name: node.name,
    kind: node.kind,
    ...(node.relPath ? { relPath: node.relPath } : {}),
    ...(node.path ? { path: node.path } : {}),
    ...(node.truncated ? { truncated: true } : {}),
    ...(node.children?.length ? { children: node.children.map(mapNode) } : {}),
  });
  return tree.roots.map(mapNode);
}

/** 判断已发布的资料树要不要重写。含节点路径，根挪了位置也会更新。不含文件正文。 */
export function libraryTreeSignature(tree: LibraryTreeSnapshot): string {
  return JSON.stringify({
    hideUnopenableFiles: tree.hideUnopenableFiles,
    truncatedReason: tree.truncatedReason ?? null,
    roots: tree.roots,
    errors: tree.errors ?? [],
  });
}

/**
 * 根目录列表变化后防抖调用 refresh。subscribe 返回取消订阅。
 * 返回值卸掉订阅并清掉尚未触发的定时器。
 */
export function createLibraryTreeRefresh(opts: {
  subscribe: (listener: () => void) => () => void;
  refresh: () => void;
  debounceMs?: number;
}): () => void {
  const wait = opts.debounceMs ?? LIBRARY_TREE_REFRESH_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onChange = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      opts.refresh();
    }, wait);
  };
  const unsubscribe = opts.subscribe(onChange);
  return () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    unsubscribe();
  };
}

export async function collectLibraryTree(
  roots: readonly LibraryRootInput[],
  opts: CollectLibraryTreeOptions = {},
): Promise<LibraryTreeSnapshot> {
  const hide = opts.hideUnopenableFiles !== false;
  const maxDepth = opts.maxDepth ?? LIBRARY_TREE_MAX_DEPTH;
  const maxEntries = opts.maxEntries ?? LIBRARY_TREE_MAX_ENTRIES;
  const canOpen = opts.canOpenFile ?? fileCanOpen;
  const io = opts.io ?? defaultIo;
  const budget: Budget = { count: 0, depth: false, entries: false, errors: [] };

  async function classify(rootAbs: string, parentRel: string, ent: Dirent): Promise<ListedChild | null> {
    if (badName(ent.name) || ent.isSymbolicLink() || isIgnoredName(ent.name)) return null;
    // 隐藏目录不 lstat。junction 若被 Dirent 报成目录，仍要等 lstat 再丢掉。
    if (ent.isDirectory() && ent.name.startsWith('.')) return null;
    const rel = joinRel(parentRel, ent.name);
    const abs = pathUnderRoot(rootAbs, rel);
    if (!abs) return null;
    let st: Stats;
    try {
      st = await io.lstat(abs);
    } catch (err) {
      budget.errors.push({ path: rel, message: errMessage(err) });
      return null;
    }
    // junction 在 Windows 上 lstat 也是符号链接。这里不跟着走进去。
    if (st.isSymbolicLink()) return null;
    const isDir = st.isDirectory();
    if (!isDir && !st.isFile()) return null;
    if (isDir && ent.name.startsWith('.')) return null;
    if (!isDir && (isSecretPath(ent.name) || (hide && !canOpen(ent.name)))) return null;
    return { name: ent.name, abs, rel, isDir };
  }

  async function readChildren(rootAbs: string, abs: string, parentRel: string): Promise<ListedChild[]> {
    let dirents: Dirent[];
    try {
      dirents = await io.readdir(abs);
    } catch (err) {
      budget.errors.push({ path: parentRel || '.', message: errMessage(err) });
      return [];
    }
    const out: ListedChild[] = [];
    for (const ent of dirents) {
      const child = await classify(rootAbs, parentRel, ent);
      if (child) out.push(child);
    }
    out.sort(compareChild);
    return out;
  }

  async function hasListableChild(rootAbs: string, abs: string, parentRel: string): Promise<boolean> {
    let dirents: Dirent[];
    try {
      dirents = await io.readdir(abs);
    } catch (err) {
      budget.errors.push({ path: parentRel || '.', message: errMessage(err) });
      return false;
    }
    for (const ent of dirents) {
      if (await classify(rootAbs, parentRel, ent)) return true;
    }
    return false;
  }

  async function walk(rootAbs: string, abs: string, parentRel: string, depth: number): Promise<{ nodes: LibraryTreeNode[]; truncated: boolean }> {
    const children = await readChildren(rootAbs, abs, parentRel);
    const nodes: LibraryTreeNode[] = [];
    let truncated = false;
    for (let i = 0; i < children.length; i += 1) {
      const item = children[i]!;
      if (budget.count >= maxEntries) {
        budget.entries = true;
        truncated = true;
        break;
      }
      budget.count += 1;
      if (item.isDir && depth >= maxDepth) {
        const more = await hasListableChild(rootAbs, item.abs, item.rel);
        if (more) budget.depth = true;
        nodes.push({
          name: item.name,
          kind: 'dir',
          relPath: item.rel,
          ...(more ? { truncated: true as const } : {}),
          path: item.abs,
        });
        continue;
      }
      if (item.isDir) {
        const nested = await walk(rootAbs, item.abs, item.rel, depth + 1);
        nodes.push({
          name: item.name,
          kind: 'dir',
          relPath: item.rel,
          ...(nested.nodes.length ? { children: nested.nodes } : {}),
          ...(nested.truncated ? { truncated: true as const } : {}),
          path: item.abs,
        });
        // 预算在子目录里用尽时，后面的兄弟没列出来，截断标在这一层。
        if (budget.entries && i < children.length - 1) truncated = true;
        if (budget.entries) break;
        continue;
      }
      nodes.push({ name: item.name, kind: 'file', relPath: item.rel, path: item.abs });
    }
    return { nodes, truncated };
  }

  const listed: LibraryTreeNode[] = [];
  for (const root of roots) {
    if (budget.entries) break;
    const label = root.name || (root.path ? path.basename(root.path) : '.');
    if (!root.path) {
      budget.errors.push({ path: label, message: 'missing' });
      continue;
    }
    const rootAbs = path.resolve(root.path);
    let st: Stats;
    try {
      st = await io.lstat(rootAbs);
    } catch (err) {
      budget.errors.push({ path: label, message: errMessage(err) });
      continue;
    }
    if (st.isSymbolicLink()) {
      budget.errors.push({ path: label, message: 'symlink' });
      continue;
    }
    if (!st.isDirectory()) {
      const base = path.basename(rootAbs);
      if (isSecretPath(base) || isSecretPath(label)) continue;
      if (hide && !canOpen(base)) continue;
      if (!st.isFile()) {
        budget.errors.push({ path: label, message: 'not-a-file' });
        continue;
      }
      if (budget.count >= maxEntries) {
        budget.entries = true;
        break;
      }
      budget.count += 1;
      listed.push({ name: label, kind: 'file', relPath: base, path: rootAbs });
      continue;
    }
    if (budget.count >= maxEntries) {
      budget.entries = true;
      break;
    }
    budget.count += 1;
    const nested = await walk(rootAbs, rootAbs, '', 1);
    listed.push({
      name: label,
      kind: 'dir',
      relPath: '',
      ...(nested.nodes.length ? { children: nested.nodes } : {}),
      ...(nested.truncated ? { truncated: true as const } : {}),
      path: rootAbs,
    });
  }

  const truncatedReason: LibraryTreeTruncation | undefined =
    budget.depth && budget.entries ? 'depth+entries' : budget.depth ? 'depth' : budget.entries ? 'entries' : undefined;
  return {
    hideUnopenableFiles: hide,
    maxDepth,
    maxEntries,
    roots: listed,
    ...(truncatedReason ? { truncated: true as const, truncatedReason } : {}),
    ...(budget.errors.length ? { errors: budget.errors } : {}),
  };
}
