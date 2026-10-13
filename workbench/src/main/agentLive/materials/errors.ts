export const MATERIAL_LIMIT = 200;
export const LOOSE_WATCH_LIMIT = 200;

const WORKSPACE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class MaterialStoreError extends Error {
  constructor(
    readonly code: 'limit' | 'secret' | 'not_a_file' | 'bad_id' | 'unsupported_schema' | 'state_unreadable',
    message: string,
  ) {
    super(message);
    this.name = 'MaterialStoreError';
  }
}

export function assertWorkspaceId(workspaceId: string): void {
  if (!WORKSPACE_ID_RE.test(workspaceId)) {
    throw new MaterialStoreError('bad_id', 'workspaceId 不能作为存储键');
  }
}

export function isWorkspaceId(workspaceId: string): boolean {
  return WORKSPACE_ID_RE.test(workspaceId);
}
