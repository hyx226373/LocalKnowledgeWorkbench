/** 欢迎页的临时现场。这个 id 不进入 workspaces 表。 */
export const TEMPORARY_WORKSPACE_ID = 'kb-overview-temporary';

export function isTemporaryWorkspaceId(id: string): boolean {
  return id === TEMPORARY_WORKSPACE_ID;
}
