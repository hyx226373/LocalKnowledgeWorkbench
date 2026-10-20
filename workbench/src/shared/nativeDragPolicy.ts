/**
 * 原生拖出的纯逻辑（不依赖 Electron）。
 *
 * 文件模式：dragstart 里 preventDefault 后，主进程在同一条 IPC 里调用
 * webContents.startDrag。这里只决定路径能不能交给 startDrag。
 * 路径模式只记 text/plain，不调用 startDrag。
 *
 * 通过条件：路径存在，并且
 * - 是文件：词法上落在已登记根里，realpath 也仍在该根里（不跟随越根符号链接），或与允许列表中的绝对路径相同；
 * - 是目录：词法和 realpath 都落在已登记根里（根目录本身可以）。精确文件允许列表不能放行根外目录。
 * Windows 用大小写不敏感的前缀比较，且要求分隔符，避免 Root 匹配 Root2。
 */
import path from 'node:path';

export const NATIVE_DRAG_LOG_CAP = 32;
export const NATIVE_DRAG_MAX_FILES = 64;
export const NATIVE_DRAG_START_CHANNEL = 'kb:native-drag-start';
export const NATIVE_DRAG_ENDED_CHANNEL = 'kb:native-drag-ended';

export type PathLib = Pick<typeof path, 'resolve' | 'isAbsolute' | 'sep'>;

export interface NativeDragStat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** lstat 不跟随最后一段；realpath 跟随全部符号链接。缺失返回 null。 */
export interface NativeDragFs {
  lstat(filePath: string): NativeDragStat | null;
  realpath(filePath: string): string | null;
}

export interface NativeDragAllow {
  /** 目录根。文件型来源不要放这里，否则 `file.txt` 会变成 `file.txt\` 的前缀。 */
  roots: readonly string[];
  /** 精确文件：单文件来源、当前打开的文件、工作资料、Agent 资料。 */
  files: readonly string[];
}

export interface NativeDragResult {
  ok: boolean;
  reason?: string;
  paths: string[];
}

export type NativeDragMode = 'file' | 'path';

export interface NativeDragLogEntry {
  paths: string[];
  ok: boolean;
  reason?: string;
  at: number;
  /** 文件：交给 startDrag。路径：只记 text/plain，不调用 startDrag。缺省是旧记录。 */
  mode?: NativeDragMode;
}

export interface NativeDragCatalog {
  rootsToWatch(): { path?: string; kind?: string }[];
  currentWorkspaceId(): string | null;
  openFileResourceIds(workspaceId: string): string[];
  workspaceFileResourceIds(workspaceId: string): string[];
  resourceAbsPath(resourceId: string): string | null;
  agentFilePaths(workspaceId: string): string[];
}

export function isPathInsideRoot(target: string, root: string, pathLib: PathLib, caseInsensitive: boolean): boolean {
  const norm = (value: string) => {
    const resolved = pathLib.resolve(value);
    return caseInsensitive ? resolved.toLowerCase() : resolved;
  };
  const file = norm(target);
  const base = norm(root);
  if (file === base) return true;
  const prefix = base.endsWith(pathLib.sep) ? base : base + pathLib.sep;
  return file.startsWith(prefix);
}

function samePath(a: string, b: string, pathLib: PathLib, caseInsensitive: boolean): boolean {
  const left = pathLib.resolve(a);
  const right = pathLib.resolve(b);
  return caseInsensitive ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function uniqueStrings(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function allowListFromCatalog(catalog: NativeDragCatalog): NativeDragAllow {
  const roots: string[] = [];
  const files: string[] = [];
  for (const root of catalog.rootsToWatch()) {
    const rootPath = typeof root.path === 'string' ? root.path.trim() : '';
    if (!rootPath) continue;
    if (root.kind === 'file') files.push(rootPath);
    else roots.push(rootPath);
  }
  const workspaceId = catalog.currentWorkspaceId();
  if (workspaceId) {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const id of [...catalog.openFileResourceIds(workspaceId), ...catalog.workspaceFileResourceIds(workspaceId)]) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    for (const id of ids) {
      const abs = catalog.resourceAbsPath(id);
      if (typeof abs === 'string' && abs.trim()) files.push(abs.trim());
    }
    for (const abs of catalog.agentFilePaths(workspaceId)) {
      if (typeof abs === 'string' && abs.trim()) files.push(abs.trim());
    }
  }
  return { roots: uniqueStrings(roots), files: uniqueStrings(files) };
}

function matchesAllowed(filePath: string, allow: NativeDragAllow, pathLib: PathLib, caseInsensitive: boolean): boolean {
  return allow.files.some((item) => samePath(filePath, item, pathLib, caseInsensitive));
}

function insideRoots(filePath: string, allow: NativeDragAllow, pathLib: PathLib, caseInsensitive: boolean): boolean {
  return allow.roots.some((root) => isPathInsideRoot(filePath, root, pathLib, caseInsensitive));
}

function insideRealRoots(
  real: string,
  allow: NativeDragAllow,
  fs: NativeDragFs,
  pathLib: PathLib,
  caseInsensitive: boolean,
): boolean {
  return allow.roots.some((root) => {
    const rootReal = fs.realpath(root);
    if (rootReal && isPathInsideRoot(real, rootReal, pathLib, caseInsensitive)) return true;
    return isPathInsideRoot(real, root, pathLib, caseInsensitive);
  });
}

/** 单个路径。返回 null 表示可以拖出。 */
export function rejectNativeDragPath(
  raw: string,
  allow: NativeDragAllow,
  fs: NativeDragFs,
  pathLib: PathLib,
  caseInsensitive: boolean,
): string | null {
  if (typeof raw !== 'string' || !raw.trim() || raw.includes('\0')) return 'invalid';
  const trimmed = raw.trim();
  if (!pathLib.isAbsolute(trimmed)) return 'invalid';
  let resolved: string;
  try {
    resolved = pathLib.resolve(trimmed);
  } catch {
    return 'invalid';
  }
  const stat = fs.lstat(resolved);
  if (!stat) return 'not-found';
  const lexicalInside = insideRoots(resolved, allow, pathLib, caseInsensitive);
  const lexicalAllowed = matchesAllowed(resolved, allow, pathLib, caseInsensitive);
  const real = fs.realpath(resolved);
  if (stat.isSymbolicLink()) {
    if (!real) return 'not-found';
    const realInside = insideRealRoots(real, allow, fs, pathLib, caseInsensitive);
    if (lexicalInside && !realInside) return 'symlink-escape';
    if (!lexicalInside && !lexicalAllowed) return 'outside-root';
    if (!lexicalInside && lexicalAllowed && !realInside && !samePath(real, resolved, pathLib, caseInsensitive)) {
      if (!matchesAllowed(real, allow, pathLib, caseInsensitive)) return 'symlink-escape';
    }
    const realStat = fs.lstat(real);
    if (!realStat || realStat.isSymbolicLink()) return 'not-found';
    if (realStat.isDirectory()) {
      if (!lexicalInside) return 'outside-root';
      if (!realInside) return 'symlink-escape';
      return null;
    }
    if (!realStat.isFile()) return 'not-file';
    if (!realInside && !lexicalAllowed && !matchesAllowed(real, allow, pathLib, caseInsensitive)) return 'symlink-escape';
    return null;
  }
  if (stat.isDirectory()) {
    if (!lexicalInside) return 'outside-root';
    if (real && !samePath(real, resolved, pathLib, caseInsensitive)) {
      if (!insideRealRoots(real, allow, fs, pathLib, caseInsensitive)) return 'symlink-escape';
    }
    return null;
  }
  if (!stat.isFile()) return 'not-file';
  if (real && !samePath(real, resolved, pathLib, caseInsensitive)) {
    const realInside = insideRealRoots(real, allow, fs, pathLib, caseInsensitive);
    if ((lexicalInside || lexicalAllowed) && !realInside) return 'symlink-escape';
  }
  if (!lexicalInside && !lexicalAllowed) return 'outside-root';
  return null;
}

function normalizeRequest(requested: unknown): { paths: string[]; reason?: string } {
  if (!Array.isArray(requested)) return { paths: [], reason: 'invalid' };
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const item of requested) {
    if (typeof item !== 'string') return { paths, reason: 'invalid' };
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    paths.push(trimmed);
    if (paths.length > NATIVE_DRAG_MAX_FILES) return { paths, reason: 'too-many' };
  }
  if (!paths.length) return { paths: [], reason: 'empty' };
  return { paths };
}

export interface PerformNativeDragDeps {
  requested: unknown;
  allow: NativeDragAllow;
  fs: NativeDragFs;
  pathLib: PathLib;
  caseInsensitive: boolean;
  startDrag: (paths: string[]) => void;
  log: { push(entry: NativeDragLogEntry): void };
  now?: () => number;
  /** 缺省按文件拖出。path 只记日志，不调用 startDrag。 */
  mode?: NativeDragMode;
}

export function performNativeDrag(deps: PerformNativeDragDeps): NativeDragResult {
  const now = deps.now ?? Date.now;
  const mode = deps.mode;
  const push = (entry: NativeDragLogEntry) => {
    const row: NativeDragLogEntry = mode === 'file' || mode === 'path' ? { ...entry, mode } : entry;
    deps.log.push(row);
  };
  const normalized = normalizeRequest(deps.requested);
  if (mode === 'path') {
    if (normalized.reason) {
      push({ paths: normalized.paths, ok: false, reason: normalized.reason, at: now() });
      return { ok: false, reason: normalized.reason, paths: normalized.paths };
    }
    push({ paths: normalized.paths, ok: true, at: now() });
    return { ok: true, paths: normalized.paths };
  }
  if (normalized.reason) {
    push({ paths: normalized.paths, ok: false, reason: normalized.reason, at: now() });
    return { ok: false, reason: normalized.reason, paths: normalized.paths };
  }
  const resolved: string[] = [];
  for (const item of normalized.paths) {
    const reason = rejectNativeDragPath(item, deps.allow, deps.fs, deps.pathLib, deps.caseInsensitive);
    if (reason) {
      push({ paths: normalized.paths, ok: false, reason, at: now() });
      return { ok: false, reason, paths: normalized.paths };
    }
    resolved.push(deps.pathLib.resolve(item.trim()));
  }
  try {
    deps.startDrag(resolved);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const reason = message === 'no-window' ? 'no-window' : message.startsWith('start-failed') ? message : `start-failed: ${message}`;
    push({ paths: resolved, ok: false, reason, at: now() });
    return { ok: false, reason, paths: resolved };
  }
  push({ paths: resolved, ok: true, at: now() });
  return { ok: true, paths: resolved };
}

export function createNativeDragLog(cap = NATIVE_DRAG_LOG_CAP) {
  const rows: NativeDragLogEntry[] = [];
  return {
    push(entry: NativeDragLogEntry) {
      const row: NativeDragLogEntry = { paths: entry.paths.slice(), ok: entry.ok, at: entry.at };
      if (entry.reason) row.reason = entry.reason;
      if (entry.mode === 'file' || entry.mode === 'path') row.mode = entry.mode;
      rows.push(row);
      while (rows.length > cap) rows.shift();
    },
    read(): NativeDragLogEntry[] {
      return rows.map((row) => ({ ...row, paths: row.paths.slice() }));
    },
  };
}

export function createNativeDragController(deps: {
  fs: NativeDragFs;
  pathLib: PathLib;
  caseInsensitive: boolean;
  startDrag: (paths: string[]) => void;
  now?: () => number;
}) {
  const log = createNativeDragLog();
  let allow: NativeDragAllow = { roots: [], files: [] };
  return {
    setAllow(next: NativeDragAllow) {
      allow = {
        roots: next.roots.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()),
        files: next.files.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()),
      };
    },
    allow(): NativeDragAllow {
      return { roots: allow.roots.slice(), files: allow.files.slice() };
    },
    start(requested: unknown, mode: NativeDragMode = 'file'): NativeDragResult {
      return performNativeDrag({ ...deps, requested, allow, log, mode });
    },
    /** 这一次用调用方的 startDrag（IPC 里是 event.sender.startDrag），仍走同一份允许列表和日志环。 */
    startUsing(requested: unknown, mode: NativeDragMode, startDrag: (paths: string[]) => void): NativeDragResult {
      return performNativeDrag({ ...deps, requested, allow, log, mode, startDrag });
    },
    /** 还没调用 startDrag 就拒绝。错误窗口、错误发送方走这里。 */
    deny(requested: unknown, reason: string): NativeDragResult {
      const paths = Array.isArray(requested)
        ? requested.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()).slice(0, NATIVE_DRAG_MAX_FILES)
        : [];
      const at = deps.now ? deps.now() : Date.now();
      log.push({ paths, ok: false, reason, at });
      return { ok: false, reason, paths };
    },
    readLog(): NativeDragLogEntry[] {
      return log.read();
    },
  };
}
