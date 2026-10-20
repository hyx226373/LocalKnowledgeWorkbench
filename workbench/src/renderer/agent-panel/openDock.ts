/**
 * 在主区 dockview 里打开源文件或对话预览。
 * 这些标签不进工作区条目（ref 不能存绝对路径），保存布局时要剔掉。
 */
import { sameMarkPath } from '../../shared/agentMarks';
import type { AgentPanelChanged } from '../../shared/agentPanel';
import { pruneDock, type SerializedDock } from '../../shared/items';

export const AGENT_PANEL_COMPONENT = 'agent-panel-doc';
export const AGENT_PANEL_DOC_PREFIX = 'agent-panel:';
export const SELECTION_MIME = 'application/x-lkw-agent-selection';

export type AgentPanelDocParams =
  | { kind: 'source'; name: string }
  | { kind: 'conversation'; path: string; title: string };

export function isAgentPanelDocId(id: string): boolean {
  return id.startsWith(AGENT_PANEL_DOC_PREFIX);
}

function stableKey(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function agentPanelDocId(params: AgentPanelDocParams): string {
  const key = params.kind === 'source' ? params.name : params.path;
  return `${AGENT_PANEL_DOC_PREFIX}${params.kind}:${stableKey(key)}`;
}

export interface ConversationPanelHandle {
  params?: unknown;
  api: {
    updateParameters(params: AgentPanelDocParams): void;
    setTitle(title: string): void;
    close(): void;
  };
}

function asConversation(params: unknown): { kind: 'conversation'; path: string; title: string } | null {
  if (!params || typeof params !== 'object') return null;
  const row = params as { kind?: unknown; path?: unknown; title?: unknown };
  if (row.kind !== 'conversation' || typeof row.path !== 'string') return null;
  return { kind: 'conversation', path: row.path, title: typeof row.title === 'string' ? row.title : '' };
}

/** 已打开的对话页跟着新路径走。删除则关掉这一页。 */
export function followConversationPaths(panels: readonly ConversationPanelHandle[], event: Pick<AgentPanelChanged, 'moved' | 'retitled' | 'removed'>): void {
  for (const panel of panels) {
    const params = asConversation(panel.params);
    if (!params) continue;
    const move = event.moved?.find((row) => sameMarkPath(row.from, params.path));
    if (move) {
      panel.api.updateParameters({ kind: 'conversation', path: move.to, title: move.title });
      panel.api.setTitle(move.title || '对话');
      continue;
    }
    const titled = event.retitled?.find((row) => sameMarkPath(row.path, params.path));
    if (titled) {
      panel.api.updateParameters({ kind: 'conversation', path: params.path, title: titled.title });
      panel.api.setTitle(titled.title || '对话');
      continue;
    }
    if (event.removed?.some((file) => sameMarkPath(file, params.path))) panel.api.close();
  }
}

export function findConversationPanel<T extends { params?: unknown }>(panels: readonly T[], filePath: string): T | undefined {
  return panels.find((panel) => {
    const params = asConversation(panel.params);
    return !!params && sameMarkPath(params.path, filePath);
  });
}

type Opener = (params: AgentPanelDocParams) => boolean;
let opener: Opener | null = null;

export function setAgentPanelOpener(fn: Opener | null): void {
  opener = fn;
}

/** 主区尚未挂上 opener 时返回 false，调用方改在侧栏里展开。 */
export function openAgentPanelDoc(params: AgentPanelDocParams): boolean {
  if (!opener) return false;
  try {
    return opener(params) !== false;
  } catch {
    return false;
  }
}

export function omitAgentPanelDocs(dock: unknown): SerializedDock | null {
  if (!dock || typeof dock !== 'object') return null;
  const serialized = dock as SerializedDock;
  if (!serialized.panels || !serialized.grid) return serialized;
  const next = pruneDock(serialized, (id) => !isAgentPanelDocId(String(id)));
  if (next) return next;
  return { ...serialized, panels: {} };
}

export function stripAgentPanelWindows<T>(raw: T): T {
  if (!raw || typeof raw !== 'object') return raw;
  const value = raw as {
    order?: string[];
    collapsed?: Record<string, unknown>;
    floats?: Record<string, unknown>;
    gridMaximized?: string;
  };
  const keep = (id: string) => !isAgentPanelDocId(id);
  const order = Array.isArray(value.order) ? value.order.filter((id) => keep(id)) : value.order;
  const collapsed = value.collapsed && typeof value.collapsed === 'object'
    ? Object.fromEntries(Object.entries(value.collapsed).filter(([id]) => keep(id)))
    : value.collapsed;
  const floats = value.floats && typeof value.floats === 'object'
    ? Object.fromEntries(Object.entries(value.floats).filter(([id]) => keep(id)))
    : value.floats;
  const next = { ...value, order, collapsed, floats } as unknown as T & { gridMaximized?: string };
  if (typeof value.gridMaximized === 'string' && !keep(value.gridMaximized)) delete next.gridMaximized;
  return next;
}
