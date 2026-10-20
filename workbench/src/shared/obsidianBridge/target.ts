/**
 * 从笔记原文里找出当前偏移所在的块或标题。
 * 块 ID 只认 kb- 开头，和 lkw-open 的 block 参数一致。围栏和前言里的标记不算。
 */

export interface OpenTarget {
  block?: string;
  heading?: string;
}

const HEADING_RE = /^[ ]{0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const BLOCK_RE = /(?:^|\s)\^(kb-[A-Za-z0-9-]+)\s*$/;

interface Row {
  line: string;
  index: number;
  offset: number;
  inFence: boolean;
  inFrontmatter: boolean;
}

export function lineIndexAt(source: string, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, source.length));
  let line = 0;
  for (let i = 0; i < clamped; i++) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

export function locateOpenTarget(markdown: string, offset: number | null | undefined): OpenTarget {
  if (!markdown || offset == null || !Number.isFinite(offset) || offset < 0) return {};
  const rows = walkRows(markdown);
  const index = Math.min(lineIndexAt(markdown, offset), Math.max(0, rows.length - 1));
  const row = rows[index];
  if (!row || row.inFrontmatter) return {};
  const heading = nearestHeading(rows, index);
  const blockLine = row.inFence ? -1 : paragraphBlockLine(rows, index);
  const blockId = blockLine >= 0 ? blockIdOf(rows[blockLine]?.line ?? '') : undefined;
  const headingId = heading ? blockIdOf(heading.line) : undefined;
  const target: OpenTarget = {};
  const block = blockId || headingId;
  if (block) target.block = block;
  if (heading?.title) target.heading = heading.title;
  return target;
}

/** 预览纯文本和原文不一致时，用落点所在行去原文里找唯一一次出现。 */
export function mapPreviewPoint(source: string, previewText: string, previewOffset: number): number | null {
  if (previewOffset < 0 || previewOffset > previewText.length) return null;
  if (previewText === source) return Math.min(previewOffset, source.length);
  const lineStart = previewText.lastIndexOf('\n', Math.max(0, previewOffset - 1)) + 1;
  const lineBreak = previewText.indexOf('\n', previewOffset);
  const lineEnd = lineBreak < 0 ? previewText.length : lineBreak;
  const line = previewText.slice(lineStart, lineEnd);
  if (!line.trim()) return null;
  const at = source.indexOf(line);
  if (at < 0) return null;
  if (source.indexOf(line, at + line.length) >= 0) return null;
  const col = Math.min(Math.max(0, previewOffset - lineStart), line.length);
  return Math.min(source.length, at + col);
}

/** 右键落在渲染后的标题上、又对不上原文偏移时，按标题文字找。 */
export function locateByHeadingText(markdown: string, visible: string): OpenTarget {
  const cleaned = visible.replace(/\s+/g, ' ').replace(/\s+\^kb-[A-Za-z0-9-]+\s*$/, '').trim();
  if (!cleaned) return {};
  const rows = walkRows(markdown);
  for (const row of rows) {
    if (row.inFence || row.inFrontmatter) continue;
    const heading = parseHeading(row.line);
    if (!heading) continue;
    if (heading.title === cleaned) return locateOpenTarget(markdown, row.offset);
  }
  return {};
}

export function cleanBlockParam(block: unknown): string | undefined {
  if (typeof block !== 'string') return undefined;
  const id = block.trim().replace(/^\^/, '');
  if (!/^kb-[A-Za-z0-9-]+$/.test(id)) return undefined;
  return id;
}

export function cleanHeadingParam(heading: unknown): string | undefined {
  if (typeof heading !== 'string') return undefined;
  const text = heading.replace(/^#+[ \t]*/, '').replace(/[ \t]+\^[A-Za-z0-9-]+$/, '').trim();
  if (!text || /[\u0000-\u001f]/.test(text)) return undefined;
  return text;
}

function walkRows(markdown: string): Row[] {
  const lines = markdown.split('\n');
  let cursor = 0;
  let fence: '`' | '~' | null = null;
  const fmEnd = frontmatterEnd(lines);
  return lines.map((line, index) => {
    const offset = cursor;
    cursor += line.length + 1;
    if (index < fmEnd) return { line, index, offset, inFence: false, inFrontmatter: true };
    const marker = fenceChar(line);
    if (fence) {
      const row = { line, index, offset, inFence: true, inFrontmatter: false };
      if (marker === fence) fence = null;
      return row;
    }
    if (marker) {
      fence = marker;
      return { line, index, offset, inFence: true, inFrontmatter: false };
    }
    return { line, index, offset, inFence: false, inFrontmatter: false };
  });
}

function frontmatterEnd(lines: string[]): number {
  if ((lines[0] ?? '').trim() !== '---') return 0;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return i + 1;
  }
  return 0;
}

function fenceChar(line: string): '`' | '~' | null {
  const match = /^[ ]{0,3}(`{3,}|~{3,})/.exec(line);
  if (!match) return null;
  return match[1][0] as '`' | '~';
}

function parseHeading(line: string): { title: string } | null {
  const match = HEADING_RE.exec(line);
  if (!match) return null;
  const raw = (match[2] ?? '').trim();
  if (!raw) return null;
  const idMatch = /^(.*?)[ \t]+\^[A-Za-z0-9-]+$/.exec(raw);
  const title = (idMatch && idMatch[1].trim() ? idMatch[1] : raw).trim();
  if (!title) return null;
  return { title };
}

function blockIdOf(line: string): string | undefined {
  const match = BLOCK_RE.exec(line);
  return match?.[1];
}

function nearestHeading(rows: Row[], index: number): { line: string; title: string } | null {
  for (let i = index; i >= 0; i--) {
    const row = rows[i];
    if (!row || row.inFence || row.inFrontmatter) continue;
    const heading = parseHeading(row.line);
    if (heading) return { line: row.line, title: heading.title };
  }
  return null;
}

/** 光标所在段落的最后一行。标题自己算一段。空行隔开。 */
function paragraphBlockLine(rows: Row[], index: number): number {
  const row = rows[index];
  if (!row || row.inFence || row.inFrontmatter) return -1;
  if (parseHeading(row.line)) return index;
  let start = index;
  while (start > 0) {
    const prev = rows[start - 1];
    if (!prev || prev.inFence || prev.inFrontmatter || !prev.line.trim() || parseHeading(prev.line)) break;
    start -= 1;
  }
  let end = index;
  while (end + 1 < rows.length) {
    const next = rows[end + 1];
    if (!next || next.inFence || next.inFrontmatter || !next.line.trim() || parseHeading(next.line)) break;
    end += 1;
  }
  return end;
}
