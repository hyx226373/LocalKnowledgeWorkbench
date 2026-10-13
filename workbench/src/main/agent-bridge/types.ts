import type { BridgeCapability, StateSnapshot } from '../../shared/actions/types';

/** 文件桥状态。批准只在界面；这里没有 approve。 */
export type BridgeStatus =
  | 'pending'
  | 'awaiting_approval'
  | 'running'
  | 'success'
  | 'failed'
  | 'conflict';

export const CAPABILITIES = [
  'query',
  'search-help',
  'console-draft',
  'classify',
  'workspace-ref',
  'open',
  'invoke',
  'plan-submit',
  'plan-status',
  'state-export',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export const REQUEST_STATES: BridgeStatus[] = [
  'pending',
  'awaiting_approval',
  'running',
  'success',
  'failed',
  'conflict',
];

export const OPEN_AS = [
  'tab',
  'split-left',
  'split-right',
  'split-up',
  'split-down',
  'float',
  'reveal-only',
] as const;

export type OpenAs = (typeof OPEN_AS)[number];

/**
 * 迁登记表之前的两条白名单。运行期以 bridgeInvokableIds() 为准。
 * 这两条是 builtin.bridge 里已有执行体的 id。sources 包另有可调用条目，不写进这个常量。
 */
export const INVOKE_WHITELIST = ['workbench.pendingPlans', 'index.showHealth'] as const;

export type InvokeCommand = (typeof INVOKE_WHITELIST)[number];

export const APP_COMMIT = '30f956d';
export const MODULES_COMMIT = 'c391925';

export interface BridgeError {
  code: string;
  message: string;
}

export interface BridgeResponse {
  requestId: string;
  status: BridgeStatus;
  updatedAt: string;
  result?: unknown;
  error?: BridgeError;
  planId?: string;
  ignoredFields?: string[];
  /** 冲突时建议下一步。桥不会按这个字段自动再批准。 */
  suggestedAction?: 're-propose' | 'open-restore-ui' | 'inspect-plan' | 're-read';
}

export interface ResourceMeta {
  resourceId: string;
  rootId: string;
  relPath: string;
  name: string;
  kind: 'file' | 'dir';
  ext?: string;
}

export interface PlanOpInput {
  kind: 'write' | 'move' | 'trash';
  resourceId: string;
  content?: string;
  expectedHash?: string | null;
  toRelPath?: string;
  /** 原文件字节哈希。缺省表示执行前不核对。 */
  expectedFileHash?: string;
  materialId?: string;
  absPath?: string;
}

export interface ProposedPlan {
  planId: string;
  title: string;
  actor: string;
  status: string;
  contentHash: string;
  ops: Array<{ opId: string; kind: string; resourceId?: string; relPath?: string }>;
}

/** AgentOps 对外只有 propose / get。不要往这个类型上加 approve。 */
export interface AgentOpsPort {
  propose(title: string, ops: PlanOpInput[]): Promise<{ plan: ProposedPlan; preview?: unknown }>;
  get(planId: string): Promise<ProposedPlan | null>;
}

export interface ConsoleRef {
  type: 'resource' | 'workspace-ref' | 'path-hint';
  resourceId?: string;
  workspaceId?: string;
  rootId?: string;
  relPath?: string;
}

export interface ConsoleDraftItem {
  id: string;
  title: string;
  note?: string;
  order: number;
  openAs: OpenAs;
  ref: ConsoleRef;
  targetPanel?: { itemId?: string; adapterId?: string };
  includeInGroupOpen?: boolean;
}

export interface ConsoleDraftInput {
  title: string;
  description?: string;
  items?: ConsoleDraftItem[];
}

export interface OpenInput {
  resourceId: string;
  openAs: OpenAs;
  targetPanel?: { itemId?: string; adapterId?: string };
}

export interface IndexHealth {
  engine: string;
  contentSearch: boolean;
  reason?: string;
  since?: number;
}

export interface PendingPlanSummary {
  planId: string;
  title: string;
  status: string;
  actor?: string;
  contentHash?: string;
}

/**
 * 桥只通过这些方法碰工作台。实现方必须走 OperationService / 既有打开函数，
 * 禁止在适配器里写 SQLite。
 */
export interface BridgeHost {
  forAgent(name: string): AgentOpsPort;
  listRoots(): Array<{ id: string; name: string }>;
  getResource(resourceId: string): ResourceMeta | null;
  listDir?(rootId: string, relPath: string): ResourceMeta[];
  open(input: OpenInput): Promise<{ ok: boolean; itemId?: string; error?: string }>;
  listPendingPlans(): PendingPlanSummary[];
  getIndexHealth?(): IndexHealth | null;
  buildConsoleDraft?(input: ConsoleDraftInput): string;
  classify?(action: 'add' | 'remove', resourceId: string, folderId: string): Promise<void>;
  workspaceRef?(action: 'add' | 'remove', workspaceId: string, resourceId: string): Promise<void>;
  notifyCommand?(commandId: string, args?: Record<string, unknown>): Promise<void>;
  /** 已保存工作区的只读快照。不写数据库。未提供时状态导出的前四键为空。 */
  readState?(): StateSnapshot | Promise<StateSnapshot>;
  /**
   * 不需要批准的 catalog.*。未挂上时 invoke 返回 not_available。
   * 不改 root_mounts。catalog.switch 只接受当前工作区。
   */
  catalog?(actionId: string, args: Record<string, unknown>): Promise<unknown> | unknown;
  /** source.remap.preview。只读，不写 root_mounts，不改配对规则。 */
  previewRemap?(sourceId: string, newLocation: string): unknown;
  /** 计划提交时的活动工作区。不要改用请求体里的 workspaceId。 */
  currentWorkspaceId?(): string | null;
  /** 资源的绝对路径。找不到返回 null，不抛给文件桥。 */
  resolveResourcePath?(resourceId: string): string | null;
}

export interface Manifest {
  bridgeVersion: 1;
  appCommit: string;
  modulesCommit: string;
  /** 请求 type 名。过渡期保留字符串数组。 */
  capabilities: readonly string[];
  /** 单条能力。字段名与 BridgeCapability、AGENT_START_HERE 一致。 */
  capabilityDetails: readonly BridgeCapability[];
  requestStates: readonly BridgeStatus[];
  notes: string;
}
