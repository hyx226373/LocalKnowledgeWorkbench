/**
 * 总览快照写入守卫。快照是派生缓存，不是布局恢复依据。
 * 不读盘、不写盘、不抛错。失败只返回结果，不能当成保存或退出失败。
 */
import { normalizeCoverRef } from './normalize';

export type SnapshotGuardReason =
  | 'ok'
  | 'disabled'
  | 'workspace-mismatch'
  | 'revision-mismatch'
  | 'absolute-path'
  | 'invalid-name'
  | 'cover-protected'
  | 'invalid'
  | 'no-window'
  | 'not-captured'
  | 'write-failed';

export interface SnapshotGuardResult {
  ok: boolean;
  /** 是否允许把新字节写入缓存。拒绝时为 false，旧图留在 keptFileName。 */
  write: boolean;
  keptFileName: string | null;
  /** 允许写入的相对文件名。拒绝时为 null。 */
  fileName: string | null;
  /** 规范化后的用户封面。绝对路径不会留下。 */
  coverRef: string | null;
  previousFileName: string | null;
  reason: SnapshotGuardReason;
  /** 恒为 false。 */
  saveError: false;
  /** 采集不得替换用户封面。恒为 false。 */
  replacesCover: false;
}

export interface SnapshotCaptureDecision extends SnapshotGuardResult {
  captured: boolean;
  /**
   * 主窗 PNG 与子视图的采样摘要是否一致。
   * 没有子视图时为 false。摘要不是逐像素证明。
   */
  includesNativeWeb: boolean;
  /** 是否存在不同于主窗的子视图。没有子视图时为 false（即 no-native-web）。 */
  nativeWebPresent: boolean;
}

function blank(): SnapshotGuardResult {
  return {
    ok: false,
    write: false,
    keptFileName: null,
    fileName: null,
    coverRef: null,
    previousFileName: null,
    reason: 'invalid',
    saveError: false,
    replacesCover: false,
  };
}

function asRecord(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  return input as Record<string, unknown>;
}

function pathLike(raw: string): boolean {
  return /[/\\:]/.test(raw) || raw.trim().startsWith('\\\\');
}

function classifyName(raw: unknown): { name: string | null; problem: 'absolute-path' | 'invalid-name' | null } {
  if (typeof raw !== 'string') return { name: null, problem: 'invalid-name' };
  const name = normalizeCoverRef(raw);
  if (name) return { name, problem: null };
  return { name: null, problem: pathLike(raw) ? 'absolute-path' : 'invalid-name' };
}

/** null、缺省和空白表示没有用户封面。 */
function classifyCover(raw: unknown): { name: string | null; problem: 'absolute-path' | 'invalid-name' | null } {
  if (raw == null) return { name: null, problem: null };
  if (typeof raw !== 'string') return { name: null, problem: 'invalid-name' };
  if (!raw.trim()) return { name: null, problem: null };
  return classifyName(raw);
}

function previousName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return normalizeCoverRef(raw);
}

function sameId(actual: unknown, expected: unknown): boolean {
  return typeof actual === 'string' && actual.length > 0 && actual === expected;
}

function sameRevision(actual: unknown, expected: unknown): boolean {
  return typeof actual === 'number' && Number.isFinite(actual) && actual === expected;
}

function keep(reason: SnapshotGuardReason, previous: string | null, coverRef: string | null): SnapshotGuardResult {
  return {
    ...blank(),
    reason,
    keptFileName: previous,
    previousFileName: previous,
    coverRef,
  };
}

function guardInner(input: unknown): SnapshotGuardResult {
  const row = asRecord(input);
  if (!row) return blank();
  const previous = previousName(row.previousFileName);
  const enabled = !Object.prototype.hasOwnProperty.call(row, 'snapshotEnabled') || row.snapshotEnabled === true;
  if (!enabled) return keep('disabled', previous, classifyCover(row.coverRef).name);
  if (!sameId(row.workspaceId, row.expectedWorkspaceId)) return keep('workspace-mismatch', previous, classifyCover(row.coverRef).name);
  if (!sameRevision(row.revision, row.expectedRevision)) return keep('revision-mismatch', previous, classifyCover(row.coverRef).name);
  const file = classifyName(row.fileName);
  const cover = classifyCover(row.coverRef);
  if (file.problem === 'absolute-path' || cover.problem === 'absolute-path') return keep('absolute-path', previous, cover.name);
  if (cover.problem === 'invalid-name' || file.problem === 'invalid-name') return keep('invalid-name', previous, null);
  if (cover.name) return keep('cover-protected', previous, cover.name);
  return {
    ok: true,
    write: true,
    keptFileName: null,
    fileName: file.name,
    coverRef: null,
    previousFileName: previous,
    reason: 'ok',
    saveError: false,
    replacesCover: false,
  };
}

/** 核对 workspaceId 与 revision，并拒绝绝对路径。不抛错。 */
export function guardSnapshotWrite(input: unknown): SnapshotGuardResult {
  try {
    return guardInner(input);
  } catch {
    return blank();
  }
}

/**
 * 没有像素字节时的判定。无窗口是 no-window。
 * 有窗口但调用方没给出字节仍是 not-captured，不在这里产图。
 * 真字节走 decideSnapshotCapture。
 */
export function assessSnapshotCapture(input: unknown, hasWindow: boolean): SnapshotCaptureDecision {
  let guard: SnapshotGuardResult;
  try {
    guard = guardSnapshotWrite(input);
  } catch {
    guard = blank();
  }
  const flags = { captured: false as const, includesNativeWeb: false as const, nativeWebPresent: false as const };
  if (!guard.write) return { ...guard, ...flags };
  if (!hasWindow) {
    return {
      ...guard,
      ...flags,
      ok: false,
      write: false,
      fileName: null,
      keptFileName: guard.previousFileName,
      reason: 'no-window',
    };
  }
  return {
    ...guard,
    ...flags,
    ok: false,
    write: false,
    fileName: null,
    keptFileName: guard.previousFileName,
    reason: 'not-captured',
  };
}
