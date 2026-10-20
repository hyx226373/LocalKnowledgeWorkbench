import { openSettingsRef } from './settings/openSettings';
import { Editor as RebirthEditor } from './rebirth/Editor';
import { setRebirthOpener } from './rebirth/openDock';
import { watchdogStats } from './sandbox/SandboxPanel';
import { runCommandCompat, runCommandResult } from './runCommandBridge';
import React, { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, themeDark, type DockviewTheme } from 'dockview-react';
import { kb } from './kb';
import { CONTENT_SEARCH_UNAVAILABLE_NOTICE, contentSearchDegraded, isContentBodyIndexEnabled } from '../shared/contentIndexScope';
import { NEW_LAYOUT_SIDEBAR_WIDTH } from '../shared/items';
import {
  AuxiliarySearchRunner,
  SearchBoxAddon,
  SearchProviderSections,
  applyExpanded,
  dispatchSearchAction,
  filenameSectionLabel,
  isActionTarget,
  isPathTarget,
  isResourceTarget,
  listSearchProviders,
  plainText,
  subscribeSearchProviders,
  type ProviderSection,
} from './search/providers';
import type { SearchProviderHit } from '../shared/searchProvider';
import { clearAllAgentMarks } from './agent-marks/client';
import { setConsoleOpener } from './console/commands';
import {
  DesktopPanel,
  DESKTOP_PANEL_COMPONENT,
  DESKTOP_PANEL_DOCK_ID,
  registerDesktopPanelCommands,
  setDesktopPanelOpener,
} from './desktop-panel';
import { createConsoleOpener, formatOpenGroupResult, type ConsoleDock } from './console/open';
import { ViewHost, ViewHostCtx, type ViewHostEnv } from './ViewHost';
import { pluginHost, type PluginEntry } from './plugin-host/host';
import { adapters, chromeThemes, commands, layoutPresets, panels, readingThemes } from './plugin-host/registry';
import {
  DEFAULT_SHELL,
  VIEW_HOST_COMPONENT,
  applyPreset,
  emptyLayout,
  makeFileItem,
  makeWebItem,
  newItemId,
  migrateLayout,
  toStoredLayout,
  type ItemPanelParams,
  type ShellLayout,
  type WorkspaceItem,
} from './plugin-host/layoutModel';
import { HOST_API_VERSION, type Disposable, type PluginApi, type PluginModule } from './plugin-host/types';
import builtinReaders from './plugins/builtin-readers';
import builtinFormats from './plugins/builtin-formats';
import demoCsv from './plugins/demo-csv-table';
import nativeAppHostPlugin from './plugins/native-app-host';
import { setNativeAppHostOpener, setActiveNativeAppHostItemId } from './plugins/native-app-host/openBridge';
import { NATIVE_APP_HOST_ADAPTER_ID, NATIVE_APP_HOST_REF } from './plugins/native-app-host/constants';
// ---- r11-A 网络资料（星图组）：内置插件 + 打开条目桥接
import webResources, { openUrl, openUrlPrompt, openWebResource, webBridge, lastCopied, lastSaved } from './web-resources';
import { openWebSiteGrants } from './web-site/grantsDialog';
import { perSiteDecl } from './web-resources/siteAccess';
import { sanitizeWebRef } from '../shared/webResources';
import { applyAppearance, DEFAULT_APPEARANCE, mergeAppearance, readStoredAppearance, type Appearance } from './theme/appearance';
import { CUSTOM_COLORS_EVENT, CUSTOM_COLORS_KEY, effectiveCustomColors, getCustomColorOverlay, parseCustomColors, setCustomColorOverlay } from './theme/customColors';
import { BrandMark } from './theme/BrandMark';
import { SchemeSunToggle } from './settings/KbToggle';
import { PluginEnableSwitch } from './settings/PluginEnableSwitch';
import { Copy, Download, FolderInput, Pencil, X } from 'lucide-react';
import { PanelLeftCloseIcon, PanelLeftOpenIcon, SearchIcon, SettingsIcon, SunIcon, OverviewMark, ChevronDownIcon, PlusIcon, FileTextIcon } from './ui/shellMarks';
import { builtinThemePacks, themeInstallFeedback, themePackEntry } from './theme/packs';
import { getFocusMode, setFocusMode } from './theme/focus';
import { DialogHost, dialogs } from './ui/dialogs';
import { LoadingLabel } from './ui/LoadingLabel';
import { patchLayoutSnapshot, readLayoutSnapshot, readUiSnapshot, shellInteractiveMark, snapshotToWorkspace, writeLayoutSnapshot, writeUiSnapshot } from './layoutSnapshot';
import { DocTab } from './ui/DocTab';
import { PendingPlansButton, openPendingPlans } from './ui/PendingPlans';
import { backgroundLoader, mountedViews, visibleContent } from './lazyLoad';
import { StatesSheet } from './ui/StatesSheet';
import { PluginManager } from './ui/PluginManager';
import { OpLogDialog } from './ui/OpLogDialog';
import { appProfileDialog, askPermissionDialog, uninstallDialog, type AppResourceOption } from './ui/adapterDialogs';
import type { AdapterPluginDto } from '../shared/pluginIpc';
import { checkNavigation } from '../shared/adapter-sdk/policy';
import { navDomains } from '../shared/webPanel';
import { webSurfaceStats } from './sandbox/WebSurface';
import { editorStatus, ENCODING_LABEL } from './editorStatus';
import { discardOpenEditor, saveOpenEditor } from './editorSave';
import { CLOSE_ALL_FILES_ID, CLOSE_ALL_FILES_TITLE, closeAllFilesKeybinding, collectOpenFileTabs, runCloseAll } from './tabs/closeAllFiles';
import { askCloseAllDirty } from './tabs/closeAllPrompt';
import { BubbleTray, FloatResizeGrips, PanelHeaderActions, SIDEBAR_COMPONENT, SIDEBAR_ID, SidebarPanel, SidebarSlot, hideDockedTabs, panelManager, showDocumentTabs, usePanelManagerVersion } from './panel-manager';
import {
  AgentLiveProvider,
  AgentMaterialsSidebar,
  SearchHitAddButton,
  createIpcAgentLiveClient,
  decideAddCurrentBinding,
  joinRoot,
  registerAgentLiveCommands,
} from './agent-live';
import { createMountHost } from './agent-live/mountHost';


import { omitAgentPanelDocs, stripAgentPanelWindows } from './agent-panel/openDock';
import { ExternalBrowsePanel } from './external-browse/ExternalBrowsePanel';
import { EXTERNAL_BROWSE_COMPONENT, omitExternalBrowsePanels } from './external-browse/layout';
import { installExternalBrowseClicks, setExternalBrowseDock } from './external-browse/openTab';
import type { MaterialRef } from '../shared/agentLive/types';
import { setHostedForeground } from './keybindings/runtime';
import type { Favorite, FsChangeEvent, IndexHealth, IndexStatus, Root, SearchHit, WorkspaceDto, WorkspaceRef, WorkspaceSummary } from '../shared/types';
import { SIDEBAR_BLOCK_IDS, showAllSidebarBlocks, toggleSidebarBlock } from './drawer/sidebarTitle';
import { DRAWER_MODULE_LABEL } from './drawer/order';
import { AppCtx, DirViewHost, FavoritesSection, RootsSection, SidebarPlugins, WorkspaceRefs, normalizeDirView, type Ctx, type DirViewHandle, type DirViewState, type OpenMode } from './dir-view';
import { Drawer, clampDrawerWidth, initialDrawerSelection, normalizeDrawerSelection, type DrawerModuleId } from './drawer';
import { dockedDrawerChrome, drawerContentOpen, resolveListDrawerWidth, toggleDockedDrawer } from './drawer/drawerToggle';
import { useSidebarPrefs } from './drawer/sidebarPrefs';
import { ModuleHead } from './drawer/ModuleHead';
import { captureWorkspaceSnapshot, deleteWorkspaceSnapshots, loadWorkspaceSnapshots } from './workspaceSnapshotClient';
import { WebResourcesPanel } from './web-resources/WebResourcesPanel';
import { peekDrag as peekDirDrag } from './dir-view/dnd';
import { isKbDrag, modifiersOf, readKbPayload } from './dnd/drag';
import { liveHint, setLiveHint, subscribeHint } from './dnd/hint';
import { readerZone } from './dnd/geometry';
import { onDropTarget } from './dnd/resolve';
import { orderRoots, parseRootOrder, ROOT_ORDER_KEY } from './dnd/rootOrder';
import { runDrop, setDndHost } from './dnd/session';
import { useDragAutoScroll } from './dnd/autoScroll';
import { installDirViewDnd, promptAddToFolder, promptMove, promptRemoveFromFolder, promptRemoveFromWorkspace, setDndRoots } from './dnd/bridge';
import { installNativeDragSession } from './nativeDrag/install';
import { setNativeDragRootIndex } from './nativeDrag/paths';
import { toDragPayload } from './dnd/bridge';
import {
  KeybindingsPage,
  effectiveOf,
  getKeybindingsStore,
  handleKeydown,
  loadKeybindings,
  pushBoundToMain,
  openSetKeybindingFor,
  registerKeybindingCommands,
  registerOpenKeybindingsPage,
  runByAccelerator,
  setFocusCommandId,
  subscribeKeybindings,
  runtimeEffectiveKeybinding,
} from './keybindings';
import { registerContentZoomCommands } from './zoom/actions';
import { runContentZoom, setActiveItemResolver } from './zoom/registry';
import { ensureWheelTrigger, wheelBindingFromAccel, setContentZoomWheelBinding } from './zoom/wheelTrigger';
import { WorkspaceOverview } from './workspace-picker/WorkspaceOverview';
import { LAST_WORKSPACE_DELETE_TITLE, requestDeleteWorkspace } from './workspace-picker/deleteWorkspace';
import { TEMPORARY_WORKSPACE_ID, keepOverviewForEmptyLibrary, overviewEntries, presetRefs } from './workspace-picker/mount';
import { SOURCE_ACTIONS } from '../shared/actions/packages/sources';
import { paletteSourceActions } from './dir-view/diskActions';
import { QuickSwitch } from './workspace-picker/QuickSwitch';
import { OverlayHostSync } from './workspace-picker/OverlayHostSync';
import { WorkspacePickerSettings } from './workspace-picker/WorkspacePickerSettings';
import { quickSwitchEntries } from './workspace-picker/quickSwitchModel';
import { decideLiveQuickSwitchKey } from './workspace-picker/quickSwitchCollect';
import { QUICK_SWITCH_COMMAND_ID, bindWorkspacePickerCommands, type QuickSwitchConflictReport } from './workspace-picker/quickSwitchKey';
import {
  WORKSPACE_PICKER_SETTINGS_KEY,
  planStartup,
  readWorkspacePickerSettings,
  startupReadsCurrentId,
  writeWorkspacePickerSettings,
} from '../shared/workspacePicker/settings';
import { EMPTY_OVERVIEW_BOARDS, OVERVIEW_BOARDS_KEY, parseOverviewBoards, type OverviewBoards } from '../shared/workspacePicker/overviewBoards';
import { DEFAULT_WORKSPACE_PICKER_SETTINGS, type WorkspacePickerSettings as PickerSettings } from '../shared/workspacePicker/types';
import { AppearanceFields } from './settings/AppearanceFields';
import { SettingsPage } from './settings/SettingsPage';
import {
  SETTINGS_CATEGORY_KEY,
  SETTINGS_COMMAND_ID,
  isSettingsCategory,
  readStoredSettingsCategory,
  settingsShortcutDecision,
  writeSettingsCategory,
  type SettingsCategoryId,
} from './settings/categories';
import { RestoreBar } from './workspace-picker/RestoreBar';
import { restorePanelsFromItems, shouldMountRestoreBar, type FileResource } from './workspace-picker/restoreFeed';
import { classifyFileResource, dismissRestore, dismissRestoreAll, readRestoreDismissed, withRestoreDismissed, type RestoreDismissed } from './workspace-picker/restoreBarModel';
import { resetRestoreContentReady, subscribeRestoreContentReady } from './workspace-picker/restoreSignals';
import { RESTORE_BAR_COMMAND, RESTORE_BAR_VISIBLE_KEY, setRestoreBarVisible, toggleRestoreBarVisible } from './settings/restoreBarVisible';
import { OUT_OF_SCOPE_MESSAGE } from '../shared/sourceFilter';
import { DEFAULT_UI_CHROME_PREFS, loadUiChromePrefs, saveUiChromePrefs, withUiChromePrefs, type UiChromePrefs } from './settings/uiChromePrefs';

import { CONTENT_ONLY_COMMAND_ID, decideContentOnlyKey, bindContentOnlyCommand, formatContentOnlyConflict, partitionContentOnlyKeyHolders } from './chrome-layout/contentOnlyKey';

/** 布局键。缺键、null、非数组为空选择，加载时不写回六卡。 */
const DRAWER_MODULES_KEY = 'settings.drawerModules';
const NARROW_TOPBAR_MQ = '(max-width: 980px)';

function narrowTopbarMatches(): boolean {
  return typeof matchMedia === 'function' && matchMedia(NARROW_TOPBAR_MQ).matches;
}

function useNarrowTopbar(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof matchMedia !== 'function') return () => undefined;
      const mq = matchMedia(NARROW_TOPBAR_MQ);
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    },
    narrowTopbarMatches,
    () => false,
  );
}

function cssColorToken(value: string): string | null {
  const v = value.trim();
  if (!v || v.length > 64 || v.startsWith('var(') || /[\n;{}]/.test(v)) return null;
  return v;
}

/** 从计算样式读标题栏色。读不到就不发，也不写死原始风格色。 */
function syncWindowChromeFromCss() {
  if (typeof document === 'undefined' || typeof kb.setWindowChrome !== 'function') return;
  const style = getComputedStyle(document.documentElement);
  const color = cssColorToken(style.getPropertyValue('--kb-color-chrome'));
  const symbolColor = cssColorToken(style.getPropertyValue('--kb-color-text'));
  if (!color || !symbolColor) return;
  void kb.setWindowChrome({ color, symbolColor }).catch(() => undefined);
}

function syncContentZoomWheel() {
  const cmd = commands.get('view.contentZoomWheel');
  const key = cmd ? effectiveOf(cmd, getKeybindingsStore()).key : 'Ctrl+Wheel';
  setContentZoomWheelBinding(() => wheelBindingFromAccel(key || 'Ctrl+Wheel'));
}

/** 全局 UI 设置（不随工作区变化）：目录树展开状态、外观选择 */
interface UiState {
  expanded: string[]; // 资源 ID（带命名空间前缀）
  appearance: Appearance;
  /** 阅读专注模式（主题接口 v2：read-focus-* 令牌） */
  focus?: boolean;
  /** 双目录视图（第 11 轮 C）。单栏时不使用，全局 expanded 仍只管原来的目录树。 */
  dirView?: DirViewState;
}
const AUTOSAVE_MS = 300;

const components = { [VIEW_HOST_COMPONENT]: ViewHost, [SIDEBAR_COMPONENT]: SidebarPanel, [DESKTOP_PANEL_COMPONENT]: DesktopPanel, rebirth: RebirthEditor, [EXTERNAL_BROWSE_COMPONENT]: ExternalBrowsePanel };

function useRegistry<T>(reg: { subscribe(cb: () => void): () => void; getVersion(): number }, get: () => T): T {
  const v = useSyncExternalStore((cb) => reg.subscribe(cb), () => reg.getVersion());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(get, [v]);
}

function DndHintBar() {
  const text = useSyncExternalStore(subscribeHint, liveHint);
  if (!text) return null;
  return (
    <div className="kb-toast" data-testid="dnd-hint" data-tone="info">
      {text}
    </div>
  );
}

function Watermark() {
  return (
    <div className="kb-watermark">
      <div className="kb-watermark-title">在左侧目录树中点击文件打开</div>
      <div className="kb-watermark-hint">用目录行的右侧分栏按钮打开 · 拖动标签可自由分栏 · Ctrl+Shift+P 命令面板</div>
    </div>
  );
}



// ---------------- search ----------------

function highlightQuery(name: string, query: string): React.ReactNode {
  const q = query.trim();
  if (!q) return name;
  const at = name.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return name;
  return (
    <>
      {name.slice(0, at)}
      <mark className="kb-search-mark">{name.slice(at, at + q.length)}</mark>
      {name.slice(at + q.length)}
    </>
  );
}

function SearchBox({ roots, health, scope = 'all', placeholder, testId = 'search-input', ariaLabel }: {
  roots: Root[];
  health: IndexHealth | null;
  scope?: 'all' | 'name' | 'content';
  placeholder?: string;
  testId?: string;
  ariaLabel?: string;
}) {
  const ctx = useContext(AppCtx);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const [degraded, setDegraded] = useState(false);
  const [notice, setNotice] = useState('');
  const [searching, setSearching] = useState(false);
  const providers = useSyncExternalStore(subscribeSearchProviders, listSearchProviders, listSearchProviders);
  const [auxSections, setAuxSections] = useState<ProviderSection[]>([]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const runnerRef = useRef<AuxiliarySearchRunner | null>(null);
  if (!runnerRef.current) runnerRef.current = new AuxiliarySearchRunner();
  useEffect(() => {
    setDegraded(contentSearchDegraded(health));
  }, [health]);
  useEffect(() => {
    if (!q.trim()) {
      setHits([]);
      setSearching(false);
      setNotice('');
      return;
    }
    setSearching(true);
    let cancelled = false;
    const t = setTimeout(() => {
      kb.searchGrouped(q, { limit: 50, scope }).then((r: any) => {
        if (cancelled) return;
        const list = (r?.hits ?? []).map((h: any) => ({
          resourceId: h.resourceId,
          rootId: h.rootId,
          relPath: h.relPath,
          name: h.title ?? h.name,
          kind: 'file' as const,
          matchKind: h.matchKind,
          snippet: h.snippet,
          page: h.page,
          score: h.score,
        }));
        const filtered = scope === 'name'
          ? list.filter((h: any) => !h.matchKind || h.matchKind === 'name' || h.matchKind === 'path')
          : scope === 'content'
            ? list.filter((h: any) => h.matchKind === 'content' || h.matchKind === 'heading')
            : list;
        setHits(filtered);
        if (typeof r?.degraded === 'boolean') setDegraded(!!r.degraded);
        else if (scope === 'content' && filtered.length > 0) setDegraded(false);
        setNotice(typeof r?.notice === 'string' ? r.notice : '');
        setSel(0);
      }).catch(() => {
        if (cancelled) return;
        if (scope === 'content') {
          setHits([]);
          setDegraded(true);
          setNotice(CONTENT_SEARCH_UNAVAILABLE_NOTICE);
          return;
        }
        return kb.search(q).then((h) => {
          if (cancelled) return;
          const list = h as SearchHit[];
          const filtered = scope === 'name'
            ? list.filter((x) => !x.matchKind || x.matchKind === 'name' || x.matchKind === 'path')
            : list;
          setHits(filtered);
          setNotice('');
          setSel(0);
        });
      }).finally(() => { if (!cancelled) setSearching(false); });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, scope]);
  useEffect(() => () => runnerRef.current?.dispose(), []);
  useEffect(() => {
    setExpanded(new Set());
  }, [q]);
  useEffect(() => {
    runnerRef.current?.schedule(
      q,
      { workspaceId: ctx.workspaceId ?? '', rootIds: roots.map((root) => root.id), limit: 50 },
      providers,
      setAuxSections,
    );
  }, [q, providers, roots, ctx.workspaceId]);
  const shownAux = useMemo(() => applyExpanded(auxSections, expanded), [auxSections, expanded]);
  const fileShown = hits.slice(0, 80);
  const auxRows = useMemo(
    () =>
      shownAux.flatMap((section) =>
        section.status === 'ok'
          ? section.visible.map((hit, index) => ({ key: `${section.id}:${index}:${hit.title}`, providerId: section.id, hit }))
          : [],
      ),
    [shownAux],
  );
  const rootName = (id: string) => roots.find((r) => r.id === id)?.name ?? '?';
  const go = (h: SearchHit, mode: OpenMode = 'tab') => {
    if (h.kind === 'file') ctx.open(h.resourceId, h.name, mode);
    setOpen(false);
  };
  const openAux = (providerId: string, hit: SearchProviderHit) => {
    const target = hit.target;
    if (isResourceTarget(target)) ctx.open(target.resourceId, plainText(hit.title) || target.resourceId);
    else if (isPathTarget(target)) {
      const dir = target.relPath.includes('/') ? target.relPath.slice(0, target.relPath.lastIndexOf('/')) : '';
      void kb.listDir(target.rootId, dir).then((entries) => {
        const found = entries.find((entry) => entry.relPath === target.relPath);
        if (found) ctx.open(found.resourceId, found.name);
      });
    } else if (isActionTarget(target)) dispatchSearchAction(providerId, target.action, target.payload);
    setOpen(false);
  };
  return (
    <div className="search">
      <SearchIcon />
      <input
        className="kb-input kb-no-drag"
        data-testid={testId}
        placeholder={placeholder ?? (scope === 'name' ? '搜索文件名' : scope === 'content' ? '搜索正文' : '搜索文件名与正文')}
        aria-label={ariaLabel ?? (scope === 'name' ? '搜索文件名' : scope === 'content' ? '搜索正文' : '搜索文件名与正文')}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (providers.length === 0) {
            if (e.key === 'ArrowDown') setSel((s) => Math.min(hits.length - 1, s + 1));
            if (e.key === 'ArrowUp') setSel((s) => Math.max(0, s - 1));
            if (e.key === 'Enter' && hits[sel]) go(hits[sel], e.altKey ? 'right' : 'tab');
            if (e.key === 'Escape') setOpen(false);
            return;
          }
          const total = fileShown.length + auxRows.length;
          if (e.key === 'ArrowDown') setSel((s) => Math.min(Math.max(total - 1, 0), s + 1));
          if (e.key === 'ArrowUp') setSel((s) => Math.max(0, s - 1));
          if (e.key === 'Enter') {
            if (sel < fileShown.length && fileShown[sel]) go(fileShown[sel], e.altKey ? 'right' : 'tab');
            else {
              const row = auxRows[sel - fileShown.length];
              if (row) openAux(row.providerId, row.hit);
            }
          }
          if (e.key === 'Escape') setOpen(false);
        }}
      />
      <SearchBoxAddon providers={providers} />
      {open && q.trim() && (
        <div className="kb-popover kb-search-results" data-testid="search-results">
          {(degraded || notice) && (
            <div className="kb-search-hit kb-search-note" data-testid="search-degraded" role="status">
              {notice || (scope === 'content' ? CONTENT_SEARCH_UNAVAILABLE_NOTICE : '全文索引不可用 · 仅文件名/路径搜索')}
            </div>
          )}
          {filenameSectionLabel(providers) ? <div className="kb-search-section-title" data-testid="search-filename-section">文件名</div> : null}
          {searching && <LoadingLabel testId="search-loading" />}
          {!searching && hits.length === 0 && !(degraded || notice) && <div className="kb-search-hit kb-search-empty">无结果</div>}
          {fileShown.map((h, i) => {
            const root = roots.find((item) => item.id === h.rootId);
            const absPath = root?.path ? joinRoot(root.path, h.relPath) : '';
            return (
            <div key={h.resourceId + i} className="kb-search-hit" aria-selected={i === sel ? 'true' : undefined} onMouseDown={(e) => go(h, e.altKey ? 'right' : 'tab')} data-match-kind={h.matchKind ?? 'name'}>
              <FileTextIcon className="kb-search-hit-ic" />
              <span className="kb-search-hit-body">
                <span className="kb-search-hit-name">{highlightQuery(h.name, q)}</span>
                <span className="p kb-search-hit-path">
                  {rootName(h.rootId)} / {h.relPath}
                </span>
              </span>
              {absPath ? <SearchHitAddButton item={{ resourceId: h.resourceId, sourceId: h.rootId, relPath: h.relPath, absPath, name: h.name }} /> : null}
            </div>
            );
          })}
          <SearchProviderSections
            sections={shownAux}
            query={q}
            selectedKey={auxRows[sel - fileShown.length]?.key}
            onOpen={openAux}
            onMore={(id) => setExpanded((prev) => new Set(prev).add(id))}
          />
        </div>
      )}
    </div>
  );
}

// ---------------- command palette ----------------

function CommandPalette({ onClose }: { onClose: () => void }) {
  const list = useRegistry(commands, () => commands.all().filter((c) => c.id !== 'workbench.commandPalette'));
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  // B2#10：按 ActionId（如 source.）也可检出 sources 等命令分组
  const items = list.filter((c) => {
    const hay = `${c.category ? c.category + '：' : ''}${c.title} ${c.id}`.toLowerCase();
    return hay.includes(q.toLowerCase());
  });
  const run = (i: number) => {
    const c = items[i];
    onClose();
    if (c) Promise.resolve(c.run()).catch((e) => dialogs.alert({ title: '命令失败', body: String(e?.message ?? e) }));
  };
  return (
    <div className="kb-dialog-backdrop" onMouseDown={onClose}>
      <div className="kb-popover palette" data-testid="command-palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          className="kb-input"
          placeholder="输入命令…"
          value={q}
          onChange={(e) => (setQ(e.target.value), setSel(0))}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setSel((s) => Math.min(items.length - 1, s + 1));
            if (e.key === 'ArrowUp') setSel((s) => Math.max(0, s - 1));
            if (e.key === 'Enter') run(sel);
            if (e.key === 'Escape') onClose();
          }}
        />
        {items.map((c, i) => (
          <div key={c.id} className="kb-menu-item" data-testid="palette-item" data-command-id={c.id} aria-selected={i === sel ? 'true' : undefined} onMouseDown={() => run(i)}>
            <span className="name">
              {c.category && <span className="p">{c.category}：</span>}
              {c.title}
            </span>
            <span className="p faint" data-testid="palette-action-id">{c.id}</span>
            {(runtimeEffectiveKeybinding(c.id) ?? c.keybinding) && <span className="kbd">{runtimeEffectiveKeybinding(c.id) ?? c.keybinding}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------- plugins panel（内置插件通过 panels 扩展点贡献） ----------------

/**
 * 侧栏「网络资料」写在资料抽屉的 slot 里（SidebarPlugins 排除了 web.resources，避免画两份）。
 * 插件开关走同一份 pluginHost 订阅：关掉 builtin.web-resources 后标题和「添加」整块消失，重新打开再挂上。
 */
/** 「网络资料」插件被关掉时为 false。资料抽屉据此不挂这个分区（连分区外框和折叠条一起不画）。 */
export function useWebResourcesEnabled(): boolean {
  const plugins = useSyncExternalStore(
    (cb) => pluginHost.subscribe(cb),
    () => pluginHost.list(),
  );
  return !plugins.some((p) => p.manifest?.id === 'builtin.web-resources' && p.status === 'disabled');
}

export function WebResourcesSidebarSection() {
  if (!useWebResourcesEnabled()) return null;
  return (
    <section className="kb-section kb-module" data-testid="panel-web.resources">
      <ModuleHead
        title="网络资料"
        testId="web-module-h"
        acts={
          <button type="button" className="kb-linkish" data-testid="web-open-url-head" onClick={() => void openUrlPrompt()}>
            <PlusIcon />
            添加
          </button>
        }
      />
      <WebResourcesPanel />
    </section>
  );
}

/** App 注入：从侧栏面板打开插件管理 */
const openPluginManagerRef: { current: ((focus?: string) => void) | null } = { current: null };
let settingsCommandDisposable: { dispose(): void } | null = null;
const openOpLogRef: { current: (() => void) | null } = { current: null };
function PluginsPanel() {
  const list = useSyncExternalStore(
    (cb) => pluginHost.subscribe(cb),
    () => pluginHost.list(),
  );
  return (
    <div className="plugins" data-testid="plugins-panel">
      <button className="kb-button kb-button--secondary kb-button--small" data-testid="open-plugin-manager" onClick={() => openPluginManagerRef.current?.()}>
        管理插件…
      </button>
      {list.map((p) => {
        const id = p.manifest?.id;
        if (!id) return null;
        return (
          <div
            className="kb-plugin-row"
            key={id}
            data-testid={`plugin-${id}`}
            data-status={p.status}
            data-kind={p.kind}
            title={[p.manifest?.name, p.manifest?.version && `v${p.manifest.version}`, p.message ?? p.manifest?.description].filter(Boolean).join(' · ')}
          >
            <span className="name" title={p.manifest?.name}>
              {p.manifest?.name}{' '}
              <span className="faint">
                {p.kind === 'theme' ? '主题包 ' : ''}
                {p.manifest?.version}
              </span>
            </span>
            <PluginEnableSwitch
              pluginId={id}
              name={p.manifest?.name}
              status={p.status}
              canDisable={p.canDisable}
              message={p.message}
              testId={`plugin-toggle-${id}`}
            />
          </div>
        );
      })}
    </div>
  );
}

// ---------------- status bar ----------------

function StatusBar({ roots, status, health, appearanceLabel, wsName, activeRid }: { roots: Root[]; status: IndexStatus[]; health: IndexHealth | null; appearanceLabel: string; wsName: string; activeRid: string | null }) {
  useSyncExternalStore(editorStatus.subscribe, editorStatus.version);
  const doc = activeRid ? editorStatus.get(activeRid) : undefined;
  const degraded = contentSearchDegraded(health);
  return (
    <footer className="kb-statusbar" data-testid="statusbar">
      {roots.length === 0 && <span className="kb-status-item">尚未注册根目录</span>}
      {degraded && (
        <span className="kb-status-item" data-testid="index-health-fallback" data-engine={health?.engine ?? 'local-fallback'} title={health?.reason || '全文索引不可用'} role="status">
          全文索引不可用 · 仅文件名/路径搜索
        </span>
      )}
      {health?.contentIndexNotice ? (
        <span className="kb-status-item" data-testid="index-full-notice" role="status">
          全文索引空间已满，已尝试压实
        </span>
      ) : null}
      {status.map((s) => {
        const r = roots.find((x) => x.id === s.rootId);
        if (!r) return null;
        let label: string;
        if (s.state === 'scanning') label = `扫描中… ${s.progress}`;
        else if (s.state === 'error') label = `错误：${s.lastError}`;
        else if (degraded) label = `全文索引不可用 · 已扫描 ${s.fileCount} 个文件`;
        else label = `已扫描 ${s.fileCount} 个文件`;
        return (
          <span key={s.rootId} className="kb-status-item" data-testid="index-status" title={degraded ? `全文索引不可用：${health?.reason || '未知原因'}` : undefined} data-state={s.state} data-engine={health?.engine ?? 'unknown'}>
            <span className="dot" />
            {r.name}：{label}
            {s.watching ? ' · 监听中' : ' · 未监听'}
            {s.lastError === '扫描已取消' && ' · 扫描已取消'}{' '}
            {s.state === 'scanning' ? (
              <button onClick={() => kb.cancelScan(s.rootId)}>取消</button>
            ) : (
              <button onClick={() => kb.rescan(s.rootId)} title="重新对账扫描" aria-label="重新对账扫描">
                <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M13.2 8a5.2 5.2 0 1 1-1.5-3.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  <path d="M13.4 2.6V5.8H10.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
          </span>
        );
      })}
      <span className="spacer" />
      {doc && (
        <span className="kb-status-item mono" data-testid="status-encoding" title="当前文件的编码与换行；保存时保持不变">
          {ENCODING_LABEL[doc.encoding]} · {doc.eol === 'crlf' ? 'CRLF' : 'LF'}
        </span>
      )}
      <span className="kb-status-item mono" data-testid="status-workspace">
        工作区：{wsName}
      </span>
      <span className="kb-status-item mono" data-testid="status-appearance">
        {appearanceLabel}
      </span>
      <span className="kb-status-item mono">API {HOST_API_VERSION}</span>
    </footer>
  );
}

// ---------------- workspace switcher ----------------

interface WsActions {
  switchTo(id: string): void;
  create(copy: boolean): void;
  rename(id: string): void;
  remove(id: string): void;
  exportWs(id: string): void;
  importWs(): void;
  applyPreset(id: string): void;
}
function WorkspaceSwitcher({ list, currentId, actions }: { list: WorkspaceSummary[]; currentId: string; actions: WsActions }) {
  const [open, setOpen] = useState(false);
  const presets = useRegistry(layoutPresets, () => layoutPresets.all());
  const cur = list.find((w) => w.id === currentId);
  const groups = useMemo(() => {
    const m = new Map<string, WorkspaceSummary[]>();
    for (const w of list) m.set(w.project, [...(m.get(w.project) ?? []), w]);
    return [...m.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
  }, [list]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const on = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', on);
    return () => window.removeEventListener('mousedown', on);
  }, [open]);
  const run = (f: () => void) => () => {
    setOpen(false);
    f();
  };
  return (
    <div className="anchor" ref={ref}>
      <button type="button" className="kb-ghost ws-switcher kb-no-drag" data-testid="ws-switcher" title={cur ? `${cur.name}${cur.project ? ` · ${cur.project}` : ''}` : '切换工作区'} onClick={() => setOpen((o) => !o)}>
        <span className="name">{cur?.name ?? '工作区'}</span>
        <ChevronDownIcon />
      </button>
      {open && (
        <div className="kb-popover menu" data-testid="ws-menu">
          {groups.map(([project, ws]) => (
            <div key={project} data-testid="ws-group" data-project={project}>
              <div className="kb-menu-group-title">{project || '未分组'}</div>
              {ws.map((w) => (
                <div
                  key={w.id}
                  className="kb-menu-item"
                  tabIndex={0}
                  data-testid="ws-item"
                  data-ws-id={w.id}
                  data-ws-name={w.name}
                  aria-selected={w.id === currentId ? 'true' : undefined}
                  onClick={run(() => actions.switchTo(w.id))}
                  title={`${w.panelCount} 个条目 · 引用 ${w.rootIds.length} 个根`}
                >
                  <span className="name">{w.name}</span>
                  <span className="p">{w.panelCount} 项{w.rootIds.length > 1 ? ` · ${w.rootIds.length} 个根` : ''}</span>
                  <span className="act" data-testid="ws-rename" title="重命名/设置项目" onClick={(e) => (e.stopPropagation(), setOpen(false), actions.rename(w.id))}>
                    <Pencil size={14} strokeWidth={1.5} aria-hidden />
                  </span>
                  <span className="act" data-testid="ws-export" title="导出 .kblayout.json" onClick={(e) => (e.stopPropagation(), setOpen(false), actions.exportWs(w.id))}>
                    <Download size={14} strokeWidth={1.5} aria-hidden />
                  </span>
                  <span
                    className={list.length <= 1 ? 'act is-disabled' : 'act'}
                    data-testid="ws-delete"
                    aria-disabled={list.length <= 1 ? 'true' : undefined}
                    title={list.length <= 1 ? LAST_WORKSPACE_DELETE_TITLE : '删除工作区（不删除任何文件）'}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (list.length <= 1) return;
                      setOpen(false);
                      actions.remove(w.id);
                    }}
                  >
                    <X size={14} strokeWidth={1.5} aria-hidden />
                  </span>
                </div>
              ))}
            </div>
          ))}
          <div className="menu-sep" />
          <div className="kb-menu-item" data-testid="ws-new" tabIndex={0} onClick={run(() => actions.create(false))}>
            <PlusIcon />
            <span className="name">新建空工作区…</span>
          </div>
          <div className="kb-menu-item" data-testid="ws-save-as" tabIndex={0} onClick={run(() => actions.create(true))}>
            <Copy size={14} strokeWidth={1.5} aria-hidden />
            <span className="name">当前工作区另存为…</span>
          </div>
          <div className="kb-menu-item" data-testid="ws-import" tabIndex={0} onClick={run(() => actions.importWs())}>
            <FolderInput size={14} strokeWidth={1.5} aria-hidden />
            <span className="name">导入 .kblayout.json…</span>
          </div>
          <div className="menu-sep" />
          <div className="kb-menu-group-title">布局预设（只改分栏排列）</div>
          {presets.map((p) => (
            <div key={p.id} className="kb-menu-item" data-testid="ws-preset" data-preset-id={p.id} tabIndex={0} title={p.description} onClick={run(() => actions.applyPreset(p.id))}>
              <span className="name">{p.label}</span>
              <span className="p">{p.owner}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------- appearance ----------------

function AppearanceMenu({ value, onChange }: { value: Appearance; onChange: (a: Appearance) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const on = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', on);
    return () => window.removeEventListener('mousedown', on);
  }, [open]);
  return (
    <div className="anchor" ref={ref}>
      <button type="button" className="kb-icon-hit kb-no-drag" data-testid="appearance-button" title="外观（外框样式 / 阅读区样式 / 明暗）" aria-label="外观" onClick={() => setOpen((o) => !o)}>
        <SunIcon />
      </button>
      {open && (
        <div className="kb-popover menu right" data-testid="appearance-menu">
          <div className="kb-menu-group-title">外观（不改变布局与阅读进度）</div>
          <AppearanceFields value={value} onChange={onChange} />
          <div className="menu-sep" />
          <div className="kb-menu-item" data-testid="install-theme" onClick={() => (setOpen(false), void installThemePack())}>
            <FolderInput size={14} strokeWidth={1.5} aria-hidden />
            <span className="name">安装主题包（文件夹）…</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** 窄窗收进工作区切换、总览、外观；宽屏这些仍留在顶栏，菜单里只留清除全部标红。 */
function TopMoreMenu({
  onCommandPalette,
  overviewHidden,
  overviewLocked,
  onToggleOverview,
  workspace,
  appearance,
  slim,
}: {
  onCommandPalette(): void;
  overviewHidden: boolean;
  overviewLocked: boolean;
  onToggleOverview(): void;
  workspace: { list: WorkspaceSummary[]; currentId: string; actions: WsActions };
  appearance: { value: Appearance; onChange: (a: Appearance) => void };
  slim?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const on = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', on);
    return () => window.removeEventListener('mousedown', on);
  }, [open]);
  const paletteKey = runtimeEffectiveKeybinding('workbench.commandPalette') ?? 'Ctrl+Shift+P';
  const clearMarks = (
    <div
      className="kb-menu-item kb-no-drag"
      role="menuitem"
      tabIndex={0}
      data-testid="clear-all-marks"
      title="去掉所有标红，并同步清掉给 Agent 的特别关注"
      onClick={() => {
        setOpen(false);
        void clearAllAgentMarks();
      }}
    >
      <svg className="kb-menu-ic" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3.2 11.2 9.2 5.2l1.6 1.6-6 6H3.2v-1.6zM8 4.4l1.4-1.4 2.6 2.6L10.6 7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
      <span className="name">清除全部标红</span>
    </div>
  );
  return (
    <div className="anchor kb-no-drag kb-top-more" ref={ref}>
      <button type="button" className="kb-button kb-button--ghost kb-no-drag" data-testid="top-more" aria-haspopup="menu" aria-expanded={open} title="更多" onClick={() => setOpen((v) => !v)}>
        更多
      </button>
      {open && (
        <div className="kb-popover menu right kb-top-more-menu" role="menu" data-testid="top-more-menu">
          {slim ? (
            clearMarks
          ) : (
            <>
              <div
                className="kb-menu-item kb-no-drag"
                role="menuitem"
                tabIndex={0}
                data-testid="top-more-command-palette"
                title="命令面板 (Ctrl+Shift+P)"
                onClick={() => {
                  setOpen(false);
                  onCommandPalette();
                }}
              >
                <span className="name">命令面板</span>
                <span className="kbd">{paletteKey}</span>
              </div>
              <div className="menu-sep" />
              <WorkspaceSwitcher list={workspace.list} currentId={workspace.currentId} actions={workspace.actions} />
              <div
                className="kb-menu-item kb-no-drag"
                role="menuitem"
                tabIndex={0}
                data-testid="ws-overview-toggle"
                title="工作区总览"
                aria-pressed={!overviewHidden}
                aria-disabled={overviewLocked || undefined}
                onClick={() => {
                  if (overviewLocked) return;
                  onToggleOverview();
                  setOpen(false);
                }}
              >
                工作区总览
              </div>
              <div className="menu-sep" />
              <div
                className="kb-menu-item kb-no-drag"
                role="menuitem"
                tabIndex={0}
                data-testid="top-more-appearance"
                title="外观"
                onClick={() => {
                  setOpen(false);
                  openSettingsRef.current('appearance');
                }}
              >
                <SunIcon />
                <span className="name">外观</span>
              </div>
              <div className="kb-top-more-scheme kb-no-drag" data-testid="topbar-scheme-sun">
                <SchemeSunToggle
                  scheme={appearance.value.scheme}
                  onScheme={(scheme) => appearance.onChange({ ...appearance.value, scheme })}
                />
              </div>
              <AppearanceMenu value={appearance.value} onChange={appearance.onChange} />
              <div className="menu-sep" />
              {clearMarks}
            </>
          )}
        </div>
      )}
    </div>
  );
}

async function installThemePack() {
  try {
    const p = await kb.installThemePackFromFolder();
    if (!p) return;
    const v = themePackEntry(p);
    if (v.validated.errors.length) {
      await dialogs.alert({ title: '主题包已复制，但校验未通过', body: v.validated.errors.slice(0, 8).join('\n') });
      return;
    }
    await pluginHost.load([v.entry]);
    const rec = pluginHost.get(v.entry.module.manifest.id);
    await dialogs.alert(themeInstallFeedback((p.manifest as { name?: string }).name ?? '', rec?.status, rec?.message));
  } catch (e) {
    await dialogs.alert({ title: '安装失败', body: String((e as Error).message ?? e) });
  }
}

// ---------------- app ----------------

/** 保存格式附加 layout.windows（面板管理层：浮动位置之外的层级/收起/最大化/侧栏状态，带自己的版本号） */
function withWindows<T extends { layout: object }>(stored: T): T {
  return { ...stored, layout: { ...stored.layout, windows: stripAgentPanelWindows(panelManager.serialize()) } };
}

async function fileElsewhere(title: string, resourceId: string): Promise<string | null> {
  const name = title.trim();
  if (!name) return null;
  const hits = await kb.search(name).catch(() => [] as SearchHit[]);
  for (const hit of hits) {
    if (hit.kind !== 'file' || hit.name !== name || hit.resourceId === resourceId) continue;
    const alt = await kb.getResource(hit.resourceId).catch(() => null);
    if (alt?.exists) return hit.resourceId;
  }
  return null;
}

/** 资料 ID 优先。ID 不在时再按文件名找一份还在的文件，供重试打开。不写绝对路径。 */
async function fileFactsForItem(item: WorkspaceItem | undefined, remember: (resourceId: string) => void): Promise<FileResource> {
  const resourceId = item?.sourceKind === 'file' ? item.ref : '';
  if (!resourceId) return { missing: true, missingReason: '已删除' };
  try {
    const res = await kb.getResource(resourceId);
    if (!res) {
      const elsewhere = await fileElsewhere(item?.title ?? '', resourceId);
      if (elsewhere) {
        remember(elsewhere);
        return classifyFileResource({
          idFound: false,
          exists: false,
          outOfScope: false,
          rootStatus: 'ok',
          rootName: '',
          inCurrentWorkspace: true,
          switchTo: null,
          pathFound: true,
          moved: false,
        });
      }
      return classifyFileResource({
        idFound: false,
        exists: false,
        outOfScope: false,
        rootStatus: 'absent',
        rootName: '',
        inCurrentWorkspace: true,
        switchTo: null,
        pathFound: false,
        moved: false,
      });
    }
    const place = await kb.rootWorkspace(res.rootId).catch(() => ({ name: '', inCurrent: true, switchTo: null as string | null, status: 'ok' as const }));
    const moved = !res.exists && place.inCurrent && place.status === 'ok' ? (await fileElsewhere(item?.title ?? res.name, resourceId)) != null : false;
    return classifyFileResource({
      idFound: true,
      exists: res.exists,
      outOfScope: false,
      rootStatus: place.status,
      rootName: place.name,
      inCurrentWorkspace: place.inCurrent,
      switchTo: place.switchTo,
      pathFound: false,
      moved,
    });
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    if (message.includes(OUT_OF_SCOPE_MESSAGE)) {
      return classifyFileResource({
        idFound: true,
        exists: false,
        outOfScope: true,
        rootStatus: 'ok',
        rootName: '',
        inCurrentWorkspace: true,
        switchTo: null,
        pathFound: false,
        moved: false,
      });
    }
    return { missing: true, missingReason: '已删除' };
  }
}

/** 启动时各主题包的校验结果（theme:shots 写入 report.json） */
let themeReport: unknown[] = [];

const CODE_PLUGINS: PluginEntry[] = [
  { module: builtinReaders, source: 'builtin' },
  { module: builtinFormats, source: 'builtin' },
  { module: demoCsv, source: 'builtin' },
  { module: nativeAppHostPlugin, source: 'builtin' },
  { module: webResources, source: 'builtin' }, // r11-A
];

function legacyAppearance(theme: unknown): Appearance | undefined {
  if (theme === 'study' || theme === 'bright') return { chrome: theme, reading: theme, scheme: 'light' };
  if (theme === 'pro') return { chrome: 'pro', reading: 'pro', scheme: 'dark' };
  return undefined;
}

const UI_SCOPE = '范围外的文件不建索引、不显示、agent 不可见';
const AWAITING_UI = new Set([
  'source.add.web',
  'source.remove',
  'source.filter.set',
  'source.remap.apply',
  'catalog.delete',
  'disk.mkdir',
  'disk.move',
  'disk.copy',
  'disk.trash',
  'disk.write',
]);

function extList(raw: string): string[] {
  return raw.split(/[,，\s]+/).map((s) => s.trim().replace(/^\./, '')).filter(Boolean);
}

function approvalResult(actionId: string, args?: unknown) {
  return {
    status: 'awaiting_approval' as const,
    actionId,
    commandId: actionId,
    executed: false,
    args: args ?? null,
    note: `${actionId} 需要界面批准。批准只在界面，这次没有执行。`,
  };
}

/** 命令 id 与 ActionId 相同。需要批准的不执行；磁盘动作仍不走文件桥。 */
async function runSourceCommand(id: string, dir: DirViewHandle | null, args?: unknown, reload?: () => void) {
  if (id === 'catalog.folder.create') return dir?.newFolder();
  if (id === 'catalog.folder.rename') return dir?.renameFolder();
  if (id === 'catalog.folder.delete') return dir?.deleteFolder();
  if (id === 'source.add.folder') {
    const picked = await kb.pickFolder();
    if (!picked) return null;
    const fields = await dialogs.prompt({
      title: '添加文件夹来源',
      body: UI_SCOPE,
      fields: [{ name: 'extensions', label: '访问范围（扩展名，逗号分隔，可空）', placeholder: 'md, pdf' }],
    });
    if (!fields) return null;
    const extensions = extList(fields.extensions ?? '');
    const added = await kb.addRoot(picked, undefined, extensions.length ? extensions : undefined);
    reload?.();
    return added;
  }
  if (id === 'source.add.file') {
    const picked = await kb.pickFile();
    if (!picked) return null;
    const added = await kb.addFileSource(picked);
    reload?.();
    return added;
  }
  if (AWAITING_UI.has(id)) {
    const result = approvalResult(id, args);
    const bag = args && typeof args === 'object' ? (args as { sourceId?: unknown }) : null;
    const fromSidebar = id === 'source.filter.set' && typeof bag?.sourceId === 'string' && bag.sourceId.length > 0;
    if (!fromSidebar) {
      await dialogs.alert({
        title: id,
        body: id === 'source.filter.set' ? `${result.note}${UI_SCOPE}` : result.note,
      });
    }
    return result;
  }
  const body = id === 'catalog.switch'
    ? 'catalog.switch 只改当前工作区的编排，不改 root_mounts。文件桥可调用现有编排服务。'
    : id === 'source.remap.preview'
      ? '重映射预览只读，由文件桥调用 previewRemap。不写 root_mounts，不改配对规则。'
      : '这个动作由文件桥调用现有编排服务。不移动磁盘文件，不改 root_mounts。';
  await dialogs.alert({ title: id, body });
  return { executed: false, actionId: id, diskMove: false };
}

export function MainShell() {
  useDragAutoScroll();
  const webResourcesOn = useWebResourcesEnabled();
  const [roots, setRoots] = useState<Root[]>([]);
  const [sidebarPhase, setSidebarPhase] = useState<'loading' | 'ready'>('loading');
  const [dataReady, setDataReady] = useState(false);
  const rootsReady = useRef(false);
  const sidebarReadyOnce = useRef(false);
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [status, setStatus] = useState<IndexStatus[]>([]);
  const [indexHealth, setIndexHealth] = useState<IndexHealth | null>(null);
  const [ui, setUi] = useState<UiState>(() => {
    const snap = readUiSnapshot();
    if (!snap) return { expanded: [], appearance: DEFAULT_APPEARANCE, focus: false };
    return { expanded: snap.expanded, appearance: snap.appearance, focus: snap.focus, dirView: normalizeDirView(snap.dirView) };
  });
  const [fsVersion, setFsVersion] = useState(0);
  const [fsEvents, setFsEvents] = useState<FsChangeEvent[]>([]);
  const [showIgnored, setShowIgnoredState] = useState(false);
  useEffect(() => {
    void kb.getShowIgnored().then(setShowIgnoredState);
  }, []);
  const setShowIgnored = useCallback((on: boolean) => {
    setShowIgnoredState(on);
    void kb.setShowIgnored(on).then(() => setFsVersion((v) => v + 1));
  }, []);
  const [booted, setBooted] = useState(false);
  const [palette, setPalette] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [wsList, setWsList] = useState<WorkspaceSummary[]>([]);
  const [wsId, setWsId] = useState('');
  const [overviewHidden, setOverviewHidden] = useState(true);
  const [quickOpen, setQuickOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategoryId>(() => readStoredSettingsCategory(typeof localStorage === 'undefined' ? null : localStorage));
  const [pickerSettingsOpen, setPickerSettingsOpen] = useState(false);
  const [pickerSettings, setPickerSettings] = useState<PickerSettings>(DEFAULT_WORKSPACE_PICKER_SETTINGS);
  const [overviewBoards, setOverviewBoards] = useState<OverviewBoards>(EMPTY_OVERVIEW_BOARDS);
  const [quickConflict, setQuickConflict] = useState<QuickSwitchConflictReport | null>(null);
  const openOverviewRef = useRef<() => void>(() => {});
  const openQuickSwitchRef = useRef<() => void>(() => {});
  const snapshotRevRef = useRef(1);
  const [snapshotSrcs, setSnapshotSrcs] = useState<Record<string, string>>({});
  const [snapshotAt, setSnapshotAt] = useState<Record<string, string>>({});
  const [snapshotFiles, setSnapshotFiles] = useState<Record<string, string>>({});
  const snapshotFilesRef = useRef(snapshotFiles);
  snapshotFilesRef.current = snapshotFiles;
  const snapshotSrcsRef = useRef(snapshotSrcs);
  snapshotSrcsRef.current = snapshotSrcs;
  const pickerSettingsRef = useRef(pickerSettings);
  pickerSettingsRef.current = pickerSettings;
  openOverviewRef.current = () => setOverviewHidden(false);
  openQuickSwitchRef.current = () => setQuickOpen(true);
  const [temporaryWs, setTemporaryWs] = useState(false);
  const temporaryWsRef = useRef(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const snap = readUiSnapshot();
    return snap ? snap.sidebarWidth : NEW_LAYOUT_SIDEBAR_WIDTH;
  });
  const [activeRid, setActiveRid] = useState<string | null>(null);
  const [wsRefs, setWsRefs] = useState<WorkspaceRef[]>([]);
  const wsRefsRef = useRef<WorkspaceRef[]>([]);
  wsRefsRef.current = wsRefs;
  const favoritesRef = useRef<Favorite[]>([]);
  favoritesRef.current = favorites;
  const [openRids, setOpenRids] = useState<Set<string>>(new Set());
  const [scheme, setScheme] = useState<'light' | 'dark'>('dark');
  const [manager, setManager] = useState<{ focus?: string } | null>(null);
  const [opLog, setOpLog] = useState(false);
  openPluginManagerRef.current = (focus) => setManager({ focus });
  openSettingsRef.current = (category) => {
    if (category && isSettingsCategory(category)) setSettingsCategory(category);
    else setSettingsCategory(readStoredSettingsCategory(typeof localStorage === 'undefined' ? null : localStorage));
    setSettingsOpen(true);
  };
  openOpLogRef.current = () => setOpLog(true);

  const apiRef = useRef<DockviewApi | null>(null);
  useEffect(() => {
    setExternalBrowseDock(() => apiRef.current);
    return installExternalBrowseClicks();
  }, []);
  const uiRef = useRef<UiState | null>(null);
  uiRef.current = ui;
  const chromePrefsRef = useRef<UiChromePrefs>(DEFAULT_UI_CHROME_PREFS);
  const chromeLoadedRef = useRef(false);
  const [reduceMotionOn, setReduceMotionOn] = useState(false);
  const [topBarVisible, setTopBarVisible] = useState(true);
  const applyUiChromeRef = useRef<(prefs: UiChromePrefs) => void>(() => undefined);
  applyUiChromeRef.current = (prefs) => {
    chromePrefsRef.current = prefs;
    chromeLoadedRef.current = true;
    if (prefs.documentTabs) showDocumentTabs();
    else hideDockedTabs();
    const root = document.documentElement;
    if (prefs.reduceMotion) root.setAttribute('data-reduce-motion', 'true');
    else root.removeAttribute('data-reduce-motion');
    setReduceMotionOn(!!prefs.reduceMotion);
    const showTop = prefs.topBarVisible !== false;
    setTopBarVisible(showTop);
    root.setAttribute('data-kb-topbar', showTop ? 'on' : 'off');
  };
  const [drawerSelection, setDrawerSelection] = useState<DrawerModuleId[]>([]);
  const drawerTouchedRef = useRef(false);
  const legacySidebar = useRef<number | undefined>(undefined);

  // ---- 当前工作区（可变引用，避免闭包过期）
  const wsIdRef = useRef('');
  async function hydrateOverviewSnapshots(ids: readonly string[]) {
    if (pickerSettingsRef.current.snapshotEnabled === false) return;
    const want = ids.filter((id) => typeof id === 'string' && id && !snapshotSrcsRef.current[id]);
    if (want.length === 0) return;
    const loaded = await loadWorkspaceSnapshots(want);
    const files: Record<string, string> = {};
    const srcs: Record<string, string> = {};
    const ats: Record<string, string> = {};
    for (const id of want) {
      const row = loaded[id];
      if (!row || typeof row.fileName !== 'string' || typeof row.dataUrl !== 'string') continue;
      if (!row.dataUrl.startsWith('data:image/png')) continue;
      files[id] = row.fileName;
      srcs[id] = row.dataUrl;
      if (typeof row.takenAt === 'string' && row.takenAt) ats[id] = row.takenAt;
    }
    if (Object.keys(files).length === 0) return;
    setSnapshotFiles((prev) => ({ ...files, ...prev }));
    setSnapshotSrcs((prev) => ({ ...srcs, ...prev }));
    if (Object.keys(ats).length) setSnapshotAt((prev) => ({ ...ats, ...prev }));
  }
  async function shootOverviewSnapshot() {
    const id = wsIdRef.current;
    if (!id || pickerSettingsRef.current.snapshotEnabled === false) return;
    const revision = snapshotRevRef.current;
    const previousFileName = snapshotFilesRef.current[id] ?? null;
    const result = await captureWorkspaceSnapshot({
      workspaceId: id,
      expectedWorkspaceId: id,
      revision,
      expectedRevision: revision,
      snapshotEnabled: true,
      coverRef: null,
      previousFileName,
    });
    if (wsIdRef.current !== id || !result.captured || !result.fileName) return;
    const dataUrl = (result as { dataUrl?: unknown }).dataUrl;
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png')) return;
    const taken = new Date().toLocaleString('zh-CN', { hour12: false });
    setSnapshotSrcs((prev) => ({ ...prev, [id]: dataUrl }));
    setSnapshotAt((prev) => ({ ...prev, [id]: taken }));
    setSnapshotFiles((prev) => ({ ...prev, [id]: result.fileName as string }));
  }
  async function openOverviewWithSnapshots() {
    const ids = wsList.map((row) => row.id);
    if (wsIdRef.current && !ids.includes(wsIdRef.current)) ids.push(wsIdRef.current);
    await hydrateOverviewSnapshots(ids);
    await shootOverviewSnapshot();
  }
  openOverviewRef.current = () => {
    void openOverviewWithSnapshots().finally(() => setOverviewHidden(false));
  };
  const itemsRef = useRef<Record<string, WorkspaceItem>>({});
  const dismissRef = useRef<RestoreDismissed>({});
  const [dismissed, setDismissed] = useState<RestoreDismissed>({});
  const resolvedRestoreRef = useRef<Record<string, string>>({});
  const shellRef = useRef<ShellLayout>({ ...DEFAULT_SHELL, sidebarWidth });
  const loadingRef = useRef(true);
  const readOnlyRef = useRef<string | null>(null);
  const pendingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const chainRef = useRef<Promise<void>>(Promise.resolve());

  const showToast = useCallback((s: string) => {
    setToast(s);
    setTimeout(() => setToast((t) => (t === s ? null : t)), 4000);
  }, []);
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;
  const closeAllFilesRef = useRef<() => Promise<void>>(async () => undefined);
  closeAllFilesRef.current = async () => {
    const api = apiRef.current;
    if (!api) return;
    const tabs = collectOpenFileTabs(
      api.panels.map((panel) => ({
        id: panel.id,
        title: panel.title,
        params: panel.params as { itemId?: string } | undefined,
      })),
      itemsRef.current,
      (resourceId) => editorStatus.isDirty(resourceId),
    );
    const result = await runCloseAll(tabs, {
      ask: askCloseAllDirty,
      save: saveOpenEditor,
      discard: discardOpenEditor,
      close: (tab) => {
        apiRef.current?.getPanel(tab.panelId)?.api.close();
      },
    });
    if (result.choice === 'save' && result.closed.length === 0 && tabs.some((tab) => tab.dirty)) {
      showToastRef.current('有文件没有保存成功，已全部保留');
    }
  };
  const pathCache = useRef(new Map<string, MaterialRef>());
  const [liveTick, setLiveTick] = useState(0);
  const rootsRef = useRef(roots);
  rootsRef.current = roots;
  const liveHost = useMemo(() => createMountHost({
    workspaceId: () => wsIdRef.current,
    roots: () => rootsRef.current.map((root) => ({ id: root.id, path: root.path })),
    selectedResourceIds: () => {
      const view = uiRef.current?.dirView;
      if (!view) return [];
      const ids: string[] = [];
      for (const pane of [view.left, view.right]) {
        for (const sel of pane?.selected ?? []) if (sel.startsWith('res:')) ids.push(sel.slice(4));
      }
      return ids;
    },
    fileItem: (id) => {
      const item = itemsRef.current[id];
      return item?.sourceKind === 'file' ? { ref: item.ref } : null;
    },
    activeFileItem: () => {
      const panel = apiRef.current?.activePanel;
      if (!panel) return null;
      const itemId = (panel.params as ItemPanelParams | undefined)?.itemId ?? panel.id;
      const item = itemsRef.current[itemId];
      return item?.sourceKind === 'file' ? { itemId, ref: item.ref } : null;
    },
    hostedApp: () => {
      const panel = apiRef.current?.activePanel;
      if (!panel) return false;
      const itemId = (panel.params as ItemPanelParams | undefined)?.itemId ?? panel.id;
      return itemsRef.current[itemId]?.sourceKind === 'app';
    },
    notify: (message) => showToastRef.current(message),
    cache: pathCache.current,
    bump: () => setLiveTick((n) => n + 1),
  }), [liveTick]);
  const liveClient = useMemo(() => createIpcAgentLiveClient(kb), []);
  useEffect(() => {
    setHostedForeground(() => liveHost.hostedForeground());
  }, [liveHost]);
  useEffect(() => {
    const workspaceId = wsIdRef.current;
    if (!workspaceId) return;
    const reading = liveHost.currentReading();
    const timer = setTimeout(() => {
      void kb.agentLiveNoteScene({
        workspaceId,
        reading,
        panels: reading ? [{ panelId: 'active', resourceId: reading.resourceId ?? null, name: reading.name, absPath: reading.absPath }] : [],
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [liveHost, wsId, activeRid]);
  const dirViewRef = useRef<DirViewHandle | null>(null);
  useEffect(() => {
    setDndRoots(roots.map((r) => ({ id: r.id, resourceId: r.resourceId })));
    setNativeDragRootIndex(roots.map((root) => ({ id: root.id, path: root.path, kind: root.kind })));
  }, [roots]);
  useEffect(() => {
    const offDir = installDirViewDnd();
    const offNative = installNativeDragSession();
    return () => {
      offDir();
      offNative();
    };
  }, []);
  const [vfolderVersion, setVfolderVersion] = useState(0);
  useEffect(() => {
    const offV = kb.onVfoldersChange(() => setVfolderVersion((v) => v + 1));
    const offR = kb.onRefsChange((e) => {
      const id = wsIdRef.current;
      if (id && (!e?.workspaceId || e.workspaceId === id)) kb.listWorkspaceRefs(id).then(setWsRefs).catch(() => undefined);
    });
    return () => {
      offV();
      offR();
    };
  }, []);
  const refreshWsList = useCallback(async () => setWsList(await kb.listWorkspaces()), []);

  const noteSidebarReady = useCallback((list: Root[]) => {
    if (sidebarReadyOnce.current) return;
    const folder = list.find((r) => r.kind !== 'file');
    const finish = () => {
      if (sidebarReadyOnce.current) return;
      sidebarReadyOnce.current = true;
      kb.startupMark('sidebar-ready');
    };
    if (!folder) finish();
    else kb.listDir(folder.id, '').then(finish, finish);
  }, []);
  const applyRootList = useCallback((list: Root[], order: unknown) => {
    const ordered = orderRoots(list, parseRootOrder(order));
    setRoots(ordered);
    rootsReady.current = true;
    setDataReady(true);
    setSidebarPhase('ready');
    noteSidebarReady(ordered);
  }, [noteSidebarReady]);
  const reload = useCallback(() => {
    setFsVersion((v) => v + 1);
    // startup-ready-race: first-screen fetch failure keeps the sidebar in "loading" and retries instead of rendering empty.
    const loadRoots = (attempt: number): void => {
      Promise.all([kb.listRoots(), kb.getLayout(ROOT_ORDER_KEY)]).then(([list, order]) => applyRootList(list, order)).catch(() => {
        if (attempt >= 20) { setSidebarPhase('ready'); return; }
        setSidebarPhase('loading');
        setTimeout(() => loadRoots(attempt + 1), Math.min(250 * 2 ** attempt, 2000));
      });
    };
    loadRoots(0);
    kb.listFavorites().then(setFavorites);
    kb.getIndexStatus().then(setStatus);
    kb.getIndexHealth?.().then(setIndexHealth).catch(() => setIndexHealth(null));
  }, [applyRootList]);

  /** 立即保存当前工作区（只在有未保存改动时） */
  const saveNow = useCallback(() => {
    clearTimeout(timerRef.current);
    if (!pendingRef.current) return chainRef.current;
    pendingRef.current = false;
    if (temporaryWsRef.current) return chainRef.current;
    const api = apiRef.current;
    const id = wsIdRef.current;
    if (!api || !id || readOnlyRef.current) return chainRef.current;
    const stored = withRestoreDismissed(withWindows(toStoredLayout(api.panels.length ? omitExternalBrowsePanels(omitAgentPanelDocs(panelManager.dockForSave(api.toJSON() as any))) : null, itemsRef.current, shellRef.current)), dismissRef.current);
    patchLayoutSnapshot(id, stored.layout, stored.items);
    chainRef.current = chainRef.current
      .then(() => kb.saveWorkspaceLayout(id, stored.layout, stored.items))
      .catch((e) => showToast('保存工作区失败：' + String(e?.message ?? e)));
    return chainRef.current;
  }, [showToast]);
  const requestSave = useCallback(() => {
    if (loadingRef.current) return;
    pendingRef.current = true;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void saveNow(), AUTOSAVE_MS);
  }, [saveNow]);
  /** 切换工作区 / 退出 / 导出前调用：写完所有防抖中的改动 */
  const flush = useCallback(async () => {
    await saveNow();
  }, [saveNow]);

  useEffect(() => {
    const save = (event: Event) => { requestSave(); (event as CustomEvent).detail.wait = flush(); };
    window.addEventListener('kb:before-sidebar', save);
    return () => window.removeEventListener('kb:before-sidebar', save);
  }, [requestSave, flush]);

  const loadWorkspace = useCallback(
    async (dto: WorkspaceDto, opts?: { paintOnly?: boolean }) => {
      const api = apiRef.current;
      if (!api) return;
      loadingRef.current = true;
      clearTimeout(timerRef.current);
      pendingRef.current = false;
      wsIdRef.current = dto.id;
      setWsId(dto.id);
      const nextDismiss = readRestoreDismissed(dto.layout);
      dismissRef.current = nextDismiss;
      setDismissed(nextDismiss);
      resolvedRestoreRef.current = {};
      resetRestoreContentReady();
      const mig = migrateLayout(dto.layout, { sidebarWidth: legacySidebar.current }, dto.items ?? []);
      api.clear();
      if (!mig.ok) {
        panelManager.reset();
        readOnlyRef.current = mig.reason;
        itemsRef.current = {};
        setBanner(
          mig.reason === 'newer'
            ? `工作区「${dto.name}」由更新版本的应用保存（布局版本 ${mig.schema}），本版本无法打开。为避免覆盖，它保持只读、未作任何修改。`
            : `工作区「${dto.name}」的布局数据无法识别，已以空布局打开（原数据未被覆盖）。`,
        );
      } else {
        readOnlyRef.current = null;
        setBanner(null);
        itemsRef.current = { ...mig.layout.items };
        shellRef.current = { ...mig.layout.shell };
        setSidebarWidth(mig.layout.shell.sidebarWidth);
        // 先记下将被收起的面板：它们在 fromJSON 挂载时按后台标签处理（不立即加载内容）
        panelManager.primeCollapsed((dto.layout as { windows?: unknown } | null)?.windows);
        if (mig.layout.dock) {
          try {
            api.fromJSON(mig.layout.dock as any);
          } catch (err) {
            console.warn('恢复布局失败', err);
          }
        }
        // 自由窗口：位置/层级/收起/最大化/侧栏（layout.windows，缺失 = 旧布局）
        panelManager.restoreLayout((dto.layout as { windows?: unknown } | null)?.windows);
        // 冷启动分级加载：记下此刻可见的面板（收起成气泡的不算）。只在真正从库恢复时记，快照预画不算。
        if (!opts?.paintOnly && !(window as any).__layoutRestored) visibleContent.begin(api.panels.filter((p) => p.api.isVisible && !panelManager.isHiddenForLoad(p.id)).map((p) => p.id));
      }
      if (opts?.paintOnly) {
        loadingRef.current = false;
        return;
      }
      if (mig.ok) writeLayoutSnapshot(dto);
      await new Promise((r) => setTimeout(r, 60));
      loadingRef.current = false;
      // 旧版本布局迁移后立即按新格式保存
      if (mig.ok && mig.migratedFrom < 4) {
        pendingRef.current = true;
        await saveNow();
      }
      (window as any).__layoutRestored = true;
    },
    [saveNow],
  );

  const switchTo = useCallback(
    async (id: string) => {
      if (id === wsIdRef.current) return;
      if (temporaryWsRef.current) {
        temporaryWsRef.current = false;
        setTemporaryWs(false);
        pendingRef.current = false;
        clearTimeout(timerRef.current);
      } else {
        await flush();
      }
      setSidebarPhase('loading');
      await kb.setCurrentWorkspace(id);
      try {
        const [list, order] = await Promise.all([kb.listRoots(), kb.getLayout(ROOT_ORDER_KEY)]);
        applyRootList(list, order);
      } catch {
        setSidebarPhase('loading');
      }
      await loadWorkspace(await kb.getWorkspace(id));
      void refreshWsList();
    },
    [applyRootList, flush, loadWorkspace, refreshWsList],
  );

  const enterTemporaryWorkspace = useCallback(() => {
    const api = apiRef.current;
    temporaryWsRef.current = true;
    setTemporaryWs(true);
    loadingRef.current = true;
    clearTimeout(timerRef.current);
    pendingRef.current = false;
    wsIdRef.current = TEMPORARY_WORKSPACE_ID;
    setWsId(TEMPORARY_WORKSPACE_ID);
    readOnlyRef.current = null;
    setBanner(null);
    itemsRef.current = {};
    if (api) {
      api.clear();
      panelManager.reset();
    }
    const shell = emptyLayout(shellRef.current).shell;
    shellRef.current = { ...shell };
    setSidebarWidth(shell.sidebarWidth);
    loadingRef.current = false;
    setOverviewHidden(true);
  }, []);

  const createEmptyNamed = useCallback(
    async (name: string) => {
      try {
        const stored = toStoredLayout(null, {}, emptyLayout(shellRef.current).shell);
        const created = await kb.createWorkspace(name, '', stored.layout, stored.items);
        await switchTo(created.id);
        setOverviewHidden(true);
      } catch (e) {
        await dialogs.alert({ title: '无法创建工作区', body: String((e as Error).message ?? e) });
      }
    },
    [switchTo],
  );

  const currentLayout = useCallback(() => {
    const api = apiRef.current;
    return withRestoreDismissed(withWindows(toStoredLayout(api && api.panels.length ? omitExternalBrowsePanels(omitAgentPanelDocs(panelManager.dockForSave(api.toJSON() as any))) : null, itemsRef.current, shellRef.current)), dismissRef.current);
  }, []);

  const wsActions: WsActions = useMemo(
    () => ({
      switchTo: (id) => void switchTo(id),
      create: async (copy) => {
        const cur = wsList.find((w) => w.id === wsIdRef.current);
        const r = await dialogs.prompt({
          title: copy ? '当前工作区另存为' : '新建工作区',
          body: copy ? '复制当前的标签、分栏、尺寸与阅读进度。' : '新工作区从空布局开始；可以打开任意根中的文件。',
          fields: [
            { name: 'name', label: '名称', value: copy ? `${cur?.name ?? ''} 副本` : '' },
            { name: 'project', label: '项目（用于分组，可留空）', value: cur?.project ?? '' },
          ],
          ok: copy ? '另存' : '创建',
        });
        if (!r) return;
        try {
          await flush();
          const stored = copy ? currentLayout() : toStoredLayout(null, {}, emptyLayout(shellRef.current).shell);
          const s = await kb.createWorkspace(r.name, r.project, stored.layout, stored.items);
          await switchTo(s.id);
        } catch (e) {
          await dialogs.alert({ title: '无法创建工作区', body: String((e as Error).message ?? e) });
        }
      },
      rename: async (id) => {
        const w = wsList.find((x) => x.id === id);
        if (!w) return;
        const r = await dialogs.prompt({
          title: '重命名工作区',
          fields: [
            { name: 'name', label: '名称', value: w.name },
            { name: 'project', label: '项目（用于分组，可留空）', value: w.project },
          ],
        });
        if (!r) return;
        try {
          await kb.updateWorkspace(id, { name: r.name, project: r.project });
          await refreshWsList();
        } catch (e) {
          await dialogs.alert({ title: '无法重命名', body: String((e as Error).message ?? e) });
        }
      },
      remove: async (id) => {
        try {
          const result = await requestDeleteWorkspace(id, {
            confirm: (spec) => dialogs.confirm(spec),
            workspaces: () => wsList.map((row) => ({ id: row.id, name: row.name })),
            currentId: () => wsIdRef.current,
            switchTo: (next) => switchTo(next),
            deleteWorkspace: (target) => kb.deleteWorkspace(target),
          });
          if (result === 'blocked') {
            if (wsList.length <= 1) await dialogs.alert({ title: '无法删除', body: '至少需要保留一个工作区。' });
            return;
          }
          if (result === 'deleted') await refreshWsList();
        } catch (e) {
          await dialogs.alert({ title: '无法删除工作区', body: String((e as Error).message ?? e) });
        }
      },
      exportWs: async (id) => {
        await flush();
        try {
          const f = await kb.exportWorkspaceToFile(id);
          if (f) showToast(`已导出：${f}`);
        } catch (e) {
          await dialogs.alert({ title: '导出失败', body: String((e as Error).message ?? e) });
        }
      },
      importWs: async () => {
        try {
          const r = await kb.importWorkspaceFromFile();
          if (!r) return;
          await refreshWsList();
          await switchTo(r.workspace.id);
          showToast(`已导入「${r.workspace.name}」：${r.matched} 项直接匹配，${r.remapped} 项按路径重新匹配${r.unresolved.length ? `，${r.unresolved.length} 项找不到` : ''}${r.missingPlugins?.length ? `；需要安装插件：${r.missingPlugins.map((p) => `${p.name} ${p.version}`).join('、')}（相关面板暂为占位）` : ''}`);
        } catch (e) {
          await dialogs.alert({ title: '导入失败', body: String((e as Error).message ?? e) });
        }
      },
      applyPreset: async (pid) => {
        const p = layoutPresets.get(pid);
        const api = apiRef.current;
        if (!p || !api) return;
        if (!api.panels.length) return showToast('当前工作区没有打开的标签');
        const windows = panelManager.serialize();
        const next = applyPreset(panelManager.dockForSave(api.toJSON() as any), p, api.width, api.height);
        if (!next) return;
        loadingRef.current = true;
        panelManager.primeCollapsed(windows);
        api.fromJSON(next as any);
        panelManager.restoreLayout(windows);
        if (p.sidebarWidth) {
          shellRef.current = { ...shellRef.current, sidebarWidth: p.sidebarWidth };
          setSidebarWidth(p.sidebarWidth);
        }
        await new Promise((r) => setTimeout(r, 60));
        loadingRef.current = false;
        requestSave();
        showToast(`已应用布局预设「${p.label}」`);
      },
    }),
    [wsList, switchTo, flush, currentLayout, refreshWsList, showToast, requestSave],
  );
  const wsActionsRef = useRef(wsActions);
  wsActionsRef.current = wsActions;

  const setAppearance = useCallback((a: Appearance) => {
    const applied = applyAppearance(a);
    setScheme(applied.resolvedScheme);
    setUi((u) => {
      if (!u) return u;
      const next = {
        ...u,
        appearance: mergeAppearance(mergeAppearance(u.appearance, a), {
          chrome: applied.chrome,
          reading: applied.reading,
          scheme: applied.scheme,
        }),
      };
      void kb.setLayout('ui', next);
      return next;
    });
  }, []);
  // 第一帧就按快照（或默认外观）铺上主题变量。不等数据库，也不等主题包列表。
  useLayoutEffect(() => {
    const snap = readUiSnapshot();
    if (snap?.customColors) setCustomColorOverlay(snap.customColors, { paint: false });
    const applied = applyAppearance(ui.appearance);
    setScheme(applied.resolvedScheme);
    syncWindowChromeFromCss();
  }, []);
  useEffect(() => {
    syncWindowChromeFromCss();
  }, [ui.appearance.chrome, ui.appearance.reading, ui.appearance.scheme, scheme]);
  useEffect(() => {
    let alive = true;
    void loadUiChromePrefs(kb).then(
      (prefs) => {
        if (alive) applyUiChromeRef.current(prefs);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    let alive = true;
    void kb.getLayout(DRAWER_MODULES_KEY).then((raw) => {
      if (!alive || drawerTouchedRef.current) return;
      setDrawerSelection(initialDrawerSelection(raw));
    }).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    const customColors = getCustomColorOverlay();
    writeUiSnapshot({
      appearance: ui.appearance,
      focus: !!ui.focus,
      expanded: ui.expanded,
      dirView: ui.dirView,
      sidebarWidth,
      ...(Object.keys(customColors).length ? { customColors } : {}),
    });
  }, [ui, sidebarWidth]);
  useEffect(() => {
    const onColors = () => {
      const appearance = uiRef.current?.appearance ?? DEFAULT_APPEARANCE;
      applyAppearance(appearance);
      const customColors = getCustomColorOverlay();
      writeUiSnapshot({
        appearance,
        focus: !!uiRef.current?.focus,
        expanded: uiRef.current?.expanded ?? [],
        dirView: uiRef.current?.dirView,
        sidebarWidth: shellRef.current.sidebarWidth,
        ...(Object.keys(customColors).length ? { customColors } : {}),
      });
    };
    window.addEventListener(CUSTOM_COLORS_EVENT, onColors);
    return () => window.removeEventListener(CUSTOM_COLORS_EVENT, onColors);
  }, []);
  useEffect(() => {
    const onReset = () => {
      rootsReady.current = false;
      setDataReady(false);
      sidebarReadyOnce.current = false;
      setSidebarPhase('loading');
      setRoots([]);
      setFavorites([]);
      Promise.all([kb.listRoots(), kb.getLayout(ROOT_ORDER_KEY)])
        .then(([list, order]) => applyRootList(list, order))
        .catch(() => setSidebarPhase('loading'));
      kb.listFavorites().then(setFavorites).catch(() => undefined);
    };
    return kb.onDataReset?.(onReset);
  }, [applyRootList]);

  // ---- 启动：加载插件与主题包 → 应用外观 → 渲染
  // ---- r11-B：快捷键命令宿主（activate 时登记；用 ref 避免卸载清掉）
  const keyHostRef = useRef({
    panelManager,
    activePanelId: () => {
      const id = apiRef.current?.activePanel?.id;
      if (!id || id === 'kb.sidebar') return null;
      return id;
    },
    cycleTab: (dir: 1 | -1) => {
      const api = apiRef.current;
      if (!api) return;
      const list = api.panels.filter((p) => p.id !== 'kb.sidebar');
      if (!list.length) return;
      const cur = api.activePanel;
      const idx = Math.max(0, list.findIndex((p) => p.id === cur?.id));
      list[(idx + dir + list.length) % list.length]?.api.setActive();
    },
    contentZoom: (delta: number) => {
      if (delta > 0) runContentZoom(null, 'in');
      else if (delta < 0) runContentZoom(null, 'out');
      else runContentZoom(null, 'reset');
    },
    panelResize: (delta: number) => {
      const id = apiRef.current?.activePanel?.id;
      if (!id) return;
      const info = panelManager.get(id);
      if (!info || info.mode !== 'floating' || !info.bounds) return;
      const b = info.bounds;
      const d = delta > 0 ? 40 : -40;
      panelManager.float(id, { left: b.left, top: b.top, width: Math.max(240, b.width + d), height: Math.max(160, b.height + d) });
    },
    toggleEditMode: () => {
      const btn = document.querySelector('[data-testid="editor-toggle-mode"], [data-testid="edit-mode-toggle"]') as HTMLButtonElement | null;
      btn?.click();
    },
    closeActive: () => {
      const p = apiRef.current?.activePanel;
      if (p && p.id !== 'kb.sidebar') p.api.close();
    },
  });

  useEffect(() => {
    ensureWheelTrigger();
    const stopActive = setActiveItemResolver(() => keyHostRef.current.activePanelId());
    syncContentZoomWheel();
    const unsub = subscribeKeybindings(() => syncContentZoomWheel());
    return () => {
      stopActive();
      unsub();
    };
  }, []);

  const wbApiRef = useRef<PluginApi | null>(null);
  useEffect(() => {
    pluginHost.askAdapterPermission = askPermissionDialog;
    (async () => {
      const u = ((await kb.getLayout('ui')) as Partial<UiState> & { theme?: string; sidebarWidth?: number }) ?? {};
      void kb.getLayout(RESTORE_BAR_VISIBLE_KEY).then((raw) => {
        if (raw === false) setRestoreBarVisible(false);
        else if (raw === true) setRestoreBarVisible(true);
      }).catch(() => undefined);
      const delay = Number(await kb.getLayout('settings.backgroundLoadDelayMs'));
      if (Number.isFinite(delay) && (await kb.getLayout('settings.backgroundLoadDelayMs')) !== null) backgroundLoader.delayMs = delay;
      legacySidebar.current = u.sidebarWidth;
      const init: UiState = { expanded: u.expanded ?? [], appearance: readStoredAppearance(u, legacyAppearance(u.theme)), focus: !!u.focus, dirView: normalizeDirView((u as { dirView?: unknown }).dirView) };
      setFocusMode(!!init.focus);
      const workbench: PluginModule = {
        manifest: { id: 'builtin.workbench', name: '工作台命令与面板', version: '1.0.0', engines: { workbench: `^${HOST_API_VERSION}` } },
        async activate(api) {
          wbApiRef.current = api;
          api.commands.register({ id: 'workbench.sidebarMode', title: '切换侧栏模式', category: '布局', keybinding: 'Ctrl+Alt+S', run: () => window.dispatchEvent(new Event('kb:toggle-sidebar')) });
          api.commands.register({ id: 'workbench.commandPalette', title: '显示命令面板', keybinding: 'Ctrl+Shift+P', run: () => setPalette(true) });
          registerDesktopPanelCommands((c) => api.commands.register(c));
          api.commands.register({
            id: 'workbench.showDocumentTabs',
            title: '显示文档标签',
            category: '工作台',
            run: async () => {
              const base = chromeLoadedRef.current ? chromePrefsRef.current : await loadUiChromePrefs(kb);
              const stored = await saveUiChromePrefs(kb, withUiChromePrefs(base, { documentTabs: true }));
              applyUiChromeRef.current(stored);
              window.dispatchEvent(new CustomEvent('kb:ui-chrome-saved', { detail: stored }));
            },
          });

          SIDEBAR_BLOCK_IDS.forEach((id) => api.commands.register({ id: `sidebar.block.toggle.${id}`, title: `切换侧栏分区：${DRAWER_MODULE_LABEL[id]}`, category: '侧栏', run: () => toggleSidebarBlock(id) }));
          api.commands.register({ id: 'sidebar.block.showAll', title: '显示全部侧栏分区', category: '侧栏', run: () => showAllSidebarBlocks() });
          api.commands.register({
            id: 'workbench.toggleTopBar',
            title: '显示/隐藏顶栏',
            category: '工作台',
            run: async () => {
              const base = chromeLoadedRef.current ? chromePrefsRef.current : await loadUiChromePrefs(kb);
              const stored = await saveUiChromePrefs(kb, withUiChromePrefs(base, { topBarVisible: base.topBarVisible === false }));
              applyUiChromeRef.current(stored);
              window.dispatchEvent(new CustomEvent('kb:ui-chrome-saved', { detail: stored }));
            },
          });

          api.commands.register({ id: 'workbench.layout.closeAll', title: '关闭所有标签', category: '布局', run: () => apiRef.current?.panels.slice().forEach((p) => p.api.close()) });
          api.commands.register({ id: 'workspace.new', title: '新建工作区…', category: '工作区', run: () => wsActionsRef.current.create(false) });
          api.commands.register({ id: 'workspace.saveAs', title: '当前工作区另存为…', category: '工作区', run: () => wsActionsRef.current.create(true) });
          api.commands.register({ id: 'workspace.rename', title: '重命名当前工作区…', category: '工作区', run: () => wsActionsRef.current.rename(wsIdRef.current) });
          api.commands.register({ id: 'workspace.delete', title: '删除当前工作区…', category: '工作区', run: () => wsActionsRef.current.remove(wsIdRef.current) });
          api.commands.register({ id: 'workspace.export', title: '导出当前工作区（.kblayout.json）…', category: '工作区', run: () => wsActionsRef.current.exportWs(wsIdRef.current) });
          api.commands.register({ id: 'workspace.import', title: '导入工作区（.kblayout.json）…', category: '工作区', run: () => wsActionsRef.current.importWs() });
          api.commands.register({
            ...RESTORE_BAR_COMMAND,
            run: () => {
              const next = toggleRestoreBarVisible();
              void kb.setLayout(RESTORE_BAR_VISIBLE_KEY, next);
            },
          });
          api.commands.register({ id: 'appearance.scheme.light', title: '浅色', category: '外观', run: () => uiRef.current && setAppearance({ ...uiRef.current.appearance, scheme: 'light' }) });
          api.commands.register({ id: 'appearance.scheme.dark', title: '深色', category: '外观', run: () => uiRef.current && setAppearance({ ...uiRef.current.appearance, scheme: 'dark' }) });
          api.commands.register({ id: 'appearance.scheme.system', title: '跟随系统明暗', category: '外观', run: () => uiRef.current && setAppearance({ ...uiRef.current.appearance, scheme: 'system' }) });
          api.commands.register({
            id: 'reading.focus.toggle',
            title: '阅读专注模式（开/关）',
            category: '阅读',
            keybinding: 'F9',
            run: () => {
              const v = !getFocusMode();
              setFocusMode(v);
              setUi((u) => {
                if (!u) return u;
                const next = { ...u, focus: v };
                void kb.setLayout('ui', next);
                return next;
              });
          // ---- day-hotkeys: 只看内容（冲突不覆盖，默认 Ctrl+Shift+F11）
          {
            const allCmds = api.commands.all ? api.commands.all() : [];
            const parts = partitionContentOnlyKeyHolders({
              commands: (allCmds as Array<{ id: string; title: string; keybinding?: string; owner?: string; when?: 'global' }> ) || [],
              actions: [],
            });
            const decision = decideContentOnlyKey({
              builtinActions: parts.builtinActions,
              pluginCommands: parts.pluginCommands,
              userBindings: [],
            });
            const conflict = bindContentOnlyCommand(
              (c) => api.commands.register(c as never),
              decision,
              () => {
              try {
                const g = (globalThis as unknown as { getFocusMode?: () => boolean; setFocusMode?: (v: boolean) => void });
                // fall through to local ui focus if helpers absent
              } catch { /* */ }
              setUi((u) => {
                if (!u) return u;
                const v = !(u as { focus?: boolean }).focus;
                const next = { ...u, focus: v, contentOnly: v };
                void kb.setLayout('ui', next);
                try {
                  document.documentElement.dataset.kbContentOnly = v ? 'on' : 'off';
                  document.documentElement.dataset.kbFocus = v ? 'on' : 'off';
                } catch { /* */ }
                return next;
              });
            },
            );
            if (conflict) {
              try { console.warn('[keybindings]', formatContentOnlyConflict(conflict)); } catch { /* */ }
            }
          }

          // ---- day-hotkeys: 只看内容（冲突不覆盖，默认 Ctrl+Shift+F11）
          {
            const allCmds = api.commands.all ? api.commands.all() : [];
            const parts = partitionContentOnlyKeyHolders({
              commands: (allCmds as Array<{ id: string; title: string; keybinding?: string; owner?: string; when?: 'global' }> ) || [],
              actions: [],
            });
            const decision = decideContentOnlyKey({
              builtinActions: parts.builtinActions,
              pluginCommands: parts.pluginCommands,
              userBindings: [],
            });
            const conflict = bindContentOnlyCommand(
              (c) => api.commands.register(c as never),
              decision,
              () => {
              try {
                const g = (globalThis as unknown as { getFocusMode?: () => boolean; setFocusMode?: (v: boolean) => void });
                // fall through to local ui focus if helpers absent
              } catch { /* */ }
              setUi((u) => {
                if (!u) return u;
                const v = !(u as { focus?: boolean }).focus;
                const next = { ...u, focus: v, contentOnly: v };
                void kb.setLayout('ui', next);
                try {
                  document.documentElement.dataset.kbContentOnly = v ? 'on' : 'off';
                  document.documentElement.dataset.kbFocus = v ? 'on' : 'off';
                } catch { /* */ }
                return next;
              });
            },
            );
            if (conflict) {
              try { console.warn('[keybindings]', formatContentOnlyConflict(conflict)); } catch { /* */ }
            }
          }

            },
          });
          api.commands.register({ id: 'plugins.manage', title: '插件管理…', category: '插件', run: () => openPluginManagerRef.current?.() });
          api.commands.register({ id: 'workbench.opLog', title: '操作记录…', category: '工作台', run: () => openOpLogRef.current?.() });
          api.commands.register({ id: 'workbench.pendingPlans', title: '待批准计划…', category: '工作台', run: () => openPendingPlans() });
          // ---- r11-D 目录树拖拽与目录命令（走 dir-view / 本机 IPC）
          api.commands.register({
            id: 'tree.moveTo',
            title: '移动到…',
            category: '目录',
            run: () => promptMove(),
          });
          api.commands.register({
            id: 'refs.addToFolder',
            title: '加入自建目录…',
            category: '目录',
            run: () => promptAddToFolder(),
          });
          api.commands.register({
            id: 'refs.removeFromFolder',
            title: '从该目录移除',
            category: '目录',
            run: () => promptRemoveFromFolder(),
          });
          api.commands.register({
            id: 'refs.removeFromWorkspace',
            title: '从本工作区移除',
            category: '目录',
            run: () => promptRemoveFromWorkspace(),
          });
          // ---- r11-E
          api.commands.register({
            id: 'index.showHealth',
            title: '查看索引状态',
            category: '索引',
            run: async () => {
              const h = await kb.getIndexHealth();
              const body = !isContentBodyIndexEnabled()
                ? `本软件只按文件名搜索。
已扫描 ${h.scannedFiles} 个文件${h.reason ? `\n原因：${h.reason}` : ''}`
                : h.engine === 'local-fallback' || !h.contentSearch
                  ? `全文索引不可用 · 仅文件名/路径搜索
原因：${h.reason || '未知'}
已扫描 ${h.scannedFiles} 个文件`
                  : `引擎：${h.engine}
已扫描 ${h.scannedFiles} 个文件 · 正文索引 ${h.contentIndexedFiles} 个`;
              await dialogs.alert({ title: '索引状态', body });
            },
          });
          api.commands.register({
            id: 'index.rebuild',
            title: '重建索引',
            category: '索引',
            run: async () => {
              const r = await kb.indexRebuild();
              await dialogs.alert({ title: '重建索引', body: r.ok ? r.detail || '已触发' : r.detail || '失败' });
            },
          });
          // ---- r11-B 琴键：设置页 + 面板/标签/缩放/读写（覆盖清单）
          if (keyHostRef.current) {
            registerKeybindingCommands((c) => api.commands.register(c), keyHostRef.current);
            registerContentZoomCommands((c) => api.commands.register(c));
            syncContentZoomWheel();
          }
          await loadKeybindings();
          const closeAllKey = closeAllFilesKeybinding(commands.all(), getKeybindingsStore());
          api.commands.register({
            id: CLOSE_ALL_FILES_ID,
            title: CLOSE_ALL_FILES_TITLE,
            category: '标签',
            ...(closeAllKey ? { keybinding: closeAllKey } : {}),
            run: () => closeAllFilesRef.current(),
          });
          await pushBoundToMain();
          api.commands.register({ id: 'appearance.installPack', title: '安装主题包（文件夹）…', category: '外观', run: () => installThemePack() });
          api.commands.register({ id: 'web.siteGrants.open', title: '网页外部资源授权…', category: '网页', run: () => void openWebSiteGrants() });
          api.commands.register({ id: 'app.update.open', title: '更新…', category: '更新', run: () => openSettingsRef.current('update') });
          api.commands.register({ id: 'dirView.toggleDual', title: '双目录视图（开/关）', category: '目录', run: () => dirViewRef.current?.toggleDual() });
          api.commands.register({ id: 'dirView.focusLeft', title: '聚焦左侧目录', category: '目录', run: () => dirViewRef.current?.focus('left') });
          api.commands.register({ id: 'dirView.focusRight', title: '聚焦右侧目录', category: '目录', run: () => dirViewRef.current?.focus('right') });
          api.commands.register({ id: 'dirView.swap', title: '对调左右目录', category: '目录', run: () => dirViewRef.current?.swap() });
          api.commands.register({ id: 'vfolder.new', title: '新建自建目录…', category: '目录', run: () => dirViewRef.current?.newFolder() });
          api.commands.register({ id: 'vfolder.rename', title: '重命名自建目录…', category: '目录', run: () => dirViewRef.current?.renameFolder() });
          api.commands.register({ id: 'vfolder.delete', title: '删除自建目录…', category: '目录', run: () => dirViewRef.current?.deleteFolder() });
          for (const action of paletteSourceActions(SOURCE_ACTIONS)) {
            const id = action.actionId;
            if (!id || commands.get(id)) continue;
            // B2#10：分类露出 sources 包名 + 原中文分组，便于命令面板看到 ActionId 分组
            const cat = action.category
              ? `sources · ${action.category}`
              : (action.source || 'sources');
            api.commands.register({
              id,
              title: action.title || id,
              category: cat,
              run: (args?: unknown) => runSourceCommand(id, dirViewRef.current, args, reload),
            });
          }
          // 插件列表只挂在资料抽屉的 plugin slot，不再经侧栏扩展点画第二份。
          // 内置布局预设（与主题包贡献的预设走同一个扩展点）
          api.themes.registerLayoutPreset({ id: 'builtin.single', label: '单栏', description: '所有标签合并到一栏', grid: { split: 'row', children: [{ slot: 1 }] } });
          api.themes.registerLayoutPreset({ id: 'builtin.two-columns', label: '左右两栏', grid: { split: 'row', children: [{ slot: 1, size: 1 }, { slot: 2, size: 1 }] } });
          api.themes.registerLayoutPreset({ id: 'builtin.two-rows', label: '上下两栏', grid: { split: 'column', children: [{ slot: 1, size: 1 }, { slot: 2, size: 1 }] } });
        },
      };
      const loaded = [...builtinThemePacks(), ...(await kb.listThemePacks())].map((p, i) => themePackEntry(p, i));
      themeReport = loaded.map((l) => ({
        id: l.entry.module.manifest.id,
        source: l.dto.source,
        location: l.dto.location,
        chrome: l.validated.chrome.map((t) => t.id),
        reading: l.validated.reading.map((t) => t.id),
        presets: l.validated.presets.map((t) => t.id),
        errors: l.validated.errors,
        warnings: l.validated.warnings,
      }));
      kb.startupMark('themes-listed');
      await pluginHost.replaceWorkbench(workbench);
      await pluginHost.load([...loaded.map((l) => l.entry), ...CODE_PLUGINS.filter(entry => !pluginHost.get(entry.module.manifest.id))]);
      kb.startupMark('plugins-loaded');
      // 第三方沙箱适配器插件：只登记声明，代码在各面板的沙箱 iframe 里运行
      try {
        pluginHost.loadSandboxed(await kb.listAdapterPlugins());
      } catch (e) {
        console.warn('加载第三方插件列表失败', e);
      }
      try {
        const colorFile = parseCustomColors(await kb.getLayout(CUSTOM_COLORS_KEY));
        if (colorFile) setCustomColorOverlay(effectiveCustomColors(colorFile), { paint: false });
      } catch { /* 库里没有这份设置时保留快照覆盖 */ }
      const applied = applyAppearance(init.appearance);
      setScheme(applied.resolvedScheme);
      init.appearance = mergeAppearance(init.appearance, { chrome: applied.chrome, reading: applied.reading, scheme: applied.scheme });
      setUi(init);
      setBooted(true);
    })();
    reload();
    void refreshWsList();
    const off1 = kb.onIndexStatus(setStatus);
    const offHealth = kb.onIndexHealth?.(setIndexHealth) ?? (() => {});
    // 应用菜单 → 工作台命令（命令注册表中的 run）
    const offMenu = kb.onMenuCommand((id) => void commands.get(id)?.run());
    let t: ReturnType<typeof setTimeout> | undefined;
    const pending: FsChangeEvent[] = [];
    const off2 = kb.onFsChange((raw) => {
      if (Array.isArray(raw)) pending.push(...raw);
      clearTimeout(t);
      t = setTimeout(() => {
        const events = pending.splice(0);
        setFsEvents(events);
        setFsVersion((v) => v + 1);
        const structural = events.length === 0 || events.some((e) => !e.resourceId || e.relPath === '' || e.type === 'addDir' || e.type === 'unlinkDir');
        if (structural) {
          kb.listFavorites().then(setFavorites);
          Promise.all([kb.listRoots(), kb.getLayout(ROOT_ORDER_KEY)]).then(([list, order]) => applyRootList(list, order));
        }
        const ids = new Set(events.map((e) => e.resourceId).filter((id): id is string => typeof id === 'string' && id.length > 0));
        apiRef.current?.panels.forEach((p) => {
          const it = itemsRef.current[(p.params as ItemPanelParams | undefined)?.itemId ?? ''];
          if (it?.sourceKind !== 'file') return;
          if (!structural && !ids.has(it.ref)) return;
          kb.getResource(it.ref).then((r) => r && r.name !== p.title && p.api.setTitle(r.name));
        });
      }, 150);
    });
    // 关闭窗口前写完布局（主进程等待 flush 完成再关闭）
    const off3 = kb.onBeforeQuit(async () => {
      await flush();
    });
    const onUnload = () => void flush();
    window.addEventListener('beforeunload', onUnload);
    return () => {
      off1();
      offHealth();
      offMenu();
      off2();
      off3();
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [reload, applyRootList, setAppearance, refreshWsList, flush]);

  // 动态命令：每个工作区一个“切换到”，每个布局预设一个“应用”，每个外观样式一个“选择”
  const presetsList = useRegistry(layoutPresets, () => layoutPresets.all());
  const chromeList = useRegistry(chromeThemes, () => chromeThemes.all());
  const readingList = useRegistry(readingThemes, () => readingThemes.all());
  const adapterList = useRegistry(adapters, () => adapters.all());
  useEffect(() => {
    const api = wbApiRef.current;
    if (!api || !booted) return;
    const ds: Disposable[] = [];
    const reg = (c: Parameters<PluginApi['commands']['register']>[0]) => {
      if (!commands.get(c.id)) ds.push(api.commands.register(c));
    };
    for (const w of wsList) reg({ id: `workspace.switch.${w.id}`, title: `切换到：${w.name}${w.project ? `（${w.project}）` : ''}`, category: '工作区', run: () => wsActionsRef.current.switchTo(w.id) });
    for (const p of presetsList) reg({ id: `layout.preset.${p.id}`, title: `应用布局预设：${p.label}`, category: '布局', run: () => wsActionsRef.current.applyPreset(p.id) });
    for (const t of chromeList) reg({ id: `appearance.chrome.${t.id}`, title: `外框样式：${t.label}`, category: '外观', run: () => uiRef.current && setAppearance({ ...uiRef.current.appearance, chrome: t.id }) });
    // 每个网页适配器一个“打开网页面板…”（地址预填适配器首页，只能填允许域名内的 https 地址）
    for (const a of adapterList) {
      if (!a.sandbox || !a.sourceKinds.includes('web')) continue;
      const decl = a.sandbox.decl;
      reg({
        id: `web.open.${a.id}`,
        title: `打开网页面板：${a.title}…`,
        category: '网页',
        run: async () => {
          const r = await dialogs.prompt({ title: `打开网页面板：${a.title}`, body: `只允许 ${navDomains(decl).join('、')} 的 https 地址。`, fields: [{ name: 'url', label: '地址', value: decl.web?.homeUrl ?? 'https://' }], ok: '打开' });
          if (!r) return;
          try {
            await openWebRef.current(a.id, r.url.trim());
          } catch (e) {
            await dialogs.alert({ title: '无法打开', body: String((e as Error).message) });
          }
        },
      });
    }
    // 每个外部程序适配器一个“新建外部程序项目…”（P3，第 9 轮接线）
    for (const a of adapterList) {
      if (!a.sandbox || !a.sourceKinds.includes('app')) continue;
      reg({ id: `app.new.${a.id}`, title: `新建外部程序项目：${a.title}…`, category: '外部程序', run: () => void newAppItemRef.current(a.id) });
    }
    for (const t of readingList) reg({ id: `appearance.reading.${t.id}`, title: `阅读区样式：${t.label}`, category: '外观', run: () => uiRef.current && setAppearance({ ...uiRef.current.appearance, reading: t.id }) });
    return () => ds.forEach((d) => d.dispose());
  }, [wsList, presetsList, chromeList, readingList, adapterList, booted, setAppearance]);

  // 跟随系统明暗
  useEffect(() => {
    if (ui?.appearance.scheme !== 'system') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => uiRef.current && setAppearance(uiRef.current.appearance);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [ui?.appearance.scheme, setAppearance]);

  // 快捷键 → 命令（overrides + when + 输入框优先级）
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      handleKeydown(e);
    };
    window.addEventListener('keydown', on);
    const offFwd = kb.onForwardedShortcut?.((accel) => {
      runByAccelerator(accel);
    });
    return () => {
      window.removeEventListener('keydown', on);
      offFwd?.();
    };
  }, []);

  // 加载快捷键覆盖；打开设置页
  const [kbPage, setKbPage] = useState(false);
  useEffect(() => {
    registerOpenKeybindingsPage(() => setKbPage(true));
    let cancelled = false;
    const bind = (allowShortcut: boolean) => {
      if (cancelled) return;
      const decision = allowShortcut ? settingsShortcutDecision(getKeybindingsStore(), commands.all()) : null;
      const keybinding = decision?.keybinding;
      const existing = commands.get(SETTINGS_COMMAND_ID);
      if (existing) {
        if (!allowShortcut || existing.keybinding === keybinding) return;
        settingsCommandDisposable?.dispose();
        settingsCommandDisposable = null;
      }
      if (commands.get(SETTINGS_COMMAND_ID)) return;
      settingsCommandDisposable = commands.register('builtin.workbench', {
        id: SETTINGS_COMMAND_ID,
        title: '设置',
        category: '设置',
        ...(keybinding ? { keybinding } : {}),
        run: () => openSettingsRef.current(),
      });
    };
    void loadKeybindings().finally(() => {
      if (booted) bind(true);
    });
    const timer = window.setTimeout(() => {
      void loadKeybindings().finally(() => bind(false));
    }, 8000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [booted]);
  const reconfigureQuickSwitch = useCallback(() => {
    setFocusCommandId(QUICK_SWITCH_COMMAND_ID);
    setKbPage(true);
  }, []);


  const open = useCallback(
    async (resourceId: string, title: string, mode: OpenMode = 'tab', adapterId?: string) => {
      const api = apiRef.current;
      if (!api) return;
      const res = await kb.getResource(resourceId);
      // r11-A：web resourceId（工作资料 / 搜索结果）按网址打开
      if (!res || res.rootId === '') {
        if (await openWebResource(resourceId, mode)) return;
        if (!res) return;
      }
      const aid = adapterId ?? adapters.best({ sourceKind: 'file', resource: res })?.id ?? 'builtin.unsupported';
      if (aid === 'builtin.unsupported') showToastRef.current('暂无阅读器');
      const existing = Object.values(itemsRef.current).find((i) => i.sourceKind === 'file' && i.ref === resourceId && i.adapterId === aid && api.getPanel(i.itemId));
      const ep = existing && api.getPanel(existing.itemId);
      if (ep && mode === 'tab') return ep.api.setActive();
      if (ep) return ep.api.moveTo({ group: ep.group, position: mode === 'below' ? 'bottom' : 'right' } as any);
      const item = makeFileItem(resourceId, aid);
      itemsRef.current[item.itemId] = item;
      const active = api.activePanel;
      api.addPanel({
        id: item.itemId,
        component: VIEW_HOST_COMPONENT,
        title,
        params: { itemId: item.itemId },
        position: mode !== 'tab' && active ? { referencePanel: active.id, direction: mode === 'below' ? 'below' : 'right' } : undefined,
      });
    },
    [],
  );
  const openRef = useRef(open);
  openRef.current = open;
  const switchToRef = useRef(switchTo);
  switchToRef.current = switchTo;
  const restorePorts = useMemo(() => ({
    onArmed: (_panelId: string, cb: (armed: boolean) => void) => {
      cb(true);
      return () => {};
    },
    getResource: (panelId: string) => {
      delete resolvedRestoreRef.current[panelId];
      return fileFactsForItem(itemsRef.current[panelId], (resourceId) => {
        resolvedRestoreRef.current[panelId] = resourceId;
      });
    },
    onContentReady: (panelId: string, cb: () => void) => subscribeRestoreContentReady(panelId, cb),
    openPanel: (panelId: string) => {
      if (panelManager.isCollapsed(panelId)) panelManager.restoreFromBubble(panelId);
      const existing = apiRef.current?.getPanel(panelId);
      if (existing) {
        existing.api.setActive();
        return;
      }
      const item = itemsRef.current[panelId];
      const resourceId = resolvedRestoreRef.current[panelId] || (item?.sourceKind === 'file' ? item.ref : '');
      if (!resourceId) return;
      void kb.getResource(resourceId).then((res) => {
        if (res?.exists) void openRef.current(resourceId, res.name);
      }).catch(() => undefined);
    },
    locateFile: (panelId: string) => {
      const item = itemsRef.current[panelId];
      if (item?.sourceKind !== 'file') return;
      void kb.showInFolder(item.ref).catch((err: unknown) => showToastRef.current(String((err as Error)?.message ?? err)));
    },
    remapFile: () => {
      void kb.openMigration('repair');
    },
    switchWorkspace: (id: string) => {
      void switchToRef.current(id);
    },
  }), []);

  // ---- r11-G 文件 Agent 桥。F2 未合入：用现有 open 的同一套面板（getResource → makeFileItem → addPanel）。
  // split-left / split-up / float 走 dockview 已有方向和 panelManager.float，不另写打开协议。
  useEffect(() => {
    const offOpen = kb.onAgentBridgeOpen((raw) => {
      const payload = raw && typeof raw === 'object' ? (raw as { resourceId?: string; openAs?: string }) : {};
      const resourceId = payload.resourceId;
      if (!resourceId) return;
      const openAs = payload.openAs ?? 'tab';
      if (openAs === 'reveal-only') {
        void kb.showInFolder(resourceId);
        return;
      }
      if (openAs === 'tab' || openAs === 'split-right' || openAs === 'split-down') {
        void open(resourceId, '', openAs === 'split-down' ? 'below' : openAs === 'split-right' ? 'right' : 'tab');
        return;
      }
      void (async () => {
        const api = apiRef.current;
        if (!api) return;
        const res = await kb.getResource(resourceId);
        if (!res) return;
        const aid = adapters.best({ sourceKind: 'file', resource: res })?.id ?? 'builtin.unsupported';
        const existing = Object.values(itemsRef.current).find((i) => i.sourceKind === 'file' && i.ref === resourceId && i.adapterId === aid && api.getPanel(i.itemId));
        if (openAs === 'float' && existing) {
          panelManager.float(existing.itemId);
          api.getPanel(existing.itemId)?.api.setActive();
          return;
        }
        const place = openAs === 'split-left' ? 'left' : openAs === 'split-up' ? 'above' : undefined;
        if (existing && place) {
          const ep = api.getPanel(existing.itemId);
          if (ep) ep.api.moveTo({ group: ep.group, position: place === 'above' ? 'top' : 'left' } as never);
          return;
        }
        const item = makeFileItem(resourceId, aid);
        itemsRef.current[item.itemId] = item;
        const active = api.activePanel;
        api.addPanel({
          id: item.itemId,
          component: VIEW_HOST_COMPONENT,
          title: res.name,
          params: { itemId: item.itemId },
          position: place && active ? { referencePanel: active.id, direction: place } : undefined,
        });
        if (openAs === 'float') panelManager.float(item.itemId);
      })();
    });
    const offInvoke = kb.onAgentBridgeInvoke((payload) => {
      const id = payload?.actionId || payload?.commandId;
      if (id === 'workbench.pendingPlans') void commands.get('workbench.pendingPlans')?.run();
      if (id === 'index.showHealth') void kb.getIndexStatus().then(setStatus);
    });
    return () => {
      offOpen();
      offInvoke();
    };
  }, [open]);
  useEffect(() => {
    const raw = sessionStorage.getItem('kb:sidebar-open');
    if (!raw) return;
    // Wait for dockview readiness; only consume after the host can open the resource.
    const timer = setInterval(() => {
      if (!apiRef.current || loadingRef.current) return;
      clearInterval(timer); sessionStorage.removeItem('kb:sidebar-open');
      try { const item = JSON.parse(raw); if(item.action==='plugins')openPluginManagerRef.current?.();else if(item.item) webBridge.get()?.openItem(item.item,item.title); else void open(item.rid, item.title); } catch { /* invalid pending request */ }
    }, 50);
    return () => clearInterval(timer);
  }, [open]);

  /** 同一文件再开一个面板（新的 itemId），不复用已经打开的那份。 */
  const openCopy = useCallback(async (resourceId: string, title?: string) => {
    const api = apiRef.current;
    if (!api) return;
    const res = await kb.getResource(resourceId);
    if (!res) return;
    const aid = adapters.best({ sourceKind: 'file', resource: res })?.id ?? 'builtin.unsupported';
    if (aid === 'builtin.unsupported') showToastRef.current('暂无阅读器');
    const item = makeFileItem(resourceId, aid);
    itemsRef.current[item.itemId] = item;
    const activePanel = api.activePanel;
    api.addPanel({
      id: item.itemId,
      component: VIEW_HOST_COMPONENT,
      title: title || res.name,
      params: { itemId: item.itemId },
      position: activePanel ? { referencePanel: activePanel.id, direction: 'right' } : undefined,
    });
    return item.itemId;
  }, []);

  useEffect(() => {
    setDndHost({
      workspaceId: () => wsIdRef.current,
      isDirty: (rid) => editorStatus.isDirty(rid),
      reload,
      openReadonly: async (filePath) => {
        if (typeof (kb as unknown as { openPath?: (p: string) => Promise<unknown> }).openPath === 'function') {
          await (kb as unknown as { openPath: (p: string) => Promise<unknown> }).openPath(filePath);
        }
      },
      closePanels: async (rid) => {
        const api = apiRef.current;
        if (!api) return;
        for (const p of [...api.panels]) {
          const it = itemsRef.current[(p.params as ItemPanelParams | undefined)?.itemId ?? ''];
          if (it?.sourceKind === 'file' && it.ref === rid) p.api.close();
        }
      },
      open: async (rid, place) => {
        const title = (await kb.getResource(rid))?.name ?? '';
        if (place === 'right') return open(rid, title, 'right');
        if (place === 'down') return open(rid, title, 'below');
        await open(rid, title, 'tab');
        const api = apiRef.current;
        if (!api || place === 'tab') return;
        const item = Object.values(itemsRef.current).find((i) => i.sourceKind === 'file' && i.ref === rid && api.getPanel(i.itemId));
        if (!item) return;
        if (place === 'float') {
          panelManager.float(item.itemId);
          return;
        }
        const direction = place === 'left' ? 'left' : place === 'up' ? 'above' : place === 'down' ? 'below' : 'right';
        panelManager.dock(item.itemId, { direction });
      },
    });
    return () => setDndHost(null);
  }, [open, reload]);

  /** 新建网页条目（H9）：地址必须在适配器 net 域名内；ref 去掉 query。renderer 'always'：切换标签不重建网页视图 */
  const openWeb = useCallback(async (adapterId: string, url?: string, mode: OpenMode = 'right') => {
    const api = apiRef.current;
    const a = adapters.get(adapterId);
    const decl = a?.sandbox?.decl;
    if (!api || !decl || !decl.sourceKinds.includes('web')) throw new Error(`没有可用的网页适配器 ${adapterId}`);
    let target = url ?? decl.web?.homeUrl ?? '';
    if (perSiteDecl(decl)) {
      // r11-A：逐站授权适配器（web.generic）接受任意 http(s) 网址，首次访问在面板内询问
      const s = sanitizeWebRef(target);
      if (!s.ok) throw new Error(s.reason);
      target = s.url;
    } else {
      const chk = checkNavigation(target, navDomains(decl));
      if (!chk.ok) throw new Error(`地址不在允许的域名内（只允许 ${navDomains(decl).join('、')}）`);
    }
    const item = makeWebItem(target, adapterId);
    itemsRef.current[item.itemId] = item;
    const active = api.activePanel;
    api.addPanel({
      id: item.itemId,
      component: VIEW_HOST_COMPONENT,
      title: decl.title,
      params: { itemId: item.itemId },
      renderer: 'always',
      position: mode !== 'tab' && active ? { referencePanel: active.id, direction: mode === 'below' ? 'below' : 'right' } : undefined,
    });
    return item.itemId;
  }, []);
  const openWebRef = useRef(openWeb);
  openWebRef.current = openWeb;

  // ---- r11-A 网络资料：给 web-resources 的打开条目桥（同 ref + 适配器已有面板则激活）
  useEffect(
    () =>
      webBridge.attach({
        openItem: (it, title, mode = 'tab') => {
          const api = apiRef.current;
          if (!api) throw new Error('工作台尚未就绪');
          const existing = Object.values(itemsRef.current).find((i) => i.sourceKind === it.sourceKind && i.ref === it.ref && i.adapterId === it.adapterId && api.getPanel(i.itemId));
          const ep = existing && api.getPanel(existing.itemId);
          if (ep && mode === 'tab') return ep.api.setActive();
          if (ep) return ep.api.moveTo({ group: ep.group, position: mode === 'below' ? 'bottom' : 'right' } as any);
          itemsRef.current[it.itemId] = it;
          const active = api.activePanel;
          api.addPanel({ id: it.itemId, component: VIEW_HOST_COMPONENT, title, params: { itemId: it.itemId }, ...(it.sourceKind === 'web' ? { renderer: 'always' as const } : {}), position: mode !== 'tab' && active ? { referencePanel: active.id, direction: mode === 'below' ? 'below' : 'right' } : undefined });
        },
        currentWorkspaceId: () => wsIdRef.current || null,
        refsChanged: (r) => setWsRefs(r),
        activeItem: () => {
          const p = apiRef.current?.activePanel;
          return (p && itemsRef.current[(p.params as ItemPanelParams | undefined)?.itemId ?? '']) || null;
        },
      }),
    [],
  );

  /**
   * 新建外部程序项目（H11 应用档案）：用户在对话框里选声明过的启动方式与文件（候选 = 当前工作区打开的文件、工作资料、收藏），
   * 主进程校验后保存应用档案（layout 表 app.profile:<id>），条目 ref = 档案 id。不会自动启动程序。
   */
  const newAppItem = useCallback(async (adapterId: string, presetResourceId?: string) => {
    const api = apiRef.current;
    const a = adapters.get(adapterId);
    const decl = a?.sandbox?.decl;
    const perm = decl?.permissions.find((x) => x.kind === 'process.launch');
    if (!api || !decl || !perm || perm.kind !== 'process.launch') return null;
    const rids = new Set<string>();
    if (presetResourceId) rids.add(presetResourceId);
    const activeItem = api.activePanel ? itemsRef.current[api.activePanel.id] : undefined;
    if (activeItem?.sourceKind === 'file') rids.add(activeItem.ref);
    for (const it of Object.values(itemsRef.current)) if (it.sourceKind === 'file') rids.add(it.ref);
    for (const r of wsRefsRef.current) if (!r.missing && r.kind === 'file') rids.add(r.resourceId);
    for (const f of favoritesRef.current) rids.add(f.resourceId);
    const opts: AppResourceOption[] = [];
    for (const rid of rids) {
      const r = await kb.getResource(rid).catch(() => null);
      if (r && r.exists && r.kind === 'file') opts.push({ resourceId: r.resourceId, label: r.relPath || r.name, ext: r.ext });
    }
    const choice = await appProfileDialog(decl.title, perm, opts, presetResourceId ?? (activeItem?.sourceKind === 'file' ? activeItem.ref : undefined));
    if (!choice) return null;
    let profile;
    try {
      profile = await kb.appProfileCreate({ adapterId, programId: choice.programId, label: choice.label, launch: choice.launch });
    } catch (e) {
      await dialogs.alert({ title: '无法新建外部程序项目', body: String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') });
      return null;
    }
    const item: WorkspaceItem = { itemId: newItemId(), sourceKind: 'app', adapterId, ref: profile.appProfileId, displayMode: 'external-managed', title: profile.label };
    itemsRef.current[item.itemId] = item;
    const active = api.activePanel;
    api.addPanel({ id: item.itemId, component: VIEW_HOST_COMPONENT, title: profile.label, params: { itemId: item.itemId }, position: active ? { referencePanel: active.id, direction: 'right' } : undefined });
    return item.itemId;
  }, []);
  const newAppItemRef = useRef(newAppItem);
  newAppItemRef.current = newAppItem;


  // host-r1-plugin: createHostPanel opener (native-app-host blank panel) — L2 merge
  useEffect(() => {
    setNativeAppHostOpener(() => {
      const api = apiRef.current;
      if (!api) return null;
      for (const it of Object.values(itemsRef.current)) {
        if (it.sourceKind === 'app' && it.adapterId === NATIVE_APP_HOST_ADAPTER_ID && it.ref === NATIVE_APP_HOST_REF) {
          const panel = api.getPanel(it.itemId);
          if (panel) {
            panel.focus();
            setActiveNativeAppHostItemId(it.itemId);
            return it.itemId;
          }
        }
      }
      const item: WorkspaceItem = {
        itemId: newItemId(),
        sourceKind: 'app',
        adapterId: NATIVE_APP_HOST_ADAPTER_ID,
        ref: NATIVE_APP_HOST_REF,
        displayMode: 'external-managed',
        title: '原生应用托管',
      };
      itemsRef.current[item.itemId] = item;
      const active = api.activePanel;
      api.addPanel({
        id: item.itemId,
        component: VIEW_HOST_COMPONENT,
        title: '原生应用托管',
        params: { itemId: item.itemId },
        position: active ? { referencePanel: active.id, direction: 'right' } : undefined,
      });
      setActiveNativeAppHostItemId(item.itemId);
      return item.itemId;
    });
    return () => setNativeAppHostOpener(() => null);
  }, []);


  const favIds = useMemo(() => new Set(favorites.map((f) => f.resourceId)), [favorites]);
  const toggleFav = useCallback(
    async (rid: string) => {
      const f = favorites.find((x) => x.resourceId === rid);
      if (f) await kb.removeFavorite(f.id);
      else await kb.addFavorite(rid);
      setFavorites(await kb.listFavorites());
    },
    [favorites],
  );
  // ---- 工作资料（集合）
  useEffect(() => {
    if (!wsId) return;
    let alive = true;
    kb.listWorkspaceRefs(wsId).then((r) => alive && setWsRefs(r), () => alive && setWsRefs([]));
    return () => {
      alive = false;
    };
  }, [wsId, fsVersion]);
  const refIds = useMemo(() => new Set(wsRefs.map((r) => r.resourceId)), [wsRefs]);
  const toggleRef = useCallback(
    async (rid: string) => {
      const id = wsIdRef.current;
      if (!id) return;
      try {
        setWsRefs(refIds.has(rid) ? await kb.removeWorkspaceRef(id, rid) : await kb.addWorkspaceRefs(id, [rid]));
        void refreshWsList();
      } catch (e) {
        showToast(String((e as Error).message ?? e).replace(/^Error invoking remote method 'kb': (Error: )?/, ''));
      }
    },
    [refIds, refreshWsList, showToast],
  );
  const removeRef = useCallback(
    async (r: WorkspaceRef) => {
      const others = (await kb.workspacesReferencing(r.resourceId)).filter((w) => w.id !== wsIdRef.current);
      // 产品决定：移除资料时关闭它已打开的标签；有未保存内容时先确认
      const api = apiRef.current;
      const tabs = api ? api.panels.filter((p) => { const it = itemsRef.current[(p.params as ItemPanelParams | undefined)?.itemId ?? '']; return r.sourceKind === 'web' ? it?.sourceKind === 'web' && it.ref === r.url : it?.sourceKind === 'file' && it.ref === r.resourceId; }) : [];
      const dirty = editorStatus.isDirty(r.resourceId);
      const ok = await dialogs.confirm({
        title: `从本工作区移除「${r.name || r.relPath}」？`,
        body: `${r.sourceKind === 'web' ? `只从当前工作区移除引用。网址「${r.url ?? ''}」仍保留在侧栏“网络资料”中。` : `只从当前工作区移除。原文件保持在「${r.rootName}/${r.relPath}」，不会被删除或移动。`}全局自建目录和其他工作区的引用都保留。${tabs.length ? `\n本工作区已打开的 ${tabs.length} 个面板会关闭。` : ''}${others.length ? `\n其他工作区仍引用它：${others.map((w) => w.name).join('、')}。` : ''}`,
        ok: '从本工作区移除',
      });
      if (!ok) return;
      if (dirty) {
        const go = await dialogs.confirm({
          title: '有未保存的修改',
          body: `「${r.name || r.relPath}」有还没保存的修改。关闭标签后修改会保留为草稿（下次打开这个文件时恢复），但不会写入文件。仍然移除并关闭标签？`,
          ok: '从本工作区移除并关闭',
          cancel: '先不移除',
          danger: true,
        });
        if (!go) return;
      }
      setWsRefs(await kb.removeWorkspaceRef(wsIdRef.current, r.resourceId));
      for (const p of tabs) p.api.close();
      void refreshWsList();
    },
    [refreshWsList],
  );
  const openAllRefs = useCallback(async () => {
    const list = wsRefs.filter((r) => !r.missing);
    for (const r of list) await open(r.resourceId, r.name);
    if (list.length < wsRefs.length) showToast(`${wsRefs.length - list.length} 项资料的原文件不在原处，未打开`);
  }, [wsRefs, open, showToast]);

  const expanded = useMemo(() => new Set(ui?.expanded ?? []), [ui?.expanded]);
  const setExpanded = useCallback((id: string, on: boolean) => {
    setUi((u) => {
      if (!u) return u;
      const s = new Set(u.expanded);
      if (on) s.add(id);
      else s.delete(id);
      const next = { ...u, expanded: [...s] };
      void kb.setLayout('ui', next);
      return next;
    });
  }, []);
  const setDirView = useCallback((fn: (d: DirViewState) => DirViewState) => {
    setUi((u) => {
      if (!u) return u;
      const next = { ...u, dirView: fn(normalizeDirView(u.dirView)) };
      void kb.setLayout('ui', next);
      return next;
    });
  }, []);

  // 控制台打开接在现有面板服务上。App 只挂载，不改 open() 的去重。
  useEffect(() => {
    const opener = createConsoleOpener({
      getDock: () => (apiRef.current as ConsoleDock | null),
      items: itemsRef,
      panelManager,
      kb,
      adapters,
      expand: (id) => setExpanded(id, true),
      reveal: (relPath) => {
        const row = document.querySelector(`[data-testid="tree-row"][data-relpath="${CSS.escape(relPath)}"]`);
        if (row instanceof HTMLElement) row.scrollIntoView({ block: 'nearest' });
      },
    });
    return setConsoleOpener({
      openItem: (item) => opener.openItem(item),
      openGroup: async (index) => {
        const result = await opener.openGroup(index);
        showToast(formatOpenGroupResult(result));
        return result;
      },
    });
  }, [setExpanded, showToast]);

  // GrabFrame close: desktop panel command entry (open / pickSource)
  useEffect(() => {
    const openDesktopPanel = () => {
      const api = apiRef.current;
      if (!api) {
        showToast('工作台未就绪');
        return;
      }
      const existing = api.getPanel(DESKTOP_PANEL_DOCK_ID);
      if (existing) {
        existing.api.setActive();
        return;
      }
      const active = api.activePanel;
      api.addPanel({
        id: DESKTOP_PANEL_DOCK_ID,
        component: DESKTOP_PANEL_COMPONENT,
        title: '桌面面板',
        position: active ? { referencePanel: active.id, direction: 'right' } : undefined,
      });
    };
    return setDesktopPanelOpener({
      open: openDesktopPanel,
      pickSource: () => {
        openDesktopPanel();
        showToast('请在桌面面板左侧选择捕获源');
      },
    });
  }, [showToast]);


  useEffect(() => {
    setRebirthOpener((req) => {
      const api = apiRef.current;
      if (!api) return false;
      const id = 'agent-panel:rebirth:' + req.id;
      const existing = api.getPanel(id);
      if (existing) { existing.api.setActive(); return true; }
      const active = api.activePanel;
      api.addPanel({ id, component: 'rebirth', title: req.title, params: req,
        position: active ? { referencePanel: active.id, direction: active.id === SIDEBAR_ID ? 'right' : 'within' } : undefined });
      return true;
    });
    return () => setRebirthOpener(null);
  }, []);

  useEffect(() => {
    if (!booted) return;
    let cancelled = false;
    const disposables: Disposable[] = [];
    void (async () => {
      await loadKeybindings();
      if (cancelled) return;
      const api = wbApiRef.current;
      if (!api) return;
      const decision = decideLiveQuickSwitchKey();
      if (cancelled) return;
      setQuickConflict(decision.report);
      bindWorkspacePickerCommands(
        (command) => {
          if (commands.get(command.id)) return;
          disposables.push(api.commands.register(command));
        },
        decision,
        {
          openOverview: () => openOverviewRef.current(),
          quickSwitch: () => openQuickSwitchRef.current(),
        },
      );
    })();
    return () => {
      cancelled = true;
      for (const d of disposables) d.dispose();
    };
  }, [booted]);

  useEffect(() => {
    if (!booted) return;
    let cancelled = false;
    const disposables: Disposable[] = [];
    void (async () => {
      await loadKeybindings();
      if (cancelled) return;
      const api = wbApiRef.current;
      if (!api) return;
      const decision = decideAddCurrentBinding(commands.all(), getKeybindingsStore(), { hostedForeground: liveHost.hostedForeground() });
      disposables.push(...registerAgentLiveCommands((command) => api.commands.register(command), decision.keybinding));
    })();
    return () => {
      cancelled = true;
      for (const d of disposables) d.dispose();
    };
  }, [booted]);

  const onReady = useCallback(
    async (e: DockviewReadyEvent) => {
      apiRef.current = e.api;
      setExternalBrowseDock(() => apiRef.current);
      (window as any).__dock = e.api; // 便于 E2E 检查
      panelManager.attach(e.api);
      e.api.onDidLayoutChange(requestSave);
      const syncOpen = () => setOpenRids(new Set(e.api.panels.map((p) => itemsRef.current[(p.params as ItemPanelParams | undefined)?.itemId ?? '']).filter((i) => i?.sourceKind === 'file').map((i) => i!.ref)));
      e.api.onDidAddPanel(syncOpen);
      e.api.onDidRemovePanel(syncOpen);
      // 标签拖动中：data-dragging（主题接口 v2 的 dragging 状态）
      const dock = document.querySelector('[data-testid="dock"]');
      dock?.addEventListener('dragstart', (ev) => (ev.target as HTMLElement | null)?.closest?.('.dv-tab')?.setAttribute('data-dragging', 'true'));
      dock?.addEventListener('dragend', () => dock.querySelectorAll('.dv-tab[data-dragging]').forEach((t) => t.removeAttribute('data-dragging')));
      const onTabCtx = (ev: Event) => {
        const tab = (ev.target as HTMLElement | null)?.closest?.('.dv-tab');
        if (!tab) return;
        ev.preventDefault();
        openSetKeybindingFor('panel-tab');
      };
      dock?.addEventListener('contextmenu', onTabCtx);
      e.api.onDidActivePanelChange(({ panel: p }) => {
        const it = p ? itemsRef.current[(p.params as ItemPanelParams | undefined)?.itemId ?? ''] : undefined;
        setActiveRid(it?.sourceKind === 'file' ? it.ref : null);
      });
      // 先用本地快照把布局画出来，再标记可交互。后面的列表和 getWorkspace 都在这之后。
      const snap = readLayoutSnapshot();
      if (snap) await loadWorkspace(snapshotToWorkspace(snap), { paintOnly: true });
      const interactive = shellInteractiveMark('shell');
      const win = window as Window & { __kbShellInteractive?: boolean };
      if (interactive && !win.__kbShellInteractive) {
        win.__kbShellInteractive = true;
        requestAnimationFrame(() => requestAnimationFrame(() => kb.startupMark(interactive)));
      }
      const listed = await kb.listWorkspaces();
      setWsList(listed);
      let rawPicker: unknown = null;
      try {
        rawPicker = await kb.getLayout(WORKSPACE_PICKER_SETTINGS_KEY);
      } catch {
        rawPicker = null;
      }
      const settings = readWorkspacePickerSettings(rawPicker);
      setPickerSettings(settings);
      let rawBoards: unknown = null;
      try {
        rawBoards = await kb.getLayout(OVERVIEW_BOARDS_KEY);
      } catch {
        rawBoards = null;
      }
      setOverviewBoards(parseOverviewBoards(rawBoards));
      if (listed.length === 0) {
        setOverviewHidden(false);
        // startup-ready-race: overview-only start has no panels to wait for; close the visible-content gate
        // instead of leaving it open until the main blank-window watchdog fires a false timeout.
        visibleContent.begin([]);
        return;
      }
      const savedIds = listed.map((row) => row.id);
      const lastId = startupReadsCurrentId(savedIds, settings) ? await kb.getCurrentWorkspaceId() : null;
      const plan = planStartup({ settings, savedWorkspaceIds: savedIds, lastWorkspaceId: lastId });
      setOverviewHidden(!plan.openOverview);
      if (plan.openOverview) {
        void hydrateOverviewSnapshots(savedIds);
      }
      if (plan.loadWorkspaceId) {
        await loadWorkspace(await kb.getWorkspace(plan.loadWorkspaceId));
        void refreshWsList();
      } else {
        visibleContent.begin([]);
      }
    },
    [requestSave, loadWorkspace, refreshWsList],
  );

  panelManager.setHost({
    persist: requestSave,
    sidebarWidth: () => shellRef.current.sidebarWidth,
    setSidebarWidth: (w) => {
      const v = Math.max(180, Math.min(600, Math.round(w)));
      shellRef.current = { ...shellRef.current, sidebarWidth: v };
      setSidebarWidth(v);
    },
    panelMeta: (id) => {
      if (id === SIDEBAR_ID) return { title: '侧栏', kind: 'sidebar' as const };
      const panel = apiRef.current?.getPanel(id);
      const params = panel?.params as { itemId?: string; viewType?: string } | undefined;
      const itemId = params?.itemId ?? id;
      const item = itemsRef.current[itemId];
      const kind =
        item?.sourceKind === 'file' || item?.sourceKind === 'web' || item?.sourceKind === 'app'
          ? item.sourceKind
          : params?.viewType === 'native-app-host'
            ? ('native-host' as const)
            : undefined;
      const title = [panel?.title, item?.title].find((t) => typeof t === 'string' && t.trim() !== '' && t.trim() !== 'unknown');
      return { title: typeof title === 'string' ? title.trim() : undefined, kind };
    },
    ensurePanel: (id, info) => {
      const api = apiRef.current;
      if (!api || api.getPanel(id) || id === SIDEBAR_ID) return;
      const item = itemsRef.current[id];
      if (!item) return;
      const stored = info.title && info.title !== 'unknown' ? info.title : '';
      const title = stored || item.title || item.ref;
      api.addPanel({
        id: item.itemId,
        component: VIEW_HOST_COMPONENT,
        title,
        params: { itemId: item.itemId },
        ...(item.sourceKind === 'web' ? { renderer: 'always' as const } : {}),
      });
    },
  });

  const onDrawerWidth = useCallback((width: number) => {
    const v = clampDrawerWidth(width);
    shellRef.current = { ...shellRef.current, sidebarWidth: v };
    setSidebarWidth(v);
    requestSave();
  }, [requestSave]);
  const onDrawerSelection = useCallback((next: DrawerModuleId[]) => {
    const prev = drawerSelection;
    const normalized = normalizeDrawerSelection(next);
    drawerTouchedRef.current = true;
    setDrawerSelection(normalized);
    void kb.setLayout(DRAWER_MODULES_KEY, normalized).catch(() => setDrawerSelection(prev));
  }, [drawerSelection]);

  // 自动化接口（E2E 与 theme:shots 使用；只调用公开的应用行为）
  useEffect(() => {
    (window as any).__kb = {
      open: (rid: string, mode?: OpenMode) => open(rid, '', mode),
      openCopy: (rid: string, title?: string) => openCopy(rid, title),
      // host-r1 L2: forward args + return value; unregistered -> explicit error object (was undefined)
      runCommand: (id: string, ...args: unknown[]) => runCommandCompat(commands, id, ...args),
      runCommandResult: (id: string, ...args: unknown[]) => runCommandResult(commands, id, ...args),
      openWeb: (adapterId: string, url?: string, mode?: OpenMode) => openWeb(adapterId, url, mode),
      // r11-A 网络资料（E2E）
      openUrl: (url: string, mode?: OpenMode) => openUrl(url, mode).then((w) => w?.resourceId ?? null),
      lastCopied: () => lastCopied.value,
      lastSaved: () => lastSaved.value,
      newAppItem: (adapterId: string, rid?: string) => newAppItem(adapterId, rid),
      webSurfaceStats: () => ({ ...webSurfaceStats }),
      pm: panelManager,
      /** 测试用：不经校验加入一个条目（模拟导入的/旧版本留下的条目，例如域名已不在允许范围内的网页条目） */
      openItemRaw: (it: WorkspaceItem, mode: OpenMode = 'tab') => {
        const api = apiRef.current;
        if (!api) return;
        itemsRef.current[it.itemId] = it;
        const active = api.activePanel;
        api.addPanel({ id: it.itemId, component: VIEW_HOST_COMPONENT, title: it.title ?? it.ref, params: { itemId: it.itemId }, ...(it.sourceKind === 'web' ? { renderer: 'always' as const } : {}), position: mode !== 'tab' && active ? { referencePanel: active.id, direction: mode === 'below' ? 'below' : 'right' } : undefined });
      },
      openByPath: async (rootId: string, rel: string, mode?: OpenMode) => {
        const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
        const e = (await kb.listDir(rootId, dir)).find((x) => x.relPath === rel);
        if (e) await open(e.resourceId, e.name, mode);
        return e?.resourceId ?? null;
      },
      flush,
      switchTo: (id: string) => switchTo(id),
      items: () => JSON.parse(JSON.stringify(itemsRef.current)),
      currentWorkspaceId: () => wsIdRef.current,
      lazyState: () => ({ mounted: [...mountedViews], pending: backgroundLoader.pendingIds(), loaded: [...backgroundLoader.loaded], deferredEver: [...backgroundLoader.deferredEver], visible: visibleContent.state(), delayMs: backgroundLoader.delayMs }),
      openRids: () => [...new Set(Object.values(itemsRef.current).filter((i) => i.sourceKind === 'file' && apiRef.current?.getPanel(i.itemId)).map((i) => i.ref))],
      setAppearance: (a: Appearance) => setAppearance(a),
      appearance: () => uiRef.current?.appearance,
      themeReport: () => JSON.parse(JSON.stringify(themeReport)),
      pluginStatus: () => pluginHost.list().map((r) => ({ id: r.manifest?.id, status: r.status, kind: r.kind, message: r.message })),
      openPluginManager: (focus?: string) => setManager({ focus }),
      openOpLog: () => setOpLog(true),
      openKeybindings: (focus?: string) => {
        if (focus) setFocusCommandId(focus);
        setKbPage(true);
      },
      openWebSiteGrants: () => openWebSiteGrants(),
      watchdogStats: () => watchdogStats,
      grants: (pluginId: string) => JSON.parse(JSON.stringify(pluginHost.grantsOf(pluginId))),
      showStatesSheet: async (on: boolean) => {
        if (on) {
          await flush();
          loadingRef.current = true;
        }
        setSheet(on);
      },
    };
  }, [open, openCopy, openWeb, flush, switchTo, setAppearance]);

  /** 卸载第三方插件（H7）：先写完当前工作区，再按用户选择处理数据与条目 */
  const uninstall = useCallback(
    async (d: AdapterPluginDto) => {
      try {
        await flush();
        const info = await kb.adapterUninstallInfo(d.id);
        const opts = await uninstallDialog(d.name, info);
        if (!opts) return;
        await flush();
        const r = await kb.uninstallAdapterPlugin(d.id, opts);
        await pluginHost.reloadSandboxed();
        if (opts.removeItems && r.removedItems > 0 && wsIdRef.current) await loadWorkspace(await kb.getWorkspace(wsIdRef.current));
        showToast(`已卸载「${d.name}」${opts.keepData ? '（数据已保留）' : '（数据已删除）'}${opts.removeItems ? `，移除了 ${r.removedItems} 个条目` : ''}`);
      } catch (e) {
        await dialogs.alert({ title: '卸载失败', body: String((e as Error).message ?? e) });
      }
    },
    [flush, loadWorkspace, showToast],
  );

  const dockTheme: DockviewTheme = useMemo(() => ({ ...themeDark, name: 'kb', colorScheme: scheme, gap: 0 }), [scheme]);
  const env: ViewHostEnv = useMemo(
    () => ({
      fsVersion,
      fsEvents,
      apiFor: (id) => pluginHost.apiFor(id),
      getItem: (id) => itemsRef.current[id],
      updateItem: (id, patch) => {
        const cur = itemsRef.current[id];
        if (!cur) return;
        const next: WorkspaceItem = { ...cur, ...patch };
        if (patch.state === undefined && 'state' in patch) delete next.state;
        itemsRef.current[id] = next;
        requestSave();
      },
      removeItem: async (id) => {
        if (!(await dialogs.confirm({ title: '从工作区移除此条目？', body: '只关闭这个面板并删除它在工作区中的记录（含阅读状态），不会删除或移动任何文件。', ok: '移除', danger: true }))) return;
        apiRef.current?.getPanel(id)?.api.close();
        delete itemsRef.current[id];
        requestSave();
      },
      openPluginManager: (focus) => setManager({ focus }),
    }),
    [fsVersion, fsEvents, requestSave],
  );

  const removeWorkspaceRef = useCallback((rid: string) => {
    const hit = wsRefs.find((r) => r.resourceId === rid);
    if (hit) void removeRef(hit);
  }, [wsRefs, removeRef]);
  // TreeRow 读 AppCtx，memo 挡不住上下文身份变化。这里只跟目录相关字段走，不跟整份 ui。
  const ctx = useMemo<Ctx>(() => ({
    open,
    openCopy,
    notify: showToast,
    openWeb,
    removeWorkspaceRef,
    workspaceId: wsId,
    vfolderVersion,
    favIds,
    toggleFav,
    expanded,
    setExpanded,
    fsVersion,
    fsEvents,
    activeResourceId: activeRid,
    showIgnored,
    setShowIgnored,
    refIds,
    toggleRef,
  }), [
    open,
    openCopy,
    showToast,
    openWeb,
    removeWorkspaceRef,
    wsId,
    vfolderVersion,
    favIds,
    toggleFav,
    expanded,
    setExpanded,
    fsVersion,
    fsEvents,
    activeRid,
    showIgnored,
    setShowIgnored,
    refIds,
    toggleRef,
  ]);
  const panelEpoch = usePanelManagerVersion();
  const narrowTopbar = useNarrowTopbar();
  const sidebarPrefs = useSidebarPrefs();
  const shellCollapsed = !!panelManager.sidebarState().collapsed;
  const shellOpen = !shellCollapsed;
  const drawerOpen = drawerContentOpen(shellCollapsed, sidebarPrefs);
  const listWidthMemory = useRef<number | undefined>(undefined);
  const prevListOpen = useRef<boolean | null>(null);
  useLayoutEffect(() => {
    const wasOpen = prevListOpen.current;
    prevListOpen.current = drawerOpen;
    if (sidebarPrefs.categoriesLayout !== 'list') return;
    // 展开：壳层若停在竖条或小于最小内容宽，把收起前的宽度写回 PanelManager。
    if (wasOpen === false && drawerOpen) {
      const w = resolveListDrawerWidth(true, listWidthMemory.current, shellRef.current.sidebarWidth);
      const docked = !panelManager.isCollapsed(SIDEBAR_ID) && panelManager.sidebarState().mode === 'docked';
      if (docked && Math.round(shellRef.current.sidebarWidth) !== w) panelManager.resize(SIDEBAR_ID, { width: w });
    }
  }, [drawerOpen, sidebarPrefs.categoriesLayout]);
  if (!ui) return <DialogHost />;
  if (sheet)
    return (
      <>
        <StatesSheet chrome={ui.appearance.chrome} reading={ui.appearance.reading} scheme={scheme} />
        <DialogHost />
      </>
    );
  const ch = chromeThemes.get(ui.appearance.chrome);
  const rd = readingThemes.get(ui.appearance.reading);
  const appearanceLabel = `外框：${ch?.label ?? ui.appearance.chrome} · 阅读区：${rd?.label ?? ui.appearance.reading} · ${scheme === 'dark' ? '深色' : '浅色'}${ui.appearance.scheme === 'system' ? '（跟随系统）' : ''}`;
  const dirView = normalizeDirView(ui.dirView);
  const drawerChrome = dockedDrawerChrome(drawerOpen);
  const toggleDrawer = () => toggleDockedDrawer(panelManager);
  const listLayout = sidebarPrefs.categoriesLayout === 'list';
  if (listLayout && drawerOpen) listWidthMemory.current = resolveListDrawerWidth(true, listWidthMemory.current, sidebarWidth);
  const listWidth = listLayout ? resolveListDrawerWidth(drawerOpen, listWidthMemory.current, sidebarWidth) : undefined;
  const overviewLocked = !overviewHidden && keepOverviewForEmptyLibrary(wsList.length, temporaryWs);
  const toggleOverview = () => {
    if (overviewLocked) return;
    if (overviewHidden) {
      void openOverviewWithSnapshots().finally(() => setOverviewHidden(false));
      return;
    }
    setOverviewHidden(true);
  };
  return (
    <AgentLiveProvider client={liveClient} host={liveHost}>
    <AppCtx.Provider value={ctx}>
      <ViewHostCtx.Provider value={env}>
        <div className="app" data-testid="app" data-motion={reduceMotionOn ? 'reduce' : 'on'} style={{ ['--bubble-reserve' as string]: panelEpoch >= 0 && panelManager.bubbles().length > 0 ? '40px' : '0px' }}>
          {topBarVisible ? (
            <header className="kb-topbar kb-drag" data-narrow={narrowTopbar ? 'true' : 'false'}>
            <div className="kb-topbar-cluster kb-topbar-cluster--left">
              <button
                type="button"
                className={drawerChrome.pressed ? 'kb-icon-hit on kb-no-drag' : 'kb-icon-hit kb-no-drag'}
                data-testid="drawer-toggle"
                aria-pressed={drawerChrome.pressed}
                aria-label={drawerChrome.drawerLabel}
                title={drawerChrome.drawerLabel}
                onClick={toggleDrawer}
              >
                {drawerChrome.icon === 'panel-left-close' ? <PanelLeftCloseIcon /> : <PanelLeftOpenIcon />}
              </button>
              <div className="kb-brand kb-drag">
                <BrandMark size={18} />
                <span className="title" title="本地知识工作台" aria-label="本地知识工作台">
                  {narrowTopbar ? '知识库' : '本地知识工作台'}
                </span>
              </div>
              {!narrowTopbar && (
                <div className="kb-ghost-wrap kb-no-drag">
                  <WorkspaceSwitcher list={wsList} currentId={wsId} actions={wsActions} />
                </div>
              )}
              {!narrowTopbar && (
                <button
                  type="button"
                  className={!overviewHidden ? 'kb-ghost kb-ov-entry on kb-no-drag' : 'kb-ghost kb-ov-entry kb-no-drag'}
                  data-testid="ws-overview-toggle"
                  title="工作区总览"
                  aria-pressed={!overviewHidden}
                  disabled={overviewLocked}
                  onClick={toggleOverview}
                >
                  <OverviewMark />
                  工作区总览
                </button>
              )}
              <span className="kb-topbar-push">

              </span>
            </div>
            <div className="kb-topbar-search kb-topbar-search-pair kb-no-drag">
              <SearchBox roots={roots} health={indexHealth} scope="name" testId="search-input" />
            </div>
            <div className="kb-topbar-cluster kb-topbar-cluster--right">
              <button type="button" className="kb-no-drag kb-sidebar-mode" onClick={() => window.dispatchEvent(new Event('kb:toggle-sidebar'))}>侧栏模式</button>
              <PendingPlansButton />
              {!narrowTopbar && (
                <button
                  type="button"
                  className="kb-icon-hit kb-no-drag"
                  data-testid="appearance-open"
                  title="外观"
                  aria-label="外观"
                  onClick={() => openSettingsRef.current('appearance')}
                >
                  <SunIcon />
                </button>
              )}
              {!narrowTopbar && (
                <span className="kb-no-drag" data-testid="topbar-scheme-sun">
                  <SchemeSunToggle
                    scheme={ui.appearance.scheme}
                    onScheme={(scheme) => setAppearance({ ...ui.appearance, scheme })}
                  />
                </span>
              )}
              <button
                type="button"
                className={settingsOpen ? 'kb-icon-hit on kb-no-drag' : 'kb-icon-hit kb-no-drag'}
                data-testid="settings-open"
                title="设置"
                aria-label="设置"
                aria-pressed={settingsOpen}
                onClick={() => openSettingsRef.current()}
              >
                <SettingsIcon />
              </button>
              <TopMoreMenu
                slim={!narrowTopbar}
                onCommandPalette={() => setPalette(true)}
                overviewHidden={overviewHidden}
                overviewLocked={overviewLocked}
                onToggleOverview={toggleOverview}
                workspace={{ list: wsList, currentId: wsId, actions: wsActions }}
                appearance={{ value: ui.appearance, onChange: setAppearance }}
              />
              <span className="kb-topbar-sep" aria-hidden="true" />
              <div className="kb-window-controls-gap" aria-hidden="true" />
            </div>
          </header>
          ) : (
            <button
              type="button"
              className="kb-topbar-reveal kb-no-drag"
              data-testid="topbar-reveal"
              title="显示顶栏"
              aria-label="显示顶栏"
              onClick={async () => {
                const base = chromeLoadedRef.current ? chromePrefsRef.current : await loadUiChromePrefs(kb);
                const stored = await saveUiChromePrefs(kb, withUiChromePrefs(base, { topBarVisible: true }));
                applyUiChromeRef.current(stored);
                window.dispatchEvent(new CustomEvent('kb:ui-chrome-saved', { detail: stored }));
              }}
            />
          )}
          {banner && (
            <div className="banner kb-banner" data-tone="warning" data-testid="ws-banner">
              {banner}
            </div>
          )}
          <div className="main">
            <SidebarSlot
              docked={(content) => (
                <aside className="kb-sidebar" data-testid="sidebar" data-open={shellOpen ? 'true' : 'false'} style={{ width: shellOpen ? listWidth : 0 }}>
                  {content}
                </aside>
              )}
            >
              <Drawer
                open={shellOpen}
                onTogglePanel={toggleDrawer}
                width={listLayout && drawerOpen ? listWidth : clampDrawerWidth(sidebarWidth)}
                onWidth={onDrawerWidth}
                selection={drawerSelection}
                onSelectionChange={onDrawerSelection}
                slots={{
                  root: (
                    <>
                      {sidebarPhase !== 'loading' && !dirView.dual ? <RootsSection roots={roots} reload={reload} /> : null}
                      <DirViewHost
                        ref={dirViewRef}
                        roots={roots}
                        favorites={favorites}
                        reload={reload}
                        refs={wsRefs}
                        openRids={openRids}
                        onRemove={removeRef}
                        onOpenAll={openAllRefs}
                        workspaceId={wsId}
                        phase={sidebarPhase}
                        dirView={dirView}
                        setDirView={setDirView}
                      />
                    </>
                  ),
                  fav: <FavoritesSection favorites={favorites} />,
                  web: webResourcesOn ? <WebResourcesSidebarSection /> : null,
                  bench: (
                    <WorkspaceRefs refs={wsRefs} openRids={openRids} onRemove={removeRef} onOpenAll={openAllRefs} workspaceId={wsId} />
                  ),
                  agent: <AgentMaterialsSidebar />,
                  plugin: (
                    <section className="kb-section kb-module" data-testid="panel-workbench.plugins">
                      <ModuleHead
                        title="插件"
                        testId="plugin-module-h"
                        acts={
                          <button type="button" className="kb-linkish" data-testid="open-plugin-manager" onClick={() => openPluginManagerRef.current?.()}>
                            管理插件…
                          </button>
                        }
                      />
                      <PluginsPanel />
                      <SidebarPlugins />
                    </section>
                  ),
                }}
              />
            </SidebarSlot>
            <main
              className="center kb-dock"
              data-testid="dock"
              style={{ minWidth: 360 }}
              onDragOver={(e) => {
                const peeked = peekDirDrag();
                const types = [...e.dataTransfer.types];
                if (!types.includes('Files') && !peeked && !isKbDrag(e.dataTransfer)) return;
                e.preventDefault();
                const main = e.currentTarget;
                const zone = readerZone(main.getBoundingClientRect(), e.clientX, e.clientY);
                const blank = !!(e.target as HTMLElement).closest?.('.kb-watermark');
                const target = blank && zone === 'center' ? { kind: 'workbench-blank' as const } : { kind: 'reader' as const, zone };
                let payload = readKbPayload(e.dataTransfer) ?? (peeked ? toDragPayload(peeked) : null);
                if (!payload && types.includes('Files')) {
                  payload = {
                    v: 1,
                    items: [{
                      resourceId: '',
                      sourceKind: 'file' as const,
                      from: { kind: 'explorer' as const },
                      entry: 'file' as const,
                      absPath: 'file',
                    }],
                  };
                }
                if (payload) {
                  const decision = onDropTarget(target, payload, modifiersOf(e));
                  e.dataTransfer.dropEffect = decision.dropEffect === 'none' ? 'none' : decision.dropEffect;
                  main.dataset.dndHint = decision.hint;
                  setLiveHint(decision.hint);
                } else {
                  e.dataTransfer.dropEffect = 'copy';
                }
                main.dataset.dragOver = 'true';
              }}
              onDragLeave={(e) => {
                if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                delete e.currentTarget.dataset.dragOver;
                delete e.currentTarget.dataset.dndHint;
                setLiveHint('');
              }}
              onDrop={(e) => {
                const peeked = peekDirDrag();
                const types = [...e.dataTransfer.types];
                if (!types.includes('Files') && !peeked && !isKbDrag(e.dataTransfer)) return;
                e.preventDefault();
                let payload = readKbPayload(e.dataTransfer) ?? (peeked ? toDragPayload(peeked) : null);
                if (!payload && e.dataTransfer.files?.length) {
                  payload = {
                    v: 1,
                    items: Array.from(e.dataTransfer.files).map((f) => ({
                      resourceId: '',
                      sourceKind: 'file' as const,
                      from: { kind: 'explorer' as const },
                      entry: 'file' as const,
                      name: f.name,
                      absPath: (f as any).path || '',
                      size: f.size,
                    })),
                  };
                }
                const main = e.currentTarget;
                const zone = readerZone(main.getBoundingClientRect(), e.clientX, e.clientY);
                const blank = !!(e.target as HTMLElement).closest?.('.kb-watermark');
                const target = blank && zone === 'center' ? { kind: 'workbench-blank' as const } : { kind: 'reader' as const, zone };
                delete main.dataset.dragOver;
                delete main.dataset.dndHint;
                if (payload) void runDrop(target, payload, modifiersOf(e));
              }}
            >
              <DockviewReact components={components} onReady={onReady} theme={dockTheme} watermarkComponent={Watermark} rightHeaderActionsComponent={PanelHeaderActions} defaultTabComponent={DocTab} />
            </main>
          </div>
          <BubbleTray />
          <FloatResizeGrips />
          <DndHintBar />
          <StatusBar roots={roots} status={status} health={indexHealth} appearanceLabel={appearanceLabel} wsName={temporaryWs ? '临时现场（未保存）' : (wsList.find((w) => w.id === wsId)?.name ?? '')} activeRid={activeRid} />
          <div className="kb-ws-overview-mount" data-testid="ws-overview-mount" hidden={overviewHidden}>
            <WorkspaceOverview
              entries={overviewEntries(wsList, temporaryWs)}
              currentId={wsId || null}
              overviewHidden={overviewHidden}
              presets={presetRefs(presetsList)}
              snapshotEnabled={pickerSettings.snapshotEnabled}
              snapshotFiles={snapshotFiles}
              snapshotSrcs={snapshotSrcs}
              snapshotTakenAt={snapshotAt}
              onEnter={(id) => {
                if (id === TEMPORARY_WORKSPACE_ID) {
                  setOverviewHidden(true);
                  return;
                }
                void switchTo(id).then(() => setOverviewHidden(true));
              }}
              onCopy={(id) => {
                void (async () => {
                  try {
                    const dto = await kb.getWorkspace(id);
                    const created = await kb.createWorkspace(`${dto.name} 副本`.slice(0, 80), dto.project, dto.layout, dto.items);
                    await switchTo(created.id);
                    setOverviewHidden(true);
                  } catch (e) {
                    await dialogs.alert({ title: '无法复制工作区', body: String((e as Error).message ?? e) });
                  }
                })();
              }}
              onExport={(id) => void wsActions.exportWs(id)}
              onRename={(id, name) => {
                void (async () => {
                  try {
                    await kb.updateWorkspace(id, { name });
                    await refreshWsList();
                  } catch (e) {
                    await dialogs.alert({ title: '无法重命名', body: String((e as Error).message ?? e) });
                  }
                })();
              }}
              onDelete={(id) => void wsActions.remove(id)}
              onFavorite={(id, favorite) => {
                void (async () => {
                  try {
                    await kb.updateWorkspace(id, { favorite });
                    await refreshWsList();
                  } catch (e) {
                    await dialogs.alert({ title: '无法更新收藏', body: String((e as Error).message ?? e) });
                  }
                })();
              }}
              onCreate={(name) => void createEmptyNamed(name)}
              onCreateFirst={(name) => void createEmptyNamed(name)}
              onEnterTemporary={() => enterTemporaryWorkspace()}
              onApplyPreset={(presetId) => void wsActions.applyPreset(presetId)}
              boards={overviewBoards}
              onBoardsChange={(next) => {
                setOverviewBoards(next);
                void kb.setLayout(OVERVIEW_BOARDS_KEY, next).catch((e) => {
                  void dialogs.alert({ title: '无法记住顺序', body: String((e as Error).message ?? e) });
                });
              }}
            />
            <button type="button" className="kb-ws-quick-open-settings" data-action="open-startup-settings" onClick={() => setPickerSettingsOpen(true)}>
              启动设置
            </button>
          </div>
          {quickOpen && (
            <QuickSwitch
              entries={quickSwitchEntries(overviewEntries(wsList, temporaryWs))}
              currentId={wsId || null}
              conflict={quickConflict}
              onEnter={(id) => {
                if (id === TEMPORARY_WORKSPACE_ID) {
                  setQuickOpen(false);
                  return;
                }
                void switchTo(id).then(() => setQuickOpen(false));
              }}
              onClose={() => setQuickOpen(false)}
              onReconfigure={reconfigureQuickSwitch}
              onOpenSettings={() => setPickerSettingsOpen(true)}
            />
          )}
          {pickerSettingsOpen && (
            <WorkspacePickerSettings
              settings={pickerSettings}
              workspaces={wsList.map((row) => ({ id: row.id, name: row.name }))}
              conflict={quickConflict}
              onChange={(next) => {
                const stored = writeWorkspacePickerSettings(next);
                setPickerSettings(stored);
                if (wsList.length === 0) return;
                void kb.setLayout(WORKSPACE_PICKER_SETTINGS_KEY, stored);
              }}
              onClearSnapshotCache={(relativeNames) => {
                void deleteWorkspaceSnapshots(relativeNames).then(() => {
                  setSnapshotFiles({});
                  setSnapshotSrcs({});
                  setSnapshotAt({});
                });
              }}
              onClose={() => setPickerSettingsOpen(false)}
              onReconfigure={reconfigureQuickSwitch}
            />
          )}
          <OverlayHostSync active={!overviewHidden || quickOpen || pickerSettingsOpen || settingsOpen} workspaceId={wsId} />
          {shouldMountRestoreBar(wsList.length, temporaryWs, wsId) ? (
            <RestoreBar
              key={wsId}
              workspaceId={wsId}
              panels={restorePanelsFromItems(itemsRef.current).map((panel) => {
                const bubble = panelManager.bubbles().find((b) => b.id === panel.panelId);
                const dockTitle = apiRef.current?.getPanel(panel.panelId)?.title;
                const itemTitle = itemsRef.current[panel.panelId]?.title;
                const title = [bubble?.title, dockTitle, itemTitle].find((t) => typeof t === 'string' && t.trim() !== '' && t.trim() !== 'unknown');
                const ready = panel.kind === 'file' ? { reportsReady: true } : {};
                return title ? { ...panel, ...ready, title: title.trim() } : { ...panel, ...ready };
              })}
              ports={restorePorts}
              dismissed={dismissed}
              onDismiss={(panelId, problemKey) => {
                dismissRef.current = dismissRestore(dismissRef.current, panelId, problemKey);
                setDismissed(dismissRef.current);
                requestSave();
              }}
              onClear={(entries) => {
                dismissRef.current = dismissRestoreAll(dismissRef.current, entries);
                setDismissed(dismissRef.current);
                requestSave();
              }}
              retryPanel={(_workspaceId, panelId) => {
                if (panelManager.isCollapsed(panelId)) panelManager.restoreFromBubble(panelId);
                apiRef.current?.getPanel(panelId)?.api.setActive();
              }}
              onActivate={(id) => {
                if (panelManager.isCollapsed(id)) panelManager.restoreFromBubble(id);
              }}
            />
          ) : null}
          {palette && <CommandPalette onClose={() => setPalette(false)} />}
          {toast && (
            <div className="kb-toast" data-testid="toast" data-tone="info">
              {toast}
            </div>
          )}
          {manager && <PluginManager focus={manager.focus} onClose={() => setManager(null)} onUninstall={uninstall} />}
          {opLog && <OpLogDialog onClose={() => setOpLog(false)} />}
          {kbPage && <KeybindingsPage onClose={() => setKbPage(false)} />}
          {settingsOpen && (
            <SettingsPage
              variant="page"
              onUiChromeSaved={(prefs) => applyUiChromeRef.current(prefs)}
              category={settingsCategory}
              onCategory={(id) => {
                setSettingsCategory(id);
                try {
                  writeSettingsCategory(id, localStorage);
                } catch {
                  /* 没有本地存储时，这次打开仍然记住分类 */
                }
              }}
              onClose={() => setSettingsOpen(false)}
              dataReady={dataReady}
              appearance={ui.appearance}
              onAppearance={setAppearance}
              onInstallTheme={() => void installThemePack()}
              showIgnored={showIgnored}
              onShowIgnored={setShowIgnored}
              indexStatus={status}
              roots={roots}
              pickerSettings={pickerSettings}
              workspaces={wsList.map((row) => ({ id: row.id, name: row.name }))}
              conflict={quickConflict}
              onPickerChange={(next) => {
                const stored = writeWorkspacePickerSettings(next);
                setPickerSettings(stored);
                if (wsList.length === 0) return;
                void kb.setLayout(WORKSPACE_PICKER_SETTINGS_KEY, stored);
              }}
              onReconfigure={() => {
                setFocusCommandId(QUICK_SWITCH_COMMAND_ID);
                setSettingsCategory('keybindings');
                try {
                  writeSettingsCategory('keybindings', localStorage);
                } catch {
                  /* 同上 */
                }
              }}
              onUninstall={uninstall}
            />
          )}
          <DialogHost />
        </div>
      </ViewHostCtx.Provider>
    </AppCtx.Provider>
    </AgentLiveProvider>
  );
}
