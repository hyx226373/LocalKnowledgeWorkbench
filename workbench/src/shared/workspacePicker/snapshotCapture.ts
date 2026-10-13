/**
 * 总览快照的像素判定。不读盘、不写盘、不依赖 Electron、不抛错。
 * 文件名只由 workspaceId 推导，忽略调用方传入的路径。
 * 采样摘要不是全图比对，也不能代替桌面实测。
 */
import { snapshotCacheFileName } from './snapshotCache';
import {
  guardSnapshotWrite,
  type SnapshotCaptureDecision,
  type SnapshotGuardResult,
} from './snapshotGuard';

export const WORKSPACE_SNAPSHOT_CAPTURE_CHANNEL = 'kb:workspace-snapshot-capture';

export type { SnapshotCaptureDecision };

/** 渲染进程打开总览前交给主进程的字段。fileName 即使传入也会被忽略。 */
export interface WorkspaceSnapshotRequest {
  workspaceId: string;
  expectedWorkspaceId: string;
  revision: number;
  expectedRevision: number;
  coverRef?: string | null;
  previousFileName?: string | null;
  snapshotEnabled?: boolean;
  fileName?: string | null;
}

export interface SnapshotPixelSource {
  mainPng: Buffer | null;
  childPng?: Buffer | null;
  childPresent: boolean;
}

const SAMPLE_STRIDE = 64;

function asRecord(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  return input as Record<string, unknown>;
}

function asPng(raw: Buffer | null | undefined): Buffer | null {
  if (!Buffer.isBuffer(raw) || raw.length === 0) return null;
  return raw;
}

/** 调用方文件名含盘符或斜杠时留给守卫拒绝；其它文件名不参与写入。 */
function guardInput(input: unknown): unknown {
  const row = asRecord(input);
  if (!row) return input;
  if (typeof row.fileName === 'string' && (/[/\\:]/.test(row.fileName) || row.fileName.trim().startsWith('\\\\'))) return input;
  return { ...row, fileName: 'snap.png' };
}

function failed(guard: SnapshotGuardResult, reason: SnapshotGuardResult['reason'], nativeWebPresent: boolean): SnapshotCaptureDecision {
  return {
    ...guard,
    ok: false,
    write: false,
    captured: false,
    includesNativeWeb: false,
    nativeWebPresent,
    fileName: null,
    keptFileName: guard.previousFileName,
    reason,
    saveError: false,
    replacesCover: false,
  };
}

/**
 * 长度加上每 64 字节取一字节的异或。
 * PNG 头 24 字节经常相同，不能单靠它判断两张图是不是一张。
 */
export function snapshotPngSampleXor(bytes: Buffer): number {
  let xor = 0;
  for (let i = 0; i < bytes.length; i += SAMPLE_STRIDE) xor ^= bytes[i]!;
  return xor & 0xff;
}

function samplesMatch(main: Buffer, child: Buffer): boolean {
  if (main.length !== child.length || main.length === 0) return false;
  return snapshotPngSampleXor(main) === snapshotPngSampleXor(child);
}

function nativeWebOf(main: Buffer, child: Buffer | null, childPresent: boolean): { includesNativeWeb: boolean; nativeWebPresent: boolean } {
  if (!childPresent) return { includesNativeWeb: false, nativeWebPresent: false };
  if (!child || !samplesMatch(main, child)) return { includesNativeWeb: false, nativeWebPresent: true };
  return { includesNativeWeb: true, nativeWebPresent: true };
}

function safeCacheName(workspaceId: string): string | null {
  const name = snapshotCacheFileName(workspaceId);
  if (!name || /[/\\:]/.test(name) || name.includes('..')) return null;
  return name;
}

/**
 * 守卫不过、或没有主图像素：不写，保留旧文件名。
 * 有主图像素且守卫通过：ok/write/captured 为 true，fileName 只来自 snapshotCacheFileName。
 * pixels 为 null 表示没有窗口。
 */
export function decideSnapshotCapture(input: unknown, pixels: SnapshotPixelSource | null): SnapshotCaptureDecision {
  let guard: SnapshotGuardResult;
  try {
    guard = guardSnapshotWrite(guardInput(input));
  } catch {
    guard = guardSnapshotWrite(null);
  }
  const childPresent = pixels?.childPresent === true;
  if (!guard.write) {
    return {
      ...guard,
      captured: false,
      includesNativeWeb: false,
      nativeWebPresent: false,
    };
  }
  if (pixels == null) return failed(guard, 'no-window', false);
  const main = asPng(pixels.mainPng);
  if (!main) return failed(guard, 'not-captured', childPresent);
  const row = asRecord(input);
  const workspaceId = row && typeof row.workspaceId === 'string' ? row.workspaceId : '';
  const fileName = safeCacheName(workspaceId);
  if (!fileName) return failed(guard, 'invalid-name', childPresent);
  const child = asPng(pixels.childPng);
  const native = nativeWebOf(main, child, childPresent);
  return {
    ok: true,
    write: true,
    keptFileName: null,
    fileName,
    coverRef: null,
    previousFileName: guard.previousFileName,
    reason: 'ok',
    saveError: false,
    replacesCover: false,
    captured: true,
    includesNativeWeb: native.includesNativeWeb,
    nativeWebPresent: native.nativeWebPresent,
  };
}
