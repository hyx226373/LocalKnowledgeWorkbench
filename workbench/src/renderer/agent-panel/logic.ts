/**
 * 对话分块、默认勾选、排序，以及配置/列表的规范化。无 IO。
 */
import type { AgentPanelLocationView, SelectionState } from '../../shared/agentPanel';
import {
  BUILTIN_AGENTS,
  BUILTIN_AGENT_IDS,
  type AgentDef,
  type AgentPanelConfig,
  type AgentRenderResult,
  type ContextBase,
  type ContextBaseSetArg,
  type ContextBaseSetResult,
  type ConversationBlock,
  type ConversationFileInfo,
  type ConversationGroup,
  type ConversationMeta,
  type ConversationsSnapshot,
  type ParsedConversation,
  type PersonaPreset,
  type QuarantinedFile,
  type SelectionEntry,
  type WriteProjectResult,
} from './types';

const BUILTIN_IDS = new Set<string>(BUILTIN_AGENT_IDS);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function selectionKey(file: string, blockId: string): string {
  return `${file}\n${blockId}`;
}

export function baseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || filePath;
}

export function defaultChecked(role: 'user' | 'agent'): boolean {
  return role === 'agent';
}

export function defaultMode(block: { summary?: string }): 'summary' | 'full' {
  return block.summary && block.summary.trim() ? 'summary' : 'full';
}

export function agentBadge(label: string): string {
  const ch = [...label.trim()][0];
  return ch ? ch.toUpperCase() : '?';
}

export function formatStarted(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function canWriteAgent(agent: AgentDef): boolean {
  return agent.id !== 'grok' && !!agent.relPath?.trim();
}

export function agentLabel(agentId: string, agents: readonly AgentDef[]): string {
  return agents.find((agent) => agent.id === agentId)?.name || BUILTIN_AGENTS.find((agent) => agent.id === agentId)?.name || agentId;
}

export function normalizeSourceNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && item.trim()) names.push(item.trim());
    else if (isRecord(item) && typeof item.name === 'string' && item.name.trim()) names.push(item.name.trim());
  }
  return [...new Set(names)];
}

export function normalizeAgentDef(raw: unknown): AgentDef | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id.trim()) return null;
  const id = raw.id.trim();
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id;
  const def: AgentDef = { id, name };
  if (typeof raw.relPath === 'string' && raw.relPath.trim()) def.relPath = raw.relPath.trim();
  if (typeof raw.format === 'string' && raw.format.trim()) def.format = raw.format.trim();
  if (typeof raw.template === 'string') def.template = raw.template;
  if (raw.builtin === true || BUILTIN_IDS.has(id)) def.builtin = true;
  return def;
}

function normalizePreset(raw: unknown): PersonaPreset | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id.trim()) return null;
  return {
    id: raw.id.trim(),
    name: typeof raw.name === 'string' ? raw.name : raw.id.trim(),
    persona: typeof raw.persona === 'string' ? raw.persona : '',
    style: typeof raw.style === 'string' ? raw.style : '',
  };
}

export function normalizeConfig(raw: unknown): AgentPanelConfig {
  const record = isRecord(raw) ? raw : {};
  const agents = Array.isArray(record.agents) ? record.agents.map(normalizeAgentDef).filter((agent): agent is AgentDef => !!agent) : [];
  const presets = Array.isArray(record.presets) ? record.presets.map(normalizePreset).filter((preset): preset is PersonaPreset => !!preset) : [];
  const overrides: Record<string, string> = {};
  if (isRecord(record.overrides)) {
    for (const [key, value] of Object.entries(record.overrides)) {
      if (typeof value === 'string') overrides[key] = value;
    }
  }
  return {
    agents,
    presets,
    activePreset: typeof record.activePreset === 'string' && record.activePreset ? record.activePreset : null,
    overrides,
    archiveRoot: typeof record.archiveRoot === 'string' ? record.archiveRoot : '',
    sources: normalizeSourceNames(record.sources),
    activeSource: typeof record.activeSource === 'string' && record.activeSource ? record.activeSource : null,
    activeAgent: typeof record.activeAgent === 'string' && record.activeAgent.trim() ? record.activeAgent.trim() : null,
  };
}

/** 只接受当前已知的 agent。空字符串表示不指定。 */
export function acceptActiveAgent(agentId: string | null | undefined, ids: readonly string[]): string | null {
  if (!agentId || !agentId.trim()) return null;
  const id = agentId.trim();
  return ids.includes(id) ? id : null;
}

export function normalizeRender(raw: unknown): AgentRenderResult {
  const record = isRecord(raw) ? raw : {};
  const relPath = typeof record.relPath === 'string' && record.relPath.trim() ? record.relPath : null;
  return {
    relPath,
    content: typeof record.content === 'string' ? record.content : '',
  };
}

export function normalizeWriteResult(raw: unknown): WriteProjectResult {
  const record = isRecord(raw) ? raw : {};
  if (record.needConfirm === true) {
    const reason = typeof record.reason === 'string' && record.reason.trim() ? record.reason : '目标文件已存在，且不是本工作台生成的。';
    return { needConfirm: true, reason };
  }
  if (record.ok === false) {
    throw new Error(typeof record.reason === 'string' && record.reason.trim() ? record.reason : '写入失败');
  }
  const relPath = typeof record.relPath === 'string' ? record.relPath : null;
  return { ok: true, relPath };
}

export function normalizeSourceContent(raw: unknown, name: string): { name: string; content: string } {
  if (typeof raw === 'string') return { name, content: raw };
  const record = isRecord(raw) ? raw : {};
  const content = typeof record.content === 'string' ? record.content : typeof record.text === 'string' ? record.text : '';
  const nextName = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : name;
  return { name: nextName, content };
}

export function sortFilesNewestFirst(files: readonly ConversationFileInfo[]): ConversationFileInfo[] {
  return [...files].sort((a, b) => {
    const at = Date.parse(a.started);
    const bt = Date.parse(b.started);
    const aOk = Number.isFinite(at);
    const bOk = Number.isFinite(bt);
    if (aOk && bOk && at !== bt) return bt - at;
    if (aOk !== bOk) return aOk ? -1 : 1;
    return b.started.localeCompare(a.started) || b.path.localeCompare(a.path);
  });
}

export function normalizeConversations(raw: unknown): ConversationsSnapshot {
  const record = isRecord(raw) ? raw : {};
  const groups: ConversationGroup[] = [];
  if (Array.isArray(record.groups)) {
    for (const group of record.groups) {
      if (!isRecord(group) || typeof group.agentId !== 'string' || !group.agentId.trim()) continue;
      const files: ConversationFileInfo[] = [];
      if (Array.isArray(group.files)) {
        for (const file of group.files) {
          if (!isRecord(file) || typeof file.path !== 'string' || !file.path) continue;
          const blocks = typeof file.blocks === 'number' ? file.blocks : Array.isArray(file.blocks) ? file.blocks.length : 0;
          files.push({
            path: file.path,
            title: typeof file.title === 'string' && file.title.trim() ? file.title.trim() : baseName(file.path),
            started: typeof file.started === 'string' ? file.started : '',
            blocks: Number.isFinite(blocks) ? Math.max(0, Math.round(blocks)) : 0,
          });
        }
      }
      groups.push({ agentId: group.agentId.trim(), files: sortFilesNewestFirst(files) });
    }
  }
  const quarantined: QuarantinedFile[] = [];
  if (Array.isArray(record.quarantined)) {
    for (const item of record.quarantined) {
      if (!isRecord(item) || typeof item.path !== 'string' || !item.path) continue;
      quarantined.push({ path: item.path, reason: typeof item.reason === 'string' ? item.reason : '' });
    }
  }
  return { groups, quarantined };
}

export function normalizeBlocks(raw: unknown): ConversationBlock[] {
  if (!Array.isArray(raw)) return [];
  const blocks: ConversationBlock[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id.trim()) continue;
    const summary = typeof item.summary === 'string' && item.summary.trim() ? item.summary : undefined;
    const block: ConversationBlock = {
      id: item.id.trim(),
      role: item.role === 'user' ? 'user' : 'agent',
      text: typeof item.text === 'string' ? item.text : '',
    };
    if (summary) block.summary = summary;
    blocks.push(block);
  }
  return blocks;
}

export function normalizeParsed(raw: unknown): ParsedConversation {
  const record = isRecord(raw) ? raw : {};
  const metaRaw = isRecord(record.meta) ? record.meta : {};
  const meta: ConversationMeta = {
    lkw: typeof metaRaw.lkw === 'string' ? metaRaw.lkw : '',
    agent: typeof metaRaw.agent === 'string' ? metaRaw.agent : '',
    title: typeof metaRaw.title === 'string' ? metaRaw.title : '',
  };
  if (typeof metaRaw.started === 'string' && metaRaw.started) meta.started = metaRaw.started;
  return { meta, blocks: normalizeBlocks(record.blocks) };
}

export function normalizeSelection(raw: unknown): SelectionEntry[] {
  if (!Array.isArray(raw)) return [];
  const items: SelectionEntry[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.file !== 'string' || !item.file || typeof item.blockId !== 'string' || !item.blockId) continue;
    const order = typeof item.order === 'number' && Number.isFinite(item.order) ? item.order : items.length;
    items.push({
      file: item.file,
      blockId: item.blockId,
      mode: item.mode === 'summary' ? 'summary' : 'full',
      order,
    });
  }
  const sorted = [...items].sort((a, b) => a.order - b.order || a.file.localeCompare(b.file) || a.blockId.localeCompare(b.blockId));
  const seen = new Set<string>();
  const unique: SelectionEntry[] = [];
  for (const item of sorted) {
    const key = selectionKey(item.file, item.blockId);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique.map((item, order) => ({ ...item, order }));
}

export interface ChunkState {
  id: string;
  role: 'user' | 'agent';
  text: string;
  summary?: string;
  checked: boolean;
  mode: 'summary' | 'full';
  canToggleMode: boolean;
}

/**
 * 已有该文件的勾选时，缺席的块为未勾。从未勾选过则回答默认勾、用户默认不勾。
 * explicit 为真：选择已经落盘（包括设成空）。缺席就是未勾，不再套默认。
 */
export function chunkStates(
  file: string,
  blocks: readonly ConversationBlock[],
  selection: readonly SelectionEntry[],
  explicit = false,
): ChunkState[] {
  const mine = selection.filter((item) => item.file === file);
  const known = explicit || mine.length > 0;
  const byId = new Map(mine.map((item) => [item.blockId, item]));
  return blocks.map((block) => {
    const saved = byId.get(block.id);
    const canToggleMode = !!block.summary?.trim();
    const requested = saved?.mode ?? defaultMode(block);
    const mode: 'summary' | 'full' = requested === 'summary' && canToggleMode ? 'summary' : 'full';
    return {
      id: block.id,
      role: block.role,
      text: block.text,
      summary: block.summary,
      checked: saved ? true : known ? false : defaultChecked(block.role),
      mode,
      canToggleMode,
    };
  });
}

export function seedFileSelection(list: readonly SelectionEntry[], file: string, blocks: readonly ConversationBlock[]): { list: SelectionEntry[]; seeded: boolean } {
  const current = normalizeSelection(list);
  if (current.some((item) => item.file === file)) return { list: current, seeded: false };
  const additions: SelectionEntry[] = [];
  for (const block of blocks) {
    if (!defaultChecked(block.role)) continue;
    additions.push({ file, blockId: block.id, mode: defaultMode(block), order: current.length + additions.length });
  }
  if (!additions.length) return { list: current, seeded: false };
  return { list: normalizeSelection([...current, ...additions]), seeded: true };
}

export function pruneFileBlocks(list: readonly SelectionEntry[], file: string, blocks: readonly ConversationBlock[]): { list: SelectionEntry[]; changed: boolean } {
  const ids = new Set(blocks.map((block) => block.id));
  const current = normalizeSelection(list);
  const next = normalizeSelection(current.filter((item) => item.file !== file || ids.has(item.blockId)));
  return { list: next, changed: next.length !== current.length };
}

/**
 * 打开一个对话文件时的勾选。seen 为真表示这次会话里已经处理过该文件
 * （用户把回答全部取消后，不要再次按默认勾回去）。
 */
export function prepareFileSelection(list: readonly SelectionEntry[], file: string, blocks: readonly ConversationBlock[], seen: boolean): { list: SelectionEntry[]; changed: boolean } {
  const pruned = pruneFileBlocks(list, file, blocks);
  if (seen || pruned.list.some((item) => item.file === file)) return pruned;
  const seeded = seedFileSelection(pruned.list, file, blocks);
  return { list: seeded.list, changed: pruned.changed || seeded.seeded };
}

export function toggleChunk(list: readonly SelectionEntry[], file: string, block: ConversationBlock, checked: boolean): SelectionEntry[] {
  const without = normalizeSelection(list).filter((item) => !(item.file === file && item.blockId === block.id));
  if (!checked) return normalizeSelection(without);
  return normalizeSelection([...without, { file, blockId: block.id, mode: defaultMode(block), order: without.length }]);
}

export function setChunkMode(list: readonly SelectionEntry[], file: string, blockId: string, mode: 'summary' | 'full'): SelectionEntry[] {
  return normalizeSelection(list.map((item) => (item.file === file && item.blockId === blockId ? { ...item, mode } : item)));
}

export function reorderSelection(list: readonly SelectionEntry[], fromIndex: number, toIndex: number): SelectionEntry[] {
  const sorted = normalizeSelection(list);
  if (fromIndex < 0 || toIndex < 0 || fromIndex >= sorted.length || toIndex >= sorted.length || fromIndex === toIndex) return sorted;
  const next = sorted.slice();
  const [item] = next.splice(fromIndex, 1);
  if (!item) return sorted;
  next.splice(toIndex, 0, item);
  return next.map((row, order) => ({ ...row, order }));
}

/** 用户气泡在右，agent 气泡在左。顺序沿用分块数组（时间顺序）。 */
export function bubbleSide(role: 'user' | 'agent'): 'left' | 'right' {
  return role === 'user' ? 'right' : 'left';
}

export function chatRows(
  file: string,
  blocks: readonly ConversationBlock[],
  selection: readonly SelectionEntry[],
  explicit = false,
): Array<ChunkState & { side: 'left' | 'right' }> {
  return chunkStates(file, blocks, selection, explicit).map((row) => ({ ...row, side: bubbleSide(row.role) }));
}

/**
 * 这个文件是否已经有明确的勾选结果，不能再套「未设置 → 默认勾选」。
 * 整份选择被写成空（set，且 items 与 touched 都空）时，所有文件都算明确为空。
 */
export function fileUsesStoredSelection(
  state: Pick<SelectionState, 'set' | 'touched' | 'items'>,
  file: string,
  seen: boolean,
): boolean {
  if (seen) return true;
  if (!state.set) return false;
  if (state.items.some((item) => item.file === file)) return true;
  if (state.touched.includes(file)) return true;
  if (state.items.length === 0 && state.touched.length === 0) return true;
  return false;
}

export function normalizeSelectionState(raw: unknown): SelectionState {
  if (Array.isArray(raw)) {
    const items = normalizeSelection(raw);
    return { set: true, manualOrder: false, touched: [...new Set(items.map((item) => item.file))], items };
  }
  const record = isRecord(raw) ? raw : {};
  const items = normalizeSelection(record.items);
  const touched = Array.isArray(record.touched)
    ? [...new Set(record.touched.filter((item): item is string => typeof item === 'string' && !!item))]
    : [];
  return {
    set: record.set === false ? false : true,
    manualOrder: record.manualOrder === true,
    touched,
    items,
  };
}

/** 当前对话的每一块都勾上。已有的摘要/全文模式保留。 */
export function selectAllChunks(list: readonly SelectionEntry[], file: string, blocks: readonly ConversationBlock[]): SelectionEntry[] {
  const current = normalizeSelection(list);
  const kept = current.filter((item) => item.file !== file);
  const prev = new Map(current.filter((item) => item.file === file).map((item) => [item.blockId, item]));
  const additions: SelectionEntry[] = blocks.map((block, index) => {
    const saved = prev.get(block.id);
    if (saved) return { ...saved, order: kept.length + index };
    return { file, blockId: block.id, mode: defaultMode(block), order: kept.length + index };
  });
  return normalizeSelection([...kept, ...additions]);
}

/** 当前对话全部取消勾选。其它文件的摘录保留。 */
export function selectNoChunks(list: readonly SelectionEntry[], file: string): SelectionEntry[] {
  return normalizeSelection(normalizeSelection(list).filter((item) => item.file !== file));
}

/**
 * 文件已经打开过后，只给新出现的回答补上默认勾选。
 * knownIds 为 null 表示这次还没有基线，不把已取消的回答重新勾上。
 */
export function refreshFileSelection(
  list: readonly SelectionEntry[],
  file: string,
  blocks: readonly ConversationBlock[],
  seen: boolean,
  knownIds: ReadonlySet<string> | null,
): { list: SelectionEntry[]; changed: boolean } {
  const prepared = prepareFileSelection(list, file, blocks, seen);
  if (!knownIds) return prepared;
  const current = prepared.list;
  const additions: SelectionEntry[] = [];
  for (const block of blocks) {
    if (knownIds.has(block.id)) continue;
    if (current.some((item) => item.file === file && item.blockId === block.id)) continue;
    if (!defaultChecked(block.role)) continue;
    additions.push({ file, blockId: block.id, mode: defaultMode(block), order: current.length + additions.length });
  }
  if (!additions.length) return prepared;
  return { list: normalizeSelection([...current, ...additions]), changed: true };
}

export function reorderSelectionByKey(list: readonly SelectionEntry[], fromKey: string, toKey: string): SelectionEntry[] {
  const sorted = normalizeSelection(list);
  const from = sorted.findIndex((item) => selectionKey(item.file, item.blockId) === fromKey);
  const to = sorted.findIndex((item) => selectionKey(item.file, item.blockId) === toKey);
  if (from < 0 || to < 0) return sorted;
  return reorderSelection(sorted, from, to);
}

export function mergeAgentTabs(remote: readonly AgentDef[] | undefined): { builtins: AgentDef[]; customs: AgentDef[] } {
  const list = remote ?? [];
  const byId = new Map(list.map((agent) => [agent.id, agent]));
  const builtins = BUILTIN_AGENTS.map((def) => {
    const incoming = byId.get(def.id);
    if (!incoming) return { ...def };
    return {
      ...def,
      ...incoming,
      id: def.id,
      name: incoming.name || def.name,
      relPath: def.id === 'grok' ? undefined : incoming.relPath ?? def.relPath,
      format: incoming.format ?? def.format,
      builtin: true,
    };
  });
  const customs = list.filter((agent) => !BUILTIN_IDS.has(agent.id));
  return { builtins, customs };
}

export function newCustomAgentId(name: string, existing: readonly string[]): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'agent';
  const ids = new Set(existing);
  let id = `custom:${slug}`;
  let n = 2;
  while (ids.has(id)) {
    id = `custom:${slug}-${n}`;
    n += 1;
  }
  return id;
}

export function newPresetId(existing: readonly string[]): string {
  const ids = new Set(existing);
  let n = existing.length + 1;
  let id = `preset-${n}`;
  while (ids.has(id)) {
    n += 1;
    id = `preset-${n}`;
  }
  return id;
}

const QUARANTINE_DIR = '_quarantine';

function agentSegment(value: string, ids: ReadonlySet<string>): string | null {
  const parts = value.split(/[\\/]+/).filter(Boolean);
  for (const part of parts) {
    if (part === QUARANTINE_DIR) continue;
    if (ids.has(part)) return part;
  }
  return null;
}

export function guessQuarantineAgent(item: QuarantinedFile, agentIds: readonly string[]): string | null {
  const ids = new Set(agentIds);
  const fromPath = agentSegment(item.path, ids);
  if (fromPath) return fromPath;
  const fromReason = agentSegment(item.reason, ids);
  if (fromReason) return fromReason;
  const match = item.reason.match(/agent\s*[:=]\s*([A-Za-z0-9_.:-]+)/);
  if (!match) return null;
  const id = match[1] ?? '';
  if (!id) return null;
  if (ids.size === 0 || ids.has(id)) return id;
  return null;
}

export interface QuarantineGroup {
  agentId: string;
  files: QuarantinedFile[];
}

export function groupQuarantine(items: readonly QuarantinedFile[], agentIds: readonly string[]): QuarantineGroup[] {
  const buckets = new Map<string, QuarantinedFile[]>();
  for (const item of items) {
    const key = guessQuarantineAgent(item, agentIds) ?? '_unknown';
    const list = buckets.get(key) ?? [];
    list.push(item);
    buckets.set(key, list);
  }
  return [...buckets.entries()].map(([agentId, files]) => ({ agentId, files }));
}

export function quarantineCount(groups: readonly QuarantineGroup[], agentId: string): number {
  return groups.find((group) => group.agentId === agentId)?.files.length ?? 0;
}

export function defaultSourceMarkdown(): string {
  return `---
lkw: conversation/1
agent: <agentId>
title: <标题>
started: <ISO 时间>
---
## [U1] 用户
（用户原话）
## [A1] 回答
> 摘要：一行摘要（可选，长回答建议写）
正文……
`;
}

/** 路径比较：忽略斜杠方向、大小写和末尾分隔符。 */
export function sameStoredPath(a: string, b: string): boolean {
  const norm = (value: string) => value.normalize('NFC').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

export function isQuarantinePath(filePath: string): boolean {
  return filePath.split(/[\\/]+/).includes('_quarantine');
}

export function isConversationMarkdownName(name: string): boolean {
  return /\.(md|markdown)$/i.test(name.trim());
}

export const BASE_ONLY_ONE = '上下文底座只能放一个对话文件';
export const BASE_NEED_FILE = '请拖入一个对话存档文件';
export const BASE_NO_DIR = '文件夹不能作为上下文底座，请拖入对话存档文件';
export const BASE_NO_WEB = '网络资料不能作为上下文底座，请拖入本机对话存档文件';
export const BASE_NO_PATH = '没有真实路径，不能设为上下文底座';
export const BASE_NOT_CONVERSATION = '不是对话存档文件。需要符合对话格式的 Markdown';
export const BASE_QUARANTINE = '这个文件已隔离，格式不合规，不能设为上下文底座';
export const BASE_PARSE_UNAVAILABLE = '解析接口未连接，无法确认这是合规的对话文件';
export const BASE_UNCONFIRMED = '无法确认这是合规的对话文件';
export const BASE_API_MISSING = '底座接口未连接';
export const BASE_FORMAT_REJECT = '文件不符合对话存档格式';
export const BASE_WAIT_FOR_AGENT = '先让 agent 建立对话';
export const ARCHIVE_EMPTY = '还没有对话。先让 agent 建立对话。';
export const ACTIVE_AGENT_HINT = '顶栏『复制当前工作区入口』将按所选 agent 的格式复制';

export function conversationFileCount(snapshot: { groups?: readonly { files?: readonly unknown[] }[] } | null | undefined): number {
  if (!snapshot?.groups) return 0;
  let count = 0;
  for (const group of snapshot.groups) count += group.files?.length ?? 0;
  return count;
}

/** 一份合规对话都没有时，不能拖入或设为底座。 */
export function contextBaseLocked(fileCount: number): boolean {
  return fileCount <= 0;
}

export type ArchivePickVia = 'pickArchiveDir' | 'pickFolder' | 'missing';

/** 优先主进程的存档目录选择；没有则退到带 archiveLocation 键的通用选目录。 */
export function archivePickVia(available: { pickArchiveDir: boolean; pickFolder: boolean }): ArchivePickVia {
  if (available.pickArchiveDir) return 'pickArchiveDir';
  if (available.pickFolder) return 'pickFolder';
  return 'missing';
}

export function pathFromArchivePick(raw: unknown): string | null {
  if (typeof raw === 'string') return raw.trim() || null;
  if (!isRecord(raw)) return null;
  const path = typeof raw.dir === 'string' ? raw.dir : typeof raw.path === 'string' ? raw.path : '';
  return path.trim() || null;
}

/** 接口没挂上时只在栏里说明。格式不合规要弹出提示。 */
export function baseRejectNeedsPrompt(reason: string): boolean {
  return reason !== BASE_API_MISSING && reason !== BASE_PARSE_UNAVAILABLE;
}

export interface BaseDropItem {
  kind: 'file' | 'dir' | 'web' | 'unknown';
  path?: string;
  name?: string;
  /** 已经在对话存档列表里，扫描时通过了格式校验。 */
  archived?: boolean;
}

/** 把现有拖入识别的一块，收成底座能判断的形状。没有路径、也没有相对路径的引用视为网络资料。 */
export function baseDropItemFromPiece(
  piece: {
    ref?: { absPath?: string; name?: string; relPath?: string };
    kind?: 'dir';
    reject?: string;
  },
  archived = false,
): BaseDropItem {
  const name = piece.ref?.name;
  const path = piece.ref?.absPath?.trim() || '';
  if (piece.kind === 'dir' || piece.reject === 'dir') return { kind: 'dir', name, ...(path ? { path } : {}) };
  if (piece.reject === 'web') return { kind: 'web', name };
  if (piece.reject) return { kind: 'unknown', name };
  if (!piece.ref) return { kind: 'unknown' };
  if (!path) {
    if (!piece.ref.relPath) return { kind: 'web', name };
    return { kind: 'unknown', name };
  }
  return { kind: 'file', path, name: name || baseName(path), archived };
}

export type BaseDropDecision =
  | { ok: true; path: string; name: string; archived: boolean }
  | { ok: false; reason: string };

/** 拖入结果里只留一个对话文件。文件夹、网络资料、多文件和不合规扩展名都拒绝。 */
export function decideBaseDrop(items: readonly BaseDropItem[]): BaseDropDecision {
  if (!items.length) return { ok: false, reason: BASE_NEED_FILE };
  const files = items.filter((item) => item.kind === 'file' && item.path);
  const dirs = items.filter((item) => item.kind === 'dir');
  const webs = items.filter((item) => item.kind === 'web');
  const unknowns = items.filter((item) => item.kind === 'unknown' || (item.kind === 'file' && !item.path));
  if (!files.length && dirs.length) return { ok: false, reason: BASE_NO_DIR };
  if (!files.length && webs.length) return { ok: false, reason: BASE_NO_WEB };
  if (!files.length && unknowns.length) return { ok: false, reason: BASE_NO_PATH };
  if (!files.length) return { ok: false, reason: BASE_NEED_FILE };
  if (files.length > 1 || dirs.length || webs.length || unknowns.length) return { ok: false, reason: BASE_ONLY_ONE };
  const file = files[0]!;
  const path = file.path!;
  if (isQuarantinePath(path)) return { ok: false, reason: BASE_QUARANTINE };
  const archived = file.archived === true;
  const name = file.name || baseName(path);
  if (!archived && !isConversationMarkdownName(name) && !isConversationMarkdownName(path)) {
    return { ok: false, reason: BASE_NOT_CONVERSATION };
  }
  return { ok: true, path, name, archived };
}

const CONV_HEADING = /^##\s+\[([UA])(\d+)\]\s*(.*)$/;
const CONV_LOOSE_HEADING = /^##\s+\[/;

export type ConversationInspection =
  | { ok: true; agent: string; title: string; blockIds: string[] }
  | { ok: false; reason: string };

function unquoteFrontmatter(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/** §4 对话格式。不合规时 reason 给界面提示，不写入底座。 */
export function inspectConversation(raw: string): ConversationInspection {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!text.trim()) return { ok: false, reason: '文件是空的' };
  if (text.length > 4 * 1024 * 1024) return { ok: false, reason: '文件超过 4MB' };
  if (!text.startsWith('---\n')) return { ok: false, reason: '缺少 frontmatter（文件应以 --- 开头）' };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { ok: false, reason: 'frontmatter 没有结束的 ---' };
  const data: Record<string, string> = {};
  for (const line of text.slice(4, end).split('\n')) {
    if (!line.trim()) continue;
    const matched = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!matched) continue;
    data[matched[1]!] = unquoteFrontmatter(matched[2] ?? '');
  }
  const reasons: string[] = [];
  if (data.lkw !== 'conversation/1') reasons.push('frontmatter 的 lkw 必须是 conversation/1');
  if (!data.agent) reasons.push('frontmatter 缺少 agent');
  if (!data.title) reasons.push('frontmatter 缺少 title');
  let bodyStart = end + 4;
  if (text[bodyStart] === '\n') bodyStart += 1;
  const ids: string[] = [];
  let current: { letter: 'U' | 'A'; n: number; id: string } | null = null;
  const flush = (): void => {
    if (!current) return;
    ids.push(current.id);
    current = null;
  };
  for (const line of text.slice(bodyStart).split('\n')) {
    if (!CONV_LOOSE_HEADING.test(line)) continue;
    const matched = CONV_HEADING.exec(line);
    if (!matched || !matched[1] || !matched[2]) {
      reasons.push(`无法识别的分块标题：${line.trim() || line}`);
      continue;
    }
    const n = Number(matched[2]);
    if (!Number.isInteger(n) || n < 1) {
      reasons.push(`无法识别的分块标题：${line.trim()}`);
      continue;
    }
    flush();
    current = { letter: matched[1] as 'U' | 'A', n, id: `${matched[1]}${n}` };
  }
  flush();
  if (!ids.length) reasons.push('至少要有一个 ## [U<n>] 或 ## [A<n>] 分块');
  let lastAny = 0;
  let lastU = 0;
  let lastA = 0;
  for (const id of ids) {
    const n = Number(id.slice(1));
    const role = id[0] === 'U' ? 'user' : 'agent';
    if (n < lastAny) reasons.push(`段号没有递增：${id}`);
    lastAny = n;
    if (role === 'user') {
      if (n <= lastU) reasons.push(`段号没有递增：${id}`);
      lastU = n;
    } else if (n <= lastA) {
      reasons.push(`段号没有递增：${id}`);
      lastA = n;
    }
  }
  if (reasons.length) return { ok: false, reason: Array.from(new Set(reasons)).join('\n') };
  return { ok: true, agent: data.agent!, title: data.title!, blockIds: ids };
}

export function acceptParsedConversation(doc: ParsedConversation | null | undefined): ConversationInspection {
  if (!doc) return { ok: false, reason: BASE_FORMAT_REJECT };
  const reasons: string[] = [];
  if (doc.meta.lkw && doc.meta.lkw !== 'conversation/1') reasons.push('frontmatter 的 lkw 必须是 conversation/1');
  if (!doc.meta.agent) reasons.push('frontmatter 缺少 agent');
  if (!doc.meta.title) reasons.push('frontmatter 缺少 title');
  if (!doc.blocks.length) reasons.push('至少要有一个 ## [U<n>] 或 ## [A<n>] 分块');
  if (reasons.length) return { ok: false, reason: reasons.join('\n') };
  return {
    ok: true,
    agent: doc.meta.agent || '',
    title: doc.meta.title || '',
    blockIds: doc.blocks.map((block) => block.id),
  };
}

export interface BaseAssignInput {
  items: readonly BaseDropItem[];
  /** 读到的正文。不传表示没读到文件内容。 */
  text?: string | null;
  parsed?: ParsedConversation | null;
  parseUnavailable?: boolean;
}

/** 拖入或「设为底座」之前的判断。通过后才调用 agentPanelBaseSet。 */
export function planBaseAssignment(input: BaseAssignInput): { ok: true; path: string; name: string; blockIds: string[] } | { ok: false; reason: string } {
  const decision = decideBaseDrop(input.items);
  if (!decision.ok) return decision;
  if (typeof input.text === 'string') {
    const checked = inspectConversation(input.text);
    if (!checked.ok) return checked;
    return { ok: true, path: decision.path, name: decision.name, blockIds: checked.blockIds };
  }
  if (decision.archived) return { ok: true, path: decision.path, name: decision.name, blockIds: [] };
  if (input.parsed) {
    const checked = acceptParsedConversation(input.parsed);
    if (!checked.ok) return checked;
    return { ok: true, path: decision.path, name: decision.name, blockIds: checked.blockIds };
  }
  if (input.parseUnavailable) return { ok: false, reason: BASE_PARSE_UNAVAILABLE };
  return { ok: false, reason: BASE_UNCONFIRMED };
}

export function blockInContextBase(file: string, blockId: string, base: Pick<ContextBase, 'path' | 'blockIds'> | null | undefined): boolean {
  if (!base?.path || !sameStoredPath(file, base.path)) return false;
  if (!base.blockIds.length) return true;
  return base.blockIds.includes(blockId);
}

function stringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && item.trim()) ids.push(item.trim());
    else if (isRecord(item) && typeof item.id === 'string' && item.id.trim()) ids.push(item.id.trim());
  }
  return ids;
}

export function normalizeContextBase(raw: unknown): ContextBase {
  if (typeof raw === 'string') return { path: raw.trim() || null, blockIds: [] };
  if (!isRecord(raw)) return { path: null, blockIds: [] };
  const pathRaw = typeof raw.path === 'string' ? raw.path : typeof raw.baseFile === 'string' ? raw.baseFile : typeof raw.file === 'string' ? raw.file : '';
  const path = pathRaw.trim() ? pathRaw.trim() : null;
  const namedIds = stringList(raw.blockIds);
  const blockIds = namedIds.length ? namedIds : stringList(raw.blocks);
  const base: ContextBase = { path, blockIds };
  if (typeof raw.agent === 'string' && raw.agent.trim()) base.agent = raw.agent.trim();
  if (typeof raw.title === 'string' && raw.title.trim()) base.title = raw.title.trim();
  return base;
}

export function normalizeBaseSetResult(raw: unknown, arg: ContextBaseSetArg): ContextBaseSetResult {
  if (raw === false) return { ok: false, path: arg?.path ?? null, reason: '未能设为底座' };
  if (isRecord(raw) && (raw.ok === false || raw.accepted === false)) {
    const reason = typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim() : BASE_FORMAT_REJECT;
    return { ok: false, path: arg?.path ?? null, reason };
  }
  const record = isRecord(raw) ? raw : {};
  const path = arg === null ? null : typeof record.path === 'string' && record.path.trim() ? record.path.trim() : arg.path;
  const result: ContextBaseSetResult = { ok: true, path };
  if (typeof record.agent === 'string' && record.agent.trim()) result.agent = record.agent.trim();
  if (typeof record.title === 'string' && record.title.trim()) result.title = record.title.trim();
  return result;
}

export type LocationVia = 'setLocation' | 'archiveRoot' | 'missing';

/** 有 agentPanelLocationSet 就用它；否则退到 agentPanelSaveConfig({archiveRoot})。 */
export function locationChangeVia(available: { setLocation: boolean; saveConfig: boolean }): LocationVia {
  if (available.setLocation) return 'setLocation';
  if (available.saveConfig) return 'archiveRoot';
  return 'missing';
}

function locationDir(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (!isRecord(raw)) return '';
  const path = typeof raw.dir === 'string' ? raw.dir : typeof raw.path === 'string' ? raw.path : typeof raw.location === 'string' ? raw.location : typeof raw.archiveRoot === 'string' ? raw.archiveRoot : '';
  return path.trim();
}

/** IPC agentPanelLocationGet / Set 的返回。旧字段 path 也认。 */
export function normalizeLocationView(raw: unknown): AgentPanelLocationView {
  const record = isRecord(raw) ? raw : {};
  const dir = locationDir(raw);
  const source = record.source === 'env' || record.source === 'location' || record.source === 'default' ? record.source : 'default';
  return {
    dir,
    defaultDir: typeof record.defaultDir === 'string' ? record.defaultDir : dir,
    source,
    envLocked: record.envLocked === true || source === 'env',
  };
}

/**
 * 设置页上显示的路径。
 * 独立位置接口优先（dir，也认旧的 path）；没有时用对话存档目录，并标成降级。
 */
export function displayedAgentDataPath(location: { dir?: string; path?: string } | null, archiveRoot: string | null): { path: string; degraded: boolean; missing: boolean } {
  if (location) {
    const path = typeof location.dir === 'string' ? location.dir : typeof location.path === 'string' ? location.path : '';
    return { path, degraded: false, missing: false };
  }
  if (archiveRoot !== null) return { path: archiveRoot, degraded: true, missing: false };
  return { path: '', degraded: false, missing: true };
}
