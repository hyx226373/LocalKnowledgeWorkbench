import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConsoleScreen } from '../src/renderer/console/ConsoleScreen';
import { buildConsoleDraft } from '../src/shared/consoleSchema';

const RID = '11111111-1111-4111-8111-111111111111';

describe('控制台渲染', () => {
  it('按 order 显示说明，挂载时不调用开整组', () => {
    const text = buildConsoleDraft({
      title: '周复盘',
      description: '本周材料',
      items: [
        { id: 'b', title: '笔记', order: 2, openAs: 'tab', note: '后', ref: { type: 'resource', resourceId: RID } },
        { id: 'a', title: '论文', order: 1, openAs: 'float', ref: { type: 'resource', resourceId: RID } },
      ],
    });
    const onOpenGroup = vi.fn();
    const html = renderToStaticMarkup(
      createElement(ConsoleScreen, {
        name: '周复盘.kbconsole.md',
        text,
        onOpenItem: () => {},
        onOpenGroup,
      }),
    );
    expect(html).toContain('data-auto-open="off"');
    expect(html).toContain('data-testid="console-title-note"');
    expect(html).toContain('本周材料');
    const paper = html.indexOf('论文');
    const note = html.indexOf('笔记');
    expect(paper).toBeGreaterThan(0);
    expect(paper).toBeLessThan(note);
    expect(html).toContain('自由窗口');
    expect(html).toContain('标签');
    expect(onOpenGroup).not.toHaveBeenCalled();
  });

  it('坏块与未知版本都有提示，未知版本没有可执行索引按钮', () => {
    const text = [
      '```kb-console v=1',
      '{ "kind": "console", "version": 2, "index": { "items": [] } }',
      '```',
      '',
      '```kb-console',
      '{',
      '```',
      '',
      '```kb-console',
      '{ "kind": "foreign", "version": 1, "label": "原样" }',
      '```',
      '',
    ].join('\n');
    const html = renderToStaticMarkup(
      createElement(ConsoleScreen, { name: 'x.kbconsole.md', text, onOpenItem: () => {}, onOpenGroup: () => {} }),
    );
    expect(html).toContain('未知控制台版本');
    expect(html).toContain('坏 JSON');
    expect(html).toContain('data-testid="console-unknown-kind"');
    expect(html).toContain('原样');
    expect(html).not.toContain('data-testid="console-open-group"');
  });
});
