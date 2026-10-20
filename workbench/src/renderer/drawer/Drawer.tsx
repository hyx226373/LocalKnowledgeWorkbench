import { useLayoutEffect, useRef, useState, type PointerEventHandler, type ReactNode } from 'react';
import { useSidebarPrefs, updateSidebarPrefs } from './sidebarPrefs';
import { ribbonClick, ribbonActive } from './ribbon';
import { DRAWER_MODULE_IDS } from './order';
import { DrawerCards } from './cards';
import { toggleSidebarBlock } from './sidebarTitle';
import {
  DRAWER_MODULE_LABEL,
  RIBBON_STRIP_WIDTH,
  normalizeDrawerSelection,
  toggleDrawerSelection,
  type DrawerModuleId,
} from './order';
import './drawer.css';
import { ModuleIcon } from './ModuleIcon';
import { ModuleHead, ModuleColumnActions } from './ModuleHead';
import { ColumnsDrawer } from './ColumnsDrawer';
import { clampColumnWidth } from '../../shared/sidebarLayout';
import './module.css';

export type DrawerProps = {
  open: boolean;
  mode?: 'main' | 'sidebar';
  cardsCollapsed?: boolean;
  hideCards?: boolean;
  allSelection?: readonly DrawerModuleId[];
  onModuleClick?: (id: DrawerModuleId, button: number) => void;
  onModuleDragOver?: React.DragEventHandler;
  onModuleDrop?: React.DragEventHandler;
  /** 展开宽度。默认 360，最小 240。侧栏模式无上限；完整界面拖宽停在阅读区仍不少于 360 的位置。grid 整栏收起时容器宽度为 0；list 只藏内容面板时为 ribbon 宽度。 */
  width?: number;
  onWidth: (width: number, animate?: boolean) => void;
  selection: readonly DrawerModuleId[];
  onSelectionChange: (selection: DrawerModuleId[]) => void;
  slots: Partial<Record<DrawerModuleId, React.ReactNode>>;
  /** 与顶栏 drawer-toggle 同一个开合。分区图标不调用它。list 下这是内容面板，不是整栏。 */
  onTogglePanel?: () => void;
};

/**
 * 插件关掉或权限未授予时，调用方把 slot 设为 null/false。
 * 窄栏入口、大图标卡片、分区外框都用这一个判断整块不画。
 * undefined 不是关掉，内容区仍显示「尚未挂接」。
 */
export function isSuppressedDrawerSlot(node: ReactNode): boolean {
  return node === null || node === false;
}

function slotNode(slots: DrawerProps['slots'], id: DrawerModuleId): ReactNode | null {
  const node = slots[id];
  if (node === undefined || isSuppressedDrawerSlot(node)) return null;
  return node;
}

export function SingleDrawer({ open, width = 360, onWidth, selection, onSelectionChange, slots, onTogglePanel, hideCards, allSelection, onModuleClick, onModuleDragOver, onModuleDrop }: DrawerProps) {
  const prefs = useSidebarPrefs();
  const ribbon = prefs.categoriesLayout === 'list';
  const collapsed = (onModuleClick ? false : ribbon) && prefs.ribbonCollapsed;
  const [active, setActive] = useState<DrawerModuleId | null>(null);
  const [highlight, setHighlight] = useState<{ id: DrawerModuleId; tick: number } | null>(null);
  const available = DRAWER_MODULE_IDS.filter((id) => slotNode(slots, id) !== null);
  // 大图标仍保留未挂接的入口（尚未挂接）。显式关掉的板块与窄栏用同一个判断，卡片本身不画。
  const gridCards = DRAWER_MODULE_IDS.filter((id) => !isSuppressedDrawerSlot(slots[id]));
  const rootRef = useRef<HTMLElement>(null);
  const shown = clampColumnWidth(width);
  const ordered = normalizeDrawerSelection(selection);

  useLayoutEffect(() => {
    if (open) return;
    const root = rootRef.current;
    const active = document.activeElement;
    if (root && active instanceof HTMLElement && root.contains(active)) active.blur();
  }, [open]);

  useLayoutEffect(() => {
    if (!ribbon || collapsed || !highlight) return;
    rootRef.current?.querySelector(`[data-testid="drawer-slot-${highlight.id}"]`)?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    const timer = setTimeout(() => setHighlight(null), 900);
    return () => clearTimeout(timer);
  }, [ribbon, collapsed, highlight, selection]);

  const toggle = (id: DrawerModuleId) => {
    if (!ribbon) { onSelectionChange(toggleDrawerSelection(allSelection ?? ordered, id)); return; }
    const next = ribbonClick(ordered, ribbonActive(active, available), collapsed, id);
    setActive(next.active);
    // 窄栏图标只显隐对应板块。再点当前项不把内容面板收成窄条；全部隐藏后侧栏留空。
    if (collapsed && !next.collapsed) updateSidebarPrefs({ ribbonCollapsed: false });
    const sameSelection = next.selection.length === ordered.length && next.selection.every((item, index) => item === ordered[index]);
    if (!sameSelection) onSelectionChange(next.selection);
    setHighlight((prev) => (next.selection.includes(id) ? { id, tick: (prev?.tick ?? 0) + 1 } : null));
  };

  const onSashDown: PointerEventHandler<HTMLDivElement> = (event) => {
    if (!open) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startW = shown;
    handle.setPointerCapture(event.pointerId);
    const move = (ev: PointerEvent) => onWidth(clampColumnWidth(startW + ev.clientX - startX));
    const end = (ev: PointerEvent) => {
      if (handle.hasPointerCapture(ev.pointerId)) handle.releasePointerCapture(ev.pointerId);
      rootRef.current?.removeAttribute('data-resizing');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };

  return (
    <aside
      ref={rootRef}
      className="kb-drawer"
      data-testid="kb-drawer"
      data-open={open ? 'true' : 'false'}
      data-layout={prefs.categoriesLayout}
      data-panel-collapsed={collapsed}
      style={{ width: open ? (collapsed ? RIBBON_STRIP_WIDTH : shown) : 0 }}
      inert={!open}
      aria-hidden={open ? undefined : true}
      aria-label="资料抽屉"
    >
      <div className="kb-drawer-body">
        {!hideCards && <DrawerCards selection={allSelection ?? ordered} available={available} gridAvailable={gridCards} onToggle={toggle} onModuleClick={onModuleClick} panelOpen={open && !collapsed} onTogglePanel={onTogglePanel} />}
        {ordered.some((id) => !isSuppressedDrawerSlot(slots[id])) && (
          <div className="kb-drawer-modules" data-testid="drawer-modules" hidden={collapsed} inert={collapsed} aria-hidden={collapsed || undefined}>
            {ordered.map((id) => {
              if (isSuppressedDrawerSlot(slots[id])) return null;
              const node = slotNode(slots, id);
              return (
                <section key={id} className="kb-drawer-module" data-module={id} data-ribbon-highlight={(ribbon && highlight?.id === id) || undefined} data-testid={`drawer-slot-${id}`}>
                  {onModuleClick && <div className="kb-column-head" onDragOver={onModuleDragOver} onDrop={onModuleDrop} draggable onDragStart={e => { e.dataTransfer.setData('application/x-kb-sidebar-module', id); e.dataTransfer.effectAllowed = 'move'; }}><ModuleIcon id={id}/><span>{DRAWER_MODULE_LABEL[id]}</span></div>}
                  <ModuleColumnActions.Provider value={onModuleClick ? [
                    {id:'column-2',label:'在第 2 栏打开',onClick:()=>onModuleClick(id,2)},
                    {id:'column-3',label:'在第 3 栏打开',onClick:()=>onModuleClick(id,1)},
                  ] : undefined}>
                  {!node && <ModuleHead title={DRAWER_MODULE_LABEL[id]}/>}
                  <button type="button" className="kb-sbb-bar kb-no-drag" data-testid={`sidebar-block-bar-${id}`} title="收起/展开分区" aria-label={`收起或展开${DRAWER_MODULE_LABEL[id]}`} onClick={() => toggleSidebarBlock(id)}>
                    <span className="kb-sbb-chev" aria-hidden="true">▾</span>
                  </button>
                  {node ?? (
                    <p className="kb-drawer-pending" data-testid={`drawer-pending-${id}`}>
                      <span className="kb-drawer-pending-name">{DRAWER_MODULE_LABEL[id]}</span>
                      <span>尚未挂接</span>
                    </p>
                  )}
                  </ModuleColumnActions.Provider>
                </section>
              );
            })}
          </div>
        )}
      </div>
      {open && !collapsed && (
        <div
          className="kb-drawer-sash"
          role="slider"
          tabIndex={0}
          aria-label="调整资料抽屉宽度"
          aria-valuemin={240}
          aria-valuenow={Math.round(shown)}
          onDoubleClick={() => { rootRef.current?.setAttribute('data-reset-width', 'true'); onWidth(360, true); setTimeout(() => rootRef.current?.removeAttribute('data-reset-width'), 160); }}
          onPointerDown={event => { rootRef.current?.setAttribute('data-resizing', 'true'); onSashDown(event); }}
          onKeyDown={(event) => {
            const step = event.shiftKey ? 24 : 8;
            if (event.key === 'ArrowRight') {
              event.preventDefault();
              onWidth(clampColumnWidth(shown + step));
            } else if (event.key === 'ArrowLeft') {
              event.preventDefault();
              onWidth(clampColumnWidth(shown - step));
            }
          }}
        />
      )}
    </aside>
  );
}

export function Drawer(props: DrawerProps) { return <ColumnsDrawer {...props} />; }
