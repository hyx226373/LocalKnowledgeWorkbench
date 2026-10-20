/**
 * 把根路径 Wikilink 从旧路径改到新路径。
 * 只改链接里的路径。显示名、# 后面的块或标题不动。
 * 围栏和行内代码里的 [[ ]] 不当链接。不改文件名。
 */

export interface RenameHop {
  from: string;
  to: string;
}

export interface RewriteResult {
  text: string;
  count: number;
}

export function rewriteWikilinks(markdown: string, records: readonly RenameHop[]): RewriteResult {
  let text = markdown;
  let count = 0;
  for (const record of records) {
    const next = rewriteOne(text, record.from, record.to);
    text = next.text;
    count += next.count;
  }
  return { text, count };
}

export function rewriteOne(markdown: string, from: string, to: string): RewriteResult {
  const fromKey = noteKey(from);
  const toPath = normalizeSlash(to);
  if (!fromKey || !isRootPath(toPath)) return { text: markdown, count: 0 };
  const lines = markdown.split('\n');
  let fence: '`' | '~' | null = null;
  let count = 0;
  const out = lines.map((line) => {
    const marker = fenceChar(line);
    if (fence) {
      if (marker === fence) fence = null;
      return line;
    }
    if (marker && /^[ ]{0,3}(`{3,}|~{3,})/.test(line)) {
      fence = marker;
      return line;
    }
    const next = rewriteLine(line, fromKey, toPath);
    count += next.count;
    return next.line;
  });
  return { text: out.join('\n'), count };
}

function rewriteLine(line: string, fromKey: string, toPath: string): { line: string; count: number } {
  let i = 0;
  let out = '';
  let count = 0;
  while (i < line.length) {
    if (line[i] === '`') {
      let width = 1;
      while (line[i + width] === '`') width += 1;
      const token = '`'.repeat(width);
      const close = line.indexOf(token, i + width);
      if (close < 0) {
        out += line.slice(i);
        break;
      }
      out += line.slice(i, close + width);
      i = close + width;
      continue;
    }
    const bang = line.startsWith('![[', i);
    const open = bang || line.startsWith('[[', i);
    if (open) {
      const innerAt = i + (bang ? 3 : 2);
      const close = line.indexOf(']]', innerAt);
      if (close < 0) {
        out += line.slice(i);
        break;
      }
      const rewritten = rewriteInner(line.slice(innerAt, close), fromKey, toPath);
      if (rewritten == null) out += line.slice(i, close + 2);
      else {
        out += `${bang ? '!' : ''}[[${rewritten}]]`;
        count += 1;
      }
      i = close + 2;
      continue;
    }
    out += line[i];
    i += 1;
  }
  return { line: out, count };
}

function rewriteInner(inner: string, fromKey: string, toPath: string): string | null {
  const bar = inner.indexOf('|');
  const target = bar >= 0 ? inner.slice(0, bar) : inner;
  const alias = bar >= 0 ? inner.slice(bar) : '';
  const hashAt = target.indexOf('#');
  const linkPath = (hashAt >= 0 ? target.slice(0, hashAt) : target).trim();
  const hash = hashAt >= 0 ? target.slice(hashAt) : '';
  if (!isRootPath(linkPath)) return null;
  if (noteKey(linkPath) !== fromKey) return null;
  const next = formatNext(linkPath, toPath);
  if (next === linkPath) return null;
  return `${next}${hash}${alias}`;
}

function formatNext(linkPath: string, toPath: string): string {
  const linkHadMd = linkPath.toLowerCase().endsWith('.md');
  const toIsMd = toPath.toLowerCase().endsWith('.md');
  if (!linkHadMd && toIsMd) return toPath.slice(0, -3);
  return toPath;
}

export function isRootPath(raw: string): boolean {
  const text = raw.trim();
  if (!text || text.includes('\\')) return false;
  if (text.startsWith('/') || text.startsWith('./') || text.startsWith('../')) return false;
  if (/^[A-Za-z]:/.test(text)) return false;
  const parts = text.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..' || part === '.obsidian')) return false;
  return true;
}

function noteKey(raw: string): string {
  const text = normalizeSlash(raw).trim();
  if (!isRootPath(text)) return '';
  return text.toLowerCase().endsWith('.md') ? text.slice(0, -3) : text;
}

function normalizeSlash(raw: string): string {
  return raw.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

function fenceChar(line: string): '`' | '~' | null {
  const match = /^[ ]{0,3}(`{3,}|~{3,})/.exec(line);
  if (!match) return null;
  return match[1][0] as '`' | '~';
}
