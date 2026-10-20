/**
 * 壳层在打开总览之前调用。本文件不改顶栏。
 * 预加载没挂上或主进程失败时返回结果，不抛错，避免挡住总览。
 */
import {
  decideSnapshotCapture,
  type SnapshotCaptureDecision,
  type WorkspaceSnapshotLoadResult,
  type WorkspaceSnapshotRequest,
} from '../shared/workspacePicker/snapshotCapture';
import { kb } from './kb';

export async function captureWorkspaceSnapshot(input: WorkspaceSnapshotRequest): Promise<SnapshotCaptureDecision> {
  try {
    if (!kb || typeof kb.captureWorkspaceSnapshot !== 'function') return decideSnapshotCapture(input, null);
    const result = await kb.captureWorkspaceSnapshot(input);
    const summary = {
      ok: result.ok,
      captured: result.captured,
      includesNativeWeb: result.includesNativeWeb,
      nativeWebPresent: result.nativeWebPresent,
      fileName: result.fileName,
      reason: result.reason,
    };
    (window as Window & { __kbLastSnapshot?: typeof summary }).__kbLastSnapshot = summary;
    return result;
  } catch {
    return decideSnapshotCapture(null, null);
  }
}

/** 从磁盘回填总览快照。预加载缺失或失败时返回空对象。 */
export async function loadWorkspaceSnapshots(workspaceIds: readonly string[]): Promise<WorkspaceSnapshotLoadResult> {
  try {
    if (!kb || typeof kb.loadWorkspaceSnapshots !== 'function') return {};
    const result = await kb.loadWorkspaceSnapshots(workspaceIds);
    if (!result || typeof result !== 'object' || Array.isArray(result)) return {};
    return result as WorkspaceSnapshotLoadResult;
  } catch {
    return {};
  }
}

/** 清除落盘快照。失败返回空数组。 */
export async function deleteWorkspaceSnapshots(relativeNames: readonly string[]): Promise<string[]> {
  try {
    if (!kb || typeof kb.deleteWorkspaceSnapshots !== 'function') return [];
    const result = await kb.deleteWorkspaceSnapshots(relativeNames);
    return Array.isArray(result) ? result.filter((name): name is string => typeof name === 'string') : [];
  } catch {
    return [];
  }
}
