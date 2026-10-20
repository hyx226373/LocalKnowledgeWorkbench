import MarkdownIt from 'markdown-it';
import type { Env } from 'markdown-it';
import { SLICE_BUDGET_MS, splitMarkdownBlocks } from './blocks';
import { escapeHtml, unescapeHtml } from './html';
import { highlightCode, normalizeLang } from './highlight';
import { renderMath } from './math';
import { BACK_TOC_BUTTON, isTocHeadingText, slugify } from './backToc';
import type { FormulaSrc, Heading, MarkdownDeps } from './types';

export { slugify };

interface FnDef {
  id: string;
  htmlId: string;
  text: string;
}

interface ReaderEnv extends Env {
  kbHeadings?: Heading[];
  kbSlugs?: Map<string, number>;
  kbFootnotes?: FnDef[];
  kbFnSeen?: Map<string, string>;
  kbFormulas?: FormulaSrc[];
}

export interface RenderedMarkdown {
  html: string;
  headings: Heading[];
  formulas: FormulaSrc[];
}

export interface MarkdownStream {
  done(): boolean;
  step(budgetMs?: number, now?: () => number): { html: string; ms: number };
  headings(): Heading[];
  formulas(): FormulaSrc[];
  toc(): string;
}

function uniqueSlug(text: string, env: ReaderEnv): string {
  const counts = (env.kbSlugs ??= new Map());
  const base = `kb-h-${slugify(text)}`;
  const n = (counts.get(base) ?? 0) + 1;
  counts.set(base, n);
  return n === 1 ? base : `${base}-${n}`;
}

function tokenText(token: { children?: { content: string; children?: { content: string }[] | null }[] | null; content: string }): string {
  if (token.children?.length) {
    return token.children.map((c) => (c.children?.length ? c.children.map((x) => x.content || '').join('') : c.content || '')).join('');
  }
  return token.content || '';
}

function lineText(state: { src: string; bMarks: number[]; eMarks: number[]; tShift: number[] }, line: number): string {
  return state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
}

export function renderToc(headings: Heading[]): string {
  if (!headings.length) return '';
  const links = headings
    .map((h) => {
      const level = Math.min(6, Math.max(1, h.level));
      return `<a class="kb-toc-l${level}" href="#${h.id}" data-kb-anchor="${h.id}">${escapeHtml(h.text)}</a>`;
    })
    .join('');
  return `<nav class="kb-md-toc" data-testid="md-toc" aria-label="目录">${links}</nav>`;
}

function resolveImage(src: string, deps: MarkdownDeps): string {
  if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('/')) return src;
  let decoded = src;
  try {
    decoded = decodeURIComponent(src);
  } catch {
    decoded = src;
  }
  const parts = (deps.relDir ? deps.relDir.split('/') : []).concat(decoded.split('/'));
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p && p !== '.') out.push(p);
  }
  return deps.fileUrl(out.join('/'));
}

function createReaderMarkdown(deps: MarkdownDeps): InstanceType<typeof MarkdownIt> {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    highlight(code, lang) {
      if (normalizeLang(lang) === 'mermaid') {
        return `<pre class="kb-mermaid" data-testid="md-mermaid"><code>${escapeHtml(code)}</code></pre>`;
      }
      return highlightCode(code, lang);
    },
  });

  md.block.ruler.before('reference', 'kb_math_block', (state, startLine, endLine, silent) => {
    const open = lineText(state, startLine);
    let kind: 'dollar' | 'bracket' | null = null;
    let single: string | null = null;
    if (open.startsWith('$$')) {
      const closeAt = open.slice(2).indexOf('$$');
      if (closeAt >= 0) {
        single = open.slice(2, 2 + closeAt).trim();
        if (!single) return false;
      } else kind = 'dollar';
    } else if (open.startsWith('\\[')) {
      const closeAt = open.indexOf('\\]');
      if (closeAt >= 0) {
        single = open.slice(2, closeAt).trim();
        if (!single) return false;
      } else kind = 'bracket';
    } else return false;
    if (silent) return true;
    let next = startLine + 1;
    const parts: string[] = [];
    if (single == null) {
      const rest = kind === 'dollar' ? open.slice(2) : open.slice(2);
      if (rest.trim()) parts.push(rest);
      let closed = false;
      for (; next < endLine; next++) {
        const l = lineText(state, next);
        const mark = kind === 'dollar' ? '$$' : '\\]';
        const at = l.indexOf(mark);
        if (at >= 0) {
          if (l.slice(0, at).trim()) parts.push(l.slice(0, at));
          closed = true;
          next++;
          break;
        }
        parts.push(l);
      }
      if (!closed) return false;
      single = parts.join('\n').trim();
    }
    const token = state.push('kb_math_block', 'div', 0);
    token.content = single;
    token.block = true;
    token.info = 'display';
    token.map = [startLine, next];
    state.line = next;
    return true;
  }, { alt: ['paragraph', 'blockquote', 'list'] });

  md.block.ruler.before('reference', 'kb_fn_def', (state, startLine, endLine, silent) => {
    const line = lineText(state, startLine);
    const m = /^\[\^([^\]]+)\]:[ \t]?(.*)$/.exec(line);
    if (!m) return false;
    if (silent) return true;
    const env = state.env as ReaderEnv;
    let text = m[2];
    let next = startLine + 1;
    while (next < endLine && !state.isEmpty(next)) {
      const indent = state.sCount[next] - state.blkIndent;
      if (indent < 4 && state.tShift[next] < 4) break;
      text += '\n' + lineText(state, next).trim();
      next++;
    }
    const seen = (env.kbFnSeen ??= new Map());
    const counts = (env.kbSlugs ??= new Map());
    const base = `kb-fn-${slugify(m[1])}`;
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    const htmlId = n === 1 ? base : `${base}-${n}`;
    if (!seen.has(m[1])) seen.set(m[1], htmlId);
    (env.kbFootnotes ??= []).push({ id: m[1], htmlId, text });
    state.line = next;
    return true;
  }, { alt: ['paragraph', 'blockquote', 'list'] });

  md.inline.ruler.before('escape', 'kb_math', (state, silent) => {
    const start = state.pos;
    const src = state.src;
    const max = state.posMax;
    if (start >= max) return false;
    if (src.charCodeAt(start) === 36) {
      const display = src.charCodeAt(start + 1) === 36;
      const openLen = display ? 2 : 1;
      if (start + openLen >= max) return false;
      if (!display && /\s/.test(src[start + 1])) return false;
      const closer = display ? '$$' : '$';
      const end = src.indexOf(closer, start + openLen);
      if (end < 0) return false;
      const body = src.slice(start + openLen, end);
      if (!body.trim() || body.includes('\n')) return false;
      if (!display && /\s/.test(src[end - 1])) return false;
      if (!silent) {
        const token = state.push('kb_math', 'span', 0);
        token.content = body.trim();
        token.info = display ? 'display' : 'inline';
        token.markup = closer;
      }
      state.pos = end + closer.length;
      return true;
    }
    if (src.charCodeAt(start) === 92 && start + 1 < max) {
      const kind = src[start + 1];
      if (kind !== '(' && kind !== '[') return false;
      const close = kind === '(' ? '\\)' : '\\]';
      const end = src.indexOf(close, start + 2);
      if (end < 0) return false;
      const body = src.slice(start + 2, end);
      if (!body.trim()) return false;
      if (!silent) {
        const token = state.push('kb_math', 'span', 0);
        token.content = body.trim();
        token.info = kind === '(' ? 'inline' : 'display';
        token.markup = close;
      }
      state.pos = end + close.length;
      return true;
    }
    return false;
  });

  md.inline.ruler.before('link', 'kb_fn_ref', (state, silent) => {
    const src = state.src;
    const start = state.pos;
    if (src.charCodeAt(start) !== 91 || src[start + 1] !== '^') return false;
    const end = src.indexOf(']', start + 2);
    if (end < 0 || end > start + 80) return false;
    if (src[end + 1] === ':') return false;
    const id = src.slice(start + 2, end);
    if (!id || /\s/.test(id)) return false;
    if (silent) {
      state.pos = end + 1;
      return true;
    }
    const env = state.env as ReaderEnv;
    const htmlId = env.kbFnSeen?.get(id) ?? `kb-fn-${slugify(id)}`;
    const token = state.push('html_inline', '', 0);
    token.content = `<sup class="kb-fn-ref"><a href="#${htmlId}" data-kb-anchor="${htmlId}">${escapeHtml(id)}</a></sup>`;
    state.pos = end + 1;
    return true;
  });

  md.core.ruler.after('inline', 'kb_task', (state) => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i++) {
      if (tokens[i].type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') continue;
      const children = tokens[i].children;
      if (!children?.length || children[0].type !== 'text') continue;
      const m = /^\[([ xX])\][ \t]+/.exec(children[0].content);
      if (!m) continue;
      const checked = m[1].toLowerCase() === 'x';
      children[0].content = children[0].content.slice(m[0].length);
      const box = new state.Token('html_inline', '', 0);
      box.content = `<span class="kb-task" data-checked="${checked ? 'true' : 'false'}" role="checkbox" aria-checked="${checked ? 'true' : 'false'}" aria-disabled="true"></span> `;
      children.unshift(box);
      tokens[i - 2].attrJoin('class', 'kb-task-item');
    }
  });

  md.core.ruler.after('kb_task', 'kb_fn_tail', (state) => {
    const env = state.env as ReaderEnv;
    const defs = env.kbFootnotes;
    if (!defs?.length) return;
    const list = defs.splice(0, defs.length);
    let body = '<section class="kb-footnotes" data-testid="md-footnotes"><ol>';
    for (const d of list) {
      body += `<li id="${d.htmlId}"><span class="kb-fn-label">${escapeHtml(d.id)}</span> ${md.renderInline(d.text, env)}</li>`;
    }
    body += '</ol></section>';
    const token = new state.Token('html_block', '', 0);
    token.content = body;
    token.block = true;
    state.tokens.push(token);
  });

  const defaultImage = md.renderer.rules.image!;
  md.renderer.rules.image = (tokens, idx, opts, env, self) => {
    const t = tokens[idx];
    const src = String(t.attrGet('src') ?? '');
    if (src) t.attrSet('src', resolveImage(src, deps));
    return defaultImage(tokens, idx, opts, env, self);
  };

  md.renderer.rules.heading_open = (tokens, idx, opts, env, self) => {
    const readerEnv = env as ReaderEnv;
    const inline = tokens[idx + 1];
    const text = tokenText(inline ?? { content: '' }).replace(/\s+/g, ' ').trim();
    const id = uniqueSlug(text, readerEnv);
    tokens[idx].attrSet('id', id);
    const level = Number(tokens[idx].tag.slice(1)) || 1;
    (readerEnv.kbHeadings ??= []).push({ level, id, text: text || id });
    return self.renderToken(tokens, idx, opts);
  };

  md.renderer.rules.heading_close = (tokens, idx, opts, env, self) => {
    const close = self.renderToken(tokens, idx, opts);
    let open = tokens[idx];
    for (let j = idx - 1; j >= 0; j--) {
      if (tokens[j].type === 'heading_open') {
        open = tokens[j];
        break;
      }
    }
    if (open.type !== 'heading_open') return close;
    const level = Number(open.tag.slice(1)) || 1;
    if (level < 2 || level > 4) return close;
    const readerEnv = env as ReaderEnv;
    const heading = readerEnv.kbHeadings?.[readerEnv.kbHeadings.length - 1];
    if (!heading || heading.id !== open.attrGet('id')) return close;
    if (isTocHeadingText(heading.text)) return close;
    return BACK_TOC_BUTTON + close;
  };

  const emitMath = (tex: string, display: boolean, env: ReaderEnv | undefined) => {
    if (env) (env.kbFormulas ??= []).push({ tex, display });
    return renderMath(tex, display, deps.katex);
  };
  md.renderer.rules.kb_math = (tokens, idx, _opts, env) => emitMath(tokens[idx].content, tokens[idx].info === 'display', env as ReaderEnv);
  md.renderer.rules.kb_math_block = (tokens, idx, _opts, env) => emitMath(tokens[idx].content, true, env as ReaderEnv);
  return md;
}

export function renderMarkdown(source: string, deps: MarkdownDeps): RenderedMarkdown {
  // Sync path for small docs only — caller must gate with LARGE_MD_CHARS so this while cannot
  // monopolize the renderer on large/complex MD (those use startMarkdownStream + slices).
  const stream = startMarkdownStream(source, deps);
  let html = '';
  while (!stream.done()) html += stream.step(SLICE_BUDGET_MS).html;
  return { html: stream.toc() + html, headings: stream.headings(), formulas: stream.formulas() };
}

/** 大文件按时间片渲染。调用方应在片与片之间让出主线程。 */
export function startMarkdownStream(source: string, deps: MarkdownDeps): MarkdownStream {
  const blocks = splitMarkdownBlocks(source);
  const md = createReaderMarkdown(deps);
  const env: ReaderEnv = {};
  let i = 0;
  return {
    done: () => i >= blocks.length,
    headings: () => env.kbHeadings ?? [],
    formulas: () => env.kbFormulas ?? [],
    toc: () => renderToc(env.kbHeadings ?? []),
    step(budgetMs = SLICE_BUDGET_MS, now = () => performance.now()) {
      const t0 = now();
      let html = '';
      while (i < blocks.length && (html === '' || now() - t0 < budgetMs)) {
        try {
          html += md.render(blocks[i], env);
        } catch {
          html += `<pre class="kb-md-error">${escapeHtml(blocks[i])}</pre>`;
        }
        i++;
        if (now() - t0 >= budgetMs) break;
      }
      return { html, ms: now() - t0 };
    },
  };
}

export function renderMarkdownSlices(source: string, deps: MarkdownDeps, budgetMs = SLICE_BUDGET_MS, now = () => performance.now()) {
  const stream = startMarkdownStream(source, deps);
  const parts: string[] = [];
  const sliceMs: number[] = [];
  while (!stream.done()) {
    const slice = stream.step(budgetMs, now);
    parts.push(slice.html);
    sliceMs.push(slice.ms);
  }
  return { parts, sliceMs, headings: stream.headings(), formulas: stream.formulas(), toc: stream.toc() };
}

/** 测试桩：把 mermaid 源码换成调用方返回的 SVG。抛错或空串时保留源码。 */
export function drawMermaid(html: string, render: (src: string) => string): string {
  return html.replace(/<pre class="kb-mermaid"[^>]*><code>([\s\S]*?)<\/code><\/pre>/g, (full, code: string) => {
    try {
      const svg = render(unescapeHtml(code));
      if (!svg) return full;
      return `<div class="kb-mermaid-drawn">${svg}</div>`;
    } catch {
      return full;
    }
  });
}
