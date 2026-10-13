import { describe, expect, it } from 'vitest';
import type { KatexLike } from '../src/renderer/plugins/builtin-readers/markdown/types';
import { extractTexFormulas, highlightTex, renderTex } from '../src/renderer/plugins/builtin-readers/tex/render';
import { restoreScrollState } from '../src/renderer/zoom/state';

const katex: KatexLike = {
  renderToString(tex, opts) {
    if (tex.includes('\\bad')) throw new Error('bad tex');
    return `<span class="katex" data-katex="${opts?.displayMode ? 'block' : 'inline'}">${tex}</span>`;
  },
};

const sample = [
  '\\documentclass{article}',
  '% 注释里的 $no$',
  '\\section{一}',
  '行内 $E=mc^2$ 与 \\(a+b\\)。',
  '$$',
  '\\int_0^1 x dx',
  '$$',
  '\\[z\\]',
  '\\begin{equation}',
  '\\gamma',
  '\\end{equation}',
  '\\verb|$skip$|',
  '\\begin{verbatim}',
  '$skip2$',
  '\\end{verbatim}',
  '价格 \\$5 元',
].join('\n');

describe('.tex 阅读', () => {
  it('抽出公式并跳过注释、verb 和转义美元', () => {
    expect(extractTexFormulas(sample).map((f) => f.tex)).toEqual(['E=mc^2', 'a+b', '\\int_0^1 x dx', 'z', '\\gamma']);
  });

  it('源码高亮，公式用 KaTeX 桩，出错显示原文', () => {
    const html = highlightTex(sample);
    expect(html).toContain('kb-hl-keyword');
    expect(html).toContain('\\section');
    expect(html).toContain('kb-hl-comment');
    expect(html).toContain('注释里的 $no$');
    const view = renderTex(sample, katex);
    expect(view.sourceHtml).toContain('kb-tex-source');
    expect(view.mathHtml).toContain('data-testid="tex-math"');
    expect(view.mathHtml).toContain('class="katex"');
    expect(view.mathHtml).toContain('kb-math-inline');
    expect(view.mathHtml).toContain('kb-math-display');
    const bad = renderTex('$\\bad$', katex);
    expect(bad.mathHtml).toContain('kb-math-fallback');
    expect(bad.mathHtml).toContain('\\bad');
    expect(renderTex('只有文字', null).mathHtml).toContain('data-testid="tex-no-math"');
  });

  it('阅读位置的模式和比例可以恢复', () => {
    const state = restoreScrollState({ scroll: 0.4, mode: 'math', zoom: 1.4 });
    expect(state?.mode).toBe('math');
    expect(state?.scroll).toBe(0.4);
    expect(state?.zoom).toBe(1.4);
  });
});
