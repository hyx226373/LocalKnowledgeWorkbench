import { LayoutGrid, List } from 'lucide-react';
import { useSidebarPrefs, updateSidebarPrefs } from '../drawer/sidebarPrefs';
/** 面板管理层的 React 部件：侧栏槽位、浮动侧栏面板、分组标题栏按钮、气泡栏、拖动遮罩。 */
import React, { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { IDockviewHeaderActionsProps, IDockviewPanelProps } from 'dockview-react';
import { ReaderAddMaterialButton } from '../agent-live/readerButton';
import { BubbleCloseIcon, FileTextIcon, WinGlyph } from '../ui/shellMarks';
import { kb } from '../kb';
import { commands } from '../plugin-host/registry';
import { CLOSE_ALL_FILES_ID } from '../tabs/closeAllFiles';
import { loadUiChromePrefs, saveUiChromePrefs, withUiChromePrefs } from '../settings/uiChromePrefs';
import { BUBBLE_MOTION, bindDockSepDrag, bubbleCaption, motionReduced, readMotionEnv } from './dockChrome';
import { panelManager } from './instance';
import { hideDockedTabs, showDocumentTabs } from './tabVisibility';
import { SIDEBAR_ID, type BubbleKind } from './types';
import { dragShieldActive } from './webOcclusion';

const KIND_LABEL: Record<BubbleKind | 'panel', string> = {
  file: '文件',
  web: '网页',
  app: '应用',
  'native-host': '本机',
  sidebar: '侧栏',
  unknown: '面板',
  panel: '面板',
};

export function usePanelManagerVersion() {
  return useSyncExternalStore(panelManager.subscribe, panelManager.getVersion);
}

function Btn(p: { id: string; title: string; onClick(): void; children: React.ReactNode; className?: string }) {
  return (
    <button
      type="button"
      className={p.className ? `pm-btn ${p.className}` : 'pm-btn'}
      data-testid={p.id}
      title={p.title}
      aria-label={p.title}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        p.onClick();
      }}
    >
      {p.children}
    </button>
  );
}

/** 阅读条已经画出浮动/收成气泡时，标签条不再留同一套文字按钮。计数避免严格模式双调用把标记清掉。 */
const paneActionCounts = new Map<string, number>();
const paneActionListeners = new Set<() => void>();

function setPaneWindowActions(id: string, present: boolean) {
  const prev = paneActionCounts.get(id) ?? 0;
  const next = present ? prev + 1 : Math.max(0, prev - 1);
  if (next === 0) paneActionCounts.delete(id);
  else paneActionCounts.set(id, next);
  if ((prev === 0) !== (next === 0)) {
    for (const fn of paneActionListeners) fn();
  }
}

function subscribePaneWindowActions(onStoreChange: () => void) {
  paneActionListeners.add(onStoreChange);
  return () => paneActionListeners.delete(onStoreChange);
}

function paneHasWindowActions(id: string | undefined): boolean {
  return !!id && (paneActionCounts.get(id) ?? 0) > 0;
}

function usePaneWindowActions(id: string | undefined): boolean {
  return useSyncExternalStore(subscribePaneWindowActions, () => paneHasWindowActions(id), () => false);
}

async function setDocumentTabsVisible(visible: boolean) {
  const base = await loadUiChromePrefs(kb);
  const stored = await saveUiChromePrefs(kb, withUiChromePrefs(base, { documentTabs: visible }));
  if (visible) showDocumentTabs();
  else hideDockedTabs();
  window.dispatchEvent(new CustomEvent('kb:ui-chrome-saved', { detail: stored }));
}

/** 一组窗口按钮（分组标题栏与侧栏工具行共用）。text 只留浮动/停靠与收成气泡；chrome 只留最大化。 */
export function WindowButtons({ id, prefix, parts = 'all', className }: { id: string; prefix: string; parts?: 'all' | 'text' | 'chrome'; className?: string }) {
  usePanelManagerVersion();
  const info = panelManager.get(id);
  if (!info) return null;
  const pm = panelManager;
  const showText = parts !== 'chrome';
  const showChrome = parts !== 'text';
  return (
    <span
      className={className ? `pm-actions ${className}` : 'pm-actions'}
      data-testid={parts === 'text' ? `${prefix}-pane-actions` : `${prefix}-actions`}
      data-mode={info.mode}
      data-maximized={info.maximized ? 'true' : 'false'}
      data-pane-window-actions={parts === 'text' ? 'true' : undefined}
    >
      {showText ? (
        <span className="pm-actions-text">
          {info.mode === 'floating' ? (
            <Btn id={`${prefix}-dock`} title={id === SIDEBAR_ID ? '停靠回左侧' : '停靠到分屏'} className="pm-btn-text" onClick={() => pm.dock(id)}>
              停靠
            </Btn>
          ) : (
            <Btn id={`${prefix}-float`} title="浮动（自由窗口）" className="pm-btn-text" onClick={() => pm.float(id)}>
              浮动
            </Btn>
          )}
          <Btn id={`${prefix}-collapse`} title={id === SIDEBAR_ID ? '隐藏侧栏' : '收成气泡'} className="pm-btn-text" onClick={() => pm.collapseToBubble(id)}>
            {id === SIDEBAR_ID ? '隐藏' : '收成气泡'}
          </Btn>
        </span>
      ) : null}
      {showChrome ? (
        info.maximized ? (
          <Btn id={`${prefix}-restore`} title="还原" onClick={() => pm.restore(id)}>
            <WinGlyph kind="restore" />
          </Btn>
        ) : (
          <Btn id={`${prefix}-max`} title="最大化" onClick={() => pm.maximize(id)}>
            <WinGlyph kind="max" />
          </Btn>
        )
      ) : null}
    </span>
  );
}

/** 阅读条最右侧的浮动/收成气泡。坐标仍走 PanelManager，不另记矩形。 */
export function PaneWindowActions({ panelId }: { panelId: string }) {
  usePanelManagerVersion();
  const ready = !!panelManager.get(panelId);
  useLayoutEffect(() => {
    if (!ready) return;
    setPaneWindowActions(panelId, true);
    return () => setPaneWindowActions(panelId, false);
  }, [panelId, ready]);
  if (!ready) return null;
  return <WindowButtons id={panelId} prefix="pm-act" parts="text" className="pm-pane-actions" />;
}

/** dockview rightHeaderActionsComponent：对分组的当前面板操作 */
export function PanelHeaderActions(props: IDockviewHeaderActionsProps) {
  usePanelManagerVersion();
  const id = props.activePanel?.id;
  const ownsPaneActions = usePaneWindowActions(id);
  const location = props.location?.type ?? props.api.location.type;
  const showHideTabs = location === 'grid' && !panelManager.dockedTabsHidden();
  const showCloseAll = (!!id && id !== SIDEBAR_ID) || showHideTabs;
  if (!id && !showHideTabs) return null;
  const itemId = (props.activePanel?.params as { itemId?: string } | undefined)?.itemId || id;
  return (
    <>
      {showHideTabs ? (
        <Btn id="pm-hide-tabs" title="隐藏标签栏" className="pm-btn-hide-tabs" onClick={() => void setDocumentTabsVisible(false)}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </Btn>
      ) : null}
      {showCloseAll ? (
        <Btn id="close-all-tabs" title="关闭全部" className="pm-btn-text" onClick={() => { void commands.get(CLOSE_ALL_FILES_ID)?.run(); }}>
          关闭全部
        </Btn>
      ) : null}
      {id ? (
        <>
          <ReaderAddMaterialButton panelId={itemId!} />
          <WindowButtons id={id} prefix="pm-act" parts={ownsPaneActions ? 'chrome' : 'all'} />
        </>
      ) : null}
    </>
  );
}

/** 停靠侧栏工具行。不写「侧栏」二字，避免和模块标题再叠一行。浮动时由标签栏承担窗口按钮。 */
function SidebarBar() {
  const prefs = useSidebarPrefs();
  return (
    <div className="pm-sidebar-bar" data-testid="pm-sidebar-bar">
      <button type="button" className="kb-mini-btn" aria-label={prefs.categoriesLayout === 'grid' ? '切换为列表' : '切换为网格'} onClick={() => updateSidebarPrefs({ categoriesLayout: prefs.categoriesLayout === 'grid' ? 'list' : 'grid' })}>{prefs.categoriesLayout === 'grid' ? <List size={16} /> : <LayoutGrid size={16} />}</button>
      <WindowButtons id={SIDEBAR_ID} prefix="pm-sidebar" />
    </div>
  );
}

/**
 * 侧栏槽位：停靠时调用 docked(content) 渲染 App 原来的 <aside>；
 * 浮动时把同一个侧栏内容 portal 到浮动面板里；收起时仍交给 docked，由外壳把宽度收成 0，不进气泡栏。
 */
export function SidebarSlot({ docked, children }: { docked: (content: React.ReactNode) => React.ReactNode; children: React.ReactNode }) {
  usePanelManagerVersion();
  const s = panelManager.sidebarState();
  if (s.collapsed) return <>{docked(children)}</>;
  if (s.mode === 'docked')
    return (
      <>
        {docked(
          <>
            <SidebarBar />
            {children}
          </>,
        )}
      </>
    );
  const content = children;
  const target = panelManager.getSidebarTarget();
  if (!target) return null;
  return createPortal(
    <div className="kb-sidebar pm-sidebar-floating" data-testid="sidebar" data-floating="true">
      {content}
    </div>,
    target,
  );
}

/** dockview 组件 SIDEBAR_COMPONENT：浮动侧栏的容器（内容由 SidebarSlot portal 进来） */
export function SidebarPanel(_props: IDockviewPanelProps) {
  return <div className="pm-sidebar-host" data-testid="pm-sidebar-host" ref={(el) => panelManager.setSidebarTarget(el)} />;
}

function FileMark() {
  return (
    <span className="pm-bubble-dot" aria-hidden="true">
      <FileTextIcon />
    </span>
  );
}

/** 拖动/缩放/停靠预览期遮罩标记，供 webOcclusion 全覆盖原生网页 */
export function DragShield() {
  const [active, setActive] = useState(false);
  useEffect(() => {
    const root = document.querySelector('.kb-dock') ?? document.body;
    let raf = 0;
    const tick = () => {
      raf = 0;
      setActive(dragShieldActive(root));
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const mo = new MutationObserver(schedule);
    mo.observe(root, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true });
    for (const t of ['pointerdown', 'pointerup', 'pointercancel', 'dragstart', 'dragend', 'drop'] as const) {
      window.addEventListener(t, schedule, true);
    }
    schedule();
    return () => {
      mo.disconnect();
      if (raf) cancelAnimationFrame(raf);
      for (const t of ['pointerdown', 'pointerup', 'pointercancel', 'dragstart', 'dragend', 'drop'] as const) {
        window.removeEventListener(t, schedule, true);
      }
    };
  }, []);
  const host = typeof document !== 'undefined' ? document.querySelector('.kb-dock') : null;
  if (!host || !active) return null;
  return createPortal(<div className="pm-drag-shield" data-testid="pm-drag-shield" data-active="true" />, host);
}

function TabsRestoreChip() {
  usePanelManagerVersion();
  if (!panelManager.dockedTabsHidden()) return null;
  const host = typeof document !== 'undefined' ? document.querySelector('.kb-dock') : null;
  if (!host) return null;
  return createPortal(
    <button type="button" className="pm-restore-tabs" data-testid="pm-restore-tabs" onClick={() => void setDocumentTabsVisible(true)}>
      显示标签
    </button>,
    host,
  );
}

/** 气泡栏：收起的文档。底排默认；可单独拖动并记位；轻点恢复；右侧关闭。侧栏不进这里。 */
function clampBubblePos(left: number, top: number, host: HTMLElement, bubbleW = 160, bubbleH = 36) {
  const w = host.clientWidth;
  const h = host.clientHeight;
  const maxL = Math.max(0, w - 48);
  const maxT = Math.max(0, h - 28);
  return {
    left: Math.min(Math.max(-Math.min(40, bubbleW - 48), left), maxL),
    top: Math.min(Math.max(0, top), maxT),
  };
}

function defaultBubblePos(index: number, host: HTMLElement) {
  const left = BUBBLE_MOTION.inset + index * (BUBBLE_MOTION.maxWidth + BUBBLE_MOTION.gap);
  const top = Math.max(8, host.clientHeight - BUBBLE_MOTION.inset - BUBBLE_MOTION.height);
  return clampBubblePos(left, top, host, BUBBLE_MOTION.maxWidth, BUBBLE_MOTION.height);
}

function BubbleChip({
  id,
  title,
  kind,
  seq,
  tray,
  index,
}: {
  id: string;
  title: string;
  kind: BubbleKind | 'panel';
  seq: number;
  tray?: { left: number; top: number };
  index: number;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const drag = React.useRef<{ ox: number; oy: number; sl: number; st: number; moved: boolean; pointerId: number } | null>(null);
  const leaveTimer = React.useRef<number | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(tray ?? null);
  const [dragging, setDragging] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const posRef = React.useRef(pos);
  posRef.current = pos;

  useEffect(() => () => {
    if (leaveTimer.current != null) window.clearTimeout(leaveTimer.current);
  }, []);

  useEffect(() => {
    if (tray) setPos(tray);
  }, [tray?.left, tray?.top, id]);

  useEffect(() => {
    if (pos) return;
    const host =
      (ref.current?.offsetParent as HTMLElement | null) ?? (document.querySelector('.kb-dock') as HTMLElement | null);
    if (!host) return;
    setPos(defaultBubblePos(index, host));
  }, [pos, index]);

  const style: React.CSSProperties | undefined = pos
    ? { left: pos.left, top: pos.top }
    : { left: BUBBLE_MOTION.inset + index * (BUBBLE_MOTION.maxWidth + BUBBLE_MOTION.gap), bottom: BUBBLE_MOTION.inset, top: 'auto' };

  const finishRestore = () => {
    if (leaveTimer.current != null) {
      window.clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
    panelManager.restoreFromBubble(id);
  };

  const beginRestore = () => {
    if (leaving) return;
    if (motionReduced(readMotionEnv())) {
      finishRestore();
      return;
    }
    setLeaving(true);
    leaveTimer.current = window.setTimeout(finishRestore, BUBBLE_MOTION.emergeMs);
  };

  return (
    <div
      ref={ref}
      className="pm-bubble"
      data-testid="pm-bubble"
      data-panel-id={id}
      data-kind={kind}
      data-seq={seq}
      data-phase={leaving ? 'out' : 'in'}
      data-dragging={dragging ? 'true' : undefined}
      style={style}
      title={`恢复：${title}`}
      onAnimationEnd={(e) => {
        if (e.target !== e.currentTarget || !leaving || e.animationName !== 'pm-bubble-out') return;
        finishRestore();
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const t = e.target as HTMLElement;
        if (t.closest('[data-bubble-close]')) return;
        const host = (e.currentTarget.offsetParent as HTMLElement | null) ?? document.querySelector('.kb-dock');
        if (!host) return;
        const cur = pos ?? defaultBubblePos(index, host as HTMLElement);
        drag.current = { ox: e.clientX, oy: e.clientY, sl: cur.left, st: cur.top, moved: false, pointerId: e.pointerId };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || d.pointerId !== e.pointerId) return;
        const dx = e.clientX - d.ox;
        const dy = e.clientY - d.oy;
        if (!d.moved && Math.hypot(dx, dy) < 6) return;
        d.moved = true;
        setDragging(true);
        const host = (e.currentTarget.offsetParent as HTMLElement | null) ?? document.querySelector('.kb-dock');
        if (!host) return;
        const next = clampBubblePos(d.sl + dx, d.st + dy, host as HTMLElement);
        setPos(next);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        if (!d || d.pointerId !== e.pointerId) return;
        drag.current = null;
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        setDragging(false);
        if (d.moved) {
          const host = (e.currentTarget.offsetParent as HTMLElement | null) ?? document.querySelector('.kb-dock');
          const cur = posRef.current;
          if (host && cur) {
            const next = clampBubblePos(cur.left, cur.top, host as HTMLElement, BUBBLE_MOTION.maxWidth, BUBBLE_MOTION.height);
            setPos(next);
            panelManager.setBubbleTray(id, next);
          }
          return;
        }
        beginRestore();
      }}
      onPointerCancel={(e) => {
        if (drag.current?.pointerId === e.pointerId) drag.current = null;
        setDragging(false);
      }}
    >
      <span className="pm-bubble-main" data-testid="pm-bubble-restore">
        <FileMark />
        <span className="pm-bubble-title">{bubbleCaption(title)}</span>
        <span className="pm-bubble-kind">{KIND_LABEL[kind] ?? '面板'}</span>
      </span>
      <button
        type="button"
        className="pm-bubble-close"
        data-bubble-close="1"
        data-testid="pm-bubble-close"
        title="关闭文档"
        aria-label={`关闭 ${title}`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          panelManager.closeBubble(id);
        }}
      >
        <BubbleCloseIcon />
      </button>
    </div>
  );
}

function useDockSepDrag() {
  useEffect(() => bindDockSepDrag(document.querySelector('.kb-dock')), []);
}

export function BubbleTray() {
  usePanelManagerVersion();
  useDockSepDrag();
  const list = panelManager.bubbles().filter((b) => b.id !== SIDEBAR_ID);
  const host = typeof document !== 'undefined' ? document.querySelector('.kb-dock') : null;
  const tray =
    list.length > 0 ? (
      <div className="pm-bubble-tray" data-testid="pm-bubble-tray" role="toolbar" aria-label="收起的面板">
        <span className="pm-bubble-label">已收起</span>
        {list.map((b, index) => (
          <BubbleChip key={b.id} id={b.id} title={b.title} kind={b.kind} seq={b.seq} tray={b.tray} index={index} />
        ))}
      </div>
    ) : null;
  return (
    <>
      <DragShield />
      <TabsRestoreChip />
      {tray && host ? createPortal(tray, host) : tray}
    </>
  );
}
