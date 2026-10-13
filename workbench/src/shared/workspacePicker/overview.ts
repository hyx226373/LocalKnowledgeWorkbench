/**
 * 工作区总览的纯视图模型。不写库、不发 IPC、不启动应用。
 * 悬停没有回调。单击只改选中。进入只走「进入」或双击。
 * 临时现场不进收藏、最近、搜索和项目/标签分组。
 */
import { WORKSPACE_CARD_CLASS, type LayoutThumbModel, type WorkspaceCounts, type WorkspaceDetail, type WorkspaceSummary } from './types';

export const OVERVIEW_UNGROUPED_PROJECT = '未分组';

export const OVERVIEW_EDIT_FIELDS = ['purpose', 'tags', 'cover'] as const;
export type OverviewEditField = (typeof OVERVIEW_EDIT_FIELDS)[number];

const EMPTY_COUNTS: WorkspaceCounts = { files: 0, webs: 0, apps: 0, panels: 0 };

export interface OverviewDetailInput {
  files?: WorkspaceDetail['files'];
  webs?: WorkspaceDetail['webs'];
  apps?: WorkspaceDetail['apps'];
  nativeHosts?: WorkspaceDetail['nativeHosts'];
  agents?: WorkspaceDetail['agents'];
  savedAt?: number;
  restorePolicy?: WorkspaceDetail['restorePolicy'];
  recentResults?: WorkspaceDetail['recentResults'];
  problems?: WorkspaceDetail['problems'];
}

export interface OverviewEntryInput {
  summary: WorkspaceSummary;
  thumb?: LayoutThumbModel | null;
  detail?: OverviewDetailInput | null;
  /** 内存里的临时现场。不是已保存工作区。 */
  temporary?: boolean;
}

export interface OverviewPresetRef {
  id: string;
  label: string;
}

export interface OverviewUiState {
  search: string;
  selectedId: string | null;
}

export interface OverviewInput {
  entries: readonly OverviewEntryInput[];
  currentId: string | null;
  overviewHidden: boolean;
  presets: readonly OverviewPresetRef[];
  ui: OverviewUiState;
}

export interface OverviewActions {
  onEnter?: (workspaceId: string) => void;
  onCopy?: (workspaceId: string) => void;
  onExport?: (workspaceId: string) => void;
  onRename?: (workspaceId: string, name: string) => void;
  onFavorite?: (workspaceId: string, favorite: boolean) => void;
  onCreate?: (name: string) => void;
  onCreateFirst?: (name: string) => void;
  onEnterTemporary?: () => void;
  onApplyPreset?: (presetId: string) => void;
}

export type OverviewIntent =
  | { type: 'search'; query: string }
  | { type: 'select'; id: string }
  | { type: 'enter'; id: string }
  | { type: 'dblclick'; id: string }
  | { type: 'hover'; id: string }
  | { type: 'copy'; id: string }
  | { type: 'export'; id: string }
  | { type: 'rename'; id: string; name: string }
  | { type: 'favorite'; id: string; favorite: boolean }
  | { type: 'create'; name: string }
  | { type: 'create-first'; name: string }
  | { type: 'from-template' }
  | { type: 'enter-temporary' }
  | { type: 'apply-preset'; presetId: string }
  | { type: 'edit'; field: OverviewEditField };

export interface OverviewCardModel {
  id: string;
  name: string;
  purpose: string;
  project: string;
  projectLabel: string;
  tags: readonly string[];
  favorite: boolean;
  temporary: boolean;
  className: string;
  counts: WorkspaceCounts;
  accent: string | null;
  coverRef: string | null;
  icon: string | null;
  thumb: LayoutThumbModel | null;
  lastUsedAt: number | null;
}

export interface OverviewGroupModel {
  key: string;
  label: string;
  cards: OverviewCardModel[];
}

export interface OverviewSectionModel {
  id: 'current' | 'favorites' | 'recent' | 'projects' | 'tags';
  title: string;
  cards: OverviewCardModel[] | null;
  groups: OverviewGroupModel[] | null;
}

export interface OverviewEditButtonModel {
  field: OverviewEditField;
  label: string;
  disabled: true;
  reason: 'no-service';
}

export interface OverviewServiceActionModel {
  id: 'enter' | 'copy' | 'export' | 'rename';
  label: string;
  enabled: boolean;
}

export interface OverviewDetailModel {
  card: OverviewCardModel;
  savedAt: number | null;
  restorePolicy: 'manual-open-apps';
  files: WorkspaceDetail['files'];
  webs: WorkspaceDetail['webs'];
  apps: WorkspaceDetail['apps'];
  nativeHosts: WorkspaceDetail['nativeHosts'];
  agents: WorkspaceDetail['agents'];
  recentResults: WorkspaceDetail['recentResults'];
  problems: WorkspaceDetail['problems'];
}

export interface OverviewWelcomeModel {
  createFirst: { enabled: true; label: '创建第一个工作区' };
  fromTemplate: { enabled: false; label: '从模板创建'; reason: 'template-unavailable' };
  enterTemporary: { enabled: true; label: '进入临时空白现场' };
}

export interface OverviewModel {
  visible: boolean;
  mode: 'hidden' | 'welcome' | 'list';
  welcome: OverviewWelcomeModel | null;
  unsaved: OverviewCardModel | null;
  sections: OverviewSectionModel[];
  presets: readonly OverviewPresetRef[];
  createEnabled: boolean;
  selectedId: string | null;
  search: string;
  detail: OverviewDetailModel | null;
  editButtons: readonly OverviewEditButtonModel[];
  serviceActions: readonly OverviewServiceActionModel[];
  readonly autoCreatesDefaultWorkspace: false;
  readonly writesLibrary: false;
  readonly hoverInvokesIpc: false;
}

export interface OverviewGate {
  hidden: boolean;
  savedIds: ReadonlySet<string>;
  temporaryIds: ReadonlySet<string>;
  presetIds: ReadonlySet<string>;
}

export interface OverviewDispatchResult {
  ui: OverviewUiState;
  called: boolean;
}

interface NormalizedEntry {
  id: string;
  summary: WorkspaceSummary;
  thumb: LayoutThumbModel | null;
  detail: OverviewDetailInput | null;
  temporary: boolean;
}

const FLAGS = {
  autoCreatesDefaultWorkspace: false as const,
  writesLibrary: false as const,
  hoverInvokesIpc: false as const,
};

const EDIT_BUTTONS: readonly OverviewEditButtonModel[] = [
  { field: 'purpose', label: '编辑用途', disabled: true, reason: 'no-service' },
  { field: 'tags', label: '编辑标签', disabled: true, reason: 'no-service' },
  { field: 'cover', label: '编辑封面', disabled: true, reason: 'no-service' },
];

const WELCOME: OverviewWelcomeModel = {
  createFirst: { enabled: true, label: '创建第一个工作区' },
  fromTemplate: { enabled: false, label: '从模板创建', reason: 'template-unavailable' },
  enterTemporary: { enabled: true, label: '进入临时空白现场' },
};

export function initialOverviewUi(): OverviewUiState {
  return { search: '', selectedId: null };
}

export function workspaceCardClassName(flags: { selected?: boolean; favorite?: boolean }): string {
  return [WORKSPACE_CARD_CLASS.root, flags.selected ? WORKSPACE_CARD_CLASS.selected : '', flags.favorite ? WORKSPACE_CARD_CLASS.favorite : '']
    .filter(Boolean)
    .join(' ');
}

/** 名称、用途、标签。空查询匹配全部。大小写不敏感。 */
export function overviewMatchesQuery(summary: Pick<WorkspaceSummary, 'name' | 'purpose' | 'tags'>, query: string): boolean {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return true;
  const name = typeof summary.name === 'string' ? summary.name : '';
  const purpose = typeof summary.purpose === 'string' ? summary.purpose : '';
  if (name.toLocaleLowerCase().includes(q) || purpose.toLocaleLowerCase().includes(q)) return true;
  const tags = Array.isArray(summary.tags) ? summary.tags : [];
  return tags.some((tag) => typeof tag === 'string' && tag.toLocaleLowerCase().includes(q));
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function countsOf(v: WorkspaceCounts | undefined): WorkspaceCounts {
  if (!v) return { ...EMPTY_COUNTS };
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.trunc(x) : 0);
  return { files: n(v.files), webs: n(v.webs), apps: n(v.apps), panels: n(v.panels) };
}

function tagList(tags: readonly string[] | undefined): string[] {
  if (!Array.isArray(tags)) return [];
  return tags.filter((tag): tag is string => typeof tag === 'string');
}

function normalizeEntry(raw: OverviewEntryInput): NormalizedEntry | null {
  const summary = raw?.summary;
  if (!summary || typeof summary.id !== 'string' || !summary.id) return null;
  const project = asString(summary.project);
  const normalized: WorkspaceSummary = {
    id: summary.id,
    name: asString(summary.name),
    purpose: asString(summary.purpose),
    tags: tagList(summary.tags),
    project,
    favorite: summary.favorite === true,
    lastUsedAt: typeof summary.lastUsedAt === 'number' && Number.isFinite(summary.lastUsedAt) ? summary.lastUsedAt : null,
    counts: countsOf(summary.counts),
    icon: typeof summary.icon === 'string' && summary.icon.trim() ? summary.icon : null,
    accent: typeof summary.accent === 'string' ? summary.accent : null,
    coverRef: typeof summary.coverRef === 'string' ? summary.coverRef : null,
    thumbVersion: typeof summary.thumbVersion === 'number' && Number.isFinite(summary.thumbVersion) ? summary.thumbVersion : 0,
  };
  return {
    id: normalized.id,
    summary: normalized,
    thumb: raw.thumb ?? null,
    detail: raw.detail ?? null,
    temporary: raw.temporary === true,
  };
}

function normalizeEntries(entries: readonly OverviewEntryInput[]): NormalizedEntry[] {
  const seen = new Set<string>();
  const out: NormalizedEntry[] = [];
  for (const raw of entries) {
    const entry = normalizeEntry(raw);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

function compareName(a: OverviewCardModel, b: OverviewCardModel): number {
  const byName = a.name.localeCompare(b.name, 'zh');
  if (byName !== 0) return byName;
  return a.id.localeCompare(b.id, 'en');
}

function toCard(entry: NormalizedEntry, selectedId: string | null): OverviewCardModel {
  const summary = entry.summary;
  const project = summary.project.trim();
  return {
    id: entry.id,
    name: summary.name,
    purpose: summary.purpose,
    project: summary.project,
    projectLabel: project ? summary.project : OVERVIEW_UNGROUPED_PROJECT,
    tags: summary.tags,
    favorite: summary.favorite && !entry.temporary,
    temporary: entry.temporary,
    className: workspaceCardClassName({
      selected: entry.id === selectedId,
      favorite: summary.favorite && !entry.temporary,
    }),
    counts: summary.counts,
    accent: summary.accent,
    coverRef: summary.coverRef,
    icon: summary.icon,
    thumb: entry.thumb,
    lastUsedAt: summary.lastUsedAt,
  };
}

function flatSection(
  id: OverviewSectionModel['id'],
  title: string,
  cards: OverviewCardModel[],
): OverviewSectionModel | null {
  if (!cards.length) return null;
  return { id, title, cards, groups: null };
}

function serviceActions(card: OverviewCardModel | null): OverviewServiceActionModel[] {
  const selected = card != null;
  const saved = selected && !card.temporary;
  return [
    { id: 'enter', label: '进入', enabled: selected },
    { id: 'copy', label: '复制', enabled: saved },
    { id: 'export', label: '导出', enabled: saved },
    { id: 'rename', label: '重命名', enabled: saved },
  ];
}

function detailOf(entry: NormalizedEntry | null, card: OverviewCardModel | null): OverviewDetailModel | null {
  if (!entry || !card) return null;
  const detail = entry.detail;
  return {
    card,
    savedAt: typeof detail?.savedAt === 'number' && Number.isFinite(detail.savedAt) ? detail.savedAt : null,
    restorePolicy: 'manual-open-apps',
    files: detail?.files ?? [],
    webs: detail?.webs ?? [],
    apps: detail?.apps ?? [],
    nativeHosts: detail?.nativeHosts ?? [],
    agents: detail?.agents ?? [],
    recentResults: detail?.recentResults ?? [],
    problems: detail?.problems ?? [],
  };
}

export function overviewGate(input: Pick<OverviewInput, 'entries' | 'overviewHidden' | 'presets'>): OverviewGate {
  const savedIds = new Set<string>();
  const temporaryIds = new Set<string>();
  for (const entry of normalizeEntries(input.entries)) {
    if (entry.temporary) temporaryIds.add(entry.id);
    else savedIds.add(entry.id);
  }
  const presetIds = new Set<string>();
  for (const preset of input.presets) {
    if (preset && typeof preset.id === 'string' && preset.id) presetIds.add(preset.id);
  }
  return { hidden: input.overviewHidden === true, savedIds, temporaryIds, presetIds };
}

export function buildOverview(input: OverviewInput): OverviewModel {
  const entries = normalizeEntries(input.entries);
  const saved = entries.filter((entry) => !entry.temporary);
  const temporary = entries.filter((entry) => entry.temporary);
  const ui = input.ui ?? initialOverviewUi();
  const search = typeof ui.search === 'string' ? ui.search : '';
  const selectedId = typeof ui.selectedId === 'string' ? ui.selectedId : null;
  const hidden = input.overviewHidden === true;
  const presets = (input.presets ?? []).filter((preset) => preset && typeof preset.id === 'string' && preset.id && typeof preset.label === 'string');

  if (hidden) {
    return {
      visible: false,
      mode: 'hidden',
      welcome: null,
      unsaved: null,
      sections: [],
      presets: [],
      createEnabled: false,
      selectedId,
      search,
      detail: null,
      editButtons: EDIT_BUTTONS,
      serviceActions: serviceActions(null),
      ...FLAGS,
    };
  }

  const welcome = saved.length === 0;
  const currentTemporary = temporary.find((entry) => entry.id === input.currentId) ?? temporary[0] ?? null;
  const unsaved = currentTemporary ? toCard(currentTemporary, selectedId) : null;
  const matched = saved.filter((entry) => overviewMatchesQuery(entry.summary, search));
  const cards = new Map(matched.map((entry) => [entry.id, toCard(entry, selectedId)]));

  const sections: OverviewSectionModel[] = [];
  if (!welcome) {
    const current = input.currentId ? cards.get(input.currentId) : undefined;
    const currentSection = current ? flatSection('current', '当前', [current]) : null;
    if (currentSection) sections.push(currentSection);

    const favorites = matched
      .filter((entry) => entry.summary.favorite)
      .map((entry) => cards.get(entry.id)!)
      .sort(compareName);
    const favoriteSection = flatSection('favorites', '收藏', favorites);
    if (favoriteSection) sections.push(favoriteSection);

    const recent = matched
      .filter((entry) => entry.summary.lastUsedAt != null)
      .slice()
      .sort((a, b) => {
        const delta = (b.summary.lastUsedAt ?? 0) - (a.summary.lastUsedAt ?? 0);
        if (delta !== 0) return delta;
        return a.summary.name.localeCompare(b.summary.name, 'zh') || a.id.localeCompare(b.id, 'en');
      })
      .map((entry) => cards.get(entry.id)!);
    const recentSection = flatSection('recent', '最近', recent);
    if (recentSection) sections.push(recentSection);

    const projectBuckets = new Map<string, OverviewCardModel[]>();
    for (const entry of matched) {
      const card = cards.get(entry.id)!;
      const key = card.project.trim() ? card.project : '';
      const list = projectBuckets.get(key);
      if (list) list.push(card);
      else projectBuckets.set(key, [card]);
    }
    const projectGroups = [...projectBuckets.entries()]
      .map(([key, groupCards]) => ({
        key,
        label: key ? key : OVERVIEW_UNGROUPED_PROJECT,
        cards: groupCards.slice().sort(compareName),
      }))
      .sort((a, b) => {
        if (!a.key) return 1;
        if (!b.key) return -1;
        return a.label.localeCompare(b.label, 'zh') || a.key.localeCompare(b.key, 'en');
      });
    if (projectGroups.length) sections.push({ id: 'projects', title: '按项目', cards: null, groups: projectGroups });

    const tagBuckets = new Map<string, OverviewCardModel[]>();
    for (const entry of matched) {
      const card = cards.get(entry.id)!;
      for (const tag of card.tags) {
        const list = tagBuckets.get(tag);
        if (list) list.push(card);
        else tagBuckets.set(tag, [card]);
      }
    }
    const tagGroups = [...tagBuckets.entries()]
      .map(([key, groupCards]) => ({ key, label: key, cards: groupCards.slice().sort(compareName) }))
      .sort((a, b) => a.label.localeCompare(b.label, 'zh') || a.key.localeCompare(b.key, 'en'));
    if (tagGroups.length) sections.push({ id: 'tags', title: '按标签', cards: null, groups: tagGroups });
  }

  const selectedEntry = entries.find((entry) => entry.id === selectedId) ?? null;
  const selectedCard = selectedEntry ? toCard(selectedEntry, selectedId) : null;

  return {
    visible: true,
    mode: welcome ? 'welcome' : 'list',
    welcome: welcome ? WELCOME : null,
    unsaved,
    sections,
    presets,
    createEnabled: !welcome,
    selectedId,
    search,
    detail: detailOf(selectedEntry, selectedCard),
    editButtons: EDIT_BUTTONS,
    serviceActions: serviceActions(selectedCard),
    ...FLAGS,
  };
}

/** 总览左侧单选。不是阅读页六卡的选择，也不写进 OverviewUiState。 */
export const OVERVIEW_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'recent', label: '最近' },
  { id: 'favorites', label: '收藏' },
  { id: 'projects', label: '项目' },
  { id: 'tags', label: '标签' },
] as const;

export type OverviewFilterId = (typeof OVERVIEW_FILTERS)[number]['id'];

/** 按已建好的分区过滤。项目名和标签只来自分组，不在这里写死分类。 */
export function overviewSectionsForFilter(
  sections: readonly OverviewSectionModel[],
  filter: OverviewFilterId,
): OverviewSectionModel[] {
  if (filter === 'all') return [...sections];
  return sections.filter((section) => section.id === filter);
}

function trimmedName(name: string): string {
  return name.trim();
}

function knownId(gate: OverviewGate, id: string): boolean {
  return gate.savedIds.has(id) || gate.temporaryIds.has(id);
}

/** 只调用注入的回调。隐藏、不可用编辑、未实现的模板、空名称都不调用。 */
export function dispatchOverview(
  ui: OverviewUiState,
  intent: OverviewIntent,
  actions: OverviewActions,
  gate: OverviewGate,
): OverviewDispatchResult {
  if (gate.hidden) return { ui, called: false };
  switch (intent.type) {
    case 'search':
      return { ui: { ...ui, search: intent.query }, called: false };
    case 'hover':
    case 'edit':
    case 'from-template':
      return { ui, called: false };
    case 'select': {
      if (!knownId(gate, intent.id)) return { ui, called: false };
      return { ui: { ...ui, selectedId: intent.id }, called: false };
    }
    case 'enter':
    case 'dblclick': {
      if (!knownId(gate, intent.id)) return { ui, called: false };
      if (actions.onEnter) actions.onEnter(intent.id);
      return { ui: { ...ui, selectedId: intent.id }, called: Boolean(actions.onEnter) };
    }
    case 'copy': {
      if (!gate.savedIds.has(intent.id) || !actions.onCopy) return { ui, called: false };
      actions.onCopy(intent.id);
      return { ui, called: true };
    }
    case 'export': {
      if (!gate.savedIds.has(intent.id) || !actions.onExport) return { ui, called: false };
      actions.onExport(intent.id);
      return { ui, called: true };
    }
    case 'rename': {
      const name = trimmedName(intent.name);
      if (!name || !gate.savedIds.has(intent.id) || !actions.onRename) return { ui, called: false };
      actions.onRename(intent.id, name);
      return { ui, called: true };
    }
    case 'favorite': {
      if (!gate.savedIds.has(intent.id) || !actions.onFavorite) return { ui, called: false };
      actions.onFavorite(intent.id, intent.favorite);
      return { ui: { ...ui, selectedId: intent.id }, called: true };
    }
    case 'create': {
      const name = trimmedName(intent.name);
      if (!name || gate.savedIds.size === 0 || !actions.onCreate) return { ui, called: false };
      actions.onCreate(name);
      return { ui, called: true };
    }
    case 'create-first': {
      const name = trimmedName(intent.name);
      if (!name || gate.savedIds.size !== 0 || !actions.onCreateFirst) return { ui, called: false };
      actions.onCreateFirst(name);
      return { ui, called: true };
    }
    case 'enter-temporary': {
      if (gate.savedIds.size !== 0 || !actions.onEnterTemporary) return { ui, called: false };
      actions.onEnterTemporary();
      return { ui, called: true };
    }
    case 'apply-preset': {
      if (!gate.presetIds.has(intent.presetId) || !actions.onApplyPreset) return { ui, called: false };
      actions.onApplyPreset(intent.presetId);
      return { ui, called: true };
    }
    default:
      return { ui, called: false };
  }
}
