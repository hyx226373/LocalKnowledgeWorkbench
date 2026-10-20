/**
 * Agent 配置与对话面板的共享契约。
 * 数据默认在应用目录 agent-data/（KB_AGENT_DATA 可覆盖；设置里的位置记在 location.json）。
 * 不主动写 userData，也不写 %LOCALAPPDATA%。
 */

export const AGENT_PANEL_CHANGED_CHANNEL = 'agent-panel:changed';

export const AGENT_PANEL_METHODS = ['agentPanelLocationGet', 'agentPanelLocationSet'] as const;

export type AgentPanelMethod = (typeof AGENT_PANEL_METHODS)[number];

/** 只读方法不进写队列。 */
export const AGENT_PANEL_READ_METHODS = ['agentPanelLocationGet'] as const;

/** @deprecated 以下仅供尚未合并的渲染车道编译；不再注册旧面板 IPC。 */
export type AgentFormat = 'markdown' | 'mdc' | 'text';

export interface AgentDef {
  id: string;
  name: string;
  /** 相对项目根。Grok 不写文件，为 null。 */
  relPath: string | null;
  format: AgentFormat;
  builtin: boolean;
  /** 自定义模板，含 {{rules}} {{persona}} {{entryPath}} {{override}}。 */
  template?: string;
}

export interface PersonaPreset {
  id: string;
  name: string;
  persona: string;
  style: string;
}

export interface CustomAgentInput {
  id?: string;
  name: string;
  relPath: string;
  template: string;
}

export interface AgentPanelConfigPatch {
  activePreset?: string | null;
  /** 整体替换预设列表。 */
  presets?: PersonaPreset[];
  /** 按 agent id 合并。空字符串删除该补充。 */
  overrides?: Record<string, string>;
  /** 归档根。空字符串恢复默认目录。 */
  archiveRoot?: string | null;
  /** 整体替换自定义 agent。 */
  customAgents?: CustomAgentInput[];
  /** 顶栏「复制当前工作区入口」用的 agent。空字符串或 null 清除，复制内容回到原来的入口路径。 */
  activeAgent?: string | null;
}

export interface AgentPanelConfigView {
  agents: AgentDef[];
  presets: PersonaPreset[];
  activePreset: string | null;
  overrides: Record<string, string>;
  archiveRoot: string;
  sources: { name: string }[];
  activeSource: string | null;
  /** 未选时为 null。复制入口保持原来的路径。 */
  activeAgent: string | null;
}

/**
 * 放进剪贴板的常驻规则。
 * agentPanelCopyResidentRules 未选 agent 时整段返回 null。
 * 对话链接和新链接始终返回这一形，未选 agent 时 agentId 为空字符串，正文是通用 Markdown。
 */
export interface AgentPanelResidentCopy {
  agentId: string;
  /** 该家常驻文件，相对项目根。Grok 和未选 agent 为 null。 */
  relPath: string | null;
  content: string;
}

export interface AgentPanelRenderResult {
  relPath: string | null;
  content: string;
}

export type AgentPanelWriteResult =
  | { ok: true; relPath: string | null }
  | { needConfirm: true; reason: string };

export interface AgentPanelSourceFile {
  name: string;
  content: string;
}

export interface ConversationFileInfo {
  path: string;
  title: string;
  started: string;
  /** 段数。 */
  blocks: number;
}

export interface ConversationGroup {
  agentId: string;
  files: ConversationFileInfo[];
}

export interface QuarantinedFile {
  path: string;
  reason: string;
}

export interface ConversationsView {
  groups: ConversationGroup[];
  quarantined: QuarantinedFile[];
}

export interface ConversationBlock {
  id: string;
  role: 'user' | 'agent';
  text: string;
  summary?: string;
}

export interface ConversationMeta {
  lkw: string;
  agent: string;
  title: string;
  started?: string;
}

export interface ParsedConversation {
  meta: ConversationMeta;
  blocks: ConversationBlock[];
}

export interface SelectionItem {
  file: string;
  blockId: string;
  mode: 'summary' | 'full';
  order: number;
}

/**
 * 勾选状态。
 * set 为 false：selection 文件不存在，items 是按默认规则算的，尚未落盘。
 * set 为 true 且 items 为空：已经设置成空，不再套默认勾选。
 */
export interface SelectionState {
  set: boolean;
  /** 用户拖过排序后为 true，注入顺序沿用 items。false 时按对话时间与段号重排。 */
  manualOrder: boolean;
  /**
   * 勾选已被用户定过的对话文件。
   * set 且 items、touched 都空：整份选择被设成空，所有文件都不再套默认。
   */
  touched: string[];
  items: SelectionItem[];
}

export type SelectionSetInput =
  | SelectionItem[]
  | {
      items?: SelectionItem[];
      manualOrder?: boolean;
      touch?: string[];
    };

export interface AgentPanelPathMove {
  from: string;
  to: string;
  title: string;
}

export interface AgentPanelChanged {
  kind: 'conversations' | 'quarantine';
  quarantined: number;
  /** 对话文件被 rename。已打开的对话页、勾选和标红改用新路径。 */
  moved?: AgentPanelPathMove[];
  /** 同一路径上 frontmatter 标题变了。 */
  retitled?: { path: string; title: string }[];
  /** 对话文件已移到回收站。勾选和标红去掉这些路径。 */
  removed?: string[];
}

/** 交给 ENTRY 渲染的一块摘录。file 用归档显示路径。 */
export interface HistoryExcerptInput {
  agent: string;
  file: string;
  blockId: string;
  mode: 'summary' | 'full';
  title: string;
  time: string;
  text: string;
  summary?: string;
  /** 绝对路径。只用于和上下文底座去重，不写入快照。 */
  absPath?: string;
}

/** 对话目录的一行。path 用归档显示路径。started 只用于排序。 */
export interface ConversationIndexInput {
  agent: string;
  title: string;
  path: string;
  anchors: string[];
  started?: string;
}

export interface SnapshotAgentRules {
  preset: string;
  rulesHash: string;
}

export interface SnapshotHistoryExcerpt {
  agent: string;
  file: string;
  blockId: string;
  mode: 'summary' | 'full';
  title: string;
  time: string;
  dup: boolean;
}

export interface SnapshotConversationIndex {
  agent: string;
  title: string;
  path: string;
  anchors: string[];
}

export interface ContextBaseBlock {
  id: string;
  role: 'user' | 'agent';
  text: string;
  summary?: string;
}

/** 交给 ENTRY 的底座全文。path 是绝对路径。 */
export interface ContextBaseInput {
  path: string;
  agent: string;
  title: string;
  text: string;
  blocks: ContextBaseBlock[];
}

/** IPC agentPanelBaseGet 与 snapshot.contextBase 共用。空则不写快照。 */
export interface SnapshotContextBase {
  path: string;
  agent: string;
  title: string;
  /** 实际注入的段号。截断时只含保留下来的最近几段。 */
  blocks: string[];
  truncated: boolean;
}

export type ContextBaseView = SnapshotContextBase;

export interface AgentPanelLocationView {
  /** 当前数据目录（config、sources、selection、默认 conversations）。 */
  dir: string;
  /** 应用目录下的 agent-data。环境变量覆盖时与 dir 相同。 */
  defaultDir: string;
  source: 'env' | 'location' | 'default';
  /** KB_AGENT_DATA 生效时，设置里不能改位置。 */
  envLocked: boolean;
}

export interface AgentPanelLocationSet {
  /** 空字符串或 null 恢复到应用目录 agent-data。 */
  dir?: string | null;
  /** true 把现有配置和存档搬过去；false 只切换。 */
  migrate?: boolean;
}
