import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { KATEX_CSS_SPEC, KATEX_FONT_SPEC, KATEX_PACKAGE, KATEX_VERSION, MERMAID_INIT, MERMAID_PACKAGE, MERMAID_VERSION, configUsesNetwork } from '../src/renderer/plugins/builtin-readers/markdown/assets';
import { LONG_TASK_LIMIT_MS, MAX_BLOCK_CHARS, SLICE_BUDGET_MS, splitMarkdownBlocks } from '../src/renderer/plugins/builtin-readers/markdown/blocks';
import { drawMermaid, renderMarkdown, renderMarkdownSlices } from '../src/renderer/plugins/builtin-readers/markdown/render';
import type { KatexLike, MarkdownDeps } from '../src/renderer/plugins/builtin-readers/markdown/types';
import { restoreScrollState } from '../src/renderer/zoom/state';

const katex: KatexLike = {
  renderToString(tex, opts) {
    if (tex.includes('\\bad')) throw new Error('bad tex');
    const safe = tex.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return `<span class="katex" data-katex="${opts?.displayMode ? 'block' : 'inline'}">${safe}</span>`;
  },
};

function deps(over: Partial<MarkdownDeps> = {}): MarkdownDeps {
  return {
    katex,
    relDir: '笔记',
    fileUrl: (rel) => `kbfile://root/r/${rel}`,
    ...over,
  };
}

function sources(html: string): string[] {
  return [...html.matchAll(/class="kb-math-source">([^<]*)</g)].map((m) => m[1]);
}

describe('Markdown 阅读', () => {
  it('表格、任务、脚注、删除线和标题目录', () => {
    const html = renderMarkdown(
      [
        '# 标题',
        '',
        '## 第二节',
        '',
        '~~删除~~',
        '',
        '| 甲 | 乙 |',
        '| --- | --- |',
        '| 1 | 2 |',
        '',
        '- [ ] 未做',
        '- [x] 已做',
        '',
        '见[^note]。',
        '',
        '[^note]: 注的正文',
        '',
        '# 标题',
      ].join('\n'),
      deps(),
    ).html;
    expect(html).toContain('<table>');
    expect(html).toContain('甲');
    expect(html).toContain('<s>删除</s>');
    expect(html).toContain('data-checked="false"');
    expect(html).toContain('data-checked="true"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('href="#kb-fn-note"');
    expect(html).toContain('注的正文');
    expect(html).toContain('id="kb-h-标题"');
    expect(html).toContain('id="kb-h-标题-2"');
    expect(html).toContain('data-testid="md-toc"');
    expect(html).toContain('href="#kb-h-第二节"');
    expect(html).not.toContain('<input');
  });

  it('代码高亮、mermaid 源码和相对图片', () => {
    const html = renderMarkdown(
      [
        '```js',
        'const n = 1;',
        '```',
        '',
        '```mermaid',
        'graph TD; A-->B;',
        '```',
        '',
        '![图](./img/a.png)',
        '',
        '![外](https://example.com/a.png)',
      ].join('\n'),
      deps(),
    ).html;
    expect(html).toContain('kb-hl-keyword');
    expect(html).toContain('const');
    expect(html).toContain('class="kb-mermaid"');
    expect(html).toContain('graph TD; A--&gt;B;');
    expect(html).toContain('src="kbfile://root/r/笔记/img/a.png"');
    expect(html).toContain('src="https://example.com/a.png"');
    const drawn = drawMermaid(html, () => '<svg data-testid="mmd"></svg>');
    expect(drawn).toContain('data-testid="mmd"');
    expect(drawn).not.toContain('graph TD');
    const kept = drawMermaid(html, () => {
      throw new Error('画不了');
    });
    expect(kept).toContain('graph TD; A--&gt;B;');
  });

  it('公式用注入的渲染器，代码里的 $ 不当公式', () => {
    const raw = ['行内 $E=mc^2$ 与 \\(a+b\\)。', '', '$$', 'c^2', '$$', '', '\\[d+e\\]', '', '中文 $x^2$ 混排', '', '代码 `$skip$` 和 $ok$', '', '```', '$nope$', '```', '', '$\\bad$'].join('\n');
    const frozen = raw;
    const rendered = renderMarkdown(raw, deps());
    expect(raw).toBe(frozen);
    expect(raw).toContain('E=mc^2');
    expect(rendered.formulas.map((f) => f.tex)).toEqual(['E=mc^2', 'a+b', 'c^2', 'd+e', 'x^2', 'ok', '\\bad']);
    expect(rendered.html).toContain('class="katex"');
    expect(rendered.html).toContain('kb-math-inline');
    expect(rendered.html).toContain('kb-math-display');
    expect(rendered.html).toContain('kb-math-fallback');
    expect(sources(rendered.html)).toContain('E=mc^2');
    expect(sources(rendered.html)).toContain('\\bad');
    expect(rendered.html).toContain('$skip$');
    expect(rendered.html).toContain('$nope$');
    const plain = renderMarkdown('$E=mc^2$', deps({ katex: null }));
    expect(plain.html).toContain('kb-math-fallback');
    expect(plain.html).toContain('E=mc^2');
    expect(plain.html).not.toContain('class="katex"');
  });

  it('父目录图片不会跑出资料根', () => {
    const html = renderMarkdown('![](../b.png)', deps({ relDir: '笔记/子' })).html;
    expect(html).toContain('src="kbfile://root/r/笔记/b.png"');
  });

  it('围栏和跨行公式各自成块', () => {
    const fence = ['```', ...Array.from({ length: 40 }, () => 'x'), '```'].join('\n');
    const math = ['$$', 'y', '$$'].join('\n');
    const blocks = splitMarkdownBlocks(`${fence}\n\n${math}\n\n# 后`);
    expect(blocks[0]).toContain('```');
    expect(blocks[0]).toContain('x');
    expect(blocks.some((b) => b.includes('$$') && b.includes('y'))).toBe(true);
    const long = `${'字'.repeat(100)}\n`.repeat(2000);
    for (const block of splitMarkdownBlocks(long)) expect(block.length).toBeLessThanOrEqual(MAX_BLOCK_CHARS + 200);
  });

  it('10MB 正文每一片低于 200ms', () => {
    const unit = `${'甲'.repeat(80)}\n\n`;
    const source = unit.repeat(Math.ceil((10 * 1024 * 1024) / unit.length));
    expect(source.length).toBeGreaterThanOrEqual(10 * 1024 * 1024);
    const splitAt = performance.now();
    const blocks = splitMarkdownBlocks(source);
    const splitMs = performance.now() - splitAt;
    const sliced = renderMarkdownSlices(source, deps({ katex: null, relDir: '', fileUrl: (p) => p }), SLICE_BUDGET_MS);
    const maxSlice = Math.max(...sliced.sliceMs);
    const outDir = 'D:\\workspace\\kb-work';
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      path.join(outDir, 'reader-perf.json'),
      JSON.stringify(
        {
          bytes: source.length,
          blocks: blocks.length,
          slices: sliced.sliceMs.length,
          splitMs: +splitMs.toFixed(2),
          maxSliceMs: +maxSlice.toFixed(2),
          sliceMs: sliced.sliceMs.map((n) => +n.toFixed(2)),
          limitMs: LONG_TASK_LIMIT_MS,
          budgetMs: SLICE_BUDGET_MS,
        },
        null,
        2,
      ),
    );
    expect(splitMs).toBeLessThan(LONG_TASK_LIMIT_MS);
    expect(maxSlice).toBeLessThan(LONG_TASK_LIMIT_MS);
    expect(sliced.parts.join('')).toContain('甲');
  }, 120000);

  it('滚动模式和缩放字段还能恢复，依赖声明不走 CDN', () => {
    expect(restoreScrollState({ scroll: 0.25, mode: 'split', zoom: 1.2 })?.zoom).toBe(1.2);
    expect(KATEX_PACKAGE).toBe('katex');
    expect(KATEX_VERSION).toBe('0.19.0');
    expect(KATEX_CSS_SPEC).toBe('katex/dist/katex.min.css');
    expect(KATEX_FONT_SPEC).toBe('katex/dist/fonts');
    expect(MERMAID_PACKAGE).toBe('mermaid');
    expect(MERMAID_VERSION).toBe('12.1.0');
    expect(configUsesNetwork(MERMAID_INIT)).toBe(false);
    const root = path.join('src', 'renderer', 'plugins', 'builtin-readers');
    for (const rel of ['markdown/load-katex.ts', 'markdown/load-mermaid.ts', 'markdown/assets.ts', 'markdown/render.ts', 'tex/render.ts']) {
      const text = readFileSync(path.join(root, rel), 'utf8');
      expect(text).not.toMatch(/https?:\/\//);
    }
    const loader = readFileSync(path.join(root, 'markdown/load-katex.ts'), 'utf8');
    expect(loader).toContain("import('katex')");
    expect(loader).toContain("import('katex/dist/katex.min.css')");
    const view = readFileSync(path.join(root, 'index.tsx'), 'utf8');
    expect(view).toMatch(/id: 'builtin\.tex'[\s\S]*actions: \['in', 'out', 'reset', 'fit', 'set', 'wheel'\]/);
    expect(view).toContain('useScrollState');
  });
});
