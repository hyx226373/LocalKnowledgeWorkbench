import { useContext, useCallback, useEffect, useId, useState, type DragEvent } from 'react';
import { Check, ChevronDown, FolderTree, Bookmark, Globe, Files, Bot, Puzzle, LayoutGrid, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useSidebarPrefs, updateSidebarPrefs, type CardSize } from './sidebarPrefs';
import { cardSizeCSSVars, CARD_SIZE_SPECS, CARD_SIZES, CARD_SIZE_LABELS } from './cardSize';
import { dockedDrawerChrome } from './drawerToggle';
import { useCommitDocTab } from '../dnd/docTabDrop';
import { docTabDropTarget, handleDocTabDragOver, handleDocTabDrop, hasDocTabMime } from '../dnd/docTabDrag';
import { DRAWER_MODULE_IDS, DRAWER_MODULE_LABEL, type DrawerModuleId, normalizeDrawerSelection } from './order';
import { AppCtx } from '../dir-view/context';
import { isKbDrag, readKbPayload } from '../dnd/drag';
import { peekDrag } from '../dir-view/dnd';
import { toDragPayload } from '../dnd/bridge';
import { runDrop } from '../dnd/session';
import type { DrawerDropModule } from '../dnd/types';
import './drawer.css';

/** 六张分类卡的 24 视口、1.5px 线框标记。颜色走 currentColor。 */
function CardMark({ id }: { id: DrawerModuleId }) {
  const common = { viewBox: '0 0 24 24', fill: 'none', width: 24, height: 24, 'aria-hidden': true as const };
  const stroke = { stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  if (id === 'root') {
    return (
      <svg {...common}>
        <path d="M3.5 8.2h5.2l1.3-1.7h10.5V18.5H3.5V8.2z" {...stroke} />
        <path d="M3.5 11h17" {...stroke} />
      </svg>
    );
  }
  if (id === 'fav') {
    return (
      <svg {...common}>
        <path d="M7 4.5h10a1 1 0 0 1 1 1V20l-6-3.4L6 20V5.5a1 1 0 0 1 1-1z" {...stroke} />
      </svg>
    );
  }
  if (id === 'web') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="7.25" {...stroke} />
        <ellipse cx="12" cy="12" rx="3.2" ry="7.25" {...stroke} />
        <path d="M4.8 12h14.4M6.2 8.8h11.6M6.2 15.2h11.6" {...stroke} />
      </svg>
    );
  }
  if (id === 'bench') {
    return (
      <svg {...common}>
        <path d="M7 6.5h7.2L17 9.2V18.5H7V6.5z" {...stroke} />
        <path d="M9.2 11.2h5.2M9.2 14h3.6" {...stroke} />
        <path d="M14.2 6.5V9h2.6" {...stroke} />
      </svg>
    );
  }
  if (id === 'agent') {
    return (
      <svg {...common}>
        <rect x="6" y="7" width="12" height="9" rx="2" {...stroke} />
        <path d="M9 16.5v2.2M15 16.5v2.2M8.5 18.7h7M9.5 11h.1M14.5 11h.1" {...stroke} />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M8 4.5h4.2a2 2 0 0 1 2 2V9H8.2a2 2 0 0 1-2-2V6.5a2 2 0 0 1 1.8-2z" {...stroke} />
      <path d="M12 10.5h5.8a2 2 0 0 1 2 2v2.2a2 2 0 0 1-2 2H14a2 2 0 0 1-2-2v-4.2z" {...stroke} />
      <path d="M6.2 14.5H5a2 2 0 0 0-2 2V18a2 2 0 0 0 2 2h3.2" {...stroke} />
    </svg>
  );
}

export function DrawerCards({
  selection,
  onToggle,
  onModuleClick,
  available = DRAWER_MODULE_IDS,
  gridAvailable = DRAWER_MODULE_IDS,
  panelOpen = true,
  onTogglePanel,
}: {
  available?: readonly DrawerModuleId[];
  /** 大图标网格的入口：保留「尚未挂接」，只去掉显式关掉（null/false）的板块。 */
  gridAvailable?: readonly DrawerModuleId[];
  selection: readonly DrawerModuleId[];
  onToggle: (id: DrawerModuleId) => void;
  onModuleClick?: (id: DrawerModuleId, button: number) => void;
  /** 与顶栏 drawer-toggle 相同：true 表示内容面板展开。 */
  panelOpen?: boolean;
  onTogglePanel?: () => void;
}) {
  const prefs = useSidebarPrefs();
  const categoriesId = useId();
  const icons = { root: FolderTree, fav: Bookmark, web: Globe, bench: Files, agent: Bot, plugin: Puzzle };
  const pressed = new Set(normalizeDrawerSelection(selection));
  const [dropOver, setDropOver] = useState<DrawerModuleId | null>(null);
  const appCtx = useContext(AppCtx);
  const workspaceId = appCtx?.workspaceId || '';
  const commitTab = useCommitDocTab();
  const panelChrome = dockedDrawerChrome(panelOpen);
  const PanelToggleIcon = panelChrome.icon === 'panel-left-close' ? PanelLeftClose : PanelLeftOpen;
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const closeCtx = useCallback(() => setCtxMenu(null), []);
  useEffect(() => {
    if (!ctxMenu) return;
    const dismiss = () => setCtxMenu(null);
    document.addEventListener('click', dismiss, { once: true });
    document.addEventListener('contextmenu', dismiss, { once: true });
    return () => {
      document.removeEventListener('click', dismiss);
      document.removeEventListener('contextmenu', dismiss);
    };
  }, [ctxMenu]);
  const onCardsContextMenu = (e: React.MouseEvent) => {
    // 卡片本身的右键已用于「在第 2 栏打开」（r22-A2），只有点在卡片之间的空白处才弹尺寸菜单。
    if (prefs.categoriesLayout !== 'grid' || e.defaultPrevented) return;
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  };
  return (
    <div className="kb-drawer-cats" data-layout={prefs.categoriesLayout} onContextMenu={onCardsContextMenu}>
      {prefs.categoriesLayout === 'list' && (
        <>
          <button
            type="button"
            className="kb-drawer-card kb-ribbon-panel-toggle kb-no-drag"
            data-testid="ribbon-panel-toggle"
            aria-pressed={panelChrome.pressed}
            title={panelChrome.ribbonLabel}
            aria-label={panelChrome.ribbonLabel}
            onClick={() => onTogglePanel?.()}
          >
            <span className="kb-drawer-card-mark">
              <PanelToggleIcon size={18} aria-hidden="true" />
            </span>
          </button>
          <div className="kb-ribbon-sep" aria-hidden="true" />
        </>
      )}
      {prefs.categoriesLayout === 'grid' && <div className="kb-drawer-cats-head">
        <button type="button" className="kb-mini-btn kb-category-toggle" aria-label={prefs.categoriesCollapsed ? '展开分类' : '收起分类'} aria-expanded={!prefs.categoriesCollapsed} aria-controls={categoriesId} onClick={() => updateSidebarPrefs({ categoriesCollapsed: !prefs.categoriesCollapsed })}><ChevronDown size={16} aria-hidden="true" />分类</button>
      </div>}
      <div className="kb-category-drawer" data-collapsed={prefs.categoriesLayout === 'grid' && prefs.categoriesCollapsed} inert={prefs.categoriesLayout === 'grid' && prefs.categoriesCollapsed} aria-hidden={prefs.categoriesLayout === 'grid' && prefs.categoriesCollapsed}><div className="kb-category-drawer-inner"><div id={categoriesId} className="kb-drawer-cards" data-layout={prefs.categoriesLayout} data-card-size={prefs.categoriesLayout === 'grid' ? prefs.cardSize : undefined} role="group" aria-label="分类入口" style={prefs.categoriesLayout === 'grid' ? cardSizeCSSVars(prefs.cardSize) as React.CSSProperties : undefined}>
        {(prefs.categoriesLayout === 'list' ? available : gridAvailable).map((id) => {
          const Icon = icons[id];
          const on = pressed.has(id);
          const dropTarget = docTabDropTarget(id);
          const cardDrag = dropTarget ? {
            onDragEnter: (event: DragEvent<HTMLButtonElement>) => {
              if (!hasDocTabMime(event.dataTransfer.types) && !isKbDrag(event.dataTransfer) && !event.dataTransfer.types.includes('application/x-kb-resource+json') && !peekDrag()) return;
              event.preventDefault();
            },
            onDragOver: (event: DragEvent<HTMLButtonElement>) => {
              if (handleDocTabDragOver(event)) {
                setDropOver(id);
                return;
              }
              if (isKbDrag(event.dataTransfer) || event.dataTransfer.types.includes('application/x-kb-resource+json') || peekDrag()) {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'link';
                event.currentTarget.setAttribute('data-drop-active', 'true');
                setDropOver(id);
              }
            },
            onDragLeave: (event: DragEvent<HTMLButtonElement>) => {
              if (event.currentTarget.contains(event.relatedTarget as Node)) return;
              event.currentTarget.removeAttribute('data-drop-active');
              setDropOver((cur) => (cur === id ? null : cur));
            },
            onDrop: (event: DragEvent<HTMLButtonElement>) => {
              const hit = handleDocTabDrop(event);
              if (hit.claimed) {
                setDropOver((cur) => (cur === id ? null : cur));
                if (hit.payload) void commitTab(dropTarget, hit.payload);
                return;
              }
              if (isKbDrag(event.dataTransfer) || event.dataTransfer.types.includes('application/x-kb-resource+json') || peekDrag()) {
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.removeAttribute('data-drop-active');
                setDropOver((cur) => (cur === id ? null : cur));
                const payload = readKbPayload(event.dataTransfer) ?? (peekDrag() ? toDragPayload(peekDrag()!) : null);
                if (payload) {
                  void runDrop({ kind: 'drawer-card', module: dropTarget as DrawerDropModule, workspaceId }, payload);
                }
              }
            },
          } : {};
          const showTitle = prefs.categoriesLayout === 'list' || CARD_SIZE_SPECS[prefs.cardSize].hideTitle;
          return (
            <button
              key={id}
              type="button"
              className={on ? 'kb-drawer-card on' : 'kb-drawer-card'}
              data-testid={`drawer-card-${id}`}
              data-module={id}
              data-drop-active={dropOver === id ? 'true' : undefined}
              aria-pressed={on}
              title={`${DRAWER_MODULE_LABEL[id]}　左键：第 1 栏　右键：第 2 栏　中键：第 3 栏`}
              aria-label={showTitle ? DRAWER_MODULE_LABEL[id] : undefined}
              onClick={() => onModuleClick ? onModuleClick(id, 0) : onToggle(id)}
              onMouseDown={e => { if(e.button === 1)e.preventDefault(); }}
              onContextMenu={e => { if(!onModuleClick)return; e.preventDefault(); onModuleClick(id, 2); }}
              onAuxClick={e => { if(e.button === 1){e.preventDefault();onModuleClick?.(id, 1);} }}
              {...cardDrag}
            >
              {on && prefs.categoriesLayout === 'grid' ? (
                <span className="kb-drawer-card-check">
                  <Check size={14} strokeWidth={1.5} aria-hidden="true" />
                </span>
              ) : null}
              <span className="kb-drawer-card-mark">
                {prefs.categoriesLayout === 'list' ? <Icon size={18} aria-hidden="true" /> : <CardMark id={id} />}
              </span>
              {prefs.categoriesLayout === 'grid' && !CARD_SIZE_SPECS[prefs.cardSize].hideTitle ? <span className="kb-drawer-card-name">{DRAWER_MODULE_LABEL[id]}</span> : null}
            </button>
          );
        })}
      </div></div></div>
      {prefs.categoriesLayout === 'list' && <button type="button" className="kb-mini-btn kb-ribbon-layout" title="切换为网格" aria-label="切换为网格" onClick={() => updateSidebarPrefs({ categoriesLayout: 'grid' })}><LayoutGrid size={18} aria-hidden="true" /></button>}
      {ctxMenu && (
        <div
          className="kb-more-menu"
          data-testid="card-size-context-menu"
          style={{ position: 'fixed', left: ctxMenu.x, top: ctxMenu.y, zIndex: 100 }}
          onKeyDown={(e) => { if (e.key === 'Escape') closeCtx(); }}
        >
          <div style={{ padding: '4px 8px', fontSize: 11, fontWeight: 600, color: 'var(--kb-color-text-muted)' }}>卡片尺寸</div>
          {CARD_SIZES.map((size) => (
            <button
              key={size}
              type="button"
              data-testid={`ctx-card-size-${size}`}
              disabled={prefs.cardSize === size}
              onClick={() => { updateSidebarPrefs({ cardSize: size }); closeCtx(); }}
            >
              {CARD_SIZE_LABELS[size]}{prefs.cardSize === size ? '（当前）' : ''}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

