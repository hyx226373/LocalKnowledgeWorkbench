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
    const projects = section(model, 'projects')?.groups ?? [];
    expect(projects.map((group) => group.label)).toEqual(['工具', '界面', '考研', '未分组']);
    expect(ids(projects.find((group) => group.label === '考研')?.cards)).toEqual([
      'ws-mixed',
      'ws-same-file',
      'ws-english',
      'ws-english-2',
      'ws-webs',
    ]);
    expect(ids(projects.find((group) => group.key === '')?.cards)).toEqual(['ws-broken', 'ws-stale', 'ws-empty']);
    const english = section(model, 'tags')?.groups?.find((group) => group.key === '英语');
    expect(ids(english?.cards)).toEqual(['ws-english', 'ws-english-2']);
    expect(model.sections.some((item) => ids(item.cards).includes('tmp-1'))).toBe(false);
  });

  it('searches name, purpose, and tags, and leaves temporary workspaces out', () => {
    expect(overviewMatchesQuery({ name: 'Alpha', purpose: '', tags: [] }, '  alpha ')).toBe(true);
    const withTemp = [...savedEntries, temporaryEntry()];
    const byPurpose = modelOf({ entries: withTemp, ui: { search: '计算器', selectedId: null } });
    expect(ids(section(byPurpose, 'favorites')?.cards)).toEqual(['ws-mixed']);
    expect(byPurpose.unsaved?.id).toBe('tmp-1');
    expect(byPurpose.sections.every((item) => !ids(item.cards).includes('tmp-1'))).toBe(true);
    expect(byPurpose.sections.every((item) => !(item.groups ?? []).some((group) => ids(group.cards).includes('tmp-1')))).toBe(true);

    const byTag = modelOf({ entries: withTemp, ui: { search: '  论文  ', selectedId: null } });
    expect(ids(section(byTag, 'current')?.cards)).toEqual([]);
    expect(section(byTag, 'current')).toBeUndefined();
    const tagIds = (section(byTag, 'tags')?.groups ?? []).flatMap((group) => ids(group.cards));
    expect(tagIds).toContain('ws-mixed');
    expect(tagIds).not.toContain('tmp-1');

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
  it('renders sections, disabled edits, card classes, and an embedded thumb', () => {
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
    for (const id of ['current', 'favorites', 'recent', 'projects', 'tags', 'presets', 'detail']) {
      expect(html).toContain(`data-section="${id}"`);
    }
    expect(html).toContain(`class="${WORKSPACE_CARD_CLASS.root} ${WORKSPACE_CARD_CLASS.selected} ${WORKSPACE_CARD_CLASS.favorite}"`);
    expect(html).toContain('data-workspace-id="ws-same-file"');
    expect(html).toContain('data-count-files="1"');
    expect(html).toContain('data-count-panels="3"');
    expect(html).toContain('data-cache-key="mixed-v1"');
    expect(html).toContain('class="kb-ws-thumb-frame"');
    expect(html).not.toContain('kb-ws-thumb-frame is-selected');
    expect(html).toContain('data-preset-id="builtin.two-columns"');
    for (const field of ['purpose', 'tags', 'cover']) {
      expect(buttonTag(html, 'data-edit', field)).toContain('disabled');
    }
    expect(html).toContain('data-detail="files"');
    expect(html).toContain('高数笔记.md');
    const broken = markup({ entries: savedEntries, currentId: 'ws-english', selectedId: 'ws-broken' });
    expect(broken).toContain('data-missing="true"');
    expect(broken).toContain('data-problem="resource-missing"');
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
    expect(overviewSectionsForFilter(model.sections, 'projects').map((section) => section.id)).toEqual(['projects']);
    expect(overviewSectionsForFilter(model.sections, 'tags').map((section) => section.id)).toEqual(['tags']);
    const projectLabels = overviewSectionsForFilter(model.sections, 'projects').flatMap((section) => section.groups?.map((group) => group.label) ?? []);
    expect(projectLabels).toContain('考研');
    expect(projectLabels).toContain('未分组');

    const html = markup({ entries: savedEntries, currentId: 'ws-english' });
    expect(html).toContain('name="kb-ws-overview-filter"');
    expect(html).toContain('data-filter-owner="overview"');
    expect(html).toContain('data-action="toggle-filter"');
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
    expect(more).toContain('disabled');

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
});

describe('workspace overview sources', () => {
  it('does not reference catalog rows, host attach, or the invoke whitelist', () => {
    const files = [
      'src/shared/workspacePicker/overview.ts',
      'src/renderer/workspace-picker/WorkspaceOverview.tsx',
      'src/renderer/workspace-picker/overview.css',
    ];
    const banned = ['catalog_id', 'host.attach', 'createWin32Helper', 'setVisible', 'INVOKE_WHITELIST', 'appLaunch', 'ipcRenderer'];
    for (const file of files) {
      const text = readFileSync(path.join(process.cwd(), file), 'utf8');
      for (const word of banned) expect(text, file).not.toContain(word);
    }
  });
});
