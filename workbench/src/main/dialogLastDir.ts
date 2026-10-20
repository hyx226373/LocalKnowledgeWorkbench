/**
 * 各文件选择入口记住上次所在目录。
 * 不写 layout：WorkbenchService.setLayout 会拒绝绝对路径。
 * 落在 userData/dialog-last-dir.json，先写临时文件再 rename。
 * 打开时把还在的目录放进 defaultPath；逐级往上都不在则不传，交给系统默认。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { BrowserWindow, OpenDialogOptions, OpenDialogReturnValue, SaveDialogOptions, SaveDialogReturnValue } from 'electron';
import { DIALOG_LAST_DIR } from '../shared/dialogLastDir';

export { DIALOG_LAST_DIR };
export const DIALOG_LAST_DIR_FILE = 'dialog-last-dir.json';

const PREFIX = 'dialogLastDir.';

export type DialogWindow = Pick<BrowserWindow, 'isDestroyed'>;

export interface DialogLastDirStore {
  get(key: string): string | null;
  set(key: string, dir: string): void;
}

export interface DialogLastDirDeps {
  store: DialogLastDirStore;
  isDir(abs: string): boolean;
  showOpenDialog(win: DialogWindow | null, options: OpenDialogOptions): Promise<OpenDialogReturnValue>;
  showSaveDialog(win: DialogWindow | null, options: SaveDialogOptions): Promise<SaveDialogReturnValue>;
}

type PathApi = typeof path.win32;

export function pathPlatform(value: string): 'win32' | 'posix' {
  const text = value.trim();
  if (/^[A-Za-z]:[\\/]/.test(text) || text.startsWith('\\\\') || text.startsWith('//')) return 'win32';
  return 'posix';
}

function pathApi(value: string): PathApi {
  return pathPlatform(value) === 'win32' ? path.win32 : path.posix;
}

export function dialogKeySlug(text: string): string {
  let out = '';
  for (const ch of text.trim()) {
    if (/[A-Za-z0-9]/.test(ch)) out += ch;
    else if (ch === '.' || ch === '_' || ch === '-') out += ch;
    else out += `u${ch.codePointAt(0)!.toString(16)}`;
    if (out.length >= 80) break;
  }
  return out.slice(0, 80) || 'default';
}

/** 统一成 dialogLastDir.*。缺前缀会补上，非法字符不会变成路径。 */
export function normalizeDialogKey(key: string): string {
  const trimmed = String(key ?? '').trim();
  const body = trimmed.startsWith(PREFIX) ? trimmed.slice(PREFIX.length) : trimmed;
  return `${PREFIX}${dialogKeySlug(body)}`;
}

const ASK_TITLES: Record<string, string> = {
  '选择插件文件夹（包含 manifest.json 与打包后的 main）': DIALOG_LAST_DIR.pluginFolder,
  '选择主题包文件夹（包含 theme.json）': DIALOG_LAST_DIR.themePack,
  '导入工作区布局': DIALOG_LAST_DIR.importWorkspace,
  '导出工作区布局': DIALOG_LAST_DIR.exportWorkspace,
};

/** 主进程 answerAsk 用。显式 dialogKey 优先，否则按标题区分入口。 */
export function askDialogKey(method: string, title: string, explicit?: string): string {
  if (explicit?.trim()) return normalizeDialogKey(explicit);
  const known = ASK_TITLES[title];
  if (known) return known;
  const suffix = title.trim() ? dialogKeySlug(title) : 'default';
  return normalizeDialogKey(`${method || 'dialog'}.${suffix}`);
}

/** 迁移窗口的四个对话框。文件夹按标题再拆开，避免和注册根目录共用一把键。 */
export function migrationDialogKey(kind: 'save' | 'package' | 'folder' | 'file', title?: string): string {
  const label = String(title ?? '');
  if (kind === 'save') return DIALOG_LAST_DIR.migrationExport;
  if (kind === 'package') return DIALOG_LAST_DIR.migrationPackage;
  if (kind === 'folder') {
    if (label.includes('资料所在的上级文件夹')) return DIALOG_LAST_DIR.migrationImportBase;
    if (label.includes('在本机的位置')) return DIALOG_LAST_DIR.migrationLocateRoot;
    return DIALOG_LAST_DIR.migrationRemapFolder;
  }
  if (label.startsWith('重新定位')) return DIALOG_LAST_DIR.migrationRelocateFile;
  return DIALOG_LAST_DIR.migrationPickFile;
}

function dirExists(isDir: (abs: string) => boolean, abs: string): boolean {
  try {
    return isDir(abs) === true;
  } catch {
    return false;
  }
}

/**
 * 从 start 往上找第一个还在的目录。start 自己是文件时会落到它所在的目录。
 * 调用方传入的路径会先按所在平台 normalize，isDir 看到的也是这个形式。
 * 连根目录都不在时返回 null。
 */
export function existingAncestor(start: string, isDir: (abs: string) => boolean): string | null {
  const text = start.trim();
  if (!text) return null;
  const api = pathApi(text);
  let current = api.normalize(text);
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    if (dirExists(isDir, current)) return current;
    const parent = api.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

function saveFileName(callerDefault: string | undefined): string | null {
  if (!callerDefault?.trim()) return null;
  const text = callerDefault.trim();
  if (/[\\/]$/.test(text)) return null;
  const api = pathApi(text);
  const base = api.basename(api.normalize(text));
  if (!base || base === '.' || base === '..') return null;
  if (!api.extname(base)) return null;
  return base;
}

function finishDefault(dir: string | null, fileName: string | null, mode: 'open' | 'save', allowBareName: boolean): string | undefined {
  if (!dir || dir === '.' || dir === '..') {
    return allowBareName && mode === 'save' && fileName ? fileName : undefined;
  }
  if (mode === 'save' && fileName) return pathApi(dir).join(dir, fileName);
  return dir;
}

/**
 * 有上次目录就用它（保存框仍带上调用方建议的文件名）。
 * 上次目录整条链都不在时不退回调用方的 defaultPath，交给系统默认。
 * 还没有上次目录时，才沿用调用方自己的 defaultPath，同样只保留还在的上级。
 */
export function resolveDialogDefaultPath(
  remembered: string | null | undefined,
  callerDefault: string | undefined,
  isDir: (abs: string) => boolean,
  mode: 'open' | 'save',
): string | undefined {
  const fileName = mode === 'save' ? saveFileName(callerDefault) : null;
  const rememberedText = remembered?.trim() ?? '';
  if (rememberedText) {
    return finishDefault(existingAncestor(rememberedText, isDir), fileName, mode, false);
  }
  if (!callerDefault?.trim()) return undefined;
  return finishDefault(existingAncestor(callerDefault, isDir), fileName, mode, true);
}

/** 选文件夹记该文件夹；选文件记它所在的目录。 */
export function directoryToRemember(picked: string, properties: readonly string[] | undefined, isDir: (abs: string) => boolean): string | null {
  const trimmed = picked.trim();
  if (!trimmed) return null;
  const api = pathApi(trimmed);
  let normalized = api.normalize(trimmed);
  const props = properties ?? [];
  const directoryDialog = props.includes('openDirectory') && !props.includes('openFile');
  const asDir = directoryDialog || dirExists(isDir, normalized);
  if (!asDir) normalized = api.dirname(normalized);
  if (!normalized || normalized === '.' || normalized === '..') return null;
  return normalized;
}

function readDirs(file: string): Record<string, string> {
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') console.error('[dialog] 上次目录读不出来，先当作没有', err);
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as { v?: unknown; dirs?: unknown };
    if (!parsed || typeof parsed !== 'object' || parsed.v !== 1 || !parsed.dirs || typeof parsed.dirs !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.dirs as Record<string, unknown>)) {
      if (typeof value !== 'string' || !value.trim()) continue;
      out[normalizeDialogKey(key)] = value.trim();
    }
    return out;
  } catch (err) {
    console.error('[dialog] 上次目录文件损坏，先当作没有', err);
    return {};
  }
}

function atomicWriteSync(dest: string, data: string): void {
  const dir = path.dirname(dest);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(dest)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, dest);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 临时文件清不掉不影响调用方看到原来的错误 */
    }
    throw err;
  }
}

export function createJsonDialogLastDirStore(file: string): DialogLastDirStore {
  let dirs = readDirs(file);
  return {
    get(key) {
      const value = dirs[normalizeDialogKey(key)];
      return typeof value === 'string' && value.trim() ? value : null;
    },
    set(key, dir) {
      const id = normalizeDialogKey(key);
      const next = dir.trim();
      if (!next || next.length > 1024 || /[\0\r\n]/.test(next)) return;
      if (dirs[id] === next) return;
      const nextDirs = { ...dirs, [id]: next };
      atomicWriteSync(file, `${JSON.stringify({ v: 1, dirs: nextDirs }, null, 2)}\n`);
      dirs = nextDirs;
    },
  };
}

export function fsIsDir(abs: string): boolean {
  try {
    return fs.statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

function liveWindow(win: DialogWindow | null | undefined): DialogWindow | null {
  if (!win) return null;
  try {
    return win.isDestroyed() ? null : win;
  } catch {
    return null;
  }
}

function withDefaultPath<T extends { defaultPath?: string }>(options: T, resolved: string | undefined): T {
  const next = { ...options };
  if (resolved) next.defaultPath = resolved;
  else delete next.defaultPath;
  return next;
}

function remember(deps: DialogLastDirDeps, key: string, picked: string | undefined, properties: readonly string[] | undefined): void {
  if (!picked?.trim()) return;
  const dir = directoryToRemember(picked, properties, deps.isDir);
  if (!dir) return;
  try {
    deps.store.set(key, dir);
  } catch (err) {
    console.error('[dialog] 上次目录没记住', err);
  }
}

function rememberedOf(deps: DialogLastDirDeps, key: string): string | null {
  try {
    return deps.store.get(key);
  } catch (err) {
    console.error('[dialog] 上次目录读失败', err);
    return null;
  }
}

export function createDialogLastDir(deps: DialogLastDirDeps) {
  return {
    async openDialogWithMemory(key: string, win: DialogWindow | null | undefined, options: OpenDialogOptions): Promise<OpenDialogReturnValue> {
      const id = normalizeDialogKey(key);
      const resolved = resolveDialogDefaultPath(rememberedOf(deps, id), options.defaultPath, deps.isDir, 'open');
      const next = withDefaultPath(options, resolved);
      const result = await deps.showOpenDialog(liveWindow(win), next);
      if (!result.canceled) {
        const picked = result.filePaths?.find((item) => typeof item === 'string' && item.trim());
        remember(deps, id, picked, options.properties);
      }
      return result;
    },
    async saveDialogWithMemory(key: string, win: DialogWindow | null | undefined, options: SaveDialogOptions): Promise<SaveDialogReturnValue> {
      const id = normalizeDialogKey(key);
      const resolved = resolveDialogDefaultPath(rememberedOf(deps, id), options.defaultPath, deps.isDir, 'save');
      const next = withDefaultPath(options, resolved);
      const result = await deps.showSaveDialog(liveWindow(win), next);
      if (!result.canceled) remember(deps, id, result.filePath, options.properties);
      return result;
    },
  };
}

let production: ReturnType<typeof createDialogLastDir> | null = null;

function productionDialogs(): ReturnType<typeof createDialogLastDir> {
  if (production) return production;
  const { app, dialog } = require('electron') as typeof import('electron');
  const file = path.join(app.getPath('userData'), DIALOG_LAST_DIR_FILE);
  production = createDialogLastDir({
    store: createJsonDialogLastDirStore(file),
    isDir: fsIsDir,
    showOpenDialog: (win, options) => (win ? dialog.showOpenDialog(win as BrowserWindow, options) : dialog.showOpenDialog(options)),
    showSaveDialog: (win, options) => (win ? dialog.showSaveDialog(win as BrowserWindow, options) : dialog.showSaveDialog(options)),
  });
  return production;
}

/** 打开文件或文件夹，并按入口键记住这次所在的目录。供后续 Agent 面板直接调用。 */
export function openDialogWithMemory(key: string, win: DialogWindow | null | undefined, options: OpenDialogOptions): Promise<OpenDialogReturnValue> {
  return productionDialogs().openDialogWithMemory(key, win, options);
}

export function saveDialogWithMemory(key: string, win: DialogWindow | null | undefined, options: SaveDialogOptions): Promise<SaveDialogReturnValue> {
  return productionDialogs().saveDialogWithMemory(key, win, options);
}
