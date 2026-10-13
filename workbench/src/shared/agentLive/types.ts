/**
 * agent live 冻结接口 v1（r13）。
 * 本文件由组 4 先提交，组 1、组 2、组 3、组 5 以此为准。
 * 工作台写出的桥文件见 0.1：先写 *.tmp，再原子替换；marker.json 最后写。
 */

export const AGENT_LIVE_SCHEMA_VERSION = 1 as const;

export const LIVE_EVENT_TYPES = [
  'material.added',
  'material.removed',
  'material.reordered',
  'material.purposeChanged',
  'material.pinned',
  'material.unpinned',
  'session.cleared',
  'content.changed',
  'path.changed',
  'material.missing',
  'material.restored',
  'reading.changed',
  'workspace.switched',
  'snapshot.reset',
] as const;

export type LiveEventType = (typeof LIVE_EVENT_TYPES)[number];

export const MATERIAL_STATUSES = ['ok', 'missing', 'unreadable'] as const;
export type MaterialStatus = (typeof MATERIAL_STATUSES)[number];

export type Unsubscribe = () => void;
export type AddResult = 'added' | 'duplicate';

/** 0.5 工作资料项。resourceId 为空表示不在任何来源里的单文件。 */
export interface AgentMaterial {
  materialId: string;
  resourceId: string | null;
  sourceId: string | null;
  relPath: string;
  absPath: string;
  name: string;
  purpose: string | null;
  order: number;
  status: MaterialStatus;
  contentHash: string | null;
  contentVersion: number;
  /** 相对该工作区 live 目录，例如 content/<materialId>/<64位hex>.txt。Windows 文件名不含冒号。 */
  readable: string | null;
  addedAt: string;
  /** 0.10。session 为本轮临时，pinned 为固定。 */
  tier?: 'session' | 'pinned';
  /** 0.11。还在计算时为 null。 */
  bytes?: number | null;
  estTokens?: number | null;
  hasText?: boolean;
  /** 只有 PDF 有。 */
  pages?: number | null;
}

export interface MaterialRef {
  resourceId?: string | null;
  sourceId?: string | null;
  relPath?: string;
  absPath: string;
  name?: string;
}

/**
 * 0.3 变更记录。组 4 在落盘前补上 rev 与 ts。
 * order：added/removed 为序号；reordered 为完整 materialId 数组。
 * size、mtimeMs、workspaceName 只用于合并与去重，不写入 jsonl。
 */
export interface LiveEvent {
  rev?: number;
  ts?: string;
  type: LiveEventType;
  workspaceId: string;
  materialId?: string;
  resourceId?: string | null;
  sourceId?: string | null;
  relPath?: string;
  absPath?: string;
  order?: number | string[];
  purpose?: string | null;
  contentHash?: string;
  prevContentHash?: string;
  /** 相对该工作区 live 目录的可读文本。 */
  content?: string;
  /** 相对该工作区 live 目录的 unified diff。大差异省略，改走 agent.getDiff。 */
  diff?: string;
  /** 仅在无法做差异时写 false（PDF、Office 等）。 */
  diffSupported?: boolean;
  prevAbsPath?: string;
  prevRelPath?: string;
  panelId?: string;
  fromWorkspaceId?: string;
  toWorkspaceId?: string;
  toRevision?: number;
  snapshotRevision?: number;
  /** 0.10。material.added 带上所在区。 */
  tier?: 'session' | 'pinned';
  /** 0.10。session.cleared 带被清掉的 materialId。 */
  materialIds?: string[];
  size?: number;
  mtimeMs?: number;
  workspaceName?: string;
}

export type MaterialEventType =
  | 'material.added'
  | 'material.removed'
  | 'material.reordered'
  | 'material.purposeChanged'
  | 'material.pinned'
  | 'material.unpinned'
  | 'path.changed'
  | 'material.missing'
  | 'material.restored'
  | 'content.changed';

/** 组 1 onChange 发出的子集，可直接交给 LiveRevisionLog.append。 */
export type MaterialEvent = LiveEvent & { type: MaterialEventType };

export interface WorkspaceMarker {
  schemaVersion: 1;
  kind: 'workspace';
  workspaceId: string;
  workspaceName: string;
  revision: number;
  oldestRevision: number;
  snapshotRevision: number;
  generatedAt: string;
  appVersion: string;
}

export interface CurrentMarker {
  schemaVersion: 1;
  kind: 'current';
  workspaceId: string;
  workspaceName: string;
  revision: number;
  oldestRevision: number;
  snapshotRevision: number;
  generatedAt: string;
  appVersion: string;
  /** 只在切换工作区时 +1。 */
  currentRevision: number;
  /** 相对 live/current，例如 ../ws/<workspaceId>。 */
  wsDir: string;
}

export type LiveMarker = WorkspaceMarker | CurrentMarker;

export interface ChangeSegment {
  from: number;
  to: number;
  file: string;
}

export interface ChangesIndex {
  segments: ChangeSegment[];
  oldestRevision: number;
}

export interface LivePanel {
  panelId: string;
  materialId?: string | null;
  resourceId?: string | null;
  name?: string;
  absPath?: string;
}

export interface LiveReading {
  panelId?: string;
  materialId?: string | null;
  resourceId?: string | null;
  name?: string;
  absPath?: string;
}

export const LIVE_NAV = {
  structure: 'nav/structure.md',
  relations: 'nav/relations.md',
  actions: 'nav/actions.md',
  guide: 'nav/guide.md',
  architecture: 'nav/architecture.md',
} as const;

/** 0.4 快照。不含正文。nav 路径相对该工作区 live 目录。 */
export interface LiveSnapshot {
  schemaVersion: 1;
  /** 0.11。组 3 写入，组 4 只声明字段。 */
  appVersion?: string;
  generatedAt?: string;
  /** 本文件实际包含哪些段。 */
  sections?: string[];
  workspaceId: string;
  workspaceName: string;
  purpose?: string;
  revision: number;
  panels: LivePanel[];
  reading: LiveReading | null;
  materials: AgentMaterial[];
  nav: { [K in keyof typeof LIVE_NAV]: string };
}

/**
 * content/<materialId>/meta.json。
 * 组 4 只更新 versions，并保留其它字段（组 3 可写 status: generating）。
 */
export interface ContentVersionMeta {
  contentHash: string;
  file: string;
  storedAt: string;
}

export interface ContentMeta {
  materialId?: string;
  status?: 'ready' | 'generating' | 'missing';
  versions?: ContentVersionMeta[];
  [key: string]: unknown;
}

/** 0.2.1 监视器交给组 1 的一批变化。组 4 不实现监视器。 */
export interface ResourceChange {
  rootId?: string;
  workspaceId?: string;
  type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir' | 'rename';
  relPath?: string;
  prevRelPath?: string;
  absPath?: string;
  prevAbsPath?: string;
  resourceId?: string;
  size?: number;
  mtimeMs?: number;
}

export interface ResourceChangeFeed {
  onBatch(cb: (batch: ResourceChange[]) => void): Unsubscribe;
}

export interface AgentMaterialsStore {
  list(workspaceId: string): AgentMaterial[];
  add(workspaceId: string, ref: MaterialRef, opts?: { purpose?: string; index?: number }): AddResult;
  remove(workspaceId: string, materialId: string): void;
  reorder(workspaceId: string, order: string[]): void;
  setPurpose(workspaceId: string, materialId: string, purpose: string | null): void;
  onChange(cb: (e: MaterialEvent) => void): Unsubscribe;
}

export interface LiveRevisionLog {
  /** 合并、落盘、按 0.1 顺序发布，返回新的工作区 revision。没有有效变化时返回当前 revision。 */
  append(workspaceId: string, events: LiveEvent[]): Promise<number>;
  current(workspaceId: string): number;
}

export interface LiveEntryWriter {
  /** 生成该工作区的 ENTRY.md、snapshot.json、nav，以及 PDF 等可读内容。不写 marker.json。 */
  render(workspaceId: string, rev: number): Promise<void>;
}

/** 组 4 定时对账读的清单。不建立目录监视。 */
export interface LiveReconcileMaterial {
  materialId: string;
  resourceId?: string | null;
  sourceId?: string | null;
  relPath: string;
  absPath: string;
}

export interface LiveReconcileSource {
  list(workspaceId: string): LiveReconcileMaterial[] | Promise<LiveReconcileMaterial[]>;
}

export interface GetContentArgs {
  materialId: string;
  workspaceId?: string;
  contentHash?: string;
  offset?: number;
  length?: number;
  /** 1 起。正文含换页符时按换页符分页，否则每 200 行一页。 */
  page?: number;
}

export interface GetContentResult {
  materialId: string;
  workspaceId: string;
  contentHash: string;
  absPath: string;
  text: string;
  offset: number;
  length: number;
  totalLength: number;
  page?: number;
  pageCount?: number;
}

export interface GetDiffArgs {
  materialId: string;
  workspaceId?: string;
  fromHash: string;
  toHash: string;
}

export interface GetDiffResult {
  materialId: string;
  workspaceId: string;
  fromHash: string;
  toHash: string;
  diffSupported: boolean;
  diff?: string;
  absPath?: string;
  deferred?: boolean;
}

/** 组 5 写入、工作台只读。 */
export interface AgentCursor {
  schemaVersion?: 1;
  agentId: string;
  workspaceId?: string | null;
  revision: number;
  updatedAt?: string;
}

export const AGENT_LIVE_ACTIONS = {
  copyBridgeLink: 'agent.copyBridgeLink',
  copyWorkspaceLink: 'agent.copyWorkspaceLink',
  materialsAdd: 'agent.materials.add',
  materialsRemove: 'agent.materials.remove',
  materialsReorder: 'agent.materials.reorder',
  materialsSetPurpose: 'agent.materials.setPurpose',
  materialsAddCurrent: 'agent.materials.addCurrent',
  materialsAddSelection: 'agent.materials.addSelection',
  materialsPin: 'agent.materials.pin',
  materialsUnpin: 'agent.materials.unpin',
  materialsClearSession: 'agent.materials.clearSession',
  getContent: 'agent.getContent',
  getDiff: 'agent.getDiff',
} as const;

/**
 * plan-submit 的 write 在提交时绑定的执行对象。
 * expectedFileHash 是原文件字节哈希，不是会被忽略的计划级 contentHash。
 */
export interface BoundWriteOp {
  kind: string;
  resourceId?: string;
  materialId?: string;
  absPath?: string;
  expectedFileHash?: string;
}

export interface BoundPlanExecution {
  requestId: string;
  planId: string | null;
  workspaceId: string;
  boundAt: string;
  ops: BoundWriteOp[];
  scope: {
    workspaceId: string;
    resourceIds: string[];
    materialIds: string[];
    absPaths: string[];
  };
}

export interface FileHashConflict {
  ok: false;
  status: 'conflict';
  suggestedAction: 're-read';
  error: { code: 'conflict'; message: string };
  materialId?: string;
  resourceId?: string;
  absPath?: string;
  expectedFileHash: string;
  actualFileHash: string | null;
}
