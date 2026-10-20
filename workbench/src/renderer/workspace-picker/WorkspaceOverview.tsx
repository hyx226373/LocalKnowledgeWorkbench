/**
 * 工作区总览页。显隐只看 overviewHidden。分类由 props 传入，本组件不直接写库。
 * 左侧是全部、最近、收藏和用户分类。右侧是同一套工作区卡片的流式网格，末尾永远有添加框。
 * 单击卡片进入工作区。复制、导出、重命名、删除在卡片菜单。从分类移出只删引用。
 * 这些动作和布局预设都走 props 回调。不渲染右侧详情栏。
 * 用途、标签、封面没有服务，总览里不做这些编辑。悬停不发请求。
 * 左侧筛选只活在本组件，不写入阅读页六卡选择。不拖动排序，不写剪贴板。
 */
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { Bookmark, Check, Clock, Ellipsis, Folder, LayoutGrid, Plus, Search, Star, Tag, X } from 'lucide-react';
import {
  EMPTY_OVERVIEW_BOARDS,
  addOverviewCategory,
  addWorkspacesToCategory,
  deleteOverviewCategory,
  formatRelativeStamp,
  isDefaultOverviewCategory,
  listOverviewCategories,
  removeWorkspaceFromCategory,
  renameOverviewCategory,
  retainOverviewWorkspaces,
  serializeOverviewBoards,
  sortPickerWorkspaces,
  type OverviewBoards,
  type OverviewCategory,
} from '../../shared/workspacePicker/overviewBoards';
import { normalizeCoverRef } from '../../shared/workspacePicker/normalize';
import {
  buildOverview,
  dispatchOverview,
  overviewGate,
  type OverviewActions,
  type OverviewCardModel,
  type OverviewEntryInput,
  type OverviewFilterId,
  type OverviewIntent,
  type OverviewModel,
  type OverviewPresetRef,
} from '../../shared/workspacePicker/overview';
import { cardAccentVars, cardThemeVars, type CardThemeSet } from './cardThemes';
import { LayoutThumb } from './LayoutThumb';
import { DELETE_WORKSPACE_TITLE, LAST_WORKSPACE_DELETE_TITLE, TEMPORARY_WORKSPACE_DELETE_TITLE } from './deleteWorkspace';
import './cardTheme.css';
import './overview.css';
import '../ui/overview-preview.css';
import { isKbDrag, readKbPayload } from '../dnd/drag';
import { peekDrag } from '../dir-view/dnd';
import { toDragPayload } from '../dnd/bridge';
import { runDrop } from '../dnd/session';
import { KB_RESOURCE_MIME } from '../dnd/mime';
import type { DragPayload } from '../dnd/types';

export interface WorkspaceOverviewProps {
  entries: readonly OverviewEntryInput[];
  currentId?: string | null;
  overviewHidden?: boolean;
  presets?: readonly OverviewPresetRef[];
  search?: string;
  selectedId?: string | null;
  theme?: CardThemeSet;
  onSearchChange?: (query: string) => void;
  onSelectedIdChange?: (id: string | null) => void;
  onEnter?: OverviewActions['onEnter'];
  onCopy?: OverviewActions['onCopy'];
  onExport?: OverviewActions['onExport'];
  onRename?: OverviewActions['onRename'];
  onDelete?: OverviewActions['onDelete'];
  onFavorite?: OverviewActions['onFavorite'];
  onCreate?: OverviewActions['onCreate'];
  onCreateFirst?: OverviewActions['onCreateFirst'];
  onEnterTemporary?: OverviewActions['onEnterTemporary'];
  onApplyPreset?: OverviewActions['onApplyPreset'];
  /** 缺省开。关掉、没有合格文件名或图片失败时走布局预览。 */
  snapshotEnabled?: boolean;
  /** 工作区 id → 本地快照文件名。只接受 normalizeCoverRef 允许的文件名。 */
  snapshotFiles?: Readonly<Record<string, unknown>>;
  /** 工作区 id → 快照 data URL（会话内或从 userData/workspace-snapshots 回填）；不写入 coverRef。 */
  snapshotSrcs?: Readonly<Record<string, string>>;
  /** 工作区 id → 可见时间的短文本。 */
  snapshotTakenAt?: Readonly<Record<string, string>>;
  /** 用户自建的项目/标签，以及全部、收藏的顺序。 */
  boards?: OverviewBoards;
  onBoardsChange?: (boards: OverviewBoards) => void;
  /** 只决定第一次画出的分类。之后由左侧单选自己管。projects、tags 会落到对应的第一条分类。 */
  initialFilter?: OverviewFilterId;
  /** 测试用来直接打开选择层。产品路径从加号或右键「添加」打开。 */
  initialPickerOpen?: boolean;
}

type RailId = 'all' | 'recent' | 'favorites' | `cat:${string}`;

function stop(event: { stopPropagation(): void }): void {
  event.stopPropagation();
}

/** 已保存工作区个数。卡片菜单用它判断能不能删，不把临时现场算进去。 */
const WorkspaceSavedCount = createContext(0);

function railFromFilter(filter: OverviewFilterId, categories: readonly OverviewCategory[]): RailId {
  if (filter === 'all' || filter === 'recent' || filter === 'favorites') return filter;
  const origin = filter === 'projects' ? 'projects' : 'tags';
  const found = categories.find((item) => item.origin === origin);
  return found ? `cat:${found.id}` : 'all';
}

function categoryIdOf(rail: RailId): string | null {
  return rail.startsWith('cat:') ? rail.slice(4) : null;
}

function metaLine(card: OverviewCardModel): string {
  const bits: string[] = [];
  if (card.tags.length) bits.push(card.tags.join(' · '));
  else if (card.purpose) bits.push(card.purpose);
  else if (card.projectLabel) bits.push(card.projectLabel);
  const counts = card.counts;
  bits.push(`文件 ${counts.files} · 面板 ${counts.panels}`);
  return bits.filter(Boolean).join(' · ');
}

export function WorkspaceOverview({
  entries,
  currentId = null,
  overviewHidden = false,
  presets = [],
  search: searchProp,
  selectedId: selectedProp,
  theme,
  onSearchChange,
  onSelectedIdChange,
  onEnter,
  onCopy,
  onExport,
  onRename,
  onDelete,
  onFavorite,
  onCreate,
  onCreateFirst,
  onEnterTemporary,
  onApplyPreset,
  snapshotEnabled = true,
  snapshotFiles,
  snapshotSrcs,
  snapshotTakenAt,
  boards: boardsProp,
  onBoardsChange,
  initialFilter = 'all',
  initialPickerOpen = false,
}: WorkspaceOverviewProps) {
  const [searchState, setSearchState] = useState('');
  const [selectedState, setSelectedState] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [filterCollapsed, setFilterCollapsed] = useState(false);
  const [boardsState, setBoardsState] = useState<OverviewBoards>(EMPTY_OVERVIEW_BOARDS);
  const [rail, setRail] = useState<RailId>(() => railFromFilter(initialFilter, listOverviewCategories(boardsProp ?? EMPTY_OVERVIEW_BOARDS)));
  const [pickerFor, setPickerFor] = useState<RailId | null>(() =>
    initialPickerOpen ? railFromFilter(initialFilter, listOverviewCategories(boardsProp ?? EMPTY_OVERVIEW_BOARDS)) : null,
  );
  const [createSignal, setCreateSignal] = useState(0);
  const [menu, setMenu] = useState<{ rail: RailId; x: number; y: number } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const skipEditCommit = useRef(false);

  const search = searchProp !== undefined ? searchProp : searchState;
  const selectedId = selectedProp !== undefined ? selectedProp : selectedState;
  const boards = boardsProp ?? boardsState;
  const categories = listOverviewCategories(boards);
  const categoryKey = categories.map((item) => item.id).join('\n');
  const model = buildOverview({
    entries,
    currentId,
    overviewHidden,
    presets,
    ui: { search, selectedId },
    boards,
  });
  const savedList = entries.filter((entry) => !entry.temporary && entry.summary?.id);
  const savedIds = new Set(savedList.map((entry) => entry.summary.id));

  useEffect(() => {
    if (!rail.startsWith('cat:')) return;
    if (!categoryKey.split('\n').filter(Boolean).includes(rail.slice(4))) setRail('all');
  }, [rail, categoryKey]);

  function publish(next: OverviewBoards): void {
    const stored = retainOverviewWorkspaces(serializeOverviewBoards(next), savedIds);
    if (boardsProp === undefined) setBoardsState(stored);
    onBoardsChange?.(stored);
  }

  const actions: OverviewActions = { onEnter, onCopy, onExport, onRename, onDelete, onFavorite, onCreate, onCreateFirst, onEnterTemporary, onApplyPreset };
  const savedCount = entries.reduce((count, entry) => count + (entry.temporary ? 0 : 1), 0);

  function dispatch(intent: OverviewIntent): boolean {
    const gate = overviewGate({ entries, overviewHidden, presets });
    const result = dispatchOverview({ search, selectedId }, intent, actions, gate);
    if (searchProp === undefined) setSearchState(result.ui.search);
    if (result.ui.search !== search) onSearchChange?.(result.ui.search);
    if (selectedProp === undefined) setSelectedState(result.ui.selectedId);
    if (result.ui.selectedId !== selectedId) onSelectedIdChange?.(result.ui.selectedId);
    return result.called;
  }

  const viewCards = cardsForRail(rail, model, categories);
  /** 全部、最近里所有工作区都已在内，「添加」就是新建工作区。 */
  const openAdd = (target: RailId) => {
    if (target === 'all' || target === 'recent') setCreateSignal((n) => n + 1);
    else setPickerFor(target);
  };
  const activeCategoryId = categoryIdOf(rail);
  const viewSection = activeCategoryId ?? rail;

  if (!model.visible) return null;

  const themeStyle = theme ? (cardThemeVars(theme) as CSSProperties) : undefined;
  return (
    <WorkspaceSavedCount.Provider value={savedCount}>
    <div
      className="kb-ws-overview"
      data-kb-overlay=""
      data-mode={model.mode}
      data-writes-library="false"
      data-hover-ipc="false"
      data-kb-scheme={theme?.scheme}
      data-overview-filter={model.mode === 'list' ? rail : undefined}
      style={themeStyle}
    >
      {model.mode === 'welcome' && model.welcome ? (
        <>
          <WelcomeBlock model={model} draftName={draftName} onDraftName={setDraftName} onDispatch={dispatch} />
          <PresetList presets={model.presets} onDispatch={dispatch} />
        </>
      ) : null}
      {model.mode === 'list' ? (
        <div className="kb-ws-overview-screen ov-screen">
          <FilterRail
            collapsed={filterCollapsed}
            rail={rail}
            categories={categories}
            counts={railCounts(savedList, categories)}
            editingId={editingId}
            editName={editName}
            onEditName={setEditName}
            onToggle={() => setFilterCollapsed((value) => !value)}
            onSelect={(id) => {
              setRail(id);
              setPickerFor(null);
              setMenu(null);
            }}
            onDropWorkspace={(catId, wsId) => {
              publish(addWorkspacesToCategory(boards, catId, [wsId]));
            }}
            onContextMenu={(id, x, y) => setMenu({ rail: id, x, y })}
            onCommitEdit={() => {
              if (skipEditCommit.current) {
                skipEditCommit.current = false;
                return;
              }
              if (!editingId) return;
              const next = renameOverviewCategory(boards, editingId, editName);
              if (next !== boards) publish(next);
              setEditingId(null);
            }}
            onCancelEdit={() => {
              skipEditCommit.current = true;
              setEditingId(null);
            }}
            onCreateCategory={() => {
              const next = addOverviewCategory(boards);
              if (next === boards) return;
              const created = (next.categories ?? []).find((item) => !(boards.categories ?? []).some((old) => old.id === item.id));
              publish(next);
              if (created) setRail(`cat:${created.id}`);
            }}
          />
          <main className="kb-ws-overview-main ov-main">
            <header className="kb-ws-overview-head ov-head">
              <h1 className="kb-ws-overview-title">
                {railLabel(rail, categories)}
                <span className="ov-title-count">{viewCards.length}</span>
              </h1>
              <label className="kb-ws-overview-search-wrap ov-search">
                <Search size={15} strokeWidth={1.5} aria-hidden="true" />
                <input
                  className="kb-ws-overview-search"
                  type="search"
                  data-field="search"
                  placeholder="搜索工作区"
                  aria-label="搜索工作区"
                  value={search}
                  onChange={(event) => dispatch({ type: 'search', query: event.target.value })}
                />
              </label>
              <CreateWorkspace
                draftName={draftName}
                onDraftName={setDraftName}
                onCreate={(name) => dispatch({ type: 'create', name })}
                openSignal={createSignal}
              />
            </header>
            <PresetList presets={model.presets} onDispatch={dispatch} />
            {model.unsaved ? (
              <section className="kb-ws-overview-section" data-section="unsaved" aria-label="未保存">
                <h2 className="kb-ws-overview-heading ov-section-label">未保存</h2>
                <p className="kb-ws-overview-unsaved ov-unsaved-note">临时现场，不会出现在收藏、最近或搜索里。</p>
                <div className="kb-ws-overview-grid ov-grid">
                  <OverviewCard
                    card={model.unsaved}
                    current={model.unsaved.id === currentId}
                    snapshotEnabled={snapshotEnabled}
                    snapshotFiles={snapshotFiles}
                    snapshotSrc={snapshotSrcs?.[model.unsaved.id]}
                    snapshotTakenAt={snapshotTakenAt?.[model.unsaved.id]}
                    onDispatch={dispatch}
                  />
                </div>
              </section>
            ) : null}
            <div className="ov-stack" key={rail}>
              <section className="kb-ws-overview-section" data-section={viewSection} aria-label={railLabel(rail, categories)}>
                {search.trim() && viewCards.length === 0 ? <p className="kb-ws-overview-empty ov-empty">没有匹配的工作区</p> : null}
                <div className="kb-ws-overview-grid ov-grid">
                  {viewCards.map((card) => (
                    <OverviewCard
                      key={card.id}
                      card={card}
                      current={card.id === currentId}
                      snapshotEnabled={snapshotEnabled}
                      snapshotFiles={snapshotFiles}
                      snapshotSrc={snapshotSrcs?.[card.id]}
                      snapshotTakenAt={snapshotTakenAt?.[card.id]}
                      onRemoveFromCategory={
                        activeCategoryId
                          ? () => {
                              const next = removeWorkspaceFromCategory(boards, activeCategoryId, card.id);
                              if (next !== boards) publish(next);
                            }
                          : undefined
                      }
                      onDispatch={dispatch}
                    />
                  ))}
                  <button type="button" className="kb-ws-overview-add ov-add" data-action="add-workspaces" aria-label="添加工作区" onClick={() => openAdd(rail)}>
                    <Plus size={28} strokeWidth={1.5} aria-hidden="true" />
                    <span>添加工作区</span>
                  </button>
                </div>
              </section>
            </div>
          </main>
          {menu ? (
            <CategoryMenu
              rail={menu.rail}
              x={menu.x}
              y={menu.y}
              onClose={() => setMenu(null)}
              onAdd={() => {
                setRail(menu.rail);
                openAdd(menu.rail);
                setMenu(null);
              }}
              onEdit={() => {
                const id = categoryIdOf(menu.rail);
                const category = id ? categories.find((item) => item.id === id) : undefined;
                setMenu(null);
                if (!category) return;
                skipEditCommit.current = false;
                setEditName(category.name);
                setEditingId(category.id);
              }}
              onDelete={() => {
                const id = categoryIdOf(menu.rail);
                setMenu(null);
                if (!id || isDefaultOverviewCategory(id)) return;
                const next = deleteOverviewCategory(boards, id);
                if (next === boards) return;
                publish(next);
                if (rail === `cat:${id}`) setRail('all');
              }}
            />
          ) : null}
          {pickerFor ? (
            <WorkspacePickDialog
              titleName={railLabel(pickerFor, categories)}
              rows={pickerRowsFor(pickerFor, savedList, categories)}
              snapshotEnabled={snapshotEnabled}
              snapshotFiles={snapshotFiles}
              snapshotSrcs={snapshotSrcs}
              onClose={() => setPickerFor(null)}
              onConfirm={(ids) => {
                if (pickerFor === 'favorites') {
                  for (const id of ids) dispatch({ type: 'favorite', id, favorite: true });
                } else {
                  const id = categoryIdOf(pickerFor);
                  if (id) {
                    const next = addWorkspacesToCategory(boards, id, ids);
                    if (next !== boards) publish(next);
                  }
                }
                setPickerFor(null);
              }}
            />
          ) : null}
        </div>
      ) : null}
    </div>
    </WorkspaceSavedCount.Provider>
  );
}

function WelcomeBlock({
  model,
  draftName,
  onDraftName,
  onDispatch,
}: {
  model: OverviewModel;
  draftName: string;
  onDraftName: (name: string) => void;
  onDispatch: (intent: OverviewIntent) => void;
}) {
  const welcome = model.welcome;
  if (!welcome) return null;
  return (
    <section className="kb-ws-overview-welcome ov-welcome" data-section="welcome" aria-label="欢迎">
      <h2 className="kb-ws-overview-heading">还没有已保存的工作区</h2>
      <p className="kb-ws-overview-copy">不会自动创建默认工作区。临时现场和已保存的工作区分开。</p>
      <div className="kb-ws-overview-actions">
        <input
          className="kb-ws-overview-name"
          type="text"
          data-field="create-first-name"
          aria-label="第一个工作区名称"
          placeholder="第一个工作区名称"
          value={draftName}
          onChange={(event) => onDraftName(event.target.value)}
        />
        <button type="button" data-action="create-first" onClick={() => onDispatch({ type: 'create-first', name: draftName })}>
          {welcome.createFirst.label}
        </button>
        <button type="button" data-action="from-template" data-reason={welcome.fromTemplate.reason} disabled>
          {welcome.fromTemplate.label}
        </button>
        <button type="button" data-action="enter-temporary" onClick={() => onDispatch({ type: 'enter-temporary' })}>
          {welcome.enterTemporary.label}
        </button>
      </div>
    </section>
  );
}

function PresetList({ presets, onDispatch }: { presets: readonly OverviewPresetRef[]; onDispatch: (intent: OverviewIntent) => void }) {
  return (
    <section className="kb-ws-overview-section kb-ws-overview-presets-section ov-presets" data-section="presets" aria-label="布局预设">
      <h2 className="kb-ws-overview-heading ov-section-label">布局预设</h2>
      {presets.length === 0 ? <p className="kb-ws-overview-empty">没有可应用的布局预设</p> : null}
      <div className="kb-ws-overview-presets">
        {presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            data-action="apply-preset"
            data-preset-id={preset.id}
            onClick={() => onDispatch({ type: 'apply-preset', presetId: preset.id })}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </section>
  );
}

const DEFAULT_RAILS: readonly { id: RailId; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'recent', label: '最近' },
  { id: 'favorites', label: '收藏' },
];

function railLabel(rail: RailId, categories: readonly OverviewCategory[]): string {
  const fixed = DEFAULT_RAILS.find((item) => item.id === rail);
  if (fixed) return fixed.label;
  return categories.find((item) => item.id === rail.slice(4))?.name ?? '分类';
}

function countIds(ids: readonly string[], savedIds: ReadonlySet<string>): number {
  const seen = new Set<string>();
  let count = 0;
  for (const id of ids) {
    if (seen.has(id) || !savedIds.has(id)) continue;
    seen.add(id);
    count += 1;
  }
  return count;
}

function railCounts(saved: readonly OverviewEntryInput[], categories: readonly OverviewCategory[]): Map<string, number> {
  const savedIds = new Set(saved.map((entry) => entry.summary.id));
  const counts = new Map<string, number>();
  counts.set('all', saved.length);
  counts.set('recent', saved.filter((entry) => typeof entry.summary.lastUsedAt === 'number' && Number.isFinite(entry.summary.lastUsedAt)).length);
  counts.set('favorites', saved.filter((entry) => entry.summary.favorite === true).length);
  for (const category of categories) counts.set(category.id, countIds(category.workspaceIds, savedIds));
  return counts;
}

function cardsForRail(rail: RailId, model: OverviewModel, categories: readonly OverviewCategory[]): OverviewCardModel[] {
  if (rail === 'all') return model.allCards;
  if (rail === 'recent') return model.sections.find((section) => section.id === 'recent')?.cards ?? [];
  if (rail === 'favorites') return model.sections.find((section) => section.id === 'favorites')?.cards ?? [];
  const category = categories.find((item) => item.id === rail.slice(4));
  if (!category) return [];
  const byId = new Map(model.allCards.map((card) => [card.id, card]));
  const seen = new Set<string>();
  const out: OverviewCardModel[] = [];
  for (const id of category.workspaceIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const card = byId.get(id);
    if (card) out.push(card);
  }
  return out;
}

function addedIds(rail: RailId, saved: readonly OverviewEntryInput[], categories: readonly OverviewCategory[]): Set<string> {
  if (rail === 'all' || rail === 'recent') return new Set(saved.map((entry) => entry.summary.id));
  if (rail === 'favorites') return new Set(saved.filter((entry) => entry.summary.favorite === true).map((entry) => entry.summary.id));
  const category = categories.find((item) => item.id === rail.slice(4));
  return new Set(category?.workspaceIds ?? []);
}

interface PickerRow {
  id: string;
  name: string;
  lastUsedAt: number | null;
  added: boolean;
  thumb: OverviewEntryInput['thumb'];
  coverRef: string | null;
}

function pickerRowsFor(rail: RailId, saved: readonly OverviewEntryInput[], categories: readonly OverviewCategory[]): PickerRow[] {
  const added = addedIds(rail, saved, categories);
  const sorted = sortPickerWorkspaces(
    saved.map((entry) => ({
      id: entry.summary.id,
      name: entry.summary.name,
      lastUsedAt: typeof entry.summary.lastUsedAt === 'number' ? entry.summary.lastUsedAt : null,
    })),
  );
  const byId = new Map(saved.map((entry) => [entry.summary.id, entry]));
  return sorted.map((row) => {
    const entry = byId.get(row.id);
    return {
      id: row.id,
      name: row.name,
      lastUsedAt: row.lastUsedAt,
      added: added.has(row.id),
      thumb: entry?.thumb ?? null,
      coverRef: entry?.summary.coverRef ?? null,
    };
  });
}

function RailIcon({ rail, origin }: { rail: RailId; origin?: OverviewCategory['origin'] }) {
  const props = { size: 16, strokeWidth: 1.5, 'aria-hidden': true as const };
  if (rail === 'all') return <LayoutGrid {...props} />;
  if (rail === 'recent') return <Clock {...props} />;
  if (rail === 'favorites') return <Star {...props} />;
  if (origin === 'tags') return <Tag {...props} />;
  if (origin === 'custom') return <Bookmark {...props} />;
  return <Folder {...props} />;
}

function FilterRail({
  collapsed,
  rail,
  categories,
  counts,
  editingId,
  editName,
  onEditName,
  onToggle,
  onSelect,
  onContextMenu,
  onCommitEdit,
  onCancelEdit,
  onCreateCategory,
  onDropWorkspace,
}: {
  collapsed: boolean;
  rail: RailId;
  categories: readonly OverviewCategory[];
  counts: Map<string, number>;
  editingId: string | null;
  editName: string;
  onEditName: (name: string) => void;
  onToggle: () => void;
  onSelect: (id: RailId) => void;
  onContextMenu: (id: RailId, x: number, y: number) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  onCreateCategory: () => void;
  onDropWorkspace?: (categoryId: string, workspaceId: string) => void;
}) {
  const rows: { rail: RailId; label: string; countKey: string; origin?: OverviewCategory['origin'] }[] = [
    ...DEFAULT_RAILS.map((item) => ({ rail: item.id, label: item.label, countKey: item.id })),
    ...categories.map((item) => ({ rail: `cat:${item.id}` as RailId, label: item.name, countKey: item.id, origin: item.origin })),
  ];
  return (
    <aside
      className="kb-ws-overview-side ov-side"
      data-collapsed={collapsed ? 'true' : 'false'}
      data-filter-owner="overview"
      aria-label="工作区筛选"
    >
      <div className="kb-ws-overview-nav ov-nav" role="radiogroup" aria-label="工作区筛选">
        <div className="kb-ws-overview-cats-head ov-cats-head">
          <span>分类</span>
          <button
            type="button"
            className="kb-ws-overview-filter-toggle ov-filter-toggle"
            data-action="toggle-filter"
            aria-expanded={collapsed ? 'false' : 'true'}
            onClick={onToggle}
          >
            {collapsed ? '展开筛选' : '收起筛选'}
          </button>
        </div>
        {collapsed
          ? null
          : rows.map((item, index) => (
              <span key={item.rail} className="ov-rail-slot">
                {index === DEFAULT_RAILS.length ? <span className="ov-cat-divider" role="separator" /> : null}
                <label
                  className={rail === item.rail ? 'kb-ws-overview-nav-item ov-item on' : 'kb-ws-overview-nav-item ov-item'}
                  htmlFor={`overview-filter-${item.rail}`}
                  data-category-id={item.rail}
                  data-default={isDefaultOverviewCategory(item.rail) ? 'true' : 'false'}
                  data-origin={item.origin}
                  onDragOver={(event) => {
                    if (item.rail.startsWith('cat:')) {
                      const types = [...event.dataTransfer.types];
                      if (types.includes('application/x-kb-resource+json') || isKbDrag(event.dataTransfer)) {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = 'link';
                      }
                    }
                  }}
                  onDrop={(event) => {
                    if (!item.rail.startsWith('cat:')) return;
                    const types = [...event.dataTransfer.types];
                    if (types.includes('application/x-kb-resource+json') || isKbDrag(event.dataTransfer)) {
                      event.preventDefault();
                      event.stopPropagation();
                      const payload = readKbPayload(event.dataTransfer) ?? (peekDrag() ? toDragPayload(peekDrag()!) : null);
                      if (payload) {
                        const categoryId = item.rail.slice(4);
                        const cat = categories.find((c) => c.id === categoryId);
                        const workspaceIds = cat ? [...cat.workspaceIds] : [];
                        void runDrop({ kind: 'category', categoryId, workspaceIds }, payload).then((res) => {
                          if (res.status === 'done') {
                            const first = payload.items[0];
                            if (first?.from.kind === 'category-card' && first.from.workspaceId) {
                              onDropWorkspace?.(categoryId, first.from.workspaceId);
                            }
                          }
                        });
                      }
                    }
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    onContextMenu(item.rail, event.clientX, event.clientY);
                  }}
                >
                  <input id={`overview-filter-${item.rail}`} type="radio" name="kb-ws-overview-filter" value={item.rail} checked={rail === item.rail} onChange={() => onSelect(item.rail)} />
                  <RailIcon rail={item.rail} origin={item.origin} />
                  {editingId && item.rail === `cat:${editingId}` ? (
                    <input
                      className="ov-cat-input"
                      type="text"
                      data-field="category-name"
                      aria-label="分类名称"
                      value={editName}
                      ref={focusCategoryName}
                      onMouseDown={stop}
                      onClick={stop}
                      onChange={(event) => onEditName(event.target.value)}
                      onBlur={onCommitEdit}
                      onKeyDown={(event) => {
                        if (event.nativeEvent.isComposing) return;
                        if (event.key === 'Escape') {
                          event.preventDefault();
                          onCancelEdit();
                          return;
                        }
                        if (event.key !== 'Enter') return;
                        event.preventDefault();
                        onCommitEdit();
                      }}
                    />
                  ) : (
                    <span className="ov-item-label">{item.label}</span>
                  )}
                  <span className="ov-item-count">{counts.get(item.countKey) ?? 0}</span>
                </label>
              </span>
            ))}
      </div>
      {collapsed ? null : (
        <button type="button" className="ov-new-category" data-action="new-category" onClick={onCreateCategory}>
          <Plus size={16} strokeWidth={1.6} aria-hidden="true" />
          新建分类
        </button>
      )}
    </aside>
  );
}

type CardPreview =
  | { kind: 'cover' | 'snapshot'; file: string }
  | { kind: 'layout'; file: null };

function cardPreview(
  card: OverviewCardModel,
  snapshotEnabled: boolean,
  snapshotFiles: Readonly<Record<string, unknown>> | undefined,
): CardPreview {
  const cover = normalizeCoverRef(card.coverRef);
  if (cover) return { kind: 'cover', file: cover };
  if (snapshotEnabled && snapshotFiles && Object.prototype.hasOwnProperty.call(snapshotFiles, card.id)) {
    const file = normalizeCoverRef(snapshotFiles[card.id]);
    if (file) return { kind: 'snapshot', file };
  }
  return { kind: 'layout', file: null };
}

function OverviewCard({
  card,
  current,
  snapshotEnabled,
  snapshotFiles,
  snapshotSrc,
  snapshotTakenAt,
  onRemoveFromCategory,
  onDispatch,
}: {
  card: OverviewCardModel;
  current: boolean;
  snapshotEnabled: boolean;
  snapshotFiles?: Readonly<Record<string, unknown>>;
  snapshotSrc?: string;
  snapshotTakenAt?: string;
  onRemoveFromCategory?: () => void;
  onDispatch: (intent: OverviewIntent) => void;
}) {
  const accent = cardAccentVars(card.accent) as CSSProperties;
  const preview = cardPreview(card, snapshotEnabled, snapshotFiles);
  const used = formatRelativeStamp(card.lastUsedAt);
  const saved = !card.temporary;
  const soleSaved = useContext(WorkspaceSavedCount) <= 1;
  const canDelete = saved && !soleSaved;
  const [menuOpen, setMenuOpen] = useState(false);
  const [renameName, setRenameName] = useState('');
  const menuRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(event: PointerEvent): void {
      const root = menuRef.current;
      if (!root || root.contains(event.target as Node)) return;
      setMenuOpen(false);
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);
  function open(event: { stopPropagation(): void }): void {
    stop(event);
    onDispatch({ type: 'enter', id: card.id });
  }
  function runSaved(intent: OverviewIntent): void {
    if (!saved) return;
    onDispatch(intent);
  }
  const wrapClass = ['ov-card', 'emerge', menuOpen ? 'is-menu-open' : ''].filter(Boolean).join(' ');
  return (
    <div className={wrapClass}>
    <article
      className={card.className}
      data-workspace-id={card.id}
      data-temporary={card.temporary ? 'true' : 'false'}
      data-count-files={card.counts.files}
      data-count-panels={card.counts.panels}
      data-activate="enter"
      style={accent}
      draggable={!card.temporary}
      onDragStart={(e) => {
        if (card.temporary) return;
        const payload: DragPayload = {
          v: 1,
          items: [{
            resourceId: card.id,
            sourceKind: 'file',
            entry: 'file',
            from: { kind: 'category-card', workspaceId: card.id },
            name: card.name,
          }],
        };
        const json = JSON.stringify(payload);
        try { e.dataTransfer.setData(KB_RESOURCE_MIME, json); } catch {}
        try { e.dataTransfer.setData('application/x-kb-resource+json', json); } catch {}
        e.dataTransfer.effectAllowed = 'copyLink';
      }}
      onDragOver={(e) => {
        const types = [...e.dataTransfer.types];
        if (types.includes('application/x-kb-resource+json') || isKbDrag(e.dataTransfer) || peekDrag()) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'link';
        }
      }}
      onDrop={(e) => {
        const types = [...e.dataTransfer.types];
        if (types.includes('application/x-kb-resource+json') || isKbDrag(e.dataTransfer) || peekDrag()) {
          e.preventDefault();
          e.stopPropagation();
          const payload = readKbPayload(e.dataTransfer) ?? (peekDrag() ? toDragPayload(peekDrag()!) : null);
          if (payload) {
            void runDrop({ kind: 'category-card', workspaceId: card.id }, payload);
          }
        }
      }}
      onClick={() => {
        onDispatch({ type: 'enter', id: card.id });
      }}
    >
      <CardVisual card={card} preview={preview} snapshotSrc={snapshotSrc} snapshotTakenAt={snapshotTakenAt} onOpen={open} />
      <div className="kb-ws-ov-meta ov-meta">
        <div className="kb-ws-ov-name ov-name">
          <button
            type="button"
            className="kb-ws-card-name"
            data-action="open-title"
            data-workspace-id={card.id}
            onClick={open}
            onDoubleClick={stop}
          >
            {card.name}
          </button>
          {current ? <em className="kb-ws-ov-current">当前</em> : null}
          <span className="kb-ws-ov-actions ov-actions">
            <button
              type="button"
              className={card.favorite ? 'kb-ws-card-mark star on' : 'kb-ws-card-mark star'}
              data-action="favorite"
              aria-label={card.favorite ? '取消收藏' : '收藏'}
              aria-pressed={card.favorite ? 'true' : 'false'}
              disabled={card.temporary}
              onClick={(event) => {
                stop(event);
                if (card.temporary) return;
                onDispatch({ type: 'favorite', id: card.id, favorite: !card.favorite });
              }}
              onDoubleClick={stop}
            >
              <Star size={15} strokeWidth={1.5} fill={card.favorite ? 'currentColor' : 'none'} aria-hidden="true" />
            </button>
            <span className="kb-ws-card-menu-anchor" ref={menuRef}>
              <button
                type="button"
                className="kb-ws-card-more star"
                data-action="more"
                aria-label="更多"
                aria-expanded={menuOpen ? 'true' : 'false'}
                aria-haspopup="menu"
                title="更多"
                data-workspace-id={card.id}
                onClick={(event) => {
                  stop(event);
                  setMenuOpen((value) => !value);
                }}
                onDoubleClick={stop}
              >
                <Ellipsis size={15} strokeWidth={1.5} aria-hidden="true" />
              </button>
              <div
                className="kb-ws-card-menu ov-card-menu"
                role="menu"
                aria-label={`${card.name}的动作`}
                hidden={!menuOpen}
                onClick={stop}
                onDoubleClick={stop}
              >
                <button
                  type="button"
                  role="menuitem"
                  data-action="copy"
                  disabled={!saved}
                  onClick={() => {
                    runSaved({ type: 'copy', id: card.id });
                    if (saved) setMenuOpen(false);
                  }}
                >
                  复制
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-action="export"
                  disabled={!saved}
                  onClick={() => {
                    runSaved({ type: 'export', id: card.id });
                    if (saved) setMenuOpen(false);
                  }}
                >
                  导出
                </button>
                <label className="kb-ws-card-menu-rename">
                  <input
                    className="kb-ws-card-rename"
                    type="text"
                    data-field="rename"
                    aria-label="重命名"
                    placeholder={card.name}
                    value={renameName}
                    disabled={!saved}
                    onClick={stop}
                    onChange={(event) => setRenameName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return;
                      event.preventDefault();
                      stop(event);
                      if (!saved || !renameName.trim()) return;
                      onDispatch({ type: 'rename', id: card.id, name: renameName });
                      setMenuOpen(false);
                    }}
                  />
                </label>
                <button
                  type="button"
                  role="menuitem"
                  data-action="rename"
                  disabled={!saved}
                  onClick={() => {
                    if (!saved || !renameName.trim()) return;
                    onDispatch({ type: 'rename', id: card.id, name: renameName });
                    setMenuOpen(false);
                  }}
                >
                  重命名
                </button>
                {onRemoveFromCategory ? (
                  <button
                    type="button"
                    role="menuitem"
                    data-action="remove-ref"
                    onClick={() => {
                      onRemoveFromCategory();
                      setMenuOpen(false);
                    }}
                  >
                    移出分类
                  </button>
                ) : null}
                {onRemoveFromCategory ? null : (
                <button
                  type="button"
                  role="menuitem"
                  data-action="delete"
                  data-testid="workspace-delete"
                  data-workspace-id={card.id}
                  disabled={!canDelete}
                  title={saved ? (soleSaved ? LAST_WORKSPACE_DELETE_TITLE : DELETE_WORKSPACE_TITLE) : TEMPORARY_WORKSPACE_DELETE_TITLE}
                  onClick={() => {
                    if (!canDelete) return;
                    onDispatch({ type: 'delete', id: card.id });
                    setMenuOpen(false);
                  }}
                >
                  删除
                </button>
                )}
              </div>
            </span>
          </span>
        </div>
        <p className="kb-ws-ov-sub ov-sub">
          <span>{metaLine(card)}</span>
          {used ? <span>{used}</span> : null}
        </p>
      </div>
    </article>
    </div>
  );
}

function CardVisual({
  card,
  preview,
  snapshotSrc,
  snapshotTakenAt,
  onOpen,
}: {
  card: OverviewCardModel;
  preview: CardPreview;
  snapshotSrc?: string;
  snapshotTakenAt?: string;
  onOpen: (event: { stopPropagation(): void }) => void;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [preview.file]);
  const showFile = preview.file != null && !failed;
  return (
    <div className="kb-ws-card-visual ov-thumb" data-snapshot-taken={snapshotTakenAt || undefined}>
      <button
        type="button"
        className="kb-ws-card-preview"
        data-action="open-preview"
        data-workspace-id={card.id}
        data-preview={showFile ? preview.kind : 'layout'}
        data-aspect-ratio="16 / 10"
        aria-label={`${card.name}，进入`}
        onClick={onOpen}
        onDoubleClick={stop}
      >
        {showFile ? (
          <img
            className="kb-ws-card-shot"
            alt=""
            draggable={false}
            loading="lazy"
            data-snapshot-file={preview.kind === 'snapshot' ? preview.file : undefined}
            data-cover-file={preview.kind === 'cover' ? preview.file : undefined}
            src={preview.kind === 'snapshot' && snapshotSrc ? snapshotSrc : preview.file ?? undefined}
            onError={() => setFailed(true)}
          />
        ) : card.thumb ? (
          <LayoutThumb model={card.thumb} embedded />
        ) : (
          <div className="kb-ws-card-thumb" data-empty-thumb="true" />
        )}
      </button>
      {showFile ? (snapshotTakenAt ? <p className="kb-ws-card-preview-label">{snapshotTakenAt}</p> : null) : <p className="kb-ws-card-preview-label">布局预览</p>}
    </div>
  );
}

/** 页头只留按钮。名称在弹出的小层里，确认后仍走 onCreate。小层默认不占主行。 */
function CreateWorkspace({
  draftName,
  onDraftName,
  onCreate,
  openSignal = 0,
}: {
  draftName: string;
  onDraftName: (name: string) => void;
  onCreate: (name: string) => boolean;
  /** 每变一次就打开新建弹层。全部/最近页的「添加工作区」框用它。 */
  openSignal?: number;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (openSignal > 0) setOpen(true);
  }, [openSignal]);
  const rootRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    nameRef.current?.focus();
    function onPointerDown(event: PointerEvent): void {
      const root = rootRef.current;
      if (!root || root.contains(event.target as Node)) return;
      setOpen(false);
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  function submit(event: FormEvent): void {
    event.preventDefault();
    if (!onCreate(draftName)) return;
    onDraftName('');
    setOpen(false);
  }
  return (
    <div className="kb-ws-overview-create ov-create" ref={rootRef}>
      <button
        type="button"
        className="kb-ws-overview-new ov-new"
        data-action="open-create"
        aria-expanded={open ? 'true' : 'false'}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
      >
        <Plus size={15} strokeWidth={1.7} aria-hidden="true" />
        新建工作区
      </button>
      <form className="kb-ws-overview-create-pop ov-create-pop" role="dialog" aria-label="新建工作区" hidden={!open} onSubmit={submit}>
        <input
          className="kb-ws-overview-name"
          type="text"
          data-field="create-name"
          aria-label="新工作区名称"
          placeholder="新工作区名称"
          value={draftName}
          ref={nameRef}
          onChange={(event) => onDraftName(event.target.value)}
        />
        <button type="submit" className="kb-ws-overview-new ov-new" data-action="create">
          创建
        </button>
      </form>
    </div>
  );
}

function menuPosition(x: number, y: number): { left: number; top: number } {
  if (typeof window === 'undefined') return { left: x, top: y };
  const width = 228;
  const height = 140;
  return {
    left: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
    top: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
  };
}

function CategoryMenu({
  rail,
  x,
  y,
  onClose,
  onAdd,
  onEdit,
  onDelete,
}: {
  rail: RailId;
  x: number;
  y: number;
  onClose: () => void;
  onAdd: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const locked = isDefaultOverviewCategory(rail);
  const rootRef = useRef<HTMLDivElement>(null);
  const place = menuPosition(x, y);
  useEffect(() => {
    function onPointerDown(event: PointerEvent): void {
      const root = rootRef.current;
      if (!root || root.contains(event.target as Node)) return;
      onClose();
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return (
    <div className="ov-cat-menu" role="menu" aria-label="分类菜单" ref={rootRef} style={{ left: place.left, top: place.top }} data-category-id={rail}>
      <button type="button" role="menuitem" className="ov-cat-menu-line" data-action="add-to-category" onClick={onAdd}>
        添加
      </button>
      <button
        type="button"
        role="menuitem"
        className="ov-cat-menu-line"
        data-action="edit-category"
        disabled={locked}
        title={locked ? '默认分类不可改名' : undefined}
        onClick={onEdit}
      >
        编辑
      </button>
      {locked ? (
        <div className="ov-cat-menu-row">
          <button
            type="button"
            role="menuitem"
            className="ov-cat-menu-line"
            data-action="delete-category"
            disabled
            title="默认分类不可删除"
          >
            删除
          </button>
          <span className="ov-cat-menu-hint">默认分类不可删除</span>
        </div>
      ) : (
        <button type="button" role="menuitem" className="ov-cat-menu-line" data-action="delete-category" title="删除分类" onClick={onDelete}>
          删除
        </button>
      )}
    </div>
  );
}

function PickThumb({
  row,
  snapshotEnabled,
  snapshotFiles,
  snapshotSrc,
}: {
  row: PickerRow;
  snapshotEnabled: boolean;
  snapshotFiles?: Readonly<Record<string, unknown>>;
  snapshotSrc?: string;
}) {
  const cover = normalizeCoverRef(row.coverRef);
  let file: string | null = cover;
  let kind: 'cover' | 'snapshot' = 'cover';
  if (!file && snapshotEnabled && snapshotFiles && Object.prototype.hasOwnProperty.call(snapshotFiles, row.id)) {
    const snap = normalizeCoverRef(snapshotFiles[row.id]);
    if (snap) {
      file = snap;
      kind = 'snapshot';
    }
  }
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [file]);
  if (file && !failed) {
    return (
      <img
        alt=""
        draggable={false}
        data-snapshot-file={kind === 'snapshot' ? file : undefined}
        data-cover-file={kind === 'cover' ? file : undefined}
        src={kind === 'snapshot' && snapshotSrc ? snapshotSrc : file}
        onError={() => setFailed(true)}
      />
    );
  }
  if (row.thumb) return <LayoutThumb model={row.thumb} embedded />;
  return <span className="ov-pick-empty" data-empty-thumb="true" />;
}

function WorkspacePickDialog({
  titleName,
  rows,
  snapshotEnabled,
  snapshotFiles,
  snapshotSrcs,
  onClose,
  onConfirm,
}: {
  titleName: string;
  rows: readonly PickerRow[];
  snapshotEnabled: boolean;
  snapshotFiles?: Readonly<Record<string, unknown>>;
  snapshotSrcs?: Readonly<Record<string, string>>;
  onClose: () => void;
  onConfirm: (ids: readonly string[]) => void;
}) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onPointerDown(event: PointerEvent): void {
      const root = rootRef.current;
      if (!root || root.contains(event.target as Node)) return;
      onClose();
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  const needle = query.trim().toLowerCase();
  const visible = needle ? rows.filter((row) => row.name.toLowerCase().includes(needle)) : rows;
  const selected = rows.filter((row) => picked.has(row.id) && !row.added).map((row) => row.id);
  const title = `添加到 ${titleName}`;
  return (
    <div className="kb-ws-overview-pick-layer ov-pick-layer" onClick={onClose}>
      <div className="kb-ws-overview-pick ov-pick" role="dialog" aria-label={title} ref={rootRef} onClick={stop}>
        <header className="ov-pick-head">
          <p className="kb-ws-overview-pick-title ov-pick-title">{title}</p>
          <button type="button" className="ov-pick-close" data-action="close-picker" aria-label="关闭" onClick={onClose}>
            <X size={16} strokeWidth={1.6} aria-hidden="true" />
          </button>
        </header>
        <label className="ov-pick-search">
          <Search size={14} strokeWidth={1.6} aria-hidden="true" />
          <input
            type="search"
            data-field="pick-search"
            aria-label="在分类里搜索工作区"
            placeholder="搜索工作区"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="ov-pick-grid">
          {visible.map((row) => {
            const stamp = formatRelativeStamp(row.lastUsedAt);
            const on = picked.has(row.id);
            return (
              <button
                key={row.id}
                type="button"
                className={on ? 'ov-pick-card on' : 'ov-pick-card'}
                data-workspace-id={row.id}
                data-added={row.added ? 'true' : 'false'}
                aria-pressed={on ? 'true' : 'false'}
                aria-label={row.name}
                disabled={row.added}
                onClick={() => {
                  if (row.added) return;
                  setPicked((prev) => {
                    const next = new Set(prev);
                    if (next.has(row.id)) next.delete(row.id);
                    else next.add(row.id);
                    return next;
                  });
                }}
              >
                <span className="ov-pick-thumb">
                  <PickThumb row={row} snapshotEnabled={snapshotEnabled} snapshotFiles={snapshotFiles} snapshotSrc={snapshotSrcs?.[row.id]} />
                  {row.added ? (
                    <span className="ov-pick-badge">已添加</span>
                  ) : (
                    <span className={on ? 'ov-pick-mark on' : 'ov-pick-mark'} aria-hidden="true">
                      {on ? <Check size={12} strokeWidth={2.6} /> : null}
                    </span>
                  )}
                </span>
                <span className="ov-pick-name">{row.name}</span>
                {stamp ? <span className="ov-pick-time">{stamp}</span> : null}
              </button>
            );
          })}
        </div>
        <footer className="ov-pick-foot">
          <span className="ov-pick-count">
            已选 <b>{selected.length}</b> 个
          </span>
          <button type="button" data-action="cancel-add" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="kb-ws-overview-new ov-new ov-pick-confirm"
            data-action="confirm-add"
            disabled={selected.length === 0}
            onClick={() => onConfirm(selected)}
          >
            确定
          </button>
        </footer>
      </div>
    </div>
  );
}

function focusCategoryName(input: HTMLInputElement | null): void {
  if (!input) return;
  input.focus();
  input.select();
}
