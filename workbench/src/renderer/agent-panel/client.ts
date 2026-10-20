/**
 * 通过 window.kb 调用 Agent 面板。
 * 方法名和参数对齐 KbApi / 车道 A 的 IPC 实际签名。
 * 方法还没挂上时返回空状态，不抛错。调用失败（主进程 reject）照常冒泡。
 */
import { DIALOG_LAST_DIR } from '../../shared/dialogLastDir';
import type { KbApi } from '../../shared/types';
import type { AgentPanelChanged, AgentPanelConfigPatch, AgentPanelLocationView, SelectionSetInput, SelectionState } from '../../shared/agentPanel';
import { kb } from '../kb';
import {
  BASE_API_MISSING,
  archivePickVia,
  locationChangeVia,
  normalizeBaseSetResult,
  normalizeConfig,
  normalizeContextBase,
  normalizeConversations,
  normalizeLocationView,
  normalizeParsed,
  normalizeRender,
  normalizeSelection,
  normalizeSelectionState,
  normalizeSourceContent,
  normalizeSourceNames,
  normalizeWriteResult,
  pathFromArchivePick,
  sameStoredPath,
  type ArchivePickVia,
  type LocationVia,
} from './logic';
import type {
  AgentPanelConfig,
  AgentRenderResult,
  ContextBase,
  ContextBaseSetArg,
  ContextBaseSetResult,
  ConversationsSnapshot,
  ParsedConversation,
  WriteProjectResult,
} from './types';

type AgentPanelIpc = Partial<
  Pick<
    KbApi,
    | 'agentPanelGetConfig'
    | 'agentPanelSaveConfig'
    | 'agentPanelRender'
    | 'agentPanelWriteProject'
    | 'agentPanelSourceList'
    | 'agentPanelSourceRead'
    | 'agentPanelSourceSave'
    | 'agentPanelSourceActivate'
    | 'agentPanelConversations'
    | 'agentPanelParse'
    | 'agentPanelSelectionGet'
    | 'agentPanelSelectionSet'
    | 'agentPanelBaseGet'
    | 'agentPanelBaseSet'
    | 'agentPanelLocationGet'
    | 'agentPanelLocationSet'
    | 'agentPanelCopyConversationLink'
    | 'agentPanelCopyNewLink'
    | 'agentPanelRenameConversation'
    | 'agentPanelDeleteConversation'
    | 'onAgentPanelChanged'
  >
>;

const contextBaseListeners = new Set<() => void>();

/** 这次会话里最近一次成功的底座。BaseGet 还没挂上时，界面用它保持「已在底座」。 */
let sessionBase: ContextBase | null = null;

/** 主进程还不认识 activeAgent 时，本次会话仍记住界面上的选择。undefined 表示用户还没改过。 */
let sessionActiveAgent: string | null | undefined;

export function sessionActiveAgentId(): string | null | undefined {
  return sessionActiveAgent;
}

export function sessionContextBase(): ContextBase | null {
  return sessionBase;
}

export function subscribeContextBase(cb: () => void): () => void {
  contextBaseListeners.add(cb);
  return () => contextBaseListeners.delete(cb);
}

function emitContextBase(): void {
  for (const cb of contextBaseListeners) {
    try {
      cb();
    } catch {
      /* 订阅方自己处理界面错误 */
    }
  }
}

function ipc(): AgentPanelIpc | null {
  const fromWindow = typeof window !== 'undefined' ? (window.kb as unknown as AgentPanelIpc | undefined) : undefined;
  if (fromWindow && typeof fromWindow === 'object') return fromWindow;
  const fromModule = kb as unknown as AgentPanelIpc | undefined;
  return fromModule && typeof fromModule === 'object' ? fromModule : null;
}

export function agentPanelApiReady(): boolean {
  return typeof ipc()?.agentPanelGetConfig === 'function';
}

export async function agentPanelGetConfig(): Promise<AgentPanelConfig | null> {
  const fn = ipc()?.agentPanelGetConfig;
  if (typeof fn !== 'function') return null;
  return normalizeConfig(await fn());
}

export async function agentPanelSaveConfig(patch: AgentPanelConfigPatch): Promise<void> {
  const fn = ipc()?.agentPanelSaveConfig;
  if (typeof fn !== 'function') return;
  await fn(patch);
}

export type ActiveAgentSaveResult = 'saved' | 'session' | 'missing';

/**
 * 用配置 IPC 写入 activeAgent。
 * 主进程还没有这个字段（写完读不回来，或直接拒绝）时降级为本次会话记忆。
 */
export async function agentPanelSetActiveAgent(agentId: string | null): Promise<ActiveAgentSaveResult> {
  const fn = ipc()?.agentPanelSaveConfig;
  if (typeof fn !== 'function') {
    sessionActiveAgent = agentId;
    return 'missing';
  }
  const patch: AgentPanelConfigPatch & { activeAgent: string | null } = { activeAgent: agentId };
  try {
    await fn(patch);
  } catch {
    sessionActiveAgent = agentId;
    return 'session';
  }
  try {
    const fresh = normalizeConfig(await ipc()?.agentPanelGetConfig?.());
    if ((fresh.activeAgent ?? null) === agentId) {
      sessionActiveAgent = undefined;
      return 'saved';
    }
  } catch {
    /* 补丁已发出，但读不回配置 */
  }
  sessionActiveAgent = agentId;
  return 'session';
}

export async function pickAndSaveArchiveDir(): Promise<{ ok: boolean; cancelled?: boolean; path: string; via: ArchivePickVia; reason?: string }> {
  const api = ipc() as (AgentPanelIpc & { agentPanelPickArchiveDir?: () => Promise<unknown> }) | null;
  const via = archivePickVia({
    pickArchiveDir: typeof api?.agentPanelPickArchiveDir === 'function',
    pickFolder: typeof kb.pickFolder === 'function',
  });
  if (via === 'missing') return { ok: false, path: '', via, reason: '无法打开目录选择框' };
  const raw = via === 'pickArchiveDir' ? await api?.agentPanelPickArchiveDir?.() : await kb.pickFolder({ dialogKey: DIALOG_LAST_DIR.archiveLocation, title: '选择存档目录' });
  const path = pathFromArchivePick(raw);
  if (!path) return { ok: false, cancelled: true, path: '', via };
  if (typeof api?.agentPanelSaveConfig !== 'function') return { ok: false, path, via, reason: '存档目录接口未连接' };
  await api.agentPanelSaveConfig({ archiveRoot: path });
  return { ok: true, path, via };
}

export async function agentPanelRender(agentId: string): Promise<AgentRenderResult | null> {
  const fn = ipc()?.agentPanelRender;
  if (typeof fn !== 'function') return null;
  return normalizeRender(await fn({ agentId }));
}

export async function agentPanelWriteProject(args: { agentId: string; rootPath: string; confirm?: boolean }): Promise<WriteProjectResult | null> {
  const fn = ipc()?.agentPanelWriteProject;
  if (typeof fn !== 'function') return null;
  return normalizeWriteResult(await fn(args));
}

export async function agentPanelSourceList(): Promise<string[] | null> {
  const fn = ipc()?.agentPanelSourceList;
  if (typeof fn !== 'function') return null;
  return normalizeSourceNames(await fn());
}

export async function agentPanelSourceRead(name: string): Promise<{ name: string; content: string } | null> {
  const fn = ipc()?.agentPanelSourceRead;
  if (typeof fn !== 'function') return null;
  return normalizeSourceContent(await fn({ name }), name);
}

export async function agentPanelSourceSave(name: string, content: string): Promise<boolean> {
  const fn = ipc()?.agentPanelSourceSave;
  if (typeof fn !== 'function') return false;
  await fn({ name, content });
  return true;
}

export async function agentPanelSourceActivate(name: string): Promise<boolean> {
  const fn = ipc()?.agentPanelSourceActivate;
  if (typeof fn !== 'function') return false;
  await fn({ name });
  return true;
}

export async function agentPanelConversations(): Promise<ConversationsSnapshot | null> {
  const fn = ipc()?.agentPanelConversations;
  if (typeof fn !== 'function') return null;
  return normalizeConversations(await fn());
}

export async function agentPanelParse(path: string): Promise<ParsedConversation | null> {
  const fn = ipc()?.agentPanelParse;
  if (typeof fn !== 'function') return null;
  return normalizeParsed(await fn({ path }));
}

export async function agentPanelSelectionGet(): Promise<SelectionState | null> {
  const fn = ipc()?.agentPanelSelectionGet;
  if (typeof fn !== 'function') return null;
  const value = await fn();
  if (value == null) return { set: false, manualOrder: false, touched: [], items: [] };
  return normalizeSelectionState(value);
}

export async function agentPanelSelectionSet(input: SelectionSetInput): Promise<SelectionState | null> {
  const fn = ipc()?.agentPanelSelectionSet;
  if (typeof fn !== 'function') return null;
  const payload: SelectionSetInput = Array.isArray(input)
    ? { items: normalizeSelection(input) }
    : {
        items: normalizeSelection(input.items ?? []),
        ...(typeof input.manualOrder === 'boolean' ? { manualOrder: input.manualOrder } : {}),
        ...(input.touch ? { touch: input.touch } : {}),
      };
  const value = await fn(payload);
  if (value == null) return { set: true, manualOrder: false, touched: [], items: [] };
  return normalizeSelectionState(value);
}

export function agentPanelBaseReady(): boolean {
  const api = ipc();
  return typeof api?.agentPanelBaseGet === 'function' || typeof api?.agentPanelBaseSet === 'function';
}

/** 方法不存在时返回 null。存在时总是给出底座形状，没有文件则 path 为 null。 */
export async function agentPanelBaseGet(): Promise<ContextBase | null> {
  const fn = ipc()?.agentPanelBaseGet;
  if (typeof fn !== 'function') return null;
  sessionBase = normalizeContextBase(await fn());
  return sessionBase;
}

/** `{ path }` 替换底座，null 清除。方法不存在时返回失败，不抛错。主进程拒绝时 reject。 */
export async function agentPanelBaseSet(arg: ContextBaseSetArg): Promise<ContextBaseSetResult> {
  const fn = ipc()?.agentPanelBaseSet;
  if (typeof fn !== 'function') return { ok: false, path: arg?.path ?? null, reason: BASE_API_MISSING };
  const result = normalizeBaseSetResult(await fn(arg), arg);
  if (result.ok) {
    sessionBase = {
      path: result.path,
      blockIds: result.path && sessionBase?.path && sameStoredPath(sessionBase.path, result.path) ? sessionBase.blockIds : [],
      ...(result.agent ? { agent: result.agent } : {}),
      ...(result.title ? { title: result.title } : {}),
    };
    emitContextBase();
  }
  return result;
}

export function agentPanelLocationVia(): LocationVia {
  const api = ipc();
  return locationChangeVia({
    setLocation: typeof api?.agentPanelLocationSet === 'function',
    saveConfig: typeof api?.agentPanelSaveConfig === 'function',
  });
}

/** 方法不存在时返回 null，调用方改显示 archiveRoot。 */
export async function agentPanelLocationGet(): Promise<AgentPanelLocationView | null> {
  const fn = ipc()?.agentPanelLocationGet;
  if (typeof fn !== 'function') return null;
  return normalizeLocationView(await fn());
}

/**
 * 优先 agentPanelLocationSet({ dir, migrate })。
 * 没有该方法时降级为 agentPanelSaveConfig({ archiveRoot })，只改对话存档目录。
 * 两个都没有时返回 missing，不抛错。主进程拒绝时 reject。
 */
export async function changeAgentDataLocation(dir: string, migrate: boolean): Promise<{ ok: boolean; path: string; via: LocationVia; reason?: string }> {
  const via = agentPanelLocationVia();
  if (via === 'setLocation') {
    const fn = ipc()?.agentPanelLocationSet;
    const view = normalizeLocationView(await fn?.({ dir, migrate }));
    return { ok: true, path: view.dir || dir, via };
  }
  if (via === 'archiveRoot') {
    await agentPanelSaveConfig({ archiveRoot: dir });
    return { ok: true, path: dir, via };
  }
  return { ok: false, path: dir, via, reason: 'Agent 数据位置接口未连接' };
}

function linkContent(raw: unknown): string {
  if (!raw || typeof raw !== 'object') throw new Error('没有可复制的链接');
  const content = (raw as { content?: unknown }).content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('没有可复制的链接');
  return content;
}

/** 本对话的复制链接。接口未挂上时抛错。未选 agent 时主进程仍返回通用 Markdown。 */
export async function agentPanelCopyConversationLink(filePath: string): Promise<string> {
  const fn = ipc()?.agentPanelCopyConversationLink;
  if (typeof fn !== 'function') throw new Error('复制链接接口未连接');
  return linkContent(await fn({ path: filePath }));
}

/** 改标题并 rename。接口未挂上时抛错。 */
export async function agentPanelRenameConversation(filePath: string, title: string): Promise<{ path: string; title: string }> {
  const fn = ipc()?.agentPanelRenameConversation;
  if (typeof fn !== 'function') throw new Error('重命名接口未连接');
  const raw = await fn({ path: filePath, title });
  if (!raw || typeof raw !== 'object') throw new Error('重命名没有返回结果');
  const next = raw as { path?: unknown; title?: unknown };
  if (typeof next.path !== 'string' || !next.path.trim()) throw new Error('重命名没有返回结果');
  return { path: next.path, title: typeof next.title === 'string' ? next.title : title };
}

/** 移到回收站。接口未挂上时抛错。调用前要先确认。 */
export async function agentPanelDeleteConversation(filePath: string): Promise<void> {
  const fn = ipc()?.agentPanelDeleteConversation;
  if (typeof fn !== 'function') throw new Error('删除接口未连接');
  await fn({ path: filePath });
}

/** 空上下文的新链接。接口未挂上时抛错。 */
export async function agentPanelCopyNewLink(): Promise<string> {
  const fn = ipc()?.agentPanelCopyNewLink;
  if (typeof fn !== 'function') throw new Error('复制链接接口未连接');
  return linkContent(await fn());
}

/** 事件名以 preload 为准：onAgentPanelChanged，频道 agent-panel:changed。 */
export function subscribeAgentPanel(cb: (event: AgentPanelChanged) => void): () => void {
  const fn = ipc()?.onAgentPanelChanged;
  if (typeof fn !== 'function') return () => undefined;
  try {
    return fn(cb) ?? (() => undefined);
  } catch {
    return () => undefined;
  }
}
