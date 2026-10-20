/** r11-D 拖拽载荷与落点。MIME 只认 application/x-kb-resource+json。entry 用 C 的三值，缺省不当成文件。 */

export const KB_RESOURCE_MIME = 'application/x-kb-resource+json';

export type SourceKind = 'file' | 'web';
/** C 的条目种类。缺省或未知值必须拒绝，不能当成 file。 */
export type DragEntry = 'file' | 'vfolder-node' | 'dir-entry';

export type DragFrom =
  | { kind: 'root'; rootId: string; relPath: string }
  | { kind: 'vfolder'; folderId: string | null }
  | { kind: 'workspace-refs'; workspaceId: string }
  | { kind: 'roots-list' }
  | { kind: 'agent-materials' }
  | { kind: 'agent-repo' }
  | { kind: 'explorer' }
  | { kind: 'category-card'; workspaceId: string }
  | { kind: 'web' }
  | { kind: 'doc-tab' };

/** Agent 仓库对外只读。外来载荷在 onDropTarget 里拒绝。 */
export interface AgentRepoZone {
  id: 'agent-repo';
  readonly: true;
}

export const AGENT_REPO_ZONE: AgentRepoZone = { id: 'agent-repo', readonly: true };

export interface DragItem {
  resourceId: string;
  sourceKind: SourceKind;
  from: DragFrom;
  /** 缺了或不是这三值时，落点拒绝。禁止默认成 file。 */
  entry?: DragEntry;
  name?: string;
  /** 磁盘位置，或（roots-list 时）已登记根的 id。根的 id 不是文件夹 resourceId。 */
  rootId?: string;
  relPath?: string;
  size?: number;
  /** vfolder-node 的目录 id */
  folderId?: string;
  /** 扩展名，可带点。缺省时从 name / relPath 取。 */
  ext?: string;
  /** 资源管理器或资料上的绝对路径。没有 resourceId 时靠它复制或加引用。 */
  absPath?: string;
  /**
   * 访问范围快照。缺省表示调用方未提供，落点不拦。
   * 有此字段时，范围外的文件不进入磁盘载荷。
   */
  scope?: {
    sourceKind: 'folder' | 'file';
    extensions: string[];
    outOfScope?: boolean;
  };
}

export interface DragPayload {
  v: 1;
  items: DragItem[];
}

export type ReaderZone = 'center' | 'left' | 'right' | 'up' | 'down';

export type DrawerDropModule = 'bench' | 'agent';

export type DropTarget =
  | { kind: 'disk-dir'; rootId: string; relPath: string; childNames?: string[] }
  | { kind: 'vfolder'; folderId: string }
  | { kind: 'workspace-refs'; workspaceId: string }
  | { kind: 'reader'; zone: ReaderZone }
  | { kind: 'workbench-blank' }
  | { kind: 'roots-list'; rootIds: string[]; index: number }
  | { kind: 'drawer-card'; module: DrawerDropModule; workspaceId: string }
  | { kind: 'agent-materials'; workspaceId: string }
  | { kind: 'agent-repo'; zone?: AgentRepoZone; to?: string }
  | { kind: 'category-card'; workspaceId: string }
  | { kind: 'category'; categoryId: string; workspaceIds: string[] }
  | { kind: 'workbench-order'; workspaceId: string; ids: string[]; index: number }
  | { kind: 'invalid' };

export interface Modifiers {
  alt?: boolean;
  ctrl?: boolean;
}

export type DropEffect = 'move' | 'link' | 'copy' | 'none';

export interface MoveOp {
  resourceId: string;
  name: string;
  fromRootId: string;
  fromRelPath: string;
  toRootId: string;
  toRelPath: string;
  size: number;
  entryKind: 'file' | 'dir';
}

/** 跨区写进真实文件夹。只描述计划，不在 drop 里写盘。 */
export interface CopyReviewOp {
  name: string;
  sourceAbs?: string;
  resourceId: string;
  toRootId: string;
  toRelPath: string;
  entryKind: 'file' | 'dir';
}

export interface AgentRefDrop {
  resourceId?: string;
  absPath?: string;
  name?: string;
  relPath?: string;
  sourceId?: string | null;
  kind?: 'file' | 'dir';
}

export type DropAction =
  | { type: 'move'; ops: MoveOp[]; crossRoot: boolean; nameClash: boolean }
  | { type: 'copy-review'; ops: CopyReviewOp[]; nameClash: boolean }
  | { type: 'classify-add'; folderId: string; resourceIds: string[]; alsoRemoveOtherFolders: boolean }
  | { type: 'classify-shift'; folderId: string; resourceIds: string[]; sourceFolderIds: (string | null)[]; copy: boolean }
  | { type: 'add-ref'; workspaceId: string; resourceIds: string[] }
  | { type: 'add-agent'; workspaceId: string; refs: AgentRefDrop[] }
  | { type: 'link-paths'; workspaceId: string; paths: string[] }
  | { type: 'open'; place: 'tab' | ReaderZone | 'float'; resourceIds: string[] }
  | { type: 'open-readonly'; paths: string[] }
  | { type: 'reorder-roots'; ids: string[] }
  | { type: 'reorder-materials'; workspaceId: string; ids: string[] }
  | { type: 'add-category'; categoryId: string; workspaceId: string; already: boolean }
  | { type: 'agent-repo-move'; to: string }
  | { type: 'reject'; reason: string };

export interface DropDecision {
  action: DropAction;
  dropEffect: DropEffect;
  /** 落点旁的一句话。真移动一定含「将移动原文件」。 */
  hint: string;
}
