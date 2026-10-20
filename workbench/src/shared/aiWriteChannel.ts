import { LINK_PROMPTS, expandLinkPrompt } from './linkPrompts';
/**
 * AI 写入通道。档位只追加，不改 snapshot / ENTRY 已有字段的名字。
 * 高档粘贴内容不得出现真实盘符或绝对路径。
 */
import { defaultDistillTemplate, normalizeDistillTemplate } from './skillDistill';

export const WRITE_TIERS = ['high', 'medium', 'low', 'fast'] as const;
export type WriteTier = (typeof WRITE_TIERS)[number];

export const WRITE_TIER_META: Record<WriteTier, { label: string; token: string; speed: string; safety: string; backup: '软件备份' | '无备份'; scene: string }> = {
  high: {
    label: '高',
    token: '最多',
    speed: '最慢',
    safety: '最安全',
    backup: '软件备份',
    scene: '适合改现有文件和重要文件。AI 只改收件箱副本，批准后软件备份并写回。',
  },
  medium: {
    label: '中',
    token: '中等',
    speed: '中等',
    safety: '较安全',
    backup: '软件备份',
    scene: '提示词更严肃。AI 动手前要确认改哪些文件、改动范围，以及冲突时怎么办。写完由软件审查：哈希冲突、越出根目录、大段删除、Markdown 文件头或块格式损坏。全过才放行；不过则放进待批准，由你决定保留还是还原到备份。',
  },
  low: {
    label: '低',
    token: '较少',
    speed: '较快',
    safety: '较低',
    backup: '软件备份',
    scene: '提示词宽松，少确认。工作台在改动前自动备份。',
  },
  fast: {
    label: '快速通道',
    token: '最少',
    speed: '最快',
    safety: '无额外保护',
    backup: '无备份',
    scene: '直通磁盘，不留软件备份。适合只读和新建。',
  },
};

export const BUILTIN_WRITE_AGENTS = [
  { id: 'codex', name: 'Codex' },
  { id: 'claude', name: 'Claude' },
  { id: 'grok', name: 'Grok' },
  { id: 'cursor', name: 'Cursor' },
  { id: 'antigravity', name: 'Antigravity' },
  { id: 'gemini', name: 'Gemini' },
] as const;

const BUILTIN_IDS = new Set<string>(BUILTIN_WRITE_AGENTS.map((agent) => agent.id));

export interface FolderRule {
  id: string;
  path: string;
  tier: WriteTier;
}

/** 用户拖进或放入链接区的一项。链接正文只带这些，不带整个根。 */
export interface LinkItem {
  id: string;
  path: string;
  name: string;
  kind: 'dir' | 'file';
}

export interface AgentPrompt {
  id: string;
  name: string;
  builtin: boolean;
  templates: Record<WriteTier, string>;
  /** 蒸馏模板。空字符串按缺省全文。不进入 WRITE_TIERS。 */
  distill?: string;
}

/** 抽屉里的提示词槽。蒸馏单独存在，不是写入档。 */
export type PromptSlot = WriteTier | 'distill';

export function withPromptDraft(agent: AgentPrompt, slot: PromptSlot, text: string): AgentPrompt {
  if (slot === 'distill') return { ...agent, distill: text };
  return { ...agent, templates: { ...agent.templates, [slot]: text } };
}

export interface AiWriteSettings {
  version: 1;
  defaultTier: WriteTier;
  /** 侧栏没选 agent 时，粘贴用这一家的模板。 */
  pasteAgentId: string;
  folders: FolderRule[];
  /** 链接区。空数组表示复制链接时不带任何路径。 */
  linkItems: LinkItem[];
  agents: AgentPrompt[];
  /** 高档收件箱根。未设置时不能复制高档链接。不预填。 */
  inboxRoot?: string;
  /** 结束会话前是否先列清单等用户确认。缺省 = 要确认。false 时免确认，但仍进回收站。 */
  inboxDiscardConfirm?: boolean;
}

/** 追加进 snapshot.json。高档不带 absPath。 */
export interface WriteChannelFolderSnap {
  id: string;
  name: string;
  tier: WriteTier;
  virtualPath: string;
  absPath?: string;
  /** 链接区条目是文件夹还是文件。旧快照可以没有。 */
  kind?: 'dir' | 'file';
}

export interface WriteChannelSnapshot {
  defaultTier: WriteTier;
  folders: WriteChannelFolderSnap[];
  /** 当前收件箱目录。不是资料路径。旧快照可以没有。 */
  inboxPath?: string;
}

export interface AiWritePlanFileView {
  virtualPath: string;
  rel: string;
  expectedHash: string;
  actualHash: string;
  conflict: boolean;
  oldText: string;
  newText: string;
  note?: string;
}

export interface AiWritePlanView {
  planId: string;
  rootName: string;
  virtualRoot: string;
  files: AiWritePlanFileView[];
}

export interface AiWriteConflictView {
  id: string;
  path: string;
  expectedHash: string;
  previousHash: string;
  actualHash: string;
  canRestore: boolean;
  /** 中档软件审查没通过的原因。缺省表示旧记录。 */
  reasons?: string[];
}

export type InboxChangeOp = 'modify' | 'create' | 'delete' | 'missing' | 'conflict' | 'rename';

/** 高档收件箱收取后的一行。旧计划仍走 AiWritePlanView。 */
export interface AiWriteChangeView {
  sessionId: string;
  fileId: string;
  inboxRel: string;
  op: InboxChangeOp;
  /** copy 是已映射的副本；created 是收件箱里新出现的文件。 */
  role: 'copy' | 'created';
  binary: boolean;
  copySize: number;
  nextSize: number;
  needsLanding: boolean;
  landingAbs: string;
  oldText: string;
  newText: string;
  note?: string;
}

export interface AiWritePending {
  plans: AiWritePlanView[];
  conflicts: AiWriteConflictView[];
  /** 高档收件箱里已收取、还没逐文件处理的改动。未收取时为空。 */
  changes?: AiWriteChangeView[];
}

/** 资料夹里可清理的旧 .kb-stage。有其它文件的不出现在这份清单里。 */
export interface AiWriteLegacyStage {
  path: string;
  /** empty：里面没有文件。processed-plan：只剩已经处理过的计划。 */
  kind: 'empty' | 'processed-plan';
}

export function legacyStageSummary(row: AiWriteLegacyStage): string {
  return `${row.path} · ${row.kind === 'empty' ? '空' : '只剩已处理的计划'}`;
}

export type AiWriteApplyDecision = 'approve' | 'reject' | 'delete' | 'overwrite';

export type AiWriteApplyResult =
  | { ok: true }
  | { ok: false; reason: 'conflict'; file: string; expectedHash: string; actualHash: string };

/** 拖放写入计划。只在收件箱里留副本，批准前不写目标文件。 */
export interface AiWritePlanDropResult {
  sessionId: string;
  fileIds: string[];
  nameClash: boolean;
}

export interface AiWritePlanDropInput {
  targetRootPath: string;
  targetRootId?: string;
  targetRelPath: string;
  files: {
    name: string;
    sourceAbs?: string;
    resourceId?: string;
    entryKind?: 'file' | 'dir';
  }[];
}

/** 有未批准变更时，待删清单上的醒目说明。 */
export const DISCARD_PENDING_WARNING = '【未批准】有未批准或待批准的变更。结束会话不会把这些变更写回原件。';

/** 结束会话的结果。还有未批准变更时不删，等用户确认后才进回收站。 */
export interface AiWriteDiscardResult {
  sessionId: string;
  /** 副本目录。 */
  inboxDir: string;
  /** 副本目录里的普通文件数。没有点过删除时也可能先数出来，供确认框使用。 */
  fileCount: number;
  /** 还有未批准的变更或待批准条目。为 true 时没有删除。 */
  needsConfirm: boolean;
  /** 未批准或待批准的条数。没有则为 0。 */
  pendingCount: number;
  /** 有未批准变更时的醒目说明。没有则为空。 */
  warning: string;
  removed: boolean;
  /** trash：确认后进了回收站。结束会话不再用 rm，'rm' 只为旧调用方保留类型。 */
  via?: 'rm' | 'trash';
}

/** 给结束会话的确认框。有未批准变更时，醒目说明放在最前面。 */
export function discardManifestBody(row: AiWriteDiscardResult): string {
  const lines = [
    row.warning,
    `会话编号 ${row.sessionId}`,
    `副本目录 ${row.inboxDir}`,
    `文件数 ${row.fileCount}`,
    row.pendingCount > 0 ? `有未批准或待批准的条目 ${row.pendingCount} 项。` : '没有未批准或待批准的条目。',
    '确认后才把整个副本目录移入系统回收站。资料原件和已有备份都还在。',
  ].filter((line) => line.length > 0);
  return lines.join('\n');
}

/** 链接区一行的复制状态。路径只在用户自己的界面上，不进粘贴。 */
export interface AiWriteLinkRow {
  id: string;
  kind: 'dir' | 'file';
  path: string;
  name: string;
  tier: WriteTier;
  copied: number;
  skipped: number;
  /** 文件整份被跳过时的原因，例如超过大小上限。 */
  skipReason?: string;
}

export interface AiWriteLinkStatus {
  needsInbox: boolean;
  rows: AiWriteLinkRow[];
  session: {
    sessionId: string;
    inboxDir: string;
    status: 'open' | 'collected' | 'applied' | 'rejected' | 'discarded';
    dirty: boolean;
    truncated: boolean;
    skipped: number;
    /** 未收取 / 已收取 / 有未收取改动 */
    label: string;
    /** 除此之外还有几份进行中的会话。 */
    otherOpen: number;
  } | null;
}

export type AiWriteApproveResult =
  | { ok: true; written: string[] }
  | { ok: false; reason: 'conflict'; file: string; expectedHash: string; actualHash: string };

/** 与侧栏导入链接的快速通道正文一致。 */
export function classicRootEntry(roots: readonly string[], entry: string): string {
  return expandLinkPrompt(LINK_PROMPTS.rootEntryLink, {roots:roots.join('\n') || '(none)',entry});
}

export function isWriteTier(value: unknown): value is WriteTier {
  return value === 'high' || value === 'medium' || value === 'low' || value === 'fast';
}

export function tierRank(tier: WriteTier): number {
  if (tier === 'high') return 3;
  if (tier === 'medium') return 2;
  if (tier === 'low') return 1;
  return 0;
}

export function strongestTier(tiers: readonly WriteTier[]): WriteTier {
  return tiers.reduce<WriteTier>((best, tier) => (tierRank(tier) > tierRank(best) ? tier : best), 'fast');
}

/** 比较用。不依赖 node:path，渲染进程也能用。 */
export function normPath(value: string): string {
  return value.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function baseName(value: string): string {
  const parts = value.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || value;
}

export function parentPath(value: string): string {
  const clean = value.replace(/[\\/]+$/, '');
  const idx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  if (idx <= 0) return clean;
  return clean.slice(0, idx);
}

export function isInside(parent: string, child: string): boolean {
  const root = normPath(parent);
  const target = normPath(child);
  return target === root || target.startsWith(`${root}/`);
}

export function rootKey(absPath: string): string {
  const norm = normPath(absPath);
  let hash = 5381;
  for (let i = 0; i < norm.length; i++) hash = Math.imul(hash, 33) ^ norm.charCodeAt(i);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function virtualRoot(absPath: string): string {
  return `kb-stage://${rootKey(absPath)}`;
}

/**
 * 禁止把本功能的数据写进 Windows 正式用户数据目录。
 * 只做字符串判断，调用方在真正落盘前再拦一次。
 */
export function isLocalKnowledgeUserData(target: string): boolean {
  const norm = String(target || '').replace(/\//g, '\\');
  if (/%localappdata%\\localknowledgeworkbench(?:\\|$)/i.test(norm)) return true;
  if (/\\appdata\\local\\localknowledgeworkbench(?:\\|$)/i.test(norm)) return true;
  let local = '';
  try {
    local = (globalThis as { process?: { env?: { LOCALAPPDATA?: string } } }).process?.env?.LOCALAPPDATA || '';
  } catch {
    local = '';
  }
  if (!local) return false;
  const ban = local.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase() + '\\localknowledgeworkbench';
  const candidate = norm.toLowerCase();
  return candidate === ban || candidate.startsWith(`${ban}\\`);
}

/** Defaults describe the selected channel without claiming system authority. */
export function defaultTemplate(agentId: string, tier: WriteTier, name = ''): string {
  return tier === 'high' ? LINK_PROMPTS.high.replace('{{inboxPath}}', '(see supplied inbox)') : LINK_PROMPTS[tier];
}

export function defaultAgents(): AgentPrompt[] {
  return BUILTIN_WRITE_AGENTS.map((agent) => ({
    id: agent.id,
    name: agent.name,
    builtin: true,
    templates: {
      high: defaultTemplate(agent.id, 'high', agent.name),
      medium: defaultTemplate(agent.id, 'medium', agent.name),
      low: defaultTemplate(agent.id, 'low', agent.name),
      fast: defaultTemplate(agent.id, 'fast', agent.name),
    },
    distill: defaultDistillTemplate(),
  }));
}

export function defaultSettings(): AiWriteSettings {
  const agents = defaultAgents();
  return { version: 1, defaultTier: 'fast', pasteAgentId: agents[0]?.id ?? 'codex', folders: [], linkItems: [], agents };
}

function normalizeAgents(value: unknown): AgentPrompt[] {
  if (!Array.isArray(value)) return defaultAgents();
  const out: AgentPrompt[] = [];
  const seen = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;
    const id = typeof rec.id === 'string' ? rec.id.trim() : '';
    const name = typeof rec.name === 'string' ? rec.name.trim() : '';
    if (!id || !name || !/^[\w:.-]{1,64}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const src = rec.templates && typeof rec.templates === 'object' ? (rec.templates as Record<string, unknown>) : {};
    const templates = {} as Record<WriteTier, string>;
    for (const tier of WRITE_TIERS) templates[tier] = typeof src[tier] === 'string' ? (src[tier] as string) : defaultTemplate(id, tier, name);
    out.push({ id, name: name.slice(0, 40), builtin: BUILTIN_IDS.has(id), templates, distill: normalizeDistillTemplate(rec.distill) });
  }
  return out.length ? out : defaultAgents();
}

function normalizeLinkItems(value: unknown): LinkItem[] {
  if (!Array.isArray(value)) return [];
  const out: LinkItem[] = [];
  const seen = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;
    const itemPath = typeof rec.path === 'string' ? rec.path.trim() : '';
    if (!itemPath || isLocalKnowledgeUserData(itemPath)) continue;
    const key = normPath(itemPath);
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = rec.kind === 'file' ? 'file' : 'dir';
    const name = typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim().slice(0, 80) : baseName(itemPath);
    const id = typeof rec.id === 'string' && /^[\w:.-]{1,64}$/.test(rec.id) ? rec.id : `l_${rootKey(itemPath)}`;
    out.push({ id, path: itemPath, name, kind });
  }
  return out;
}

function normalizeFolders(value: unknown): FolderRule[] {
  if (!Array.isArray(value)) return [];
  const out: FolderRule[] = [];
  const seen = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;
    const folderPath = typeof rec.path === 'string' ? rec.path.trim() : '';
    if (!folderPath || isLocalKnowledgeUserData(folderPath)) continue;
    const key = normPath(folderPath);
    if (seen.has(key)) continue;
    seen.add(key);
    const tier = isWriteTier(rec.tier) ? rec.tier : 'fast';
    const id = typeof rec.id === 'string' && /^[\w:.-]{1,64}$/.test(rec.id) ? rec.id : `f_${rootKey(folderPath)}`;
    out.push({ id, path: folderPath, tier });
  }
  return out;
}

export function normalizeSettings(input: unknown): AiWriteSettings {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const agents = normalizeAgents(raw.agents);
  const paste = typeof raw.pasteAgentId === 'string' && agents.some((agent) => agent.id === raw.pasteAgentId) ? raw.pasteAgentId : agents[0]?.id ?? 'codex';
  const inboxText = typeof raw.inboxRoot === 'string' ? raw.inboxRoot.trim() : '';
  const inboxRoot = inboxText && !isLocalKnowledgeUserData(inboxText) ? inboxText : undefined;
  return {
    version: 1,
    defaultTier: isWriteTier(raw.defaultTier) ? raw.defaultTier : 'fast',
    pasteAgentId: paste,
    folders: normalizeFolders(raw.folders),
    linkItems: normalizeLinkItems(raw.linkItems),
    agents,
    ...(inboxRoot ? { inboxRoot } : {}),
    ...(raw.inboxDiscardConfirm === false ? { inboxDiscardConfirm: false } : {}),
  };
}

/** 最长的覆盖规则优先，否则用默认档。 */
export function tierFor(absPath: string, settings: AiWriteSettings): WriteTier {
  const target = normPath(absPath);
  let best: { len: number; tier: WriteTier } | null = null;
  for (const rule of settings.folders) {
    const rulePath = normPath(rule.path);
    if (target === rulePath || target.startsWith(`${rulePath}/`)) {
      if (!best || rulePath.length > best.len) best = { len: rulePath.length, tier: rule.tier };
    }
  }
  return best?.tier ?? settings.defaultTier;
}

export function pickAgent(settings: AiWriteSettings, agentId?: string | null): AgentPrompt {
  const wanted = agentId?.trim();
  return settings.agents.find((agent) => agent.id === wanted) ?? settings.agents.find((agent) => agent.id === settings.pasteAgentId) ?? settings.agents[0] ?? defaultAgents()[0]!;
}

export interface ScopedLinkItem {
  path: string;
  name: string;
  kind: 'dir' | 'file';
  tier: WriteTier;
  /** 只有文件夹。相对路径，不含文件。高档不使用。 */
  childDirs?: readonly string[];
  /** 高档文件项：当前内容的 sha256（十六进制）。文件不存在为空串。不含路径。 */
  currentHash?: string;
}

const READ_ON_DEMAND = 'Read only needed scoped files; never enumerate whole roots.';
const EMPTY_LINK = 'No scoped files were supplied. Use conversation evidence only. If a file is required, ask the user to add it; never scan roots.';

/** 高档只给收件箱绝对路径，不附文件清单，不附 expectedHash，不写资料路径。 */
export function highInboxBlock(inboxPath: string | undefined, truncated = false): string {
  return expandLinkPrompt(LINK_PROMPTS.high,{inboxPath:inboxPath || '(missing: stop and request an inbox)'})+
    (inboxPath?'\nInbox scope: '+JSON.stringify(inboxPath):'')+
    (truncated?'\nInbox copies are incomplete. State which necessary sources are missing; do not infer absent content.':'');
}

function scopedBlock(item: ScopedLinkItem): string {
  if(item.tier==='high')return highInboxBlock(undefined);
  return [`Scoped ${item.kind}: ${item.path}`, `Name (data): ${JSON.stringify(item.name)}`,
    item.kind==='dir'?'Child folders (not files): '+JSON.stringify(item.childDirs??[]):'Read only this selected file, not its siblings.',
    `Policy for this item: ${item.tier}.`].join('\n');
}

/**
 * 侧栏导入链接的正文。只描述链接区里的文件夹和文件。
 * 不列文件清单，不带未放入的根目录。
 */
export function composeScopedLink(input: {
  items: readonly ScopedLinkItem[];
  settings: AiWriteSettings;
  agentId?: string | null;
  /** 高档收件箱目录。有高档项时粘贴只给这一条绝对路径。 */
  inboxPath?: string;
  truncated?: boolean;
}): string {
  const settings = input.settings;
  const agent = pickAgent(settings, input.agentId);
  const items = input.items.filter((item) => item.path && !isLocalKnowledgeUserData(item.path));
  if (!items.length && !input.inboxPath) {
    const prompt = settings.defaultTier==='high'?highInboxBlock(undefined):(agent.templates[settings.defaultTier] || defaultTemplate(agent.id,settings.defaultTier)).trim();
    return [prompt, EMPTY_LINK].filter(Boolean).join('\n\n');
  }
  const high = items.filter((item) => item.tier === 'high');
  const rest = items.filter((item) => item.tier !== 'high');
  const tiers: WriteTier[] = items.map((item) => item.tier);
  if (input.inboxPath || high.length) tiers.push('high');
  const strongest = strongestTier(tiers.length ? tiers : [settings.defaultTier]);
  const prompt = (agent.templates[strongest] || '').trim();
  const blocks: string[] = [];
  if (high.length || input.inboxPath) return [highInboxBlock(input.inboxPath,input.truncated===true), rest.length?'Mixed tiers: use a separate link for other targets.':''].filter(Boolean).join('\n\n');
  for (const item of rest) blocks.push(scopedBlock(item));
  return [prompt, READ_ON_DEMAND, ...blocks].filter(Boolean).join('\n\n');
}

/** 快照只列链接区。高档不写 absPath。roots 参数保留给旧调用，不再展开成整棵根。inboxPath 是收件箱目录，不是资料路径。 */
export function toWriteChannelSnapshot(settings: AiWriteSettings, _roots?: readonly { path: string; name?: string }[], inboxPath?: string): WriteChannelSnapshot {
  const folders: WriteChannelFolderSnap[] = settings.linkItems.filter((item) => !isLocalKnowledgeUserData(item.path)).map((item) => {
    const tier = tierFor(item.path, settings);
    const zone = item.kind === 'file' ? parentPath(item.path) : item.path;
    const row: WriteChannelFolderSnap = {
      id: rootKey(item.path),
      name: item.name,
      tier,
      virtualPath: item.kind === 'file' ? `${virtualRoot(zone)}/${baseName(item.path)}` : virtualRoot(item.path),
      kind: item.kind,
    };
    if (tier !== 'high') row.absPath = item.path;
    return row;
  });
  const inbox = inboxPath?.trim();
  return { defaultTier: settings.defaultTier, folders, ...(inbox ? { inboxPath: inbox } : {}) };
}

const CHANGE_OP_LABEL: Record<InboxChangeOp, string> = {
  modify: '修改',
  create: '新建',
  delete: '删除',
  missing: '副本缺失',
  conflict: '冲突',
  rename: '重命名建议',
};

/** 链接区一行。路径只给用户自己看。 */
export function linkRowSummary(row: AiWriteLinkRow): string {
  const kind = row.kind === 'dir' ? '文件夹' : '文件';
  const bits = [`${kind} · ${row.path} · ${WRITE_TIER_META[row.tier].label}`];
  if (row.copied > 0) bits.push(`已复制 ${row.copied}`);
  if (row.skipped > 0) bits.push(row.skipReason ? `已跳过（${row.skipReason}）` : `已跳过 ${row.skipped}`);
  return bits.join(' · ');
}

/** 链接区里的收件箱状态。有其它进行中的会话时注明。 */
export function sessionSummary(session: NonNullable<AiWriteLinkStatus['session']>): string {
  const parts = [`收件箱 ${session.inboxDir}`, session.label];
  if (session.truncated) parts.push('副本不完整');
  if (session.otherOpen > 0) parts.push(`已有进行中的会话（另有 ${session.otherOpen} 份）`);
  return parts.join(' · ');
}

export function changeSummary(row: AiWriteChangeView): string {
  const label = CHANGE_OP_LABEL[row.op];
  if (!row.note) return `${row.inboxRel} · ${label}`;
  if (row.note === label || row.note.startsWith(label)) return `${row.inboxRel} · ${row.note}`;
  return `${row.inboxRel} · ${label} · ${row.note}`;
}

/** 批准页上这一行能出现哪些按钮。对不上源文件夹时先选目标，冲突不能直接批准。 */
export function changeActions(row: AiWriteChangeView): { approve: boolean; reject: boolean; confirmDelete: boolean; overwrite: boolean; pickLanding: boolean } {
  const missingSide = row.op === 'missing' || (row.op === 'rename' && row.role !== 'created');
  const writeSide = row.op === 'modify' || row.op === 'create' || (row.op === 'rename' && row.role === 'created');
  return {
    approve: writeSide && !row.needsLanding,
    reject: true,
    confirmDelete: missingSide,
    overwrite: row.op === 'conflict',
    pickLanding: row.needsLanding,
  };
}

/** 中档：写前副本的哈希必须等于上次放行的 expectedHash，否则算哈希冲突。 */
export function evaluateMediumChange(input: { previousHash: string; expectedHash: string | null; hadFile: boolean }): 'accept' | 'conflict' {
  if (input.expectedHash === null) return 'accept';
  if (!input.previousHash) return input.hadFile ? 'conflict' : 'accept';
  if (input.previousHash !== input.expectedHash) return 'conflict';
  return 'accept';
}

export type MediumReviewReason = 'hash' | 'escape' | 'deletion' | 'format';

export const MEDIUM_REVIEW_LABEL: Record<MediumReviewReason, string> = {
  hash: '哈希冲突',
  escape: '越出根目录',
  deletion: '大段删除',
  format: 'md 文件头或块格式损坏',
};

/** 大段删除：原文已经不短，又去掉了一半以上。短文件整段改写不算。 */
export function isLargeDeletion(previous: string, next: string): boolean {
  if (!previous) return false;
  const prevChars = previous.length;
  const nextChars = next.length;
  const prevLines = previous.split('\n').length;
  const nextLines = next.split('\n').length;
  if (prevChars < 400 && prevLines < 15) return false;
  if (!next.trim()) return true;
  if (prevChars - nextChars >= 200 && nextChars <= prevChars * 0.5) return true;
  if (prevLines - nextLines >= 8 && nextLines <= prevLines * 0.4) return true;
  return false;
}

function unfencedLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const line of lines) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && !(marker[2] ?? '').trim()) fence = null;
      continue;
    }
    if (marker) {
      fence = { char: marker[1]![0]!, length: marker[1]!.length };
      continue;
    }
    out.push(line);
  }
  return out;
}

function frontMatterState(text: string): 'none' | 'closed' | 'open' {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if ((lines[0] ?? '').trim() !== '---') return 'none';
  for (let i = 1; i < lines.length; i++) if ((lines[i] ?? '').trim() === '---') return 'closed';
  return 'open';
}

/** 文件头没闭合、type 注释写坏，或原有的 ## 块结构被抹掉。 */
export function markdownFormatDamaged(previous: string, next: string): boolean {
  if (frontMatterState(next) === 'open') return true;
  if (frontMatterState(previous) === 'closed' && frontMatterState(next) !== 'closed') return true;
  for (const line of unfencedLines(next)) {
    if (!line.includes('<!--') || !/type\s*:/.test(line)) continue;
    if (!/<!--\s*type:\s*\S[^>]*-->/.test(line)) return true;
  }
  const heads = (text: string) => unfencedLines(text).filter((line) => /^##\s+\S/.test(line)).length;
  if (heads(previous) > 0 && heads(next) === 0 && previous.length >= 80) return true;
  return false;
}

export function reviewMediumChange(input: {
  previousHash: string;
  expectedHash: string | null;
  hadFile: boolean;
  zonePath: string;
  absPath: string;
  rel: string;
  previousText: string;
  nextText: string;
  markdown: boolean;
}): MediumReviewReason[] {
  const reasons: MediumReviewReason[] = [];
  if (evaluateMediumChange(input) === 'conflict') reasons.push('hash');
  const relParts = input.rel.replace(/\\/g, '/').split('/');
  if (!input.rel || relParts.some((part) => !part || part === '.' || part === '..') || !isInside(input.zonePath, input.absPath)) reasons.push('escape');
  if (isLargeDeletion(input.previousText, input.nextText)) reasons.push('deletion');
  if (input.markdown && markdownFormatDamaged(input.previousText, input.nextText)) reasons.push('format');
  return reasons;
}

export interface PlanFileInput {
  virtualPath: string;
  expectedHash: string;
  content?: string;
  unifiedDiff?: string;
}

const HASH_RE = /^(?:sha256:)?([0-9a-f]{64})$/i;

export function normalizeHash(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value.trim().toLowerCase();
  if (!text) return '';
  const match = HASH_RE.exec(text);
  return match ? match[1]! : '';
}

export function parsePlanFiles(input: unknown): PlanFileInput[] {
  const raw = input && typeof input === 'object' && Array.isArray((input as { files?: unknown }).files) ? (input as { files: unknown[] }).files : null;
  if (!raw) throw new Error('计划必须是 { files: [...] }');
  const files: PlanFileInput[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;
    const virtualPath = typeof rec.virtualPath === 'string' ? rec.virtualPath.trim() : '';
    if (!virtualPath.startsWith('kb-stage://')) throw new Error('高档计划只能使用 kb-stage:// 虚拟路径');
    const content = typeof rec.content === 'string' ? rec.content : undefined;
    const unifiedDiff = typeof rec.unifiedDiff === 'string' ? rec.unifiedDiff : undefined;
    if (content === undefined && !unifiedDiff) throw new Error('计划文件需要 content 或 unifiedDiff');
    const expected = typeof rec.expectedHash === 'string' ? rec.expectedHash.trim() : '';
    if (expected && !normalizeHash(expected)) throw new Error('expectedHash 必须是 sha256');
    files.push({ virtualPath, expectedHash: expected ? normalizeHash(expected) : '', content, unifiedDiff });
  }
  if (!files.length) throw new Error('计划里没有文件');
  return files;
}

/** 行级 unified diff。对不上就抛错，调用方不得写盘。 */
export function applyUnifiedDiff(original: string, diff: string): string {
  const orig = original.replace(/\r\n/g, '\n').split('\n');
  const rows = diff.replace(/\r\n/g, '\n').split('\n');
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  let index = 0;
  while (index < rows.length && !rows[index]!.startsWith('@@')) index++;
  if (index >= rows.length) throw new Error('diff 里没有 hunk');
  const out: string[] = [];
  let cursor = 0;
  while (index < rows.length) {
    const mark = hunkRe.exec(rows[index] ?? '');
    if (!mark) {
      index++;
      continue;
    }
    const start = Math.max(0, Number(mark[1]) - (mark[1] === '0' ? 0 : 1));
    if (start < cursor) throw new Error('diff hunk 重叠');
    out.push(...orig.slice(cursor, start));
    cursor = start;
    index++;
    while (index < rows.length && !(rows[index] ?? '').startsWith('@@')) {
      const row = rows[index] ?? '';
      if (row.startsWith('\\')) {
        index++;
        continue;
      }
      const tag = row[0];
      const text = row.slice(1);
      if (tag === ' ') {
        if (orig[cursor] !== text) throw new Error('diff 上下文对不上');
        out.push(text);
        cursor++;
      } else if (tag === '-') {
        if (orig[cursor] !== text) throw new Error('diff 删除行对不上');
        cursor++;
      } else if (tag === '+') out.push(text);
      else if (row === '') break;
      else throw new Error('diff 行无法识别');
      index++;
    }
  }
  out.push(...orig.slice(cursor));
  return out.join('\n');
}
