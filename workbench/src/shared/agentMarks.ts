/**
 * 标红给 Agent。
 *
 * 「一轮」= 当前工作区 Agent 资料的 session 层（界面称「本轮资料」）。
 * 这一层的资料集重置事件是 `session.cleared`（`clearSession` / 清空本轮资料）。
 * 固定资料和工作台资料引用不会被这个事件清掉。
 * `snapshot.reset` 只是内容、编排或资料树变化后的重发，不是换轮。
 * `workspace.switched` 只改当前工作区指针，不清某一工作区的本轮资料。
 *
 * 标红不写用户源文件。保留策略「本轮有效」在 `session.cleared` 时清空全部标红。
 */

export const MARK_INELIGIBLE_REASON = '只有放进本轮工作台资料或 Agent 资料的文件才能标红';
export const MARK_NEED_SELECTION = '请先选中要标红的文字';
export const MARK_UNMAPPED = '选区无法对应到文件原文';
export const MARK_TOO_LONG = '选区过长，请缩小后再标红';
export const MARK_NO_HIT = '此处没有标红';

/** 换轮事件。见文件头对「一轮」的定义。 */
export const ROUND_RESET_EVENT = 'session.cleared';

export const MAX_MARK_CHARS = 8192;

export type MarkRetention = 'round' | 'manual';

/**
 * 对话气泡标红的来源。只在对话文件上出现。
 * path 是对话文件绝对路径，blockId 如 A3、U1。
 */
export interface AttentionConversation {
  path: string;
  agent: string;
  title: string;
  blockId: string;
}

export interface AttentionRebirth { id: string; no: number; title: string; blockIdx: number }

export interface AttentionMark {
  id: string;
  absPath: string;
  /** 1-based，含首尾行。 */
  startLine: number;
  endLine: number;
  /** 0-based，含起始、不含结束，相对文件原文。 */
  startOffset: number;
  endOffset: number;
  text: string;
  createdAt: string;
  conversation?: AttentionConversation;
  rebirth?: AttentionRebirth;
}

/** 写进 snapshot.json / ENTRY.md 的信号。不含本地 id。 */
export interface AttentionSignal {
  absPath: string;
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
  text: string;
  /** 对话来源。旧标红没有这一项。 */
  conversation?: AttentionConversation;
  rebirth?: AttentionRebirth;
}

export interface AttentionDraft {
  absPath: string;
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
  text: string;
  conversation?: AttentionConversation;
  rebirth?: AttentionRebirth;
  /**
   * 有 conversation 时，startOffset/endOffset 是气泡正文（text）或摘要（summary）里的位置。
   * 主进程按块换算成文件偏移后再落盘。预览标红不带这个字段。
   */
  conversationDisplay?: 'text' | 'summary';
}

export interface MenuItemState {
  id: 'copy' | 'mark' | 'unmark' | 'obsidian';
  testId: 'preview-ctx-copy' | 'preview-ctx-mark' | 'preview-ctx-unmark' | 'preview-ctx-obsidian' | 'chat-ctx-copy' | 'chat-ctx-mark' | 'chat-ctx-unmark';
  label: string;
  enabled: boolean;
  title?: string;
}

export interface PreviewMenuInput {
  hasSelection: boolean;
  fileInRound: boolean;
  /** 右键落点或选区与已有标红重叠。 */
  selectionOrClickOnMark: boolean;
  /** 有选区但对不上原文，或选区过长。 */
  unmapped?: boolean;
  tooLong?: boolean;
  /** 当前预览是 Markdown，并且已经知道文件路径。只有这时才出现「在 Obsidian 打开」。 */
  markdownFile?: boolean;
}

export function markPathKey(absPath: string): string {
  let s = absPath.trim().replace(/\//g, '\\');
  if (!/^[a-zA-Z]:\\?$/.test(s)) s = s.replace(/\\+$/, '');
  return s.toLowerCase();
}

export function sameMarkPath(a: string, b: string): boolean {
  return markPathKey(a) === markPathKey(b) && markPathKey(a) !== '';
}

export function lineAt(source: string, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, source.length));
  let line = 1;
  for (let i = 0; i < clamped; i++) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

export function toSignal(mark: AttentionMark): AttentionSignal {
  const signal: AttentionSignal = {
    absPath: mark.absPath,
    startLine: mark.startLine,
    endLine: mark.endLine,
    startOffset: mark.startOffset,
    endOffset: mark.endOffset,
    text: mark.text,
  };
  if (mark.rebirth) { signal.rebirth = {...mark.rebirth}; signal.absPath = ''; }
  if (mark.conversation) signal.conversation = { ...mark.conversation };
  return signal;
}

export function markFromSelection(
  source: string,
  absPath: string,
  start: number,
  end: number,
  now: string,
  id: string,
): AttentionMark | null {
  if (!absPath.trim()) return null;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > source.length || end <= start) return null;
  const text = source.slice(start, end);
  if (!text.trim()) return null;
  if (text.length > MAX_MARK_CHARS) return null;
  return {
    id,
    absPath: absPath.trim(),
    startLine: lineAt(source, start),
    endLine: lineAt(source, end - 1),
    startOffset: start,
    endOffset: end,
    text,
    createdAt: now,
  };
}

export function rangesOverlap(a0: number, a1: number, b0: number, b1: number): boolean {
  return a0 < b1 && b0 < a1;
}

export function selectionOverlapsMark(marks: readonly AttentionMark[], absPath: string, start: number, end: number): boolean {
  if (!absPath || end < start) return false;
  const point = start === end;
  return marks.some((mark) => {
    if (!sameMarkPath(mark.absPath, absPath)) return false;
    if (point) return start >= mark.startOffset && start < mark.endOffset;
    return rangesOverlap(mark.startOffset, mark.endOffset, start, end);
  });
}

export function unmarkOverlapping(marks: readonly AttentionMark[], absPath: string, start: number, end: number): AttentionMark[] {
  if (!absPath) return marks.slice();
  return marks.filter((mark) => {
    if (!sameMarkPath(mark.absPath, absPath)) return true;
    if (start === end) return !(start >= mark.startOffset && start < mark.endOffset);
    return !rangesOverlap(mark.startOffset, mark.endOffset, start, end);
  });
}

export function marksForPath(marks: readonly AttentionMark[], absPath: string): AttentionMark[] {
  if (!absPath) return [];
  return marks.filter((mark) => sameMarkPath(mark.absPath, absPath));
}

export function eligibilityForPath(
  absPath: string,
  roundPaths: readonly string[],
  opts?: { conversationFile?: boolean },
): { ok: true } | { ok: false; reason: string } {
  if (!absPath.trim()) return { ok: false, reason: MARK_INELIGIBLE_REASON };
  // 对话文件不必先放进本轮资料。其它文件仍要在本轮工作台资料或 Agent 资料里。
  if (opts?.conversationFile) return { ok: true };
  for (const candidate of roundPaths) {
    if (sameMarkPath(candidate, absPath)) return { ok: true };
  }
  return { ok: false, reason: MARK_INELIGIBLE_REASON };
}

function contextMenu(input: PreviewMenuInput, labels: { copy: MenuItemState['testId']; mark: MenuItemState['testId']; unmark: MenuItemState['testId']; markLabel: string; unmarkLabel: string }): MenuItemState[] {
  let markTitle: string | undefined;
  if (!input.fileInRound) markTitle = MARK_INELIGIBLE_REASON;
  else if (input.tooLong) markTitle = MARK_TOO_LONG;
  else if (input.unmapped) markTitle = MARK_UNMAPPED;
  else if (!input.hasSelection) markTitle = MARK_NEED_SELECTION;
  const markEnabled = input.fileInRound && input.hasSelection && !input.unmapped && !input.tooLong;
  return [
    {
      id: 'copy',
      testId: labels.copy,
      label: '复制',
      enabled: input.hasSelection,
      ...(input.hasSelection ? {} : { title: MARK_NEED_SELECTION }),
    },
    {
      id: 'mark',
      testId: labels.mark,
      label: labels.markLabel,
      enabled: markEnabled,
      ...(markTitle ? { title: markTitle } : {}),
    },
    {
      id: 'unmark',
      testId: labels.unmark,
      label: labels.unmarkLabel,
      enabled: input.selectionOrClickOnMark,
      ...(input.selectionOrClickOnMark ? {} : { title: MARK_NO_HIT }),
    },
  ];
}

export function previewContextMenu(input: PreviewMenuInput): MenuItemState[] {
  const items = contextMenu(input, {
    copy: 'preview-ctx-copy',
    mark: 'preview-ctx-mark',
    unmark: 'preview-ctx-unmark',
    markLabel: '标红给 Agent',
    unmarkLabel: '取消此处标红',
  });
  if (input.markdownFile) {
    items.push({
      id: 'obsidian',
      testId: 'preview-ctx-obsidian',
      label: '在 Obsidian 打开',
      enabled: true,
    });
  }
  return items;
}

/** 对话气泡右键。复制、标红；落在已有标红上时「移除标红」可用。 */
export function conversationContextMenu(input: PreviewMenuInput): MenuItemState[] {
  return contextMenu(input, {
    copy: 'chat-ctx-copy',
    mark: 'chat-ctx-mark',
    unmark: 'chat-ctx-unmark',
    markLabel: '标红',
    unmarkLabel: '移除标红',
  });
}

/** 本轮有效遇到换轮事件则清空；一直保留则不动。其它事件都保留。 */
export function marksAfterRoundEvent(
  marks: readonly AttentionMark[],
  retention: MarkRetention,
  eventType: string,
): AttentionMark[] {
  if (retention === 'round' && eventType === ROUND_RESET_EVENT) return [];
  return marks.slice();
}

export interface HighlightSlice {
  text: string;
  markId?: string;
}

export function highlightSlices(
  text: string,
  ranges: readonly { id: string; start: number; end: number; text: string }[],
): HighlightSlice[] {
  const usable = ranges
    .filter((range) => range.start >= 0 && range.end <= text.length && range.end > range.start && text.slice(range.start, range.end) === range.text)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: HighlightSlice[] = [];
  let cursor = 0;
  for (const range of usable) {
    if (range.start < cursor) continue;
    if (range.start > cursor) out.push({ text: text.slice(cursor, range.start) });
    out.push({ text: text.slice(range.start, range.end), markId: range.id });
    cursor = range.end;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor) });
  return out;
}

export function occurrenceOf(source: string, start: number, text: string): number {
  if (!text) return 0;
  let count = 0;
  let from = 0;
  while (from < start) {
    const at = source.indexOf(text, from);
    if (at < 0 || at >= start) break;
    count += 1;
    from = at + text.length;
  }
  return count;
}

export function nthIndex(haystack: string, needle: string, occurrence: number): number | null {
  if (!needle || occurrence < 0) return null;
  let from = 0;
  let seen = 0;
  while (from <= haystack.length) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return null;
    if (seen === occurrence) return at;
    seen += 1;
    from = at + needle.length;
  }
  return null;
}

/**
 * 预览文本与原文一致时用精确偏移。
 * 否则按选中原文在预览里的出现次序，到源文里找同一次出现。
 */
export function mapSelectionToSource(
  source: string,
  previewText: string,
  previewStart: number,
  previewEnd: number,
): { start: number; end: number; text: string } | null {
  if (previewEnd <= previewStart || previewStart < 0 || previewEnd > previewText.length) return null;
  const selected = previewText.slice(previewStart, previewEnd);
  if (!selected.trim()) return null;
  if (selected.length > MAX_MARK_CHARS) return null;
  if (previewText === source) return { start: previewStart, end: previewEnd, text: selected };
  const occurrence = occurrenceOf(previewText, previewStart, selected);
  const at = nthIndex(source, selected, occurrence);
  if (at != null) return { start: at, end: at + selected.length, text: selected };
  const first = nthIndex(source, selected, 0);
  const second = nthIndex(source, selected, 1);
  if (first != null && second == null) return { start: first, end: first + selected.length, text: selected };
  return null;
}

export interface JsonSchemaNode {
  type?: string;
  required?: string[];
  additionalProperties?: boolean;
  properties?: Record<string, unknown>;
  [key: string]: unknown;
}

/** 已有字段必须原样保留。新字段不能进入 required。 */
export function schemaAppendProblems(previous: JsonSchemaNode, next: JsonSchemaNode): string[] {
  const problems: string[] = [];
  if (JSON.stringify(previous.required ?? []) !== JSON.stringify(next.required ?? [])) problems.push('required');
  if (previous.type !== next.type) problems.push('type');
  if (previous.additionalProperties !== next.additionalProperties) problems.push('additionalProperties');
  const prevProps = previous.properties ?? {};
  const nextProps = next.properties ?? {};
  for (const key of Object.keys(prevProps)) {
    if (!(key in nextProps)) problems.push(`removed:${key}`);
    else if (JSON.stringify(prevProps[key]) !== JSON.stringify(nextProps[key])) problems.push(`changed:${key}`);
  }
  const required = new Set(next.required ?? []);
  for (const key of Object.keys(nextProps)) {
    if (key in prevProps) continue;
    if (required.has(key)) problems.push(`new-required:${key}`);
  }
  return problems;
}

const BLOCK_HEADING = /^##\s+\[([UA])(\d+)\]\s*(.*)$/;
const LOOSE_HEADING = /^##\s+\[/;
const SUMMARY_LINE = /^>\s*摘要\s*[:：]\s*(.*)$/;

export interface ConversationRegion {
  id: string;
  role: 'user' | 'agent';
  text: string;
  textStart: number;
  textEnd: number;
  summary?: string;
  summaryStart?: number;
  summaryEnd?: number;
}

export interface ConversationRegions {
  agent: string;
  title: string;
  blocks: ConversationRegion[];
}

function unquoteFm(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/** 去掉 BOM，并把 CRLF 折成 LF。map[i] 是规范化文本第 i 个字符在原文字里的位置。 */
function normalizeConversationSource(source: string): { text: string; map: number[] } {
  let raw = source;
  let base = 0;
  if (raw.startsWith('\uFEFF')) {
    raw = raw.slice(1);
    base = 1;
  }
  const text: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    if (raw.charCodeAt(i) === 13 && raw.charCodeAt(i + 1) === 10) continue;
    text.push(raw[i]!);
    map.push(base + i);
  }
  return { text: text.join(''), map };
}

function rawStart(map: number[], index: number): number {
  if (index <= 0) return map[0] ?? 0;
  return map[index] ?? (map[map.length - 1] ?? 0) + 1;
}

/** 规范化下标的右开区间，落到原文时不含被跳过的 CR。 */
function rawExclusiveEnd(map: number[], exclusive: number, sourceLength: number): number {
  if (exclusive <= 0) return map[0] ?? 0;
  const last = exclusive - 1;
  if (last >= map.length) return sourceLength;
  const at = map[last];
  return at == null ? sourceLength : at + 1;
}

/** 气泡正文是 LF。原文可能是 CRLF，把正文里的位置换成原文里的位置。 */
function lfLocalToRaw(lf: string, raw: string, local: number): number | null {
  if (local < 0 || local > lf.length) return null;
  let li = 0;
  let ri = 0;
  while (li < local) {
    if (ri >= raw.length) return null;
    if (lf[li] === '\n' && raw[ri] === '\r' && raw[ri + 1] === '\n') {
      li += 1;
      ri += 2;
      continue;
    }
    if (lf[li] !== raw[ri]) return null;
    li += 1;
    ri += 1;
  }
  return ri;
}

/**
 * 对话文件里每个块在原文中的区间。正文和摘要的切法与对话解析一致。
 * 不是对话文件时返回 null。
 */
export function conversationRegions(source: string): ConversationRegions | null {
  const { text, map } = normalizeConversationSource(source);
  if (!text.startsWith('---\n')) return null;
  const fence = text.indexOf('\n---', 3);
  if (fence < 0) return null;
  let agent = '';
  let title = '';
  let lkw = '';
  for (const line of text.slice(4, fence).split('\n')) {
    if (!line.trim()) continue;
    const matched = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!matched) continue;
    const value = unquoteFm(matched[2] ?? '');
    if (matched[1] === 'lkw') lkw = value;
    else if (matched[1] === 'agent') agent = value;
    else if (matched[1] === 'title') title = value;
  }
  if (lkw !== 'conversation/1' || !agent || !title) return null;
  let bodyAt = fence + 4;
  if (text[bodyAt] === '\n') bodyAt += 1;

  const blocks: ConversationRegion[] = [];
  type Open = { letter: 'U' | 'A'; id: string; starts: number[]; lines: string[] };
  let current: Open | null = null;
  const flush = (): void => {
    if (!current || !current.lines.length && current.starts.length === 0) {
      current = null;
      return;
    }
    const joined = current.lines.join('\n');
    let lead = 0;
    while (lead < joined.length && joined.charCodeAt(lead) === 10) lead += 1;
    let trail = joined.length;
    while (trail > lead && /\s/.test(joined[trail - 1]!)) trail -= 1;
    const mapJoined = (index: number): number => {
      let remain = index;
      for (let i = 0; i < current!.lines.length; i += 1) {
        const line = current!.lines[i]!;
        if (remain <= line.length) return current!.starts[i]! + remain;
        remain -= line.length + 1;
      }
      const last = current!.lines.length - 1;
      return (current!.starts[last] ?? bodyAt) + (current!.lines[last]?.length ?? 0);
    };
    const role = current.letter === 'U' ? 'user' : 'agent';
    let blockText = joined.slice(lead, trail);
    let textNormStart = mapJoined(lead);
    let textNormEnd = mapJoined(trail);
    let summary: string | undefined;
    let summaryNormStart: number | undefined;
    let summaryNormEnd: number | undefined;
    if (role === 'agent' && blockText) {
      const lines = blockText.split('\n');
      const first = lines[0] ?? '';
      const sum = SUMMARY_LINE.exec(first.trim());
      if (sum) {
        summary = (sum[1] ?? '').trim();
        const at = summary ? first.indexOf(summary) : -1;
        summaryNormStart = textNormStart + (at >= 0 ? at : 0);
        summaryNormEnd = summaryNormStart + summary.length;
        const restJoined = lines.slice(1).join('\n');
        let restLead = 0;
        while (restLead < restJoined.length && restJoined.charCodeAt(restLead) === 10) restLead += 1;
        let restTrail = restJoined.length;
        while (restTrail > restLead && /\s/.test(restJoined[restTrail - 1]!)) restTrail -= 1;
        blockText = restJoined.slice(restLead, restTrail);
        const origin = lead + first.length + 1 + restLead;
        textNormStart = mapJoined(origin);
        textNormEnd = textNormStart + blockText.length;
      }
    }
    const region: ConversationRegion = {
      id: current.id,
      role,
      text: blockText,
      textStart: rawStart(map, textNormStart),
      textEnd: rawExclusiveEnd(map, textNormEnd, source.length),
    };
    if (summary != null && summaryNormStart != null && summaryNormEnd != null) {
      region.summary = summary;
      region.summaryStart = rawStart(map, summaryNormStart);
      region.summaryEnd = rawExclusiveEnd(map, summaryNormEnd, source.length);
    }
    blocks.push(region);
    current = null;
  };

  let cursor = bodyAt;
  while (cursor <= text.length) {
    const nl = text.indexOf('\n', cursor);
    const lineEnd = nl < 0 ? text.length : nl;
    const line = text.slice(cursor, lineEnd);
    if (LOOSE_HEADING.test(line)) {
      flush();
      const matched = BLOCK_HEADING.exec(line);
      if (matched?.[1] && matched[2] && Number(matched[2]) >= 1) {
        current = { letter: matched[1] as 'U' | 'A', id: `${matched[1]}${matched[2]}`, starts: [], lines: [] };
      } else {
        current = null;
      }
    } else if (current) {
      current.lines.push(line);
      current.starts.push(cursor);
    }
    if (nl < 0) break;
    cursor = nl + 1;
  }
  flush();
  if (!blocks.length) return null;
  return { agent, title, blocks };
}

export function placeConversationSelection(
  source: string,
  input: {
    absPath: string;
    blockId: string;
    displayed: 'text' | 'summary';
    localStart: number;
    localEnd: number;
  },
): AttentionDraft | null {
  if (!input.absPath.trim()) return null;
  if (!Number.isInteger(input.localStart) || !Number.isInteger(input.localEnd) || input.localEnd <= input.localStart) return null;
  const regions = conversationRegions(source);
  if (!regions) return null;
  const block = regions.blocks.find((row) => row.id === input.blockId);
  if (!block) return null;
  const slice = input.displayed === 'summary' ? block.summary : block.text;
  const origin = input.displayed === 'summary' ? block.summaryStart : block.textStart;
  if (slice == null || origin == null) return null;
  if (input.localStart < 0 || input.localEnd > slice.length) return null;
  const picked = slice.slice(input.localStart, input.localEnd);
  if (!picked.trim() || picked.length > MAX_MARK_CHARS) return null;
  const regionEnd = input.displayed === 'summary' ? block.summaryEnd : block.textEnd;
  if (regionEnd == null) return null;
  const rawLocalStart = lfLocalToRaw(slice, source.slice(origin, regionEnd), input.localStart);
  const rawLocalEnd = lfLocalToRaw(slice, source.slice(origin, regionEnd), input.localEnd);
  if (rawLocalStart == null || rawLocalEnd == null || rawLocalEnd <= rawLocalStart) return null;
  const start = origin + rawLocalStart;
  const end = origin + rawLocalEnd;
  const text = source.slice(start, end);
  if (!text.trim() || text.replace(/\r\n/g, '\n') !== picked) return null;
  return {
    absPath: input.absPath.trim(),
    startLine: lineAt(source, start),
    endLine: lineAt(source, end - 1),
    startOffset: start,
    endOffset: end,
    text,
    conversation: {
      path: input.absPath.trim(),
      agent: regions.agent,
      title: regions.title,
      blockId: block.id,
    },
  };
}

function locateNeedle(source: string, origin: number, haystack: string, needle: string, previous: number): number {
  if (!needle || origin < 0) return -1;
  const end = origin + haystack.length;
  if (previous >= origin && previous + needle.length <= end && source.slice(previous, previous + needle.length) === needle) return previous;
  let best = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  let from = 0;
  while (from <= haystack.length) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    const fileAt = origin + at;
    const dist = Math.abs(fileAt - previous);
    if (dist < bestDist) {
      best = fileAt;
      bestDist = dist;
    }
    from = at + Math.max(1, needle.length);
  }
  return best;
}

/**
 * 对话文件变了之后，按块号和原文重新定位。
 * 块不在了，或原文在这一块里找不到，就去掉这条标红。其它文件的标红不动。
 */
export function relocateConversationMarks(marks: readonly AttentionMark[], absPath: string, source: string): AttentionMark[] {
  if (!absPath || !marks.some((mark) => mark.conversation && sameMarkPath(mark.absPath, absPath))) return marks.slice();
  const regions = conversationRegions(source);
  const out: AttentionMark[] = [];
  for (const mark of marks) {
    if (!mark.conversation || !sameMarkPath(mark.absPath, absPath)) {
      out.push(mark);
      continue;
    }
    const block = regions?.blocks.find((row) => row.id === mark.conversation!.blockId);
    if (!block || !regions) continue;
    const inText = locateNeedle(source, block.textStart, source.slice(block.textStart, block.textEnd), mark.text, mark.startOffset);
    const inSummary = block.summaryStart != null && block.summaryEnd != null
      ? locateNeedle(source, block.summaryStart, source.slice(block.summaryStart, block.summaryEnd), mark.text, mark.startOffset)
      : -1;
    let start = inText;
    if (inSummary >= 0 && (start < 0 || Math.abs(inSummary - mark.startOffset) < Math.abs(start - mark.startOffset))) start = inSummary;
    if (start < 0 || source.slice(start, start + mark.text.length) !== mark.text) continue;
    const end = start + mark.text.length;
    out.push({
      ...mark,
      absPath: mark.absPath,
      startOffset: start,
      endOffset: end,
      startLine: lineAt(source, start),
      endLine: lineAt(source, end - 1),
      conversation: {
        path: mark.conversation.path || absPath,
        agent: regions.agent,
        title: regions.title,
        blockId: block.id,
      },
    });
  }
  return out;
}

/** 对话文件 rename 后，标红的文件路径和对话来源路径一起改到新文件。 */
export function retargetAttentionPaths(
  marks: readonly AttentionMark[],
  moves: readonly { from: string; to: string; title?: string }[],
): AttentionMark[] {
  if (!moves.length) return marks.slice();
  return marks.map((mark) => {
    let absPath = mark.absPath;
    let conversation = mark.conversation ? { ...mark.conversation } : undefined;
    for (const move of moves) {
      const absHit = sameMarkPath(absPath, move.from);
      const convHit = !!conversation && sameMarkPath(conversation.path, move.from);
      if (!absHit && !convHit) continue;
      if (absHit) absPath = move.to;
      if (conversation && (convHit || absHit)) {
        conversation = {
          ...conversation,
          path: convHit || sameMarkPath(conversation.path, mark.absPath) ? move.to : conversation.path,
          ...(move.title ? { title: move.title } : {}),
        };
      }
    }
    if (!conversation) return { ...mark, absPath };
    return { ...mark, absPath, conversation };
  });
}

/** 对话文件进了回收站后，去掉指向它的标红。 */
export function forgetAttentionPaths(marks: readonly AttentionMark[], paths: readonly string[]): AttentionMark[] {
  if (!paths.length) return marks.slice();
  return marks.filter((mark) => {
    if (paths.some((file) => sameMarkPath(mark.absPath, file))) return false;
    if (mark.conversation && paths.some((file) => sameMarkPath(mark.conversation!.path, file))) return false;
    return true;
  });
}
