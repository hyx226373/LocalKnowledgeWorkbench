import { escapeHtml } from '../markdown/html';
import { renderMath } from '../markdown/math';
import type { FormulaSrc, KatexLike } from '../markdown/types';

const DISPLAY_ENVS = new Set([
  'equation', 'equation*', 'align', 'align*', 'alignat', 'alignat*', 'gather', 'gather*',
  'displaymath', 'eqnarray', 'eqnarray*', 'multline', 'multline*', 'flalign', 'flalign*',
]);

function escaped(src: string, i: number): boolean {
  let n = 0;
  for (let j = i - 1; j >= 0 && src[j] === '\\'; j--) n++;
  return n % 2 === 1;
}

/** 从 .tex 里抽出公式原文。跳过注释、\\verb 和 verbatim。不编译整篇。 */
export function extractTexFormulas(src: string): FormulaSrc[] {
  const out: FormulaSrc[] = [];
  let i = 0;
  while (i < src.length) {
    if (src[i] === '%' && !escaped(src, i)) {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl + 1;
      continue;
    }
    if (src.startsWith('\\verb', i) && !escaped(src, i)) {
      const star = src[i + 5] === '*' ? 1 : 0;
      const delimAt = i + 5 + star;
      const delim = src[delimAt];
      if (delim && !/[A-Za-z{*[]/.test(delim)) {
        const end = src.indexOf(delim, delimAt + 1);
        i = end < 0 ? src.length : end + 1;
        continue;
      }
    }
    if (src.startsWith('\\begin{verbatim}', i) || src.startsWith('\\begin{lstlisting}', i)) {
      const endTag = src.startsWith('\\begin{verbatim}', i) ? '\\end{verbatim}' : '\\end{lstlisting}';
      const end = src.indexOf(endTag, i);
      i = end < 0 ? src.length : end + endTag.length;
      continue;
    }
    const begin = /^\\begin\{([A-Za-z*]+)\}/.exec(src.slice(i));
    if (begin && DISPLAY_ENVS.has(begin[1]) && !escaped(src, i)) {
      const endTag = `\\end{${begin[1]}}`;
      const end = src.indexOf(endTag, i + begin[0].length);
      if (end < 0) {
        i += begin[0].length;
        continue;
      }
      const tex = src.slice(i + begin[0].length, end).trim();
      if (tex) out.push({ tex, display: true });
      i = end + endTag.length;
      continue;
    }
    if (src.startsWith('$$', i) && !escaped(src, i)) {
      const end = src.indexOf('$$', i + 2);
      if (end < 0) {
        i += 2;
        continue;
      }
      const tex = src.slice(i + 2, end).trim();
      if (tex) out.push({ tex, display: true });
      i = end + 2;
      continue;
    }
    if (src.startsWith('\\[', i) && !escaped(src, i)) {
      const end = src.indexOf('\\]', i + 2);
      if (end < 0) {
        i += 2;
        continue;
      }
      const tex = src.slice(i + 2, end).trim();
      if (tex) out.push({ tex, display: true });
      i = end + 2;
      continue;
    }
    if (src.startsWith('\\(', i) && !escaped(src, i)) {
      const end = src.indexOf('\\)', i + 2);
      if (end < 0) {
        i += 2;
        continue;
      }
      const tex = src.slice(i + 2, end).trim();
      if (tex) out.push({ tex, display: false });
      i = end + 2;
      continue;
    }
    if (src[i] === '$' && !escaped(src, i)) {
      const end = src.indexOf('$', i + 1);
      const body = end < 0 ? '' : src.slice(i + 1, end);
      if (end > i + 1 && body.trim() && !body.includes('\n') && !/\s/.test(src[i + 1]) && !/\s/.test(src[end - 1])) {
        out.push({ tex: body.trim(), display: false });
        i = end + 1;
        continue;
      }
    }
    i++;
  }
  return out;
}

/** 命令、百分号注释、花括号。数学定界符留给公式预览，源码里仍可见。 */
export function highlightTex(source: string): string {
  const out: string[] = [];
  const n = source.length;
  let i = 0;
  while (i < n) {
    const ch = source[i];
    if (ch === '%' && !escaped(source, i)) {
      const end = source.indexOf('\n', i);
      const stop = end < 0 ? n : end;
      out.push(`<span class="kb-hl-comment">${escapeHtml(source.slice(i, stop))}</span>`);
      i = stop;
      continue;
    }
    if (ch === '\\' && /[A-Za-z]/.test(source[i + 1] ?? '')) {
      let j = i + 1;
      while (j < n && /[A-Za-z]/.test(source[j])) j++;
      out.push(`<span class="kb-hl-keyword">${escapeHtml(source.slice(i, j))}</span>`);
      i = j;
      continue;
    }
    if (ch === '{' || ch === '}') {
      out.push(`<span class="kb-hl-brace">${escapeHtml(ch)}</span>`);
      i++;
      continue;
    }
    out.push(escapeHtml(ch));
    i++;
  }
  return out.join('');
}

export interface TexRender {
  sourceHtml: string;
  mathHtml: string;
  formulas: FormulaSrc[];
}

export function renderTex(source: string, katex: KatexLike | null): TexRender {
  const formulas = extractTexFormulas(source);
  const sourceHtml = `<pre class="kb-tex-source"><code>${highlightTex(source)}</code></pre>`;
  const mathHtml = formulas.length
    ? `<section class="kb-tex-math" data-testid="tex-math">${formulas.map((f) => renderMath(f.tex, f.display, katex)).join('')}</section>`
    : '<p class="kb-tex-empty" data-testid="tex-no-math">没有识别到公式</p>';
  return { sourceHtml, mathHtml, formulas };
}
