import { escapeHtml } from './html';
import type { KatexLike } from './types';

/**
 * 公式出错或 katex 不在时，页面上只剩原文，不留空节点。
 * 成功时原文仍放在 .kb-math-source，正文索引读的是文件原文，这里给页内查找用。
 */
export function renderMath(tex: string, display: boolean, katex: KatexLike | null): string {
  const source = `<span class="kb-math-source">${escapeHtml(tex)}</span>`;
  const cls = display ? 'kb-math kb-math-display' : 'kb-math kb-math-inline';
  const mode = display ? 'block' : 'inline';
  if (!katex) return `<span class="${cls} kb-math-fallback" data-display="${mode}">${source}</span>`;
  try {
    const html = katex.renderToString(tex, {
      displayMode: display,
      throwOnError: true,
      strict: 'ignore',
      trust: false,
      output: 'html',
    });
    if (!html || html.includes('katex-error')) throw new Error('katex');
    return `<span class="${cls}" data-display="${mode}">${html}${source}</span>`;
  } catch {
    return `<span class="${cls} kb-math-fallback" data-display="${mode}">${source}</span>`;
  }
}
