import { describe, expect, it } from 'vitest';
import {
  buildConsoleDraft,
  executableIndex,
  groupOpenPlan,
  isConsoleDocument,
  orderedItems,
  parseConsoleDocument,
  parseResourceDrag,
  withIndexItems,
  type ConsoleIndexItem,
} from '../src/shared/consoleSchema';

const RID = '11111111-1111-4111-8111-111111111111';
const RID2 = '22222222-2222-4222-8222-222222222222';

function item(partial: Partial<ConsoleIndexItem> & Pick<ConsoleIndexItem, 'id' | 'title' | 'order'>): ConsoleIndexItem {
  return { openAs: 'tab', ref: { type: 'resource', resourceId: RID }, ...partial };
}

function fence(body: string, version = 'v=1') {
  return '```kb-console ' + version + '\n' + body + '\n```\n';
}

const goodBody = JSON.stringify(
  {
    kind: 'console',
    version: 1,
    index: {
      titleNote: '本周材料',
      items: [item({ id: 'note', title: '笔记', order: 2, openAs: 'tab' }), item({ id: 'paper', title: '论文', order: 1, openAs: 'float', ref: { type: 'path-hint', rootId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', relPath: '资料/论文/paper.pdf' } })],
    },
  },
  null,
  2,
);

describe('控制台解析', () => {
  it('v=1 出索引，并按 order 排序、同序保持原序', () => {
    const text = `---\nkbConsole: 1\ntitle: 论文周复盘\ndescription: 打开本周\n---\n\n# 会被 front matter 覆盖\n\n${fence(goodBody)}`;
    const parsed = parseConsoleDocument(text);
    expect(parsed.title).toBe('论文周复盘');
    expect(parsed.errors).toEqual([]);
    const index = executableIndex(parsed)!;
    expect(index.titleNote).toBe('本周材料');
    expect(orderedItems(index.items).map((i) => i.title)).toEqual(['论文', '笔记']);
    const tied = orderedItems([item({ id: 'a', title: '甲', order: 1 }), item({ id: 'b', title: '乙', order: 1 })]);
    expect(tied.map((i) => i.id)).toEqual(['a', 'b']);
    expect(isConsoleDocument({ text })).toBe(true);
    expect(isConsoleDocument({ name: '周报.kbconsole.md' })).toBe(true);
    expect(isConsoleDocument({ name: '普通.md', text: '# 标题\n\n一段话\n' })).toBe(false);
  });

  it('坏 JSON 只作废该块，其它块继续', () => {
    const text = `${fence('{ bad')}\n\n${fence(JSON.stringify({ kind: 'checklist', version: 1, label: '仍在' }))}`;
    const parsed = parseConsoleDocument(text);
    expect(parsed.blocks[0].status).toBe('invalid');
    expect(parsed.blocks[0].error).toMatch(/坏 JSON/);
    expect(parsed.blocks[1].status).toBe('ok');
    expect(parsed.blocks[1].kind).toBe('checklist');
    expect(executableIndex(parsed)).toBeNull();
  });

  it('未知 version 整块只读，不给出可执行索引', () => {
    const text = fence(JSON.stringify({ kind: 'console', version: 9, index: { items: [] } }));
    const parsed = parseConsoleDocument(text);
    expect(parsed.primary?.status).toBe('unknown-version');
    expect(parsed.primary?.error).toBe('未知控制台版本');
    expect(executableIndex(parsed)).toBeNull();
    expect(isConsoleDocument({ text })).toBe(true);
  });

  it('第二个 kind:console 无效', () => {
    const one = JSON.stringify({ kind: 'console', version: 1, index: { items: [item({ id: 'a', title: '甲', order: 1 })] } });
    const parsed = parseConsoleDocument(fence(one) + '\n' + fence(one));
    expect(parsed.blocks.filter((b) => b.kind === 'console')).toHaveLength(2);
    expect(parsed.blocks[0].status).toBe('ok');
    expect(parsed.blocks[1].status).toBe('invalid');
    expect(parsed.blocks[1].error).toMatch(/至多一个/);
    expect(executableIndex(parsed)?.items).toHaveLength(1);
  });

  it('拒绝注释和尾逗号', () => {
    expect(parseConsoleDocument(fence('{ "kind": "console", "version": 1, }')).blocks[0].status).toBe('invalid');
    expect(parseConsoleDocument(fence('{ "kind": "console", "version": 1, /*no*/ "index": { "items": [] } }')).blocks[0].status).toBe('invalid');
  });

  it('缺字段使该块无效', () => {
    const parsed = parseConsoleDocument(fence(JSON.stringify({ version: 1, index: { items: [] } })));
    expect(parsed.blocks[0].error).toMatch(/kind/);
    expect(parsed.primary).toBeNull();
  });

  it('文件内 approved 被忽略，不成为可执行批准', () => {
    const body = JSON.stringify({ kind: 'console', version: 1, approved: true, index: { items: [item({ id: 'a', title: '甲', order: 1 })] } });
    const parsed = parseConsoleDocument(fence(body));
    expect(parsed.primary?.status).toBe('ok');
    expect(parsed.primary?.ignoredFields).toEqual(['approved']);
    expect(JSON.stringify(parsed.primary?.index)).not.toContain('approved');
  });

  it('草稿可再解析，path-hint 保留到打开前', () => {
    const text = buildConsoleDraft({
      title: '周复盘',
      description: '说明',
      items: [item({ id: 'p', title: '论文', order: 1, ref: { type: 'path-hint', rootId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', relPath: '资料/论文/paper.pdf' } })],
    });
    expect(text).toContain('```kb-console v=1');
    const parsed = parseConsoleDocument(text);
    expect(parsed.title).toBe('周复盘');
    expect(executableIndex(parsed)?.items[0].ref).toEqual({ type: 'path-hint', rootId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', relPath: '资料/论文/paper.pdf' });
    expect(isConsoleDocument({ name: '周复盘.kbconsole.md', text })).toBe(true);
  });

  it('写回索引后能再解析，且多一条', () => {
    const text = buildConsoleDraft({ title: '周复盘', items: [item({ id: 'a', title: '甲', order: 1 })] });
    const next = withIndexItems(text, [item({ id: 'b', title: '乙', order: 2, ref: { type: 'resource', resourceId: RID2 } })]);
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    const titles = orderedItems(executableIndex(parseConsoleDocument(next.text))!.items).map((i) => i.title);
    expect(titles).toEqual(['甲', '乙']);
  });

  it('整组计划跳过未知 openAs，默认不含 includeInGroupOpen:false', () => {
    const plan = groupOpenPlan({
      items: [
        item({ id: 'skip', title: '跳', order: 1, includeInGroupOpen: false }),
        item({ id: 'bad', title: '坏', order: 2, openAs: 'teleport' }),
        item({ id: 'ok', title: '好', order: 3, openAs: 'split-right' }),
      ],
    });
    expect(plan.run.map((i) => i.id)).toEqual(['ok']);
    expect(plan.skipped).toEqual([{ id: 'bad', reason: '未知打开方式 teleport' }]);
  });

  it('拖拽 MIME 只解析条目', () => {
    const raw = JSON.stringify({
      v: 1,
      items: [{ resourceId: RID, sourceKind: 'file', from: { kind: 'root', rootId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', relPath: '笔记/a.md' } }],
    });
    const parsed = parseResourceDrag(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.items[0].resourceId).toBe(RID);
    expect(parseResourceDrag('{"v":1,"approved":true}').ok).toBe(false);
  });
});
