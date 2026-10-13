/** 外贴 29 冻结类型。纯函数，不碰数据库、不碰磁盘。 */

export type RootOpKind = 'detach' | 'delete-disk';

export type RootTaskState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export type RootTaskPriority = 'remove' | 'user' | 'background';

/** 数据进程里同时跑的根任务槽。不是 Electron 进程数。 */
export const ROOT_JOB_LIMIT = 2;

/** 清索引时每批行数。每批一个短事务，批与批之间让出写锁。 */
export const ROOT_CLEANUP_BATCH = 200;

export const PHASE_DELETING = '文件删除中';
export const PHASE_DELETED = '删除完成';

export interface RootPublishSnapshot {
  generation: number;
  publishable: boolean;
}

export interface RootOpReceipt {
  ok: true;
  rootId: string;
  workspaceId: string;
  taskId: string;
  generation: number;
  kind: RootOpKind;
  hidden: true;
}

export interface RootTask {
  taskId: string;
  rootId: string;
  workspaceId: string;
  generation: number;
  kind: RootOpKind;
  state: RootTaskState;
  /** 真实删除进行中必须是「文件删除中」。只有移动成功才是「删除完成」。 */
  phaseText: string;
  error: string | null;
  diskPath: string;
  createdAt: number;
  updatedAt: number;
}

export interface RootDiskDeleteRequest {
  rootId: string;
  absPath: string;
  stagingDir: string;
  dataDir: string;
  /** 移动成功之后才调用。返回 op_log id。失败路径不得调用。 */
  record(detail: {
    staging: string;
    kind: 'dir' | 'file';
    fileCount: number;
    totalBytes: number;
    rootDelete: true;
  }): number;
}

export interface RootDiskDeleteResult {
  ok: boolean;
  opId: number | null;
  error: string | null;
}

/** 没有退休行时视为第 0 代，可以发布。代次不一致或已不可发布，一律丢弃。 */
export function shouldPublish(current: RootPublishSnapshot | null, capturedGeneration: number): boolean {
  const snap = current ?? { generation: 0, publishable: true };
  if (!snap.publishable) return false;
  return snap.generation === capturedGeneration;
}
