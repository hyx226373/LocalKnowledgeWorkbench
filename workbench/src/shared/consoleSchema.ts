/**
 * 文件化控制台（r11-iface-v2 · 14 号 §一、§二）。
 * 纯函数：解析、校验、草稿文本、索引写回。不读盘、不写 SQLite、不打开面板。
 * UI、主进程草稿落盘、以及 G1 的 console-draft 都调用这里。
 */

export const CONSOLE_FENCE_LANG = 'kb-console';
export const CONSOLE_INDEX_VERSION = 1;
export const CONSOLE_COMMAND_OPEN_ITEM = 'console.openItem';
export const CONSOLE_COMMAND_OPEN_GROUP = 'console.openGroup';
export const KB_RESOURCE_MIME = 'application/x-kb-resource+json';

export const CONSOLE_OPEN_AS = ['tab', 'split-left', 'split-right', 'split-up', 'split-down', 'float', 'reveal-only'] as const;
export type ConsoleOpenAs = (typeof CONSOLE_OPEN_AS)[number];

const OPEN_AS_LABEL: Record<ConsoleOpenAs, string> = {
  tab: '标签',
  'split-left': '向左分屏',
  'split-right': '向右分屏',
  'split-up': '向上分屏',
  'split-down': '向下分屏',
  float: '自由窗口',
  'reveal-only': '仅揭示',
};

export function openAsLabel(openAs: string): string {
  return OPEN_AS_LABEL[openAs as ConsoleOpenAs] ?? `未知方式 ${openAs}`;
}

export function isKnownOpenAs(openAs: string): openAs is ConsoleOpenAs {
  return (CONSOLE_OPEN_AS as readonly string[]).includes(openAs);
}

export type ConsoleRef =
  | { type: 'resource'; resourceId: string }
  | { type: 'workspace-ref'; workspaceId: string; resourceId: string }
  | { type: 'path-hint'; rootId: string; relPath: string };

export interface ConsoleTargetPanel {
  itemId?: string;
  adapterId?: string;
}

export interface ConsoleIndexItem {
  id: string;
  title: string;
  note?: string;
  ref: ConsoleRef;
  order: number;
  openAs: string;
  targetPanel?: ConsoleTargetPanel;
  includeInGroupOpen?: boolean;
}

export interface ConsoleOpenGroup {
  mode: 'sequential' | 'simultaneous';
  maxConcurrent?: number;
}

export interface ConsoleIndex {
  titleNote?: string;
  items: ConsoleIndexItem[];
  openGroup?: ConsoleOpenGroup;
}

export interface ConsoleFrontMatter {
  kbConsole?: number;
  title?: string;
  description?: string;
}

export type ConsoleBlockStatus = 'ok' | 'invalid' | 'unknown-version';

export interface ConsoleFenceBlock {
  start: number;
  end: number;
  bodyStart: number;
  bodyEnd: number;
  fenceVersion: number | null;
  rawBody: string;
  status: ConsoleBlockStatus;
  error?: string;
  /** 文件里出现 approved / approve 时记下，解析不会因此执行任何批准 */
  ignoredFields?: string[];
  kind?: string;
  version?: number;
  data?: unknown;
  index?: ConsoleIndex;
}

export interface ParsedConsoleDocument {
  frontMatter: ConsoleFrontMatter;
  title: string;
  blocks: ConsoleFenceBlock[];
  /** 主定义（kind:console）至多一个。未知版本时仍挂在这里，但没有可执行的 index */
  primary: ConsoleFenceBlock | null;
  errors: string[];
}

export interface ConsoleDraftInput {
  title: string;
  description?: string;
  items: ConsoleIndexItem[];
  titleNote?: string;
  openGroup?: ConsoleOpenGroup;
}

const ID_RE = /^[\w.:-]{1,200}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function badRel(rel: string): boolean {
  if (!rel || rel.includes('\0') || rel.includes('\\') || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return true;
  return rel.split('/').some((p) => p === '' || p === '.' || p === '..' || p.includes(':'));
}

function asId(v: unknown): string | null {
  return typeof v === 'string' && ID_RE.test(v) ? v : null;
}

export function validateRef(raw: unknown): { ref: ConsoleRef } | { error: string } {
  if (!isRecord(raw) || typeof raw.type !== 'string') return { error: 'ref 缺少 type' };
  if (raw.type === 'resource') {
    const resourceId = asId(raw.resourceId);
    if (!resourceId) return { error: 'resourceId 无效' };
    return { ref: { type: 'resource', resourceId } };
  }
  if (raw.type === 'workspace-ref') {
    const workspaceId = asId(raw.workspaceId);
    const resourceId = asId(raw.resourceId);
    if (!workspaceId || !resourceId) return { error: 'workspace-ref 缺少 workspaceId 或 resourceId' };
    return { ref: { type: 'workspace-ref', workspaceId, resourceId } };
  }
  if (raw.type === 'path-hint') {
    const rootId = asId(raw.rootId);
    if (!rootId) return { error: 'path-hint 的 rootId 无效' };
    if (typeof raw.relPath !== 'string' || badRel(raw.relPath)) return { error: 'path-hint 的 relPath 无效' };
    return { ref: { type: 'path-hint', rootId, relPath: raw.relPath } };
  }
  return { error: `不认识的 ref.type：${raw.type}` };
}

export function validateIndexItem(raw: unknown): { item: ConsoleIndexItem } | { error: string } {
  if (!isRecord(raw)) return { error: '条目不是对象' };
  const id = asId(raw.id);
  if (!id) return { error: '条目缺少 id' };
  if (typeof raw.title !== 'string') return { error: `条目 ${id} 缺少 title` };
  if (typeof raw.order !== 'number' || !Number.isFinite(raw.order)) return { error: `条目 ${id} 缺少 order` };
  if (typeof raw.openAs !== 'string' || !raw.openAs) return { error: `条目 ${id} 缺少 openAs` };
  const ref = validateRef(raw.ref);
  if ('error' in ref) return { error: `条目 ${id}：${ref.error}` };
  const item: ConsoleIndexItem = { id, title: raw.title, order: raw.order, openAs: raw.openAs, ref: ref.ref };
  if (raw.note !== undefined) {
    if (typeof raw.note !== 'string') return { error: `条目 ${id} 的 note 不是字符串` };
    item.note = raw.note;
  }
  if (raw.includeInGroupOpen !== undefined) {
    if (typeof raw.includeInGroupOpen !== 'boolean') return { error: `条目 ${id} 的 includeInGroupOpen 不是布尔值` };
    item.includeInGroupOpen = raw.includeInGroupOpen;
  }
  if (raw.targetPanel !== undefined) {
    if (!isRecord(raw.targetPanel)) return { error: `条目 ${id} 的 targetPanel 不是对象` };
    const target: ConsoleTargetPanel = {};
    if (raw.targetPanel.itemId !== undefined) {
      if (typeof raw.targetPanel.itemId !== 'string' || !raw.targetPanel.itemId) return { error: `条目 ${id} 的 targetPanel.itemId 无效` };
      target.itemId = raw.targetPanel.itemId;
    }
    if (raw.targetPanel.adapterId !== undefined) {
      if (typeof raw.targetPanel.adapterId !== 'string' || !raw.targetPanel.adapterId) return { error: `条目 ${id} 的 targetPanel.adapterId 无效` };
      target.adapterId = raw.targetPanel.adapterId;
    }
    item.targetPanel = target;
  }
  return { item };
}

export function validateIndex(raw: unknown): { index: ConsoleIndex } | { error: string } {
  if (!isRecord(raw)) return { error: '缺少 index' };
  if (!Array.isArray(raw.items)) return { error: 'index.items 不是数组' };
  const items: ConsoleIndexItem[] = [];
  const seen = new Set<string>();
  for (const entry of raw.items) {
    const one = validateIndexItem(entry);
    if ('error' in one) return { error: one.error };
    if (seen.has(one.item.id)) return { error: `条目 id 重复：${one.item.id}` };
    seen.add(one.item.id);
    items.push(one.item);
  }
  const index: ConsoleIndex = { items };
  if (raw.titleNote !== undefined) {
    if (typeof raw.titleNote !== 'string') return { error: 'titleNote 不是字符串' };
    index.titleNote = raw.titleNote;
  }
  if (raw.openGroup !== undefined) {
    if (!isRecord(raw.openGroup) || (raw.openGroup.mode !== 'sequential' && raw.openGroup.mode !== 'simultaneous')) {
      return { error: 'openGroup.mode 必须是 sequential 或 simultaneous' };
    }
    const group: ConsoleOpenGroup = { mode: raw.openGroup.mode };
    if (raw.openGroup.maxConcurrent !== undefined) {
      if (typeof raw.openGroup.maxConcurrent !== 'number' || !Number.isInteger(raw.openGroup.maxConcurrent) || raw.openGroup.maxConcurrent < 1) {
        return { error: 'openGroup.maxConcurrent 必须是正整数' };
      }
      group.maxConcurrent = raw.openGroup.maxConcurrent;
    }
    index.openGroup = group;
  }
  return { index };
}

/** 同 order 保持数组原序 */
export function orderedItems(items: readonly ConsoleIndexItem[]): ConsoleIndexItem[] {
  return items.map((item, i) => ({ item, i })).sort((a, b) => a.item.order - b.item.order || a.i - b.i).map((x) => x.item);
}

export function groupOpenPlan(index: ConsoleIndex): { run: ConsoleIndexItem[]; skipped: { id: string; reason: string }[] } {
  const run: ConsoleIndexItem[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const item of orderedItems(index.items)) {
    if (item.includeInGroupOpen === false) continue;
    if (!isKnownOpenAs(item.openAs)) {
      skipped.push({ id: item.id, reason: `未知打开方式 ${item.openAs}` });
      continue;
    }
    run.push(item);
  }
  return { run, skipped };
}

export function parseFrontMatter(text: string): { matter: ConsoleFrontMatter; bodyStart: number } {
  const src = text.replace(/^\uFEFF/, '');
  const bom = text.length - src.length;
  if (!src.startsWith('---')) return { matter: {}, bodyStart: 0 };
  const nl = src.indexOf('\n');
  if (nl < 0 || src.slice(0, nl).trim() !== '---') return { matter: {}, bodyStart: 0 };
  const rest = src.slice(nl + 1);
  const close = rest.search(/\n---\s*(?:\n|$)/);
  if (close < 0) return { matter: {}, bodyStart: 0 };
  const matter: ConsoleFrontMatter = {};
  for (const line of rest.slice(0, close).split('\n')) {
    const m = /^([A-Za-z][\w]*)\s*:\s*(.*?)\s*$/.exec(line.replace(/\r$/, ''));
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, '');
    if (m[1] === 'kbConsole') {
      const n = Number(value);
      if (Number.isInteger(n)) matter.kbConsole = n;
    } else if (m[1] === 'title') matter.title = value;
    else if (m[1] === 'description') matter.description = value;
  }
  const after = nl + 1 + close;
  const tail = src.slice(after).match(/^\n---\s*\n?/);
  return { matter, bodyStart: bom + after + (tail ? tail[0].length : 0) };
}

function firstHeading(text: string, from: number): string | undefined {
  for (const line of text.slice(from).split(/\n/)) {
    const m = /^#\s+(.+?)\s*$/.exec(line.replace(/\r$/, ''));
    if (m) return m[1];
  }
  return undefined;
}

interface TextLine {
  start: number;
  /** 行内容结束（不含换行） */
  end: number;
  /** 下一行起点 */
  nl: number;
  text: string;
}

function splitLines(text: string): TextLine[] {
  const out: TextLine[] = [];
  let i = 0;
  while (i <= text.length) {
    let j = i;
    while (j < text.length && text[j] !== '\n') j++;
    const end = j > i && text[j - 1] === '\r' ? j - 1 : j;
    const nl = j < text.length ? j + 1 : text.length;
    out.push({ start: i, end, nl, text: text.slice(i, end) });
    if (j >= text.length) break;
    i = nl;
  }
  return out;
}

interface FenceSpan {
  openStart: number;
  bodyStart: number;
  bodyEnd: number;
  closeEnd: number;
  info: string;
  closed: boolean;
  bodyText: string;
}

function fenceSpans(text: string): FenceSpan[] {
  const lines = splitLines(text);
  const out: FenceSpan[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^[ ]{0,3}(`{3,})kb-console(?:[ \t]+(.*))?$/.exec(lines[i].text);
    if (!open) continue;
    const marker = open[1].length;
    const info = (open[2] ?? '').trim();
    let close = -1;
    for (let k = i + 1; k < lines.length; k++) {
      const c = /^[ ]{0,3}(`{3,})[ \t]*$/.exec(lines[k].text);
      if (c && c[1].length >= marker) {
        close = k;
        break;
      }
    }
    if (close < 0) {
      const bodyStart = lines[i].nl;
      out.push({ openStart: lines[i].start, bodyStart, bodyEnd: text.length, closeEnd: text.length, info, closed: false, bodyText: text.slice(bodyStart) });
      break;
    }
    const bodyStart = lines[i].nl;
    const bodyEnd = lines[close].start;
    out.push({
      openStart: lines[i].start,
      bodyStart,
      bodyEnd,
      closeEnd: lines[close].nl,
      info,
      closed: true,
      bodyText: text.slice(bodyStart, bodyEnd).replace(/\s+$/, ''),
    });
    i = close;
  }
  return out;
}

function fenceVersionOf(info: string): { version: number | null; error?: string } {
  if (!info) return { version: null };
  const tokens = info.split(/\s+/);
  let version: number | null = null;
  for (const token of tokens) {
    const m = /^v=(\d+)$/.exec(token);
    if (!m) return { version: null, error: `围栏参数无法识别：${token}` };
    const n = Number(m[1]);
    if (!Number.isInteger(n) || n < 1) return { version: null, error: '围栏版本必须是正整数' };
    if (version != null && version !== n) return { version: null, error: '围栏版本重复且不一致' };
    version = n;
  }
  return { version };
}

function ignoredApproval(data: Record<string, unknown>): string[] {
  const names = ['approved', 'approve'].filter((k) => k in data);
  return names;
}

function interpretBlock(span: FenceSpan): ConsoleFenceBlock {
  const base: ConsoleFenceBlock = {
    start: span.openStart,
    end: span.closeEnd,
    bodyStart: span.bodyStart,
    bodyEnd: span.bodyEnd,
    fenceVersion: null,
    rawBody: span.bodyText,
    status: 'invalid',
  };
  if (!span.closed) return { ...base, error: '围栏未闭合' };
  const fv = fenceVersionOf(span.info);
  base.fenceVersion = fv.version;
  const body = span.bodyText;
  base.rawBody = body;
  if (fv.error) return { ...base, error: fv.error };
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch (e) {
    return { ...base, error: `坏 JSON：${(e as Error).message}` };
  }
  if (!isRecord(data)) return { ...base, error: '功能块必须是 JSON 对象', data };
  const ignored = ignoredApproval(data);
  if (ignored.length) base.ignoredFields = ignored;
  if (typeof data.kind !== 'string' || !data.kind) return { ...base, error: '缺少 kind', data };
  base.kind = data.kind;
  if (typeof data.version !== 'number' || !Number.isInteger(data.version) || data.version < 1) {
    return { ...base, error: '缺少 version', data };
  }
  base.version = data.version;
  base.data = data;
  // 体内 version 决定解析器。控制台版本不认识时整块降级，即使围栏写成了 v=1。
  if (data.kind === 'console' && data.version !== CONSOLE_INDEX_VERSION) {
    return { ...base, status: 'unknown-version', error: '未知控制台版本' };
  }
  if (fv.version != null && fv.version !== data.version) {
    return { ...base, error: '围栏版本与体内 version 不一致' };
  }
  if (data.kind === 'console') {
    const index = validateIndex(data.index);
    if ('error' in index) return { ...base, error: index.error };
    return { ...base, status: 'ok', index: index.index, error: undefined };
  }
  return { ...base, status: 'ok', error: undefined };
}

export function parseConsoleDocument(text: string): ParsedConsoleDocument {
  const { matter, bodyStart } = parseFrontMatter(text);
  const blocks: ConsoleFenceBlock[] = [];
  let consoleCount = 0;
  for (const span of fenceSpans(text)) {
    const block = interpretBlock(span);
    if (block.kind === 'console') {
      consoleCount += 1;
      if (consoleCount > 1) {
        blocks.push({ ...block, status: 'invalid', index: undefined, error: '每个文件至多一个 kind:console' });
        continue;
      }
    }
    blocks.push(block);
  }
  const primary = blocks.find((b) => b.kind === 'console') ?? null;
  const errors = blocks.filter((b) => b.status !== 'ok' && b.error).map((b) => b.error!);
  const title = matter.title || firstHeading(text, bodyStart) || '';
  return { frontMatter: matter, title, blocks, primary, errors };
}

export function isConsoleDocument(input: { name?: string; text?: string }): boolean {
  if (input.name && /\.kbconsole\.md$/i.test(input.name)) return true;
  if (!input.text) return false;
  const parsed = parseConsoleDocument(input.text);
  if (parsed.frontMatter.kbConsole === 1) return true;
  return parsed.blocks.some((b) => b.kind === 'console' && (b.status === 'ok' || b.status === 'unknown-version'));
}

export function executableIndex(parsed: ParsedConsoleDocument): ConsoleIndex | null {
  if (!parsed.primary || parsed.primary.status !== 'ok' || !parsed.primary.index) return null;
  return parsed.primary.index;
}

function yamlScalar(value: string): string {
  if (/[:#\n\r"'']/.test(value) || value.trim() !== value || value === '') return JSON.stringify(value);
  return value;
}

export function buildConsoleDraft(input: ConsoleDraftInput): string {
  const title = input.title.trim();
  if (!title) throw new Error('草稿缺少标题');
  const indexCheck = validateIndex({
    ...(input.titleNote ?? input.description ? { titleNote: input.titleNote ?? input.description } : {}),
    items: input.items,
    ...(input.openGroup ? { openGroup: input.openGroup } : {}),
  });
  if ('error' in indexCheck) throw new Error(indexCheck.error);
  const description = input.description?.trim();
  const lines = ['---', 'kbConsole: 1', `title: ${yamlScalar(title)}`];
  if (description) lines.push(`description: ${yamlScalar(description)}`);
  lines.push('---', '', `# ${title}`, '');
  if (description) lines.push(description, '');
  const payload = {
    kind: 'console',
    version: CONSOLE_INDEX_VERSION,
    index: indexCheck.index,
  };
  lines.push('```kb-console v=1', JSON.stringify(payload, null, 2), '```', '');
  return lines.join('\n');
}

export function replacePrimaryIndex(text: string, index: ConsoleIndex): { ok: true; text: string } | { ok: false; error: string } {
  const checked = validateIndex(index);
  if ('error' in checked) return { ok: false, error: checked.error };
  const parsed = parseConsoleDocument(text);
  const block = parsed.primary;
  if (!block || block.status !== 'ok' || !isRecord(block.data)) return { ok: false, error: block?.error || '没有可写回的控制台索引' };
  const data: Record<string, unknown> = { ...block.data, kind: 'console', version: CONSOLE_INDEX_VERSION, index: checked.index };
  delete data.approved;
  delete data.approve;
  const json = JSON.stringify(data, null, 2);
  const rest = text.slice(block.bodyEnd);
  const pad = /^[ ]{0,3}`/.test(rest) ? '\n' : '';
  return { ok: true, text: text.slice(0, block.bodyStart) + json + pad + rest };
}

export function withIndexItems(text: string, add: readonly ConsoleIndexItem[]): { ok: true; text: string } | { ok: false; error: string } {
  const parsed = parseConsoleDocument(text);
  const index = executableIndex(parsed);
  if (!index) return { ok: false, error: parsed.primary?.error || '没有可写回的控制台索引' };
  const items = [...index.items];
  const seen = new Set(items.map((i) => i.id));
  for (const item of add) {
    const one = validateIndexItem(item);
    if ('error' in one) return { ok: false, error: one.error };
    if (seen.has(one.item.id)) return { ok: false, error: `条目 id 重复：${one.item.id}` };
    seen.add(one.item.id);
    items.push(one.item);
  }
  return replacePrimaryIndex(text, { ...index, items });
}

export interface ResourceDragItem {
  resourceId: string;
  sourceKind: 'file' | 'web';
  from:
    | { kind: 'root'; rootId: string; relPath: string }
    | { kind: 'vfolder'; folderId: string }
    | { kind: 'workspace-refs'; workspaceId: string }
    | { kind: 'roots-list' };
}

/** 13 §2.5.1 拖拽 MIME。只读出条目，不解释成移动。 */
export function parseResourceDrag(raw: string): { ok: true; items: ResourceDragItem[] } | { ok: false; error: string } {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: '拖拽数据不是 JSON' };
  }
  if (!isRecord(data) || data.v !== 1 || !Array.isArray(data.items)) return { ok: false, error: '拖拽数据不是 v=1 资料条目' };
  const items: ResourceDragItem[] = [];
  for (const entry of data.items) {
    if (!isRecord(entry)) return { ok: false, error: '拖拽条目不是对象' };
    const resourceId = asId(entry.resourceId);
    if (!resourceId) return { ok: false, error: '拖拽条目缺少 resourceId' };
    if (entry.sourceKind !== 'file' && entry.sourceKind !== 'web') return { ok: false, error: '拖拽条目 sourceKind 无效' };
    if (!isRecord(entry.from) || typeof entry.from.kind !== 'string') return { ok: false, error: '拖拽条目缺少 from' };
    const kind = entry.from.kind;
    let from: ResourceDragItem['from'];
    if (kind === 'root') {
      const rootId = asId(entry.from.rootId);
      if (!rootId || typeof entry.from.relPath !== 'string') return { ok: false, error: '拖拽来源 root 无效' };
      from = { kind: 'root', rootId, relPath: entry.from.relPath };
    } else if (kind === 'vfolder') {
      const folderId = asId(entry.from.folderId);
      if (!folderId) return { ok: false, error: '拖拽来源 vfolder 无效' };
      from = { kind: 'vfolder', folderId };
    } else if (kind === 'workspace-refs') {
      const workspaceId = asId(entry.from.workspaceId);
      if (!workspaceId) return { ok: false, error: '拖拽来源 workspace-refs 无效' };
      from = { kind: 'workspace-refs', workspaceId };
    } else if (kind === 'roots-list') {
      from = { kind: 'roots-list' };
    } else return { ok: false, error: `不认识的拖拽来源 ${kind}` };
    items.push({ resourceId, sourceKind: entry.sourceKind, from });
  }
  return { ok: true, items };
}

export async function resolveConsoleRef(
  ref: ConsoleRef,
  lookupPath: (rootId: string, relPath: string) => Promise<string | null>,
): Promise<{ ok: true; resourceId: string } | { ok: false; reason: string }> {
  if (ref.type === 'resource' || ref.type === 'workspace-ref') return { ok: true, resourceId: ref.resourceId };
  try {
    const id = await lookupPath(ref.rootId, ref.relPath);
    if (!id) return { ok: false, reason: `找不到 path-hint ${ref.rootId}/${ref.relPath}` };
    return { ok: true, resourceId: id };
  } catch (e) {
    return { ok: false, reason: (e as Error).message || 'path-hint 解析失败' };
  }
}

export function nextItemOrder(items: readonly ConsoleIndexItem[]): number {
  let max = 0;
  for (const item of items) if (item.order > max) max = item.order;
  return max + 1;
}

export function indexItemFromDrag(drag: ResourceDragItem, title: string, order: number, id: string): ConsoleIndexItem {
  if (drag.from.kind === 'workspace-refs') {
    return { id, title, order, openAs: 'tab', ref: { type: 'workspace-ref', workspaceId: drag.from.workspaceId, resourceId: drag.resourceId } };
  }
  return { id, title, order, openAs: 'tab', ref: { type: 'resource', resourceId: drag.resourceId } };
}
