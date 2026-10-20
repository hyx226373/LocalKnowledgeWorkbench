import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 阅读预览间距约定（styles.css）：
 * 段落上下 0.5em；h2/h3/h4 上边距 0.75/0.65/0.55em、下边距 0.4/0.35/0.3em；
 * 行间公式 0.5em，并清掉 KaTeX .katex-display 的 1em（否则叠在 overflow BFC 里）。
 * 公式 text-indent 为 0，避免主题段首缩进进到 inline-block。
 * 不改 --kb-read-lh（1.75）和 --kb-read-max-width（880px）。
 */
describe('阅读预览间距', () => {
  const css = readFileSync(path.join(__dirname, '../src/renderer/styles.css'), 'utf8');

  it('段落、标题、行间公式收到教材密度，行高与版心不变', () => {
    expect(css).toContain('--kb-read-lh: 1.75');
    expect(css).toContain('--kb-read-max-width: 880px');
    expect(css).toMatch(/\.kb-reading \.kb-md p \{ margin: 0\.5em 0; \}/);
    expect(css).toMatch(/\.kb-reading \.kb-md h2 \{ margin: 0\.75em 0 0\.4em; \}/);
    expect(css).toMatch(/\.kb-reading \.kb-md h3 \{ margin: 0\.65em 0 0\.35em; \}/);
    expect(css).toMatch(/\.kb-reading \.kb-md h4 \{ margin: 0\.55em 0 0\.3em; \}/);
    expect(css).not.toMatch(/kb-math-display[^}]*margin:\s*0\.8em/);
    expect(css).toMatch(/\.kb-reading \.kb-md \.kb-math-display,\s*\.kb-reading \.kb-tex \.kb-math-display \{[^}]*margin: 0\.5em auto/);
    expect(css).toMatch(/\.kb-reading \.kb-math-display \.katex-display \{ margin: 0; \}/);
    expect(css).toMatch(/\.kb-reading \.kb-md \.kb-math-inline \{[^}]*text-indent: 0/);
    expect(css).toMatch(/\.kb-reading \.kb-tex \.kb-math-display \{[^}]*text-indent: 0/);
    expect(css).not.toMatch(/\.kb-reading \.kb-md p \{[^}]*!important/);
    expect(css).not.toMatch(/kb-math-display[^}]*!important/);
  });
});
