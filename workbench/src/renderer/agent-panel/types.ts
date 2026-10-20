/**
 * 渲染层用的形状。和 src/shared/agentPanel.ts 一致的类型直接复用。
 * 配置在界面里把 sources 收成名字列表；AgentDef 允许缺省字段（Grok 不写 relPath）。
 * 底座的空状态用 path: null，和 IPC 的 ContextBaseView | null 不是同一个形状。
 */
export type {
  AgentPanelChanged,
  AgentPanelConfigPatch,
  AgentPanelLocationSet,
  AgentPanelLocationView,
  AgentPanelRenderResult,
  AgentPanelRenderResult as AgentRenderResult,
  AgentPanelWriteResult,
  AgentPanelWriteResult as WriteProjectResult,
  ContextBaseView,
  ConversationBlock,
  ConversationFileInfo,
  ConversationGroup,
  ConversationMeta,
  ConversationsView,
  ConversationsView as ConversationsSnapshot,
  CustomAgentInput,
  ParsedConversation,
  PersonaPreset,
  QuarantinedFile,
  SelectionItem,
  SelectionItem as SelectionEntry,
} from '../../shared/agentPanel';

export const BUILTIN_AGENT_IDS = ['claude', 'codex', 'cursor', 'antigravity', 'gemini', 'grok'] as const;

export type BuiltinAgentId = (typeof BUILTIN_AGENT_IDS)[number];

/** 界面上的 agent。比共享 AgentDef 松：relPath / format / builtin 可以不出现。 */
export interface AgentDef {
  id: string;
  name: string;
  /** 相对当前根目录。没有路径时只能复制（Grok Bot）。 */
  relPath?: string;
  format?: string;
  /** 自定义模板，占位 {{rules}} {{persona}} {{entryPath}}。 */
  template?: string;
  builtin?: boolean;
}

/** 规范化之后的配置。sources 是版本名，不是 IPC 的 { name }[]。 */
export interface AgentPanelConfig {
  agents: AgentDef[];
  presets: import('../../shared/agentPanel').PersonaPreset[];
  activePreset: string | null;
  overrides: Record<string, string>;
  archiveRoot: string;
  sources: string[];
  activeSource: string | null;
  /** 顶栏「复制当前工作区入口」使用的 agent。主进程还没这个字段时为 null。 */
  activeAgent: string | null;
}

export const EMPTY_CONFIG: AgentPanelConfig = {
  agents: [],
  presets: [],
  activePreset: null,
  overrides: {},
  archiveRoot: '',
  sources: [],
  activeSource: null,
  activeAgent: null,
};

export const EMPTY_CONVERSATIONS: import('../../shared/agentPanel').ConversationsView = { groups: [], quarantined: [] };

export const BUILTIN_AGENTS: AgentDef[] = [
  { id: 'claude', name: 'Claude Code', relPath: 'CLAUDE.md', format: 'markdown', builtin: true },
  { id: 'codex', name: 'Codex', relPath: 'AGENTS.md', format: 'markdown', builtin: true },
  { id: 'cursor', name: 'Cursor', relPath: '.cursor/rules/lkw-workbench.mdc', format: 'mdc', builtin: true },
  { id: 'antigravity', name: 'Antigravity', relPath: '.agent/rules/lkw-workbench.md', format: 'markdown', builtin: true },
  { id: 'gemini', name: 'Gemini CLI', relPath: 'GEMINI.md', format: 'markdown', builtin: true },
  { id: 'grok', name: 'Grok Bot', format: 'text', builtin: true },
];

export const DEFAULT_CUSTOM_TEMPLATE = '{{rules}}\n\n{{persona}}\n\n入口：{{entryPath}}\n';

export const MORE_TAB = '__more__';

/**
 * 界面上的底座。没有文件时 path 为 null。
 * blockIds 来自 IPC 的 blocks（段号字符串）。
 */
export interface ContextBase {
  path: string | null;
  agent?: string;
  title?: string;
  /** 纳入的块。空数组表示整份文件都算底座。 */
  blockIds: string[];
}

/** agentPanelBaseSet 的参数：设为 `{ path }`，清除为 null。 */
export type ContextBaseSetArg = { path: string } | null;

/** 主进程失败时抛错。方法还没挂上时客户端用 ok: false，不抛错。 */
export interface ContextBaseSetResult {
  ok: boolean;
  reason?: string;
  path: string | null;
  agent?: string;
  title?: string;
}
