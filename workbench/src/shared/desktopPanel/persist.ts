/**
 * 工作区持久化：DesktopPanelLayoutPersist（01 §8）。
 * 禁止持久化 captureId / sessionId / lastPointer。
 */
import type { Rect, SourceDescriptor } from './types';
import { DESKTOP_PANEL_VIEW_TYPE } from './commands';

export interface DesktopPanelLayoutPersist {
  v: 1;
  viewType: typeof DESKTOP_PANEL_VIEW_TYPE;
  source: SourceDescriptor;
  panel: {
    mode: 'float' | 'tile' | 'maximized' | 'bubble';
    bounds?: Rect;
    bubbleCollapsed?: boolean;
  };
  displaySettings: {
    objectFit: 'contain';
    showToolbar: boolean;
  };
}

/** 视图状态壳：可序列化进 WorkspaceItem.state.data；恢复默认 viewing */
export interface DesktopPanelViewState {
  layout: DesktopPanelLayoutPersist;
  /** 明确不存：captureId / sessionId */
}

export function isDesktopPanelLayoutPersist(raw: unknown): raw is DesktopPanelLayoutPersist {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || o.viewType !== DESKTOP_PANEL_VIEW_TYPE) return false;
  if (!o.source || typeof o.source !== 'object') return false;
  const src = o.source as Record<string, unknown>;
  if (src.v !== 1 || typeof src.displayKey !== 'string') return false;
  if ('captureId' in o || 'sessionId' in o) return false;
  return true;
}

export function stripForbiddenPersistFields(raw: Record<string, unknown>): Record<string, unknown> {
  const { captureId: _c, sessionId: _s, lastPointer: _p, ...rest } = raw;
  return rest;
}

export function defaultLayoutPersist(source: SourceDescriptor): DesktopPanelLayoutPersist {
  return {
    v: 1,
    viewType: DESKTOP_PANEL_VIEW_TYPE,
    source,
    panel: { mode: 'tile' },
    displaySettings: { objectFit: 'contain', showToolbar: true },
  };
}
