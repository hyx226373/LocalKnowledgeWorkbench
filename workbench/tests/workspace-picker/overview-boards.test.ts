import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_OVERVIEW_BOARDS,
  OVERVIEW_BOARDS_KEY,
  addOverviewCategory,
  addWorkspacesToCategory,
  deleteOverviewCategory,
  formatPickerStamp,
  formatRelativeStamp,
  listOverviewCategories,
  parseOverviewBoards,
  removeWorkspaceFromCategory,
  renameOverviewCategory,
  retainOverviewWorkspaces,
  serializeOverviewBoards,
  sortPickerWorkspaces,
} from '../../src/shared/workspacePicker/overviewBoards';

describe('overview boards', () => {
  it('键名和空分组', () => {
    expect(OVERVIEW_BOARDS_KEY).toBe('settings.overviewBoards');
    expect(parseOverviewBoards(null)).toEqual(EMPTY_OVERVIEW_BOARDS);
    expect(parseOverviewBoards(undefined)).toEqual(EMPTY_OVERVIEW_BOARDS);
    expect(parseOverviewBoards('settings.overviewBoards')).toEqual(EMPTY_OVERVIEW_BOARDS);
    expect(parseOverviewBoards({ v: 2, projects: [{ id: 'p-1', name: '项目1', workspaceIds: ['a'] }] })).toEqual(EMPTY_OVERVIEW_BOARDS);
  });

  it('只留下分组和顺序，丢掉路径和未知字段，不改入参', () => {
    const raw = {
      v: 1,
      projects: [
        { id: 'p-1', name: '  项目1 ', workspaceIds: ['ws-1', 'ws-1', 'C:\\secret', '../x'] },
        { id: 'p-1', name: '重复', workspaceIds: ['ws-2'] },
        { id: 'bad\\id', name: '坏', workspaceIds: ['ws-3'] },
      ],
      tags: [{ id: 't-1', name: 'C:\\盘', workspaceIds: ['ws-9'] }],
      allOrder: ['/home/amy', 'ws-2', 'ws-2'],
      favoriteOrder: ['ws-1'],
      extra: true,
    };
    const parsed = parseOverviewBoards(raw);
    expect(parsed).toEqual({
      v: 1,
      projects: [{ id: 'p-1', name: '项目1', workspaceIds: ['ws-1', 'ws-2'] }],
      tags: [],
      allOrder: ['ws-2'],
      favoriteOrder: ['ws-1'],
      categories: [],
    });
    expect(raw.extra).toBe(true);
    expect(serializeOverviewBoards(parsed)).toEqual(parsed);
  });

  it('工作区被删掉后，各分类里的引用一并收掉，其它数据不动', () => {
    const base = parseOverviewBoards({
      v: 1,
      projects: [{ id: 'p-1', name: '项目1', workspaceIds: ['ws-a', 'ws-b'] }],
      tags: [],
      allOrder: ['ws-a', 'ws-b'],
      favoriteOrder: [],
      categories: [{ id: 'c-1', name: '考研', workspaceIds: ['ws-b'] }],
    });
    const kept = retainOverviewWorkspaces(base, new Set(['ws-a']));
    expect(kept.projects[0]?.workspaceIds).toEqual(['ws-a']);
    expect(kept.categories?.[0]?.workspaceIds).toEqual([]);
    expect(kept.allOrder).toEqual(['ws-a']);
    expect(base.projects[0]?.workspaceIds).toEqual(['ws-a', 'ws-b']);
  });

  it('选择列表按最近排序，同一天显示时分', () => {
    expect(
      sortPickerWorkspaces([
        { id: 'a', name: '空白', lastUsedAt: null },
        { id: 'b', name: 'b', lastUsedAt: 2 },
        { id: 'c', name: '数学', lastUsedAt: 5 },
        { id: 'd', name: 'a', lastUsedAt: 2 },
      ]).map((row) => row.id),
    ).toEqual(['c', 'd', 'b', 'a']);
    const now = new Date(2026, 9, 16, 15, 0).getTime();
    expect(formatPickerStamp(new Date(2026, 9, 16, 14, 45).getTime(), now)).toBe('14:45');
    expect(formatPickerStamp(new Date(2026, 9, 14, 6, 21).getTime(), now)).toBe('10/14');
    expect(formatPickerStamp(null, now)).toBe('');
  });

  it('同一分类去重，删除只拿掉这一条引用', () => {
    const boards = {
      v: 1 as const,
      projects: [{ id: 'p-1', name: '项目', workspaceIds: ['a', 'b'] }],
      tags: [{ id: 't-1', name: '标签', workspaceIds: ['a', 'c'] }],
      allOrder: [] as string[],
      favoriteOrder: [] as string[],
      categories: [{ id: 'c-1', name: '考研', workspaceIds: ['a', 'b'] }],
    };
    const added = addWorkspacesToCategory(boards, 'p-1', ['b', 'c', 'b', 'C:\\secret']);
    expect(added.projects[0]?.workspaceIds).toEqual(['a', 'b', 'c']);
    expect(added.tags[0]?.workspaceIds).toEqual(['a', 'c']);
    expect(added.categories?.[0]?.workspaceIds).toEqual(['a', 'b']);
    expect(addWorkspacesToCategory(added, 'p-1', ['c', 'b'])).toBe(added);
    expect(addWorkspacesToCategory(boards, 'all', ['a'])).toBe(boards);
    expect(addWorkspacesToCategory(boards, 'missing', ['a'])).toBe(boards);

    const removed = removeWorkspaceFromCategory(added, 'p-1', 'a');
    expect(removed.projects[0]?.workspaceIds).toEqual(['b', 'c']);
    expect(removed.tags[0]?.workspaceIds).toEqual(['a', 'c']);
    expect(removed.categories?.[0]?.workspaceIds).toEqual(['a', 'b']);
    expect(removeWorkspaceFromCategory(removed, 'p-1', 'a')).toBe(removed);
    expect(removeWorkspaceFromCategory(boards, 'favorites', 'a')).toBe(boards);
    expect(boards.projects[0]?.workspaceIds).toEqual(['a', 'b']);
  });

  it('默认分类不可删除，删分类不影响其它分类', () => {
    const boards = addOverviewCategory(
      {
        v: 1 as const,
        projects: [{ id: 'p-1', name: '项目1', workspaceIds: ['a'] }],
        tags: [{ id: 't-1', name: '标签1', workspaceIds: ['a', 'b'] }],
        allOrder: ['a'],
        favoriteOrder: [],
      },
      '考研',
    );
    expect(deleteOverviewCategory(boards, 'all')).toBe(boards);
    expect(deleteOverviewCategory(boards, 'recent')).toBe(boards);
    expect(deleteOverviewCategory(boards, 'favorites')).toBe(boards);
    expect(renameOverviewCategory(boards, 'all', '别的')).toBe(boards);

    const removed = deleteOverviewCategory(boards, 'p-1');
    expect(removed.projects).toEqual([]);
    expect(removed.tags).toEqual(boards.tags);
    expect(removed.categories).toEqual(boards.categories);
    expect(removed.allOrder).toEqual(['a']);
    expect(deleteOverviewCategory(removed, 'p-1')).toBe(removed);

    const renamed = renameOverviewCategory(boards, 'c-1', '  课程 ');
    expect(renamed.categories?.[0]?.name).toBe('课程');
    expect(boards.categories?.[0]?.name).toBe('考研');
    expect(renameOverviewCategory(boards, 'c-1', '   ')).toBe(boards);
  });

  it('旧的项目和标签分组迁成分类，字段只增不改', () => {
    const raw = {
      v: 1,
      projects: [{ id: 'p-1', name: '项目1', workspaceIds: ['ws-1', 'ws-1'] }],
      tags: [{ id: 't-1', name: '标签1', workspaceIds: ['ws-2'] }],
      allOrder: ['ws-1'],
      favoriteOrder: ['ws-2'],
    };
    const parsed = parseOverviewBoards(raw);
    expect(parsed.projects).toEqual([{ id: 'p-1', name: '项目1', workspaceIds: ['ws-1'] }]);
    expect(parsed.tags).toEqual([{ id: 't-1', name: '标签1', workspaceIds: ['ws-2'] }]);
    expect(parsed.allOrder).toEqual(['ws-1']);
    expect(parsed.favoriteOrder).toEqual(['ws-2']);
    expect(parsed.categories).toEqual([]);
    expect(raw).not.toHaveProperty('categories');
    expect(listOverviewCategories(parsed).map((item) => [item.origin, item.id, item.name, item.workspaceIds.join(',')])).toEqual([
      ['projects', 'p-1', '项目1', 'ws-1'],
      ['tags', 't-1', '标签1', 'ws-2'],
    ]);

    const created = addOverviewCategory(parsed);
    expect(created.projects).toEqual(parsed.projects);
    expect(created.tags).toEqual(parsed.tags);
    expect(created.categories).toEqual([{ id: 'c-1', name: '分类1', workspaceIds: [] }]);
    expect(addOverviewCategory(created).categories?.map((item) => item.name)).toEqual(['分类1', '分类2']);
    const named = addOverviewCategory(parsed, '  考研资料 ');
    expect(named.categories?.[0]).toEqual({ id: 'c-1', name: '考研资料', workspaceIds: [] });
    expect(serializeOverviewBoards(named).categories).toEqual(named.categories);
    expect(listOverviewCategories(named).map((item) => item.origin)).toEqual(['projects', 'tags', 'custom']);
  });

  it('重复的分组和重复的工作区在载入时合并', () => {
    const parsed = parseOverviewBoards({
      v: 1,
      projects: [
        { id: 'p-1', name: '项目', workspaceIds: ['a', 'a', 'b'] },
        { id: 'p-1', name: '重复项目', workspaceIds: ['b', 'c'] },
      ],
      tags: [{ id: 'p-1', name: '撞号', workspaceIds: ['d'] }, { id: 't-1', name: '标签', workspaceIds: ['a', 'a'] }],
      categories: [{ id: 'p-1', name: '再撞', workspaceIds: ['e'] }, { id: 'c-9', name: '笔记', workspaceIds: ['a', 'b', 'b'] }],
    });
    expect(parsed.projects).toEqual([{ id: 'p-1', name: '项目', workspaceIds: ['a', 'b', 'c', 'd', 'e'] }]);
    expect(parsed.tags).toEqual([{ id: 't-1', name: '标签', workspaceIds: ['a'] }]);
    expect(parsed.categories).toEqual([{ id: 'c-9', name: '笔记', workspaceIds: ['a', 'b'] }]);
    const removed = removeWorkspaceFromCategory(parsed, 'p-1', 'a');
    expect(removed.projects[0]?.workspaceIds).toEqual(['b', 'c', 'd', 'e']);
    expect(removed.tags[0]?.workspaceIds).toEqual(['a']);
    expect(removed.categories?.[0]?.workspaceIds).toEqual(['a', 'b']);
  });

  it('相对时间按天截断', () => {
    const now = new Date(2026, 9, 16, 15, 0).getTime();
    expect(formatRelativeStamp(null, now)).toBe('');
    expect(formatRelativeStamp(now - 30_000, now)).toBe('刚刚');
    expect(formatRelativeStamp(now - 2 * 60 * 60 * 1000, now)).toBe('2 小时前');
    expect(formatRelativeStamp(new Date(2026, 9, 15, 10, 0).getTime(), now)).toBe('昨天');
    expect(formatRelativeStamp(new Date(2026, 9, 13, 8, 0).getTime(), now)).toBe('3 天前');
    expect(formatRelativeStamp(new Date(2026, 9, 8, 8, 0).getTime(), now)).toBe('上周');
    expect(formatRelativeStamp(new Date(2026, 8, 1, 8, 0).getTime(), now)).toBe('9/1');
  });

  it('总览文件不写本机数据目录，顺序走已有 layout 键', () => {
    const root = process.cwd();
    const app = readFileSync(path.join(root, 'src/renderer/MainShell.tsx'), 'utf8');
    const view = readFileSync(path.join(root, 'src/renderer/workspace-picker/WorkspaceOverview.tsx'), 'utf8');
    expect(app).toContain('OVERVIEW_BOARDS_KEY');
    expect(app).toContain('parseOverviewBoards');
    expect(app).toContain('setLayout(OVERVIEW_BOARDS_KEY, next)');
    expect(view).not.toContain('application/x-kb-overview-order');
    expect(view).toContain('默认分类不可删除');
    expect(view).toContain('添加工作区');
    expect(view).toContain('data-action="new-category"');
    expect(view).not.toContain('text/plain');
    for (const file of [app, view, readFileSync(path.join(root, 'src/shared/workspacePicker/overviewBoards.ts'), 'utf8')]) {
      expect(file).not.toContain('LOCALAPPDATA');
      expect(file).not.toContain('LocalKnowledgeWorkbench');
      expect(file).not.toContain('clipboard');
    }
  });
});
