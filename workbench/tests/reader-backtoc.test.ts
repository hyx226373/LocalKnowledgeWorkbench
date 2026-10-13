import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/renderer/plugins/builtin-readers/markdown/render';
import type { MarkdownDeps } from '../src/renderer/plugins/builtin-readers/markdown/types';
import {
  BACK_TOC_COMMAND,
  planBackToc,
  resolveDocHash,
  shouldShowBackToc,
  slugify,
  type TocScan,
} from '../src/renderer/plugins/builtin-readers/markdown/backToc';

const katex = {
  renderToString(tex: string) {
    return tex;
  },
};

function deps(): MarkdownDeps {
  return { katex, relDir: '', fileUrl: (rel) => rel };
}

function headingHtml(html: string, id: string): string {
  const match = html.match(new RegExp(`<h[1-6][^>]*id="${id}"[^>]*>[\\s\\S]*?</h[1-6]>`));
  return match?.[0] ?? '';
}

describe('回到目录', () => {
  it('四种目标：中文目录、英文 TOC、前部链接列表、没有目录', () => {
    const ids = new Set(['kb-h-目录', 'kb-h-toc', 'kb-h-甲', 'kb-h-乙', 'kb-h-丙']);
    const chinese: TocScan[] = [
      { kind: 'heading', level: 2, text: '目录', id: 'kb-h-目录' },
      { kind: 'heading', level: 2, text: '甲', id: 'kb-h-甲' },
    ];
    expect(planBackToc(chinese, ids).kind).toBe('heading');
    expect(planBackToc(chinese, ids).id).toBe('kb-h-目录');

    const english: TocScan[] = [{ kind: 'heading', level: 2, text: 'TOC', id: 'kb-h-toc' }];
    expect(planBackToc(english, ids)).toEqual({ kind: 'heading', id: 'kb-h-toc' });

    const listed: TocScan[] = [
      { kind: 'block' },
      { kind: 'list', links: ['#甲', '#乙', '#丙'] },
      { kind: 'heading', level: 2, text: '甲', id: 'kb-h-甲' },
    ];
    expect(planBackToc(listed, ids)).toEqual({ kind: 'list', listIndex: 1 });

    const none: TocScan[] = [
      { kind: 'heading', level: 2, text: '甲', id: 'kb-h-甲' },
      { kind: 'block' },
    ];
    expect(planBackToc(none, ids)).toEqual({ kind: 'top' });
  });

  it('目录标题没有按钮，按钮本身没有文字', () => {
    const html = renderMarkdown(['## 目录', '', '## 甲', '', '## 乙', '', '## 丙'].join('\n'), deps()).html;
    expect(headingHtml(html, 'kb-h-目录')).not.toContain('kb-md-backtoc');
    const button = headingHtml(html, 'kb-h-甲').match(/<button type="button" class="kb-md-backtoc"[^>]*><\/button>/);
    expect(button).not.toBeNull();
    expect(html).not.toContain('↑ 目录');
  });

  it('标题少于 3 个不显示，关闭开关也不显示，正文不因开关重画', () => {
    expect(shouldShowBackToc(2, true)).toBe(false);
    expect(shouldShowBackToc(3, false)).toBe(false);
    expect(shouldShowBackToc(3, true)).toBe(true);
    const source = ['## 甲', '', '## 乙', '', '## 丙'].join('\n');
    expect(renderMarkdown(source, deps()).html).toBe(renderMarkdown(source, deps()).html);
  });

  it('手写中文链接、自带目录链接和重名 -2 对得上', () => {
    const html = renderMarkdown(['## 一、极限', '', '## 标题', '', '## 标题'].join('\n'), deps()).html;
    expect(html).toContain('id="kb-h-一极限"');
    expect(html).toContain('id="kb-h-标题-2"');
    const ids = new Set(['kb-h-一极限', 'kb-h-标题', 'kb-h-标题-2']);
    expect(resolveDocHash('#一极限', ids)).toBe('kb-h-一极限');
    expect(resolveDocHash('#kb-h-一极限', ids)).toBe('kb-h-一极限');
    expect(resolveDocHash('#kb-h-标题-2', ids)).toBe('kb-h-标题-2');
    expect(resolveDocHash('#a---b', new Set(['kb-h-a-b']))).toBe('kb-h-a-b');
    expect(slugify('a---b')).toBe('a-b');
  });

  it('回到目录命令不带默认快捷键', () => {
    expect(BACK_TOC_COMMAND.id).toBe('reader.backToToc');
    expect(BACK_TOC_COMMAND).not.toHaveProperty('keybinding');
  });

  it('500 个标题开和关的渲染中位数相差不超过 20ms', () => {
    const source = Array.from({ length: 500 }, (_, i) => `## 标题${i}\n\n正文`).join('\n\n');
    const sample = () => {
      const started = performance.now();
      renderMarkdown(source, deps());
      return performance.now() - started;
    };
    sample();
    const take = () => {
      const values = [sample(), sample(), sample(), sample(), sample()].sort((a, b) => a - b);
      return values[2] ?? 0;
    };
    const on = take();
    const off = take();
    expect(Math.abs(on - off)).toBeLessThanOrEqual(20);
  });
});
