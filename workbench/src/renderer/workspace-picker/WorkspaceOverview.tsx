/**
 * 工作区总览页。显隐只看 overviewHidden，不写库。
 * 布局按预览 overview：左 NavMark 大图标单选 + 右大图卡。
 * 复制、导出、重命名、进入、新建和布局预设都走 props 回调。
 * 用途、标签、封面没有服务，按钮保持不可用。悬停不发请求。
 * 左侧筛选只活在本组件，不写入阅读页六卡选择。
 */
import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { normalizeCoverRef } from '../../shared/workspacePicker/normalize';
import {
  OVERVIEW_FILTERS,
  buildOverview,
  dispatchOverview,
  overviewGate,
  overviewSectionsForFilter,
  type OverviewActions,
  type OverviewCardModel,
  type OverviewEntryInput,
  type OverviewFilterId,
  type OverviewGroupModel,
  type OverviewIntent,
  type OverviewModel,
  type OverviewPresetRef,
  type OverviewSectionModel,
} from '../../shared/workspacePicker/overview';
import { cardAccentVars, cardThemeVars, type CardThemeSet } from './cardThemes';
import { LayoutThumb } from './LayoutThumb';
import './cardTheme.css';
import './overview.css';

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
  onFavorite?: OverviewActions['onFavorite'];
  onCreate?: OverviewActions['onCreate'];
  onCreateFirst?: OverviewActions['onCreateFirst'];
  onEnterTemporary?: OverviewActions['onEnterTemporary'];
  onApplyPreset?: OverviewActions['onApplyPreset'];
  /** 缺省开。关掉、没有合格文件名或图片失败时走布局预览。 */
  snapshotEnabled?: boolean;
  /** 工作区 id → 本地快照文件名。只接受 normalizeCoverRef 允许的文件名。 */
  snapshotFiles?: Readonly<Record<string, unknown>>;
  /** 工作区 id → 本机会话内 data URL；不写入 coverRef。 */
  snapshotSrcs?: Readonly<Record<string, string>>;
  /** 工作区 id → 可见时间的短文本。 */
  snapshotTakenAt?: Readonly<Record<string, string>>;
}

function stop(event: { stopPropagation(): void }): void {
  event.stopPropagation();
}

function formatUsedAt(at: number | null | undefined): string {
  if (at == null || !Number.isFinite(at)) return '';
  try {
    return new Date(at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
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
  onFavorite,
  onCreate,
  onCreateFirst,
  onEnterTemporary,
  onApplyPreset,
  snapshotEnabled = true,
  snapshotFiles,
  snapshotSrcs,
  snapshotTakenAt,
}: WorkspaceOverviewProps) {
  const [searchState, setSearchState] = useState('');
  const [selectedState, setSelectedState] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [renameName, setRenameName] = useState('');
  const [filter, setFilter] = useState<OverviewFilterId>('all');
  const [filterCollapsed, setFilterCollapsed] = useState(false);

  const search = searchProp !== undefined ? searchProp : searchState;
  const selectedId = selectedProp !== undefined ? selectedProp : selectedState;
  const model = buildOverview({
    entries,
    currentId,
    overviewHidden,
    presets,
    ui: { search, selectedId },
  });
  const shownSections = overviewSectionsForFilter(model.sections, filter);
  const actions: OverviewActions = { onEnter, onCopy, onExport, onRename, onFavorite, onCreate, onCreateFirst, onEnterTemporary, onApplyPreset };

  function dispatch(intent: OverviewIntent): void {
    const gate = overviewGate({ entries, overviewHidden, presets });
    const result = dispatchOverview({ search, selectedId }, intent, actions, gate);
    if (searchProp === undefined) setSearchState(result.ui.search);
    if (result.ui.search !== search) onSearchChange?.(result.ui.search);
    if (selectedProp === undefined) setSelectedState(result.ui.selectedId);
    if (result.ui.selectedId !== selectedId) onSelectedIdChange?.(result.ui.selectedId);
  }

  if (!model.visible) return null;

  const themeStyle = theme ? (cardThemeVars(theme) as CSSProperties) : undefined;
  return (
    <div
      className="kb-ws-overview"
      data-kb-overlay=""
      data-mode={model.mode}
      data-writes-library="false"
      data-hover-ipc="false"
      data-kb-scheme={theme?.scheme}
      data-overview-filter={model.mode === 'list' ? filter : undefined}
      style={themeStyle}
    >
      {model.mode === 'welcome' && model.welcome ? (
        <WelcomeBlock model={model} draftName={draftName} onDraftName={setDraftName} onDispatch={dispatch} />
      ) : null}
      <PresetList presets={model.presets} onDispatch={dispatch} />
      {model.mode === 'list' ? (
        <div className="kb-ws-overview-screen">
          <FilterRail
            collapsed={filterCollapsed}
            filter={filter}
            onToggle={() => setFilterCollapsed((value) => !value)}
            onFilter={setFilter}
          />
          <main className="kb-ws-overview-main">
            <header className="kb-ws-overview-head">
              <h1 className="kb-ws-overview-title">工作区总览</h1>
              <label className="kb-ws-overview-search-wrap">
                <SearchGlyph />
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
              <input
                className="kb-ws-overview-name"
                type="text"
                data-field="create-name"
                aria-label="新工作区名称"
                placeholder="新工作区名称"
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
              />
              <button
                type="button"
                className="kb-ws-overview-new"
                data-action="create"
                onClick={() => dispatch({ type: 'create', name: draftName })}
              >
                <PlusGlyph />
                新建工作区
              </button>
            </header>
            {model.unsaved ? (
              <section className="kb-ws-overview-section" data-section="unsaved" aria-label="未保存">
                <h2 className="kb-ws-overview-heading">未保存</h2>
                <p className="kb-ws-overview-unsaved">临时现场，不会出现在收藏、最近或搜索里。</p>
                <div className="kb-ws-overview-grid">
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
            <div className="kb-ws-overview-layout">
              <div className="kb-ws-overview-body">
                {shownSections.map((section) => (
                  <SectionBlock
                    key={section.id}
                    section={section}
                    currentId={currentId}
                    snapshotEnabled={snapshotEnabled}
                    snapshotFiles={snapshotFiles}
                    snapshotSrcs={snapshotSrcs}
                    snapshotTakenAt={snapshotTakenAt}
                    onDispatch={dispatch}
                  />
                ))}
                {shownSections.length === 0 ? <p className="kb-ws-overview-empty">没有匹配的工作区</p> : null}
              </div>
              <DetailPane model={model} renameName={renameName} onRenameName={setRenameName} onDispatch={dispatch} />
            </div>
          </main>
        </div>
      ) : null}
    </div>
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
    <section className="kb-ws-overview-welcome" data-section="welcome" aria-label="欢迎">
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
    <section className="kb-ws-overview-section kb-ws-overview-presets-section" data-section="presets" aria-label="布局预设">
      <h2 className="kb-ws-overview-heading">布局预设</h2>
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

function SectionBlock({
  section,
  currentId,
  snapshotEnabled,
  snapshotFiles,
  snapshotSrcs,
  snapshotTakenAt,
  onDispatch,
}: {
  section: OverviewSectionModel;
  currentId: string | null;
  snapshotEnabled: boolean;
  snapshotFiles?: Readonly<Record<string, unknown>>;
  snapshotSrcs?: Readonly<Record<string, string>>;
  snapshotTakenAt?: Readonly<Record<string, string>>;
  onDispatch: (intent: OverviewIntent) => void;
}) {
  return (
    <section className="kb-ws-overview-section" data-section={section.id} aria-label={section.title}>
      <h2 className="kb-ws-overview-heading">{section.title}</h2>
      {section.cards ? (
        <div className="kb-ws-overview-grid">
          {section.cards.map((card) => (
            <OverviewCard
              key={card.id}
              card={card}
              current={card.id === currentId}
              snapshotEnabled={snapshotEnabled}
              snapshotFiles={snapshotFiles}
              snapshotSrc={snapshotSrcs?.[card.id]}
              snapshotTakenAt={snapshotTakenAt?.[card.id]}
              onDispatch={onDispatch}
            />
          ))}
        </div>
      ) : null}
      {section.groups?.map((group) => (
        <GroupBlock
          key={group.key || group.label}
          group={group}
          sectionId={section.id}
          currentId={currentId}
          snapshotEnabled={snapshotEnabled}
          snapshotFiles={snapshotFiles}
          snapshotSrcs={snapshotSrcs}
          snapshotTakenAt={snapshotTakenAt}
          onDispatch={onDispatch}
        />
      ))}
    </section>
  );
}

function GroupBlock({
  group,
  sectionId,
  currentId,
  snapshotEnabled,
  snapshotFiles,
  snapshotSrcs,
  snapshotTakenAt,
  onDispatch,
}: {
  group: OverviewGroupModel;
  sectionId: OverviewSectionModel['id'];
  currentId: string | null;
  snapshotEnabled: boolean;
  snapshotFiles?: Readonly<Record<string, unknown>>;
  snapshotSrcs?: Readonly<Record<string, string>>;
  snapshotTakenAt?: Readonly<Record<string, string>>;
  onDispatch: (intent: OverviewIntent) => void;
}) {
  const attr = sectionId === 'tags' ? { 'data-tag': group.key } : { 'data-project': group.key };
  return (
    <div className="kb-ws-overview-group" {...attr}>
      <h3 className="kb-ws-overview-group-label">{group.label}</h3>
      <div className="kb-ws-overview-grid">
        {group.cards.map((card) => (
          <OverviewCard
            key={card.id}
            card={card}
            current={card.id === currentId}
            snapshotEnabled={snapshotEnabled}
            snapshotFiles={snapshotFiles}
            snapshotSrc={snapshotSrcs?.[card.id]}
            snapshotTakenAt={snapshotTakenAt?.[card.id]}
            onDispatch={onDispatch}
          />
        ))}
      </div>
    </div>
  );
}

function FilterRail({
  collapsed,
  filter,
  onToggle,
  onFilter,
}: {
  collapsed: boolean;
  filter: OverviewFilterId;
  onToggle: () => void;
  onFilter: (id: OverviewFilterId) => void;
}) {
  return (
    <aside
      className="kb-ws-overview-side"
      data-collapsed={collapsed ? 'true' : 'false'}
      data-filter-owner="overview"
      aria-label="工作区筛选"
    >
      <button
        type="button"
        className="kb-ws-overview-filter-toggle"
        data-action="toggle-filter"
        aria-expanded={collapsed ? 'false' : 'true'}
        onClick={onToggle}
      >
        {collapsed ? '展开筛选' : '收起筛选'}
      </button>
      {collapsed ? null : (
        <div className="kb-ws-overview-nav" role="radiogroup" aria-label="工作区筛选">
          <div className="kb-ws-overview-cats-head">
            <span>分类</span>
          </div>
          {OVERVIEW_FILTERS.map((item) => (
            <label key={item.id} className={filter === item.id ? 'kb-ws-overview-nav-item on' : 'kb-ws-overview-nav-item'}>
              <input
                type="radio"
                name="kb-ws-overview-filter"
                value={item.id}
                checked={filter === item.id}
                onChange={() => onFilter(item.id)}
              />
              <NavMark id={item.id} />
              <span>{item.label}</span>
            </label>
          ))}
        </div>
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
  onDispatch,
}: {
  card: OverviewCardModel;
  current: boolean;
  snapshotEnabled: boolean;
  snapshotFiles?: Readonly<Record<string, unknown>>;
  snapshotSrc?: string;
  snapshotTakenAt?: string;
  onDispatch: (intent: OverviewIntent) => void;
}) {
  const accent = cardAccentVars(card.accent) as CSSProperties;
  const preview = cardPreview(card, snapshotEnabled, snapshotFiles);
  const used = formatUsedAt(card.lastUsedAt);
  function open(event: { stopPropagation(): void }): void {
    stop(event);
    onDispatch({ type: 'enter', id: card.id });
  }
  return (
    <article
      className={card.className}
      data-workspace-id={card.id}
      data-temporary={card.temporary ? 'true' : 'false'}
      data-count-files={card.counts.files}
      data-count-panels={card.counts.panels}
      style={accent}
      onClick={() => onDispatch({ type: 'select', id: card.id })}
      onDoubleClick={() => onDispatch({ type: 'dblclick', id: card.id })}
    >
      <CardVisual card={card} preview={preview} snapshotSrc={snapshotSrc} snapshotTakenAt={snapshotTakenAt} onOpen={open} />
      <div className="kb-ws-ov-meta">
        <div className="kb-ws-ov-name">
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
          <span className="kb-ws-ov-actions">
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
              <StarGlyph filled={card.favorite} />
            </button>
            <button
              type="button"
              className="kb-ws-card-more star"
              data-action="more"
              aria-label="更多"
              title="更多（稍后）"
              data-workspace-id={card.id}
              disabled
              onClick={stop}
              onDoubleClick={stop}
            >
              <EllipsisGlyph />
            </button>
          </span>
        </div>
        <p className="kb-ws-ov-sub">
          <span>{metaLine(card)}</span>
          {used ? <span>{used}</span> : null}
        </p>
      </div>
    </article>
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
    <div className="kb-ws-card-visual" data-snapshot-taken={snapshotTakenAt || undefined}>
      <button
        type="button"
        className="kb-ws-card-preview"
        data-action="open-preview"
        data-workspace-id={card.id}
        data-preview={showFile ? preview.kind : 'layout'}
        aria-label={`${card.name}，进入`}
        style={{ aspectRatio: '16 / 10' }}
        onClick={onOpen}
        onDoubleClick={stop}
      >
        {showFile ? (
          <img
            className="kb-ws-card-shot"
            alt=""
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

function DetailPane({
  model,
  renameName,
  onRenameName,
  onDispatch,
}: {
  model: OverviewModel;
  renameName: string;
  onRenameName: (name: string) => void;
  onDispatch: (intent: OverviewIntent) => void;
}) {
  const detail = model.detail;
  const card = detail?.card ?? null;
  return (
    <aside className="kb-ws-overview-detail" data-section="detail" aria-label="详情">
      <h2 className="kb-ws-overview-heading">详情</h2>
      {card ? (
        <>
          <p className="kb-ws-card-name">{card.name}</p>
          <p className="kb-ws-overview-meta">{card.temporary ? '未保存' : card.purpose || '没有用途'}</p>
          {card.coverRef ? (
            <p className="kb-ws-overview-meta" data-cover-ref={card.coverRef}>
              {card.coverRef}
            </p>
          ) : null}
        </>
      ) : (
        <p className="kb-ws-overview-empty">选中一张卡片查看详情</p>
      )}
      <div className="kb-ws-overview-actions">
        {model.editButtons.map((button) => (
          <button key={button.field} type="button" data-edit={button.field} data-reason={button.reason} disabled>
            {button.label}
          </button>
        ))}
      </div>
      {card ? (
        <div className="kb-ws-overview-actions">
          <input
            className="kb-ws-overview-name"
            type="text"
            data-field="rename"
            aria-label="重命名"
            placeholder={card.name}
            value={renameName}
            onChange={(event) => onRenameName(event.target.value)}
          />
          {model.serviceActions.map((action) => (
            <button
              key={action.id}
              type="button"
              data-action={action.id}
              data-workspace-id={card.id}
              disabled={!action.enabled}
              onClick={() => {
                if (!action.enabled) return;
                if (action.id === 'rename') onDispatch({ type: 'rename', id: card.id, name: renameName });
                else if (action.id === 'enter') onDispatch({ type: 'enter', id: card.id });
                else if (action.id === 'copy') onDispatch({ type: 'copy', id: card.id });
                else onDispatch({ type: 'export', id: card.id });
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
      {detail ? <DetailLists detail={detail} /> : null}
    </aside>
  );
}

function DetailLists({ detail }: { detail: NonNullable<OverviewModel['detail']> }) {
  return (
    <>
      {detail.files.length ? (
        <ul className="kb-ws-overview-list" data-detail="files">
          {detail.files.map((file) => (
            <li key={file.resourceId} data-missing={file.missing ? 'true' : 'false'}>
              {file.title}
            </li>
          ))}
        </ul>
      ) : null}
      {detail.webs.length ? (
        <ul className="kb-ws-overview-list" data-detail="webs">
          {detail.webs.map((web) => (
            <li key={web.ref}>{web.title}</li>
          ))}
        </ul>
      ) : null}
      {detail.apps.length ? (
        <ul className="kb-ws-overview-list" data-detail="apps">
          {detail.apps.map((app) => (
            <li key={app.ref}>{app.title}</li>
          ))}
        </ul>
      ) : null}
      {detail.nativeHosts.length ? (
        <ul className="kb-ws-overview-list" data-detail="native-hosts">
          {detail.nativeHosts.map((host) => (
            <li key={host.panelId}>{host.titleHint}</li>
          ))}
        </ul>
      ) : null}
      {detail.agents.length ? (
        <ul className="kb-ws-overview-list" data-detail="agents">
          {detail.agents.map((agent) => (
            <li key={agent.roomId} data-running={agent.running}>
              {agent.title}
            </li>
          ))}
        </ul>
      ) : null}
      {detail.problems.length ? (
        <ul className="kb-ws-overview-list" data-detail="problems">
          {detail.problems.map((problem) => (
            <li key={`${problem.code}:${problem.panelId ?? ''}`} data-problem={problem.code}>
              {problem.message}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** 预览 NavMark 形态；分类 id 用正式筛选，不写考研样例。 */
function NavMark({ id }: { id: OverviewFilterId }): ReactNode {
  const common = { width: 56, height: 56, viewBox: '0 0 64 64', fill: 'none', 'aria-hidden': true as const };
  if (id === 'all') {
    return (
      <svg {...common}>
        <rect x="10" y="10" width="18" height="18" rx="5" fill="var(--kb-color-surface)" stroke="var(--kb-color-accent)" strokeWidth="1.6" />
        <rect x="36" y="10" width="18" height="18" rx="5" fill="var(--kb-color-surface)" stroke="var(--kb-color-accent)" strokeWidth="1.6" />
        <rect x="10" y="36" width="18" height="18" rx="5" fill="var(--kb-color-surface)" stroke="var(--kb-color-accent)" strokeWidth="1.6" />
        <rect x="36" y="36" width="18" height="18" rx="5" fill="var(--kb-color-accent)" />
      </svg>
    );
  }
  if (id === 'recent') {
    return (
      <svg {...common}>
        <circle cx="32" cy="32" r="18" fill="var(--kb-color-surface)" stroke="var(--kb-color-accent)" strokeWidth="1.6" />
        <path d="M32 20v14l9 5" stroke="var(--kb-color-accent)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (id === 'favorites') {
    return (
      <svg {...common}>
        <path
          d="M32 14l4.6 9.4 10.4 1.5-7.5 7.3 1.8 10.3L32 37.8l-9.3 4.7 1.8-10.3-7.5-7.3 10.4-1.5L32 14z"
          fill="var(--kb-color-surface)"
          stroke="var(--kb-color-accent)"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (id === 'projects') {
    return (
      <svg {...common}>
        <path d="M12 18h28a4 4 0 0 1 4 4v28H16a4 4 0 0 1-4-4V18z" fill="var(--kb-color-surface)" stroke="var(--kb-color-accent)" strokeWidth="1.6" />
        <path d="M44 22h8v28a4 4 0 0 1-4 4H32" stroke="var(--kb-color-accent)" strokeWidth="1.6" />
        <path d="M20 28h16M20 35h12" stroke="var(--kb-color-text-muted)" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path
        d="M14 24h22l4 4h12v22a4 4 0 0 1-4 4H18a4 4 0 0 1-4-4V24z"
        fill="var(--kb-color-surface)"
        stroke="var(--kb-color-accent)"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M18 24v-6h16l3 6" stroke="var(--kb-color-accent)" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M22 40h20M22 46h12" stroke="var(--kb-color-text-muted)" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function SearchGlyph(): ReactNode {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M16.5 16.5L21 21" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function PlusGlyph(): ReactNode {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function StarGlyph({ filled }: { filled: boolean }): ReactNode {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 3.6l2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 16.8l-4.8 2.5.9-5.4-3.9-3.8 5.4-.8L12 3.6z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function EllipsisGlyph(): ReactNode {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  );
}
