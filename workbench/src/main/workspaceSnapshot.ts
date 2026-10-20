/**
 * 工作区总览快照的主进程入口。
 * 窗口还在且守卫通过时 capturePage，并把 PNG 写入 host 给的目录。
 * 失败只返回结果，不抛到关闭流程。不截桌面。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ipcMain, type BrowserWindow } from 'electron';
import {
  decideSnapshotCapture,
  WORKSPACE_SNAPSHOT_CAPTURE_CHANNEL,
  WORKSPACE_SNAPSHOT_DELETE_CHANNEL,
  WORKSPACE_SNAPSHOT_LOAD_CHANNEL,
  type SnapshotCaptureDecision,
  type WorkspaceSnapshotLoadResult,
} from '../shared/workspacePicker/snapshotCapture';
import { snapshotCacheFileName } from '../shared/workspacePicker/snapshotCache';
import { resolveInRoot, PathEscapeError } from './service/paths';

export { WORKSPACE_SNAPSHOT_CAPTURE_CHANNEL };

/** 壳层在 registerIpc 里接的一行。目录另由 getSnapshotDir 提供。 */
export const WORKSPACE_SNAPSHOT_REGISTER_LINE = 'registerWorkspaceSnapshot({ getWindow: () => win })';

export interface WorkspaceSnapshotHost {
  getWindow(): BrowserWindow | null;
  getSnapshotDir(): string;
}

function windowAlive(win: BrowserWindow | null | undefined): win is BrowserWindow {
  try {
    if (!win || typeof win.isDestroyed !== 'function' || win.isDestroyed() !== false) return false;
    return !!win.webContents && win.webContents.isDestroyed() === false;
  } catch {
    return false;
  }
}

function pngBytes(image: { toPNG?: () => Buffer; isEmpty?: () => boolean } | null | undefined): Buffer | null {
  try {
    if (!image || typeof image.toPNG !== 'function') return null;
    if (typeof image.isEmpty === 'function' && image.isEmpty()) return null;
    const png = image.toPNG();
    if (!Buffer.isBuffer(png) || png.length === 0) return null;
    return png;
  } catch {
    return null;
  }
}

interface CapturableContents {
  capturePage: () => Promise<{ toPNG?: () => Buffer; isEmpty?: () => boolean }>;
  isDestroyed?: () => boolean;
}

function childContents(view: unknown): CapturableContents | null {
  if (!view || typeof view !== 'object' || !('webContents' in view)) return null;
  const wc = (view as { webContents?: unknown }).webContents;
  if (!wc || typeof wc !== 'object') return null;
  if (typeof (wc as { capturePage?: unknown }).capturePage !== 'function') return null;
  return wc as CapturableContents;
}

/**
 * contentView.children 里跳过主窗自己的 webContents。
 * Electron 44 常把主窗页面放在第一个子视图，原生网页是后面的 WebContentsView。
 * 枚举失败当作没有子视图。
 */
async function captureChild(win: BrowserWindow): Promise<{ childPng: Buffer | null; childPresent: boolean }> {
  let children: unknown;
  try {
    children = win.contentView.children;
  } catch {
    return { childPng: null, childPresent: false };
  }
  if (!Array.isArray(children)) return { childPng: null, childPresent: false };
  for (const view of children) {
    const wc = childContents(view);
    if (!wc || (wc as unknown) === win.webContents) continue;
    try {
      if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) continue;
      const image = await wc.capturePage();
      return { childPng: pngBytes(image), childPresent: true };
    } catch {
      return { childPng: null, childPresent: true };
    }
  }
  return { childPng: null, childPresent: false };
}

function writableName(name: string | null): name is string {
  return !!name && !/[/\\:]/.test(name) && !name.includes('..') && name !== '.' && name !== '..';
}

async function writePng(getDir: () => string, fileName: string, bytes: Buffer): Promise<boolean> {
  if (!writableName(fileName)) return false;
  const dir = getDir();
  if (typeof dir !== 'string' || !dir.trim()) return false;
  const target = path.join(dir, fileName);
  if (path.basename(target) !== fileName) return false;
  const partName = `${fileName}.part`;
  if (!writableName(partName)) return false;
  const part = path.join(dir, partName);
  if (path.basename(part) !== partName) return false;
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(part, bytes);
  try {
    await fs.promises.rename(part, target);
    return true;
  } catch {
    /* 目标已存在时 Windows 的 rename 会失败，下面再替换。 */
  }
  const backup = path.join(dir, `${fileName}.bak`);
  let moved = false;
  try {
    await fs.promises.rm(backup, { force: true });
    await fs.promises.rename(target, backup);
    moved = true;
    await fs.promises.rename(part, target);
    await fs.promises.rm(backup, { force: true });
    return true;
  } catch {
    if (moved) {
      try {
        await fs.promises.rename(backup, target);
      } catch {
        /* 旧图留在 .bak，不把半成品当成新快照。 */
      }
    }
    try {
      await fs.promises.rm(part, { force: true });
    } catch {
      /* 半成品删不掉也不覆盖已经留住的旧图。 */
    }
    return false;
  }
}

function keepOld(decision: SnapshotCaptureDecision, reason: SnapshotCaptureDecision['reason']): SnapshotCaptureDecision {
  return {
    ...decision,
    ok: false,
    write: false,
    captured: false,
    fileName: null,
    keptFileName: decision.previousFileName,
    reason,
    saveError: false,
    replacesCover: false,
  };
}

/** 无窗口、无字节或写盘失败都返回结果，不抛错。 */
export async function captureWorkspaceSnapshot(
  win: BrowserWindow | null | undefined,
  input: unknown,
  getDir: () => string,
): Promise<SnapshotCaptureDecision> {
  try {
    const gate = decideSnapshotCapture(input, { mainPng: Buffer.from([1]), childPresent: false });
    if (!gate.write) return gate;
    if (!windowAlive(win)) return decideSnapshotCapture(input, null);
    let mainPng: Buffer | null = null;
    try {
      mainPng = pngBytes(await win.webContents.capturePage());
    } catch {
      mainPng = null;
    }
    const child = await captureChild(win);
    const decision = decideSnapshotCapture(input, { mainPng, childPng: child.childPng, childPresent: child.childPresent });
    if (!decision.write || !decision.fileName || !mainPng) return decision;
    try {
      const wrote = await writePng(getDir, decision.fileName, mainPng);
      if (wrote) return { ...decision, dataUrl: `data:image/png;base64,${mainPng.toString('base64')}` };
    } catch {
      /* 写失败留旧图 */
    }
    return keepOld(decision, 'write-failed');
  } catch {
    return decideSnapshotCapture(null, null);
  }
}


/** 按工作区 id 读已落盘 PNG，填回总览卡片。缺文件则跳过。 */
export async function loadWorkspaceSnapshots(
  getDir: () => string,
  workspaceIds: unknown,
): Promise<WorkspaceSnapshotLoadResult> {
  const out: WorkspaceSnapshotLoadResult = {};
  try {
    const dir = getDir();
    if (typeof dir !== 'string' || !dir.trim()) return out;
    const ids = Array.isArray(workspaceIds) ? workspaceIds : [];
    for (const id of ids) {
      if (typeof id !== 'string' || !id) continue;
      const fileName = snapshotCacheFileName(id);
      if (!writableName(fileName)) continue;
      const target = path.join(dir, fileName);
      if (path.basename(target) !== fileName) continue;
      try {
        const st = await fs.promises.stat(target);
        if (!st.isFile() || st.size <= 0) continue;
        const bytes = await fs.promises.readFile(target);
        if (!Buffer.isBuffer(bytes) || bytes.length === 0) continue;
        let takenAt: string | null = null;
        try {
          takenAt = new Date(st.mtimeMs).toLocaleString('zh-CN', { hour12: false });
        } catch {
          takenAt = null;
        }
        out[id] = {
          fileName,
          dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
          takenAt,
        };
      } catch {
        /* 单文件失败不影响其它工作区 */
      }
    }
  } catch {
    return out;
  }
  return out;
}

/** 只删 getDir 下的相对文件名（resolveInRoot 围栏）。返回实际删掉的名字。 */
export async function deleteWorkspaceSnapshots(
  getDir: () => string,
  relativeNames: unknown,
): Promise<string[]> {
  const deleted: string[] = [];
  try {
    const dir = getDir();
    if (typeof dir !== 'string' || !dir.trim()) return deleted;
    const names = Array.isArray(relativeNames) ? relativeNames : [];
    for (const raw of names) {
      if (typeof raw !== 'string') continue;
      // 快过滤：明显非法名直接跳过
      if (!writableName(raw)) continue;
      let target: string;
      try {
        target = resolveInRoot(dir, raw);
      } catch (e) {
        if (e instanceof PathEscapeError) continue;
        continue;
      }
      try {
        await fs.promises.rm(target, { force: true });
        deleted.push(raw);
      } catch {
        /* 继续删下一个 */
      }
      for (const extra of [`${raw}.part`, `${raw}.bak`]) {
        if (!writableName(extra)) continue;
        try {
          const extraPath = resolveInRoot(dir, extra);
          await fs.promises.rm(extraPath, { force: true });
        } catch {
          /* PathEscape 或删失败都忽略 */
        }
      }
    }
  } catch {
    return deleted;
  }
  return deleted;
}

export function registerWorkspaceSnapshot(host: WorkspaceSnapshotHost): () => void {
  const channel = WORKSPACE_SNAPSHOT_CAPTURE_CHANNEL;
  const loadChannel = WORKSPACE_SNAPSHOT_LOAD_CHANNEL;
  const deleteChannel = WORKSPACE_SNAPSHOT_DELETE_CHANNEL;
  ipcMain.handle(channel, async (_event, payload: unknown) => {
    try {
      return await captureWorkspaceSnapshot(host.getWindow(), payload, () => host.getSnapshotDir());
    } catch {
      return decideSnapshotCapture(null, null);
    }
  });
  ipcMain.handle(loadChannel, async (_event, workspaceIds: unknown) => {
    try {
      return await loadWorkspaceSnapshots(() => host.getSnapshotDir(), workspaceIds);
    } catch {
      return {};
    }
  });
  ipcMain.handle(deleteChannel, async (_event, relativeNames: unknown) => {
    try {
      return await deleteWorkspaceSnapshots(() => host.getSnapshotDir(), relativeNames);
    } catch {
      return [];
    }
  });
  return () => {
    ipcMain.removeHandler(channel);
    ipcMain.removeHandler(loadChannel);
    ipcMain.removeHandler(deleteChannel);
  };
}
