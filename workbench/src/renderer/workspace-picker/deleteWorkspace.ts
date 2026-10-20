/** 删除已保存工作区：先确认，当前工作区先切走，再调数据层。不碰磁盘。 */

export const DELETE_WORKSPACE_CONFIRM_BODY =
  '只删除这个工作区的配置（根目录登记、布局等），不会删除磁盘上的任何文件。';

export const LAST_WORKSPACE_DELETE_TITLE = '只剩这一个工作区，不能删除';

export const TEMPORARY_WORKSPACE_DELETE_TITLE = '临时现场还没保存，不能删除';

export const DELETE_WORKSPACE_TITLE = '删除这个工作区的配置，不会删除磁盘上的文件';

export interface WorkspaceDeleteTarget {
  id: string;
  name: string;
}

export interface WorkspaceDeletePorts {
  confirm(input: { title: string; body: string; ok?: string; cancel?: string; danger?: boolean }): Promise<boolean>;
  workspaces(): readonly WorkspaceDeleteTarget[];
  currentId(): string;
  switchTo(id: string): Promise<void>;
  deleteWorkspace(id: string): Promise<void>;
}

export type WorkspaceDeleteResult = 'deleted' | 'cancelled' | 'blocked';

/** 只剩一个、或名单里没有这个 id 时不弹框、不删除。确认取消也不删除。 */
export async function requestDeleteWorkspace(id: string, ports: WorkspaceDeletePorts): Promise<WorkspaceDeleteResult> {
  const list = ports.workspaces();
  const target = list.find((row) => row.id === id);
  if (!target || list.length <= 1) return 'blocked';
  const ok = await ports.confirm({
    title: `删除工作区「${target.name}」？`,
    body: DELETE_WORKSPACE_CONFIRM_BODY,
    ok: '删除',
    danger: true,
  });
  if (!ok) return 'cancelled';
  const fresh = ports.workspaces();
  if (fresh.length <= 1 || !fresh.some((row) => row.id === id)) return 'blocked';
  if (ports.currentId() === id) {
    const next = fresh.find((row) => row.id !== id);
    if (!next) return 'blocked';
    await ports.switchTo(next.id);
  }
  await ports.deleteWorkspace(id);
  return 'deleted';
}
