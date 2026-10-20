import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CARD_THEME_SETS } from '../../src/renderer/workspace-picker/cardThemes';
import { WorkspaceOverview } from '../../src/renderer/workspace-picker/WorkspaceOverview';
import {
  WORKSPACE_CARD_CLASS,
  OVERVIEW_FILTERS,
  buildOverview,
  dispatchOverview,
  initialOverviewUi,
  overviewGate,
  overviewMatchesQuery,
  overviewSectionsForFilter,
  type LayoutThumbModel,
  type OverviewActions,
  type OverviewEntryInput,
  type OverviewIntent,
  type OverviewModel,
  type OverviewSectionModel,
  type WorkspaceCounts,
  type WorkspaceSummary,
} from '../../src/shared/workspacePicker';

interface SampleDetail {
  files: { resourceId: string; title: string; missing: boolean }[];
  webs: { ref: string; title: string }[];
  apps: { ref: string; title: string; configured: true }[];
  nativeHosts: { panelId: string; hostPath: string; titleHint: string }[];
  agents: { roomId: string; title: string; roles: { id: string; name: string; configured: true }[]; running: 'running' | 'stopped' | 'unknown' }[];
  savedAt: number;
  restorePolicy: 'manual-open-apps';
  recentResults: { at: number; title: string; ref: string }[];
  problems: { code: string; panelId?: string; message: string; retryable: boolean }[];
}

interface SampleWorkspace {
  id: string;
  name: string;
  purpose: string;
  tags: string[];
  project: string;
  favorite: boolean;
  lastUsedAt: number | null;
  counts: WorkspaceCounts;
  icon: string | null;
  accent: string | null;
  coverRef: string | null;
  thumbVersion: number;
  thumb: LayoutThumbModel;
  detail: SampleDetail;
}

const samples = JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/workspace-picker-samples.json'), 'utf8')) as {
  workspaces: SampleWorkspace[];
};

const PRESETS = [
  { id: 'builtin.single', label: '单栏' },
  { id: 'builtin.two-columns', label: '左右两栏' },
];

function entryOf(ws: SampleWorkspace, temporary = false): OverviewEntryInput {
  const summary: WorkspaceSummary = {
    id: ws.id,
    name: ws.name,
    purpose: ws.purpose,
    tags: ws.tags,
    project: ws.project,
    favorite: ws.favorite,
    lastUsedAt: ws.lastUsedAt,
    counts: ws.counts,
    icon: ws.icon,
    accent: ws.accent,
    coverRef: ws.coverRef,
    thumbVersion: ws.thumbVersion,
  };
  return { summary, thumb: ws.thumb, detail: ws.detail, temporary };
}

const savedEntries = samples.workspaces.map((ws) => entryOf(ws));

function temporaryEntry(): OverviewEntryInput {
  const base = samples.workspaces.find((ws) => ws.id === 'ws-mixed');
  if (!base) throw new Error('fixture missing ws-mixed');
  const entry = entryOf(base, true);
  entry.summary = {
    ...entry.summary,
    id: 'tmp-1',
    name: '论文临时现场',
    purpose: '还没保存',
    tags: ['论文'],
    project: '考研',
    favorite: true,
    lastUsedAt: 1990000000000,
  };
  return entry;
}

function modelOf(extra?: Partial<Parameters<typeof buildOverview>[0]>): OverviewModel {
  return buildOverview({
    entries: savedEntries,
    currentId: 'ws-english',
    overviewHidden: false,
    presets: PRESETS,
    ui: initialOverviewUi(),
    ...extra,
  });
}

function section(model: OverviewModel, id: OverviewSectionModel['id']): OverviewSectionModel | undefined {
  return model.sections.find((item) => item.id === id);
}

function ids(cards: { id: string }[] | null | undefined): string[] {
  return (cards ?? []).map((card) => card.id);
}

function actions() {
  const spies = {
    onEnter: vi.fn<(workspaceId: string) => void>(),
    onCopy: vi.fn<(workspaceId: string) => void>(),
    onExport: vi.fn<(workspaceId: string) => void>(),
    onRename: vi.fn<(workspaceId: string, name: string) => void>(),
    onDelete: vi.fn<(workspaceId: string) => void>(),
    onFavorite: vi.fn<(workspaceId: string, favorite: boolean) => void>(),
    onCreate: vi.fn<(name: string) => void>(),
    onCreateFirst: vi.fn<(name: string) => void>(),
    onEnterTemporary: vi.fn<() => void>(),
    onApplyPreset: vi.fn<(presetId: string) => void>(),
  };
  const callbacks: OverviewActions = {
    onEnter: (workspaceId) => spies.onEnter(workspaceId),
    onCopy: (workspaceId) => spies.onCopy(workspaceId),
    onExport: (workspaceId) => spies.onExport(workspaceId),
    onRename: (workspaceId, name) => spies.onRename(workspaceId, name),
    onDelete: (workspaceId) => spies.onDelete(workspaceId),
    onFavorite: (workspaceId, favorite) => spies.onFavorite(workspaceId, favorite),
    onCreate: (name) => spies.onCreate(name),
    onCreateFirst: (name) => spies.onCreateFirst(name),
    onEnterTemporary: () => spies.onEnterTemporary(),
    onApplyPreset: (presetId) => spies.onApplyPreset(presetId),
  };
  return { spies, callbacks };
}

function run(entries: readonly OverviewEntryInput[], intent: OverviewIntent, hidden = false) {
  const { spies, callbacks } = actions();
  const gate = overviewGate({ entries, overviewHidden: hidden, presets: PRESETS });
  const result = dispatchOverview(initialOverviewUi(), intent, callbacks, gate);
  return { spies, result, gate };
}

function markup(props: Parameters<typeof WorkspaceOverview>[0]): string {
  return renderToStaticMarkup(createElement(WorkspaceOverview, props));
}

function buttonTag(html: string, attr: string, value: string): string {
  const re = new RegExp(`<button\\b[^>]*${attr}="${value}"[^>]*>`);
  const found = html.match(re);
  expect(found, `${attr}=${value}`).not.toBeNull();
  return found![0];
}

describe('workspace overview model', () => {
  it('groups saved workspaces and keeps stale at the end of recent', () => {
    const model = modelOf();
    expect(model.mode).toBe('list');
    expect(model.visible).toBe(true);
    expect(model.writesLibrary).toBe(false);
    expect(model.autoCreatesDefaultWorkspace).toBe(false);
    expect(model.hoverInvokesIpc).toBe(false);
    expect(ids(section(model, 'current')?.cards)).toEqual(['ws-english']);
    expect(ids(section(model, 'favorites')?.cards)).toEqual(['ws-long', 'ws-mixed', 'ws-english', 'ws-cover']);
    const recent = ids(section(model, 'recent')?.cards);
    expect(recent[0]).toBe('ws-cover');
    expect(recent[recent.length - 1]).toBe('ws-stale');
    expect(recent).not.toContain('ws-norecent');
    expect(recent).not.toContain('ws-empty');
    expect(section(model, 'projects')).toBeUndefined();
    expect(section(model, 'tags')).toBeUndefined();
    expect(model.allOrderIds[0]).toBe('ws-english');
    expect(model.allOrderIds).toContain('ws-empty');
    expect(model.allOrderIds).toContain('ws-norecent');
    expect(model.allCards.map((card) => card.id)).toEqual(model.allOrderIds);
    expect(new Set(model.allOrderIds).size).toBe(model.allOrderIds.length);
    expect(model.sections.some((item) => ids(item.cards).includes('tmp-1'))).toBe(false);
  });

  it('项目和标签只来自用户分组，顺序可以单独记住', () => {
    const boards = {
      v: 1 as const,
      projects: [{ id: 'p-1', name: '项目1', workspaceIds: ['ws-english', 'ws-empty', 'missing'] }],
      tags: [{ id: 't-1', name: '标签1', workspaceIds: ['ws-webs', 'ws-english'] }],
      allOrder: ['ws-empty', 'ws-english'],
      favoriteOrder: ['ws-english', 'ws-cover', 'ws-long', 'ws-mixed'],
    };
    const model = modelOf({ boards });
    const projects = section(model, 'projects')?.groups ?? [];
    expect(projects.map((group) => group.label)).toEqual(['项目1']);
    expect(projects.map((group) => group.key)).toEqual(['p-1']);
    expect(ids(projects[0]?.cards)).toEqual(['ws-english', 'ws-empty']);
    expect(ids(section(model, 'tags')?.groups?.[0]?.cards)).toEqual(['ws-webs', 'ws-english']);
    expect(model.allOrderIds.slice(0, 2)).toEqual(['ws-empty', 'ws-english']);
    expect(model.favoriteOrderIds).toEqual(['ws-english', 'ws-cover', 'ws-long', 'ws-mixed']);
    expect(ids(section(model, 'favorites')?.cards)).toEqual(['ws-english', 'ws-cover', 'ws-long', 'ws-mixed']);
    const searched = modelOf({
      boards,
      ui: { search: '从未', selectedId: null },
    });
    expect(ids(section(searched, 'projects')?.groups?.[0]?.cards)).toEqual([]);
    expect(section(searched, 'projects')).toBeUndefined();
    const named = modelOf({
      boards: {
        ...boards,
        projects: [{ id: 'p-1', name: '项目1', workspaceIds: ['ws-english', 'ws-norecent'] }],
      },
      ui: { search: '从未', selectedId: null },
    });
    expect(ids(section(named, 'projects')?.groups?.[0]?.cards)).toEqual(['ws-norecent']);
    expect(ids(section(named, 'recent')?.cards)).not.toContain('ws-norecent');
  });

  it('searches name, purpose, and tags, and leaves temporary workspaces out', () => {
    expect(overviewMatchesQuery({ name: 'Alpha', purpose: '', tags: [] }, '  alpha ')).toBe(true);
    const withTemp = [...savedEntries, temporaryEntry()];
    const byPurpose = modelOf({ entries: withTemp, ui: { search: '计算器', selectedId: null } });
    expect(ids(section(byPurpose, 'favorites')?.cards)).toEqual(['ws-mixed']);
    expect(byPurpose.unsaved?.id).toBe('tmp-1');
    expect(byPurpose.sections.every((item) => !ids(item.cards).includes('tmp-1'))).toBe(true);
    expect(byPurpose.sections.every((item) => !(item.groups ?? []).some((group) => ids(group.cards).includes('tmp-1')))).toBe(true);

    const byName = modelOf({ entries: withTemp, ui: { search: '  论文  ', selectedId: null } });
    expect(ids(section(byName, 'current')?.cards)).toEqual([]);
    expect(section(byName, 'current')).toBeUndefined();
    expect(section(byName, 'tags')).toBeUndefined();
    expect(ids(byName.allCards)).toContain('ws-mixed');
    expect(ids(byName.allCards)).not.toContain('tmp-1');

    const byTag = modelOf({ entries: withTemp, ui: { search: '数学', selectedId: null } });
    expect(ids(byTag.allCards)).toEqual(['ws-mixed']);
    expect(byTag.sections.every((item) => !ids(item.cards).includes('tmp-1'))).toBe(true);

    const none = modelOf({ ui: { search: '没有这个词', selectedId: null } });
    expect(none.mode).toBe('list');
    expect(none.sections).toEqual([]);
  });

  it('selects on click, enters on enter and double-click, and ignores hover', () => {
    const entries = savedEntries;
    const selected = run(entries, { type: 'select', id: 'ws-cover' });
    expect(selected.result.ui.selectedId).toBe('ws-cover');
    expect(selected.result.called).toBe(false);
    expect(selected.spies.onEnter).not.toHaveBeenCalled();

    const entered = run(entries, { type: 'enter', id: 'ws-cover' });
    expect(entered.spies.onEnter).toHaveBeenCalledTimes(1);
    expect(entered.spies.onEnter).toHaveBeenCalledWith('ws-cover');
    expect(entered.result.ui.selectedId).toBe('ws-cover');

    const doubled = run(entries, { type: 'dblclick', id: 'ws-host' });
    expect(doubled.spies.onEnter).toHaveBeenCalledTimes(1);
    expect(doubled.spies.onEnter).toHaveBeenCalledWith('ws-host');

    const hover = run(entries, { type: 'hover', id: 'ws-cover' });
    expect(hover.result.called).toBe(false);
    expect(hover.result.ui).toEqual(initialOverviewUi());
    for (const spy of Object.values(hover.spies)) expect(spy).not.toHaveBeenCalled();

    const missing = run(entries, { type: 'enter', id: 'missing' });
    expect(missing.spies.onEnter).not.toHaveBeenCalled();
    const built = modelOf({ ui: { search: '', selectedId: 'ws-cover' } });
    expect(built.sections.flatMap((item) => item.cards ?? []).find((card) => card.id === 'ws-cover')?.lastUsedAt).toBe(1780000007000);
    expect(built.sections.flatMap((item) => item.cards ?? []).find((card) => card.id === 'ws-cover')?.className).toBe(
      `${WORKSPACE_CARD_CLASS.root} ${WORKSPACE_CARD_CLASS.selected} ${WORKSPACE_CARD_CLASS.favorite}`,
    );
  });

  it('keeps purpose, tag, and cover edits disabled and routes copy, export, and rename through callbacks', () => {
    const model = modelOf({ ui: { search: '', selectedId: 'ws-broken' } });
    expect(model.editButtons.map((button) => [button.field, button.disabled, button.reason])).toEqual([
      ['purpose', true, 'no-service'],
      ['tags', true, 'no-service'],
      ['cover', true, 'no-service'],
    ]);
    expect(model.detail?.problems.map((problem) => problem.code)).toEqual(['resource-missing', 'load-failed']);
    expect(model.detail?.files.find((file) => file.resourceId === 'res-gone')?.missing).toBe(true);

    const copied = run(savedEntries, { type: 'copy', id: 'ws-broken' });
    expect(copied.spies.onCopy).toHaveBeenCalledWith('ws-broken');
    expect(copied.spies.onExport).not.toHaveBeenCalled();
    const exported = run(savedEntries, { type: 'export', id: 'ws-broken' });
    expect(exported.spies.onExport).toHaveBeenCalledWith('ws-broken');
    const renamed = run(savedEntries, { type: 'rename', id: 'ws-broken', name: '  修好了  ' });
    expect(renamed.spies.onRename).toHaveBeenCalledWith('ws-broken', '修好了');
    const blank = run(savedEntries, { type: 'rename', id: 'ws-broken', name: '   ' });
    expect(blank.spies.onRename).not.toHaveBeenCalled();
    const removed = run(savedEntries, { type: 'delete', id: 'ws-broken' });
    expect(removed.spies.onDelete).toHaveBeenCalledWith('ws-broken');
    expect(removed.result.called).toBe(true);
    const only = savedEntries.filter((entry) => entry.summary.id === 'ws-empty');
    const last = run(only, { type: 'delete', id: 'ws-empty' });
    expect(last.result.called).toBe(false);
    expect(last.spies.onDelete).not.toHaveBeenCalled();
    const tempDelete = run([temporaryEntry()], { type: 'delete', id: 'tmp-1' });
    expect(tempDelete.spies.onDelete).not.toHaveBeenCalled();

    const favOn = run(savedEntries, { type: 'favorite', id: 'ws-english', favorite: true });
    expect(favOn.result.called).toBe(true);
    expect(favOn.spies.onFavorite).toHaveBeenCalledWith('ws-english', true);
    const favOff = run(savedEntries, { type: 'favorite', id: 'ws-english', favorite: false });
    expect(favOff.spies.onFavorite).toHaveBeenCalledWith('ws-english', false);
    const favTemp = run(savedEntries, { type: 'favorite', id: 'missing-id', favorite: true });
    expect(favTemp.result.called).toBe(false);
    expect(favTemp.spies.onFavorite).not.toHaveBeenCalled();

    for (const field of ['purpose', 'tags', 'cover'] as const) {
      const edited = run(savedEntries, { type: 'edit', field });
      expect(edited.result.called).toBe(false);
      for (const spy of Object.values(edited.spies)) expect(spy).not.toHaveBeenCalled();
    }
  });

  it('hides the overview without calling callbacks or creating a default workspace', () => {
    const hidden = modelOf({ overviewHidden: true, entries: [] });
    expect(hidden.visible).toBe(false);
    expect(hidden.mode).toBe('hidden');
    expect(hidden.sections).toEqual([]);
    expect(hidden.welcome).toBeNull();
    const dispatched = run(savedEntries, { type: 'enter', id: 'ws-english' }, true);
    expect(dispatched.result.called).toBe(false);
    expect(dispatched.spies.onEnter).not.toHaveBeenCalled();
    expect(hidden.autoCreatesDefaultWorkspace).toBe(false);
  });

  it('shows the welcome choices and does not persist a temporary scene', () => {
    const entries = [temporaryEntry()];
    const model = modelOf({ entries, currentId: 'tmp-1', ui: { search: '', selectedId: 'tmp-1' } });
    expect(model.mode).toBe('welcome');
    expect(model.welcome?.fromTemplate).toEqual({ enabled: false, label: '从模板创建', reason: 'template-unavailable' });
    expect(model.welcome?.createFirst.enabled).toBe(true);
    expect(model.welcome?.enterTemporary.enabled).toBe(true);
    expect(model.sections).toEqual([]);
    expect(model.unsaved?.id).toBe('tmp-1');
    expect(model.unsaved?.temporary).toBe(true);
    expect(model.unsaved?.className).toBe(`${WORKSPACE_CARD_CLASS.root} ${WORKSPACE_CARD_CLASS.selected}`);
    expect(model.serviceActions.find((action) => action.id === 'copy')?.enabled).toBe(false);
    expect(model.serviceActions.find((action) => action.id === 'enter')?.enabled).toBe(true);
    expect(JSON.stringify(model)).not.toContain('默认工作区');

    const created = run(entries, { type: 'create-first', name: ' 第一份 ' });
    expect(created.spies.onCreateFirst).toHaveBeenCalledWith('第一份');
    expect(created.spies.onCreate).not.toHaveBeenCalled();
    const blocked = run(entries, { type: 'from-template' });
    expect(blocked.result.called).toBe(false);
    for (const spy of Object.values(blocked.spies)) expect(spy).not.toHaveBeenCalled();
    const temporary = run(entries, { type: 'enter-temporary' });
    expect(temporary.spies.onEnterTemporary).toHaveBeenCalledTimes(1);
    expect(temporary.spies.onCreateFirst).not.toHaveBeenCalled();
    const preset = run(entries, { type: 'apply-preset', presetId: 'builtin.single' });
    expect(preset.spies.onApplyPreset).toHaveBeenCalledWith('builtin.single');
    expect(preset.spies.onCreateFirst).not.toHaveBeenCalled();
    const unknownPreset = run(entries, { type: 'apply-preset', presetId: 'missing' });
    expect(unknownPreset.spies.onApplyPreset).not.toHaveBeenCalled();

    const saved = run(savedEntries, { type: 'create', name: '新的' });
    expect(saved.spies.onCreate).toHaveBeenCalledWith('新的');
    const notWelcome = run(savedEntries, { type: 'create-first', name: '新的' });
    expect(notWelcome.spies.onCreateFirst).not.toHaveBeenCalled();
    const notTemporary = run(savedEntries, { type: 'enter-temporary' });
    expect(notTemporary.spies.onEnterTemporary).not.toHaveBeenCalled();
    const tempCopy = run(entries, { type: 'copy', id: 'tmp-1' });
    expect(tempCopy.spies.onCopy).not.toHaveBeenCalled();
    const tempEnter = run(entries, { type: 'dblclick', id: 'tmp-1' });
    expect(tempEnter.spies.onEnter).toHaveBeenCalledWith('tmp-1');
  });
});

describe('workspace overview markup', () => {
  it('renders sections, card classes, and an embedded thumb without a detail column', () => {
    const html = markup({
      entries: savedEntries,
      currentId: 'ws-english',
      selectedId: 'ws-mixed',
      presets: PRESETS,
      theme: CARD_THEME_SETS[0],
    });
    expect(html.startsWith('<div class="kb-ws-overview"')).toBe(true);
    expect(html).toContain('data-kb-overlay=""');
    expect(html).toContain('data-mode="list"');
    expect(html).toContain('data-writes-library="false"');
    expect(html).toContain('data-hover-ipc="false"');
    expect(html).toContain('data-kb-scheme="light"');
    expect(html).toContain('--kb-color-surface:');
    for (const id of ['all', 'presets']) {
      expect(html).toContain(`data-section="${id}"`);
    }
    expect(html).not.toContain('data-section="current"');
    expect(html).not.toContain('data-section="projects"');
    expect(html).not.toContain('data-section="tags"');
    // r21 §7：分类页卡片可拖到左侧分类（只加引用），因此卡片允许 draggable
    expect(html).toContain('data-action="add-workspaces"');
    expect(html).toContain('添加工作区');
    expect(html).not.toContain('data-section="detail"');
    expect(html).toContain(`class="${WORKSPACE_CARD_CLASS.root} ${WORKSPACE_CARD_CLASS.selected} ${WORKSPACE_CARD_CLASS.favorite}"`);
    expect(html).toContain('data-workspace-id="ws-same-file"');
    expect(html).toContain('data-count-files="1"');
    expect(html).toContain('data-count-panels="3"');
    expect(html).toContain('data-cache-key="mixed-v1"');
    expect(html).toContain('class="kb-ws-thumb-frame"');
    expect(html).not.toContain('kb-ws-thumb-frame is-selected');
    expect(html).toContain('data-preset-id="builtin.two-columns"');
    expect(html).not.toContain('data-edit=');
    expect(html).not.toContain('data-detail="files"');
    expect(html).not.toContain('高数笔记.md');
    const broken = markup({ entries: savedEntries, currentId: 'ws-english', selectedId: 'ws-broken' });
    expect(broken).not.toContain('data-missing="true"');
    expect(broken).not.toContain('data-problem="resource-missing"');
    expect(broken).not.toContain('data-section="detail"');
    expect(html).not.toContain('catalog_id');
  });

  it('renders the empty welcome page and nothing when the overview is hidden', () => {
    const welcome = markup({ entries: [], presets: PRESETS });
    expect(welcome).toContain('data-mode="welcome"');
    expect(welcome).toContain('data-section="welcome"');
    expect(buttonTag(welcome, 'data-action', 'create-first')).not.toContain('disabled');
    expect(buttonTag(welcome, 'data-action', 'from-template')).toContain('disabled');
    expect(buttonTag(welcome, 'data-action', 'enter-temporary')).not.toContain('disabled');
    expect(welcome).toContain('不会自动创建默认工作区');
    expect(welcome).not.toContain('data-workspace-id=');
    expect(welcome).not.toContain('data-section="favorites"');
    expect(markup({ entries: savedEntries, overviewHidden: true })).toBe('');
  });

  it('左侧单选来自真实分区，图片和标题带工作区 id，没有快照时显示布局预览', () => {
    expect(OVERVIEW_FILTERS.map((item) => item.label)).toEqual(['全部', '最近', '收藏', '项目', '标签']);
    expect(OVERVIEW_FILTERS.map((item) => item.label).join('')).not.toContain('考研');
    const model = modelOf();
    expect(overviewSectionsForFilter(model.sections, 'recent').map((section) => section.id)).toEqual(['recent']);
    expect(overviewSectionsForFilter(model.sections, 'favorites').map((section) => section.id)).toEqual(['favorites']);
    expect(overviewSectionsForFilter(model.sections, 'projects')).toEqual([]);
    expect(overviewSectionsForFilter(model.sections, 'tags')).toEqual([]);

    const html = markup({ entries: savedEntries, currentId: 'ws-english' });
    expect(html).toContain('name="kb-ws-overview-filter"');
    expect(html).toContain('data-filter-owner="overview"');
    expect(html).toContain('data-action="toggle-filter"');
    expect(html).toContain('data-category-id="all"');
    expect(html).toContain('data-default="true"');
    expect(html).toContain('data-action="new-category"');
    expect(html).toContain('新建分类');
    expect(html).toContain('data-action="open-preview"');
    expect(html).toContain('data-action="open-title"');
    expect(html).toContain('data-action="favorite"');
    expect(html).toContain('data-action="more"');
    expect(html).toContain('布局预览');
    expect(html).toContain('aspect-ratio');
    expect(html).not.toContain('mini-tab');
    expect(html).not.toContain('考研学习');
    const openTitle = buttonTag(html, 'data-action', 'open-title');
    expect(openTitle).toContain('data-workspace-id="');
    const favorite = buttonTag(html, 'data-action', 'favorite');
    expect(favorite).not.toContain('data-action="enter"');
    const more = buttonTag(html, 'data-action', 'more');
    expect(more).not.toContain('disabled');
    expect(more).toContain('aria-haspopup="menu"');
    expect(more).toContain('aria-expanded="false"');
    expect(html).toContain('data-activate="enter"');
    expect(html).toContain('data-action="copy"');
    expect(html).toContain('data-action="export"');
    expect(html).toContain('data-action="rename"');
    expect(html).toContain('data-action="delete"');
    expect(html).toContain('data-testid="workspace-delete"');
    expect(html).toContain('data-field="rename"');
    const enabledDelete = buttonTag(html, 'data-testid', 'workspace-delete');
    expect(enabledDelete).not.toContain('disabled');
    expect(enabledDelete).toContain('不会删除磁盘上的文件');
    expect(html).not.toContain('更多（稍后）');
    const headStart = html.indexOf('<header');
    const headEnd = html.indexOf('</header>');
    const head = html.slice(headStart, headEnd);
    const formStart = head.indexOf('<form');
    const formOpen = head.slice(formStart, head.indexOf('>', formStart));
    expect(formOpen).toContain('ov-create-pop');
    expect(formOpen).toContain('hidden');
    expect(head.indexOf('data-field="create-name"')).toBeGreaterThan(formStart);
    expect(head).toContain('data-action="open-create"');
    expect(head).toContain('aria-haspopup="dialog"');
    expect(head).toContain('data-action="create"');
    const tempHtml = markup({ entries: [...savedEntries, temporaryEntry()], currentId: 'ws-english' });
    expect(buttonTag(tempHtml, 'data-action', 'copy')).toContain('disabled');
    expect(buttonTag(tempHtml, 'data-action', 'export')).toContain('disabled');
    expect(buttonTag(tempHtml, 'data-action', 'rename')).toContain('disabled');
    expect(buttonTag(tempHtml, 'data-testid', 'workspace-delete')).toContain('disabled');
    expect(buttonTag(tempHtml, 'data-testid', 'workspace-delete')).toContain('临时现场还没保存，不能删除');
    const source = readFileSync(path.join(process.cwd(), 'src/renderer/workspace-picker/WorkspaceOverview.tsx'), 'utf8');
    expect(source).not.toContain("type: 'select'");
    expect(source).toContain("type: 'enter', id: card.id");
    expect(source).toContain("type: 'create', name");

    const shot = markup({
      entries: savedEntries,
      currentId: 'ws-english',
      snapshotFiles: { 'ws-empty': 'snap-ws-empty.png', 'ws-long': 'C:\\shot.png' },
    });
    expect(shot).toContain('data-snapshot-file="snap-ws-empty.png"');
    expect(shot).not.toContain('data-snapshot-file="C:\\shot.png"');
    expect(shot).toContain('data-cover-file="ws-cover.png"');
    const closed = markup({
      entries: savedEntries,
      currentId: 'ws-english',
      snapshotEnabled: false,
      snapshotFiles: { 'ws-empty': 'snap-ws-empty.png' },
    });
    expect(closed).not.toContain('data-snapshot-file="snap-ws-empty.png"');
    expect(closed).toContain('布局预览');
    expect(closed).toContain('data-cover-file="ws-cover.png"');
  });

  it('只剩一个已保存工作区时，删除按钮禁用并说明原因', () => {
    const html = markup({ entries: savedEntries.filter((entry) => entry.summary.id === 'ws-empty'), currentId: 'ws-empty' });
    const button = buttonTag(html, 'data-testid', 'workspace-delete');
    expect(button).toContain('data-workspace-id="ws-empty"');
    expect(button).toContain('disabled');
    expect(button).toContain('只剩这一个工作区，不能删除');
    expect(button).toContain('删除');
  });
});

describe('分类页', () => {
  const boards = {
    v: 1 as const,
    projects: [{ id: 'p-1', name: '项目1', workspaceIds: ['ws-english', 'ws-empty'] }],
    tags: [{ id: 't-1', name: '标签1', workspaceIds: ['ws-webs'] }],
    allOrder: [] as string[],
    favoriteOrder: [] as string[],
  };

  it('没有项目分类时回到全部，仍有添加框，不按工作区项目字段分组', () => {
    const html = markup({ entries: savedEntries, currentId: 'ws-english', initialFilter: 'projects' });
    expect(html).toContain('data-section="all"');
    expect(html).toContain('data-action="add-workspaces"');
    expect(html).toContain('添加工作区');
    expect(html).toContain('data-action="new-category"');
    expect(html).not.toContain('data-action="add-group"');
    expect(html).not.toContain('data-project=');
    expect(html).not.toContain('>考研<');
    // r21 §7：分类页卡片可拖到左侧分类（只加引用），因此卡片允许 draggable
  });

  it('项目分类是流式网格，卡片按分组顺序，末尾是添加框', () => {
    const html = markup({ entries: savedEntries, currentId: 'ws-english', initialFilter: 'projects', boards });
    expect(html).toContain('data-section="p-1"');
    expect(html).toContain('项目1');
    expect(html).toContain('data-category-id="cat:p-1"');
    expect(html).toContain('data-origin="projects"');
    expect(html).toContain('data-workspace-id="ws-english"');
    expect(html).toContain('data-workspace-id="ws-empty"');
    expect(html).toContain('data-action="add-workspaces"');
    expect(html).toContain('data-action="remove-ref"');
    expect(html).toContain('移出分类');
    // 分类页里只能移出引用，不能从这里删掉工作区本身（旧 bug：删一个，别处的同一卡片失效）。
    expect(html).not.toContain('data-testid="workspace-delete"');
    expect(html).not.toContain('class="kb-ws-overview-row ov-row"');
    // r21 §7：分类页卡片可拖到左侧分类（只加引用），因此卡片允许 draggable
    const english = html.indexOf('data-workspace-id="ws-english"');
    const empty = html.indexOf('data-workspace-id="ws-empty"');
    expect(english).toBeGreaterThan(0);
    expect(english).toBeLessThan(empty);
    const css = readFileSync(path.join(process.cwd(), 'src/renderer/workspace-picker/overview.css'), 'utf8');
    const preview = readFileSync(path.join(process.cwd(), 'src/renderer/ui/overview-preview.css'), 'utf8');
    expect(css).not.toContain('flex-wrap: nowrap');
    expect(css).not.toContain('overflow-x: auto');
    expect(css).toContain('repeat(auto-fill, minmax(220px, 1fr))');
    expect(preview).toContain('repeat(auto-fill, minmax(220px, 1fr))');
    expect(preview).not.toContain('minmax(240px, 1fr)');
    expect(css).not.toContain('#5B5BD6');
    expect(preview).not.toContain('#5B5BD6');
  });

  it('标签分类用同一套网格', () => {
    const html = markup({ entries: savedEntries, currentId: 'ws-english', initialFilter: 'tags', boards });
    expect(html).toContain('data-section="t-1"');
    expect(html).toContain('标签1');
    expect(html).toContain('data-category-id="cat:t-1"');
    expect(html).toContain('data-origin="tags"');
    expect(html).toContain('data-workspace-id="ws-webs"');
    expect(html).not.toContain('data-workspace-id="ws-english"');
    expect(html).not.toContain('class="kb-ws-overview-row ov-row"');
  });

  it('选择工作区是缩略图多选，已添加置灰，临时现场不出现', () => {
    const html = markup({
      entries: [...savedEntries, temporaryEntry()],
      currentId: 'ws-english',
      initialFilter: 'projects',
      boards,
      initialPickerOpen: true,
    });
    const pickerAt = html.indexOf('aria-label="添加到 项目1"');
    expect(pickerAt).toBeGreaterThan(0);
    const picker = html.slice(pickerAt);
    expect(picker).toContain('data-field="pick-search"');
    expect(picker).toContain('data-action="confirm-add"');
    expect(picker).toContain('data-action="cancel-add"');
    expect(picker).toContain('已选 <b>0</b> 个');
    expect(picker).toContain('已添加');
    expect(buttonTag(picker, 'data-action', 'confirm-add')).toContain('disabled');
    expect(picker).toContain('确定');
    expect(picker).toContain('取消');
    expect(picker).not.toContain('论文临时现场');
    expect(picker).not.toContain('data-workspace-id="tmp-1"');
    expect(buttonTag(picker, 'data-workspace-id', 'ws-english')).toContain('data-added="true"');
    expect(buttonTag(picker, 'data-workspace-id', 'ws-english')).toContain('disabled');
    expect(buttonTag(picker, 'data-workspace-id', 'ws-webs')).toContain('data-added="false"');
    expect(buttonTag(picker, 'data-workspace-id', 'ws-webs')).not.toContain('disabled');
    const cover = picker.indexOf('自设封面');
    const english = picker.indexOf('英语阅读');
    const blank = picker.indexOf('>空白<');
    expect(cover).toBeGreaterThan(0);
    expect(cover).toBeLessThan(english);
    expect(english).toBeLessThan(blank);
  });

  it('最近和收藏不能排序拖动，添加框仍在', () => {
    const recent = markup({ entries: savedEntries, currentId: 'ws-english', initialFilter: 'recent' });
    expect(recent).not.toContain('data-order-scope="recent"');
    expect(recent).toContain('data-section="recent"');
    expect(recent).toContain('data-action="add-workspaces"');
    const favorites = markup({ entries: savedEntries, currentId: 'ws-english', initialFilter: 'favorites' });
    expect(favorites).toContain('data-section="favorites"');
    expect(favorites).not.toContain('data-order-scope="favorites"');
    expect(favorites).not.toContain('移出分类');
  });
});

describe('workspace overview sources', () => {
  it('does not reference catalog rows, host attach, or the invoke whitelist', () => {
    const files = [
      'src/shared/workspacePicker/overview.ts',
      'src/shared/workspacePicker/overviewBoards.ts',
      'src/renderer/workspace-picker/WorkspaceOverview.tsx',
      'src/renderer/workspace-picker/overview.css',
    ];
    const banned = ['catalog_id', 'host.attach', 'createWin32Helper', 'setVisible', 'INVOKE_WHITELIST', 'appLaunch', 'ipcRenderer', 'clipboard', 'LOCALAPPDATA', 'LocalKnowledgeWorkbench'];
    for (const file of files) {
      const text = readFileSync(path.join(process.cwd(), file), 'utf8');
      for (const word of banned) expect(text, file).not.toContain(word);
    }
  });
});
