import { cacheDisplaysFromLayout } from './chrome';
/**
 * layout.* event consumer — aligned with freeze v1 (02-chrome-layout-schema.md §5).
 * Plugin listens to layout.* (filtered by panelId where applicable).
 * Layout host sends layout.* state events (v1 four + L2 displaysChanged).
 * Plugin product-path may ONLY dispatch `layout.requestActivate` (never host.activate).
 * Never call host.setBounds / setVisible / activate from this module.
 */

/** Matches LayoutChangeReason in chromeLayout / 02 §1. */
export type LayoutChangeReason =
  | 'chrome-toggle'
  | 'content-only'
  | 'edit-drag'
  | 'restore'
  | 'workspace-open'
  | 'dpi-change'
  | 'layout-adjust';

/** v1 four + L2 displaysChanged. */
export const LAYOUT_EVENTS = {
  contentBoundsChanged: 'layout.contentBoundsChanged',
  chromeVisibilityChanged: 'layout.chromeVisibilityChanged',
  hostOcclusionChanged: 'layout.hostOcclusionChanged',
  editModeChanged: 'layout.editModeChanged',
  displaysChanged: 'layout.displaysChanged',
} as const;

export type LayoutEventName = (typeof LAYOUT_EVENTS)[keyof typeof LAYOUT_EVENTS];

export const LAYOUT_EVENT_NAMES: readonly LayoutEventName[] = [
  LAYOUT_EVENTS.contentBoundsChanged,
  LAYOUT_EVENTS.chromeVisibilityChanged,
  LAYOUT_EVENTS.hostOcclusionChanged,
  LAYOUT_EVENTS.editModeChanged,
  LAYOUT_EVENTS.displaysChanged,
];

export interface ContentBoundsPayload {
  panelId: string;
  bounds: { x: number; y: number; w: number; h: number; scaleFactor?: number };
  /** Required (v1). */
  reason: LayoutChangeReason;
}

export interface DisplaysChangedPayload {
  displays: Array<{
    id?: number;
    bounds: { x: number; y: number; width: number; height: number };
    scaleFactor: number;
  }>;
}

export interface ChromeVisibilityPayload {
  visibility: Record<string, boolean>;
  /** Required boolean (v1). */
  contentOnly: boolean;
  /** Required (v1). */
  reason: LayoutChangeReason;
}

/** Occlusion payload has no reason field (v1). */
export interface HostOcclusionPayload {
  panelId: string;
  occluded: boolean;
}

export interface EditModePayload {
  editMode: boolean;
  dirty: boolean;
}

export type LayoutEventPayload =
  | { name: typeof LAYOUT_EVENTS.contentBoundsChanged; detail: ContentBoundsPayload }
  | { name: typeof LAYOUT_EVENTS.chromeVisibilityChanged; detail: ChromeVisibilityPayload }
  | { name: typeof LAYOUT_EVENTS.hostOcclusionChanged; detail: HostOcclusionPayload }
  | { name: typeof LAYOUT_EVENTS.editModeChanged; detail: EditModePayload }
  | { name: typeof LAYOUT_EVENTS.displaysChanged; detail: DisplaysChangedPayload };

export interface LayoutUiState {
  contentBounds: { x: number; y: number; w: number; h: number; scaleFactor?: number } | null;
  /** Last reason that updated content bounds (optional UI hint). */
  contentBoundsReason?: LayoutChangeReason;
  contentBoundsScale?: number;
  chromeVisibility: Record<string, boolean>;
  contentOnly: boolean;
  chromeVisibilityReason?: LayoutChangeReason;
  occluded: boolean;
  editMode: boolean;
  dirty: boolean;
  displays: DisplaysChangedPayload['displays'];
}

export function emptyLayoutUiState(): LayoutUiState {
  return {
    contentBounds: null,
    chromeVisibility: {},
    contentOnly: false,
    occluded: false,
    editMode: false,
    dirty: false,
    displays: [],
  };
}

type Listener = (ev: LayoutEventPayload) => void;

const listeners = new Set<Listener>();

/** Prefer globalThis.window so Node tests can mock without a lexical `window` binding. */
function getWindow(): {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  dispatchEvent(event: Event): boolean;
} | undefined {
  const w = (globalThis as { window?: unknown }).window;
  if (
    w &&
    typeof w === 'object' &&
    typeof (w as { addEventListener?: unknown }).addEventListener === 'function' &&
    typeof (w as { removeEventListener?: unknown }).removeEventListener === 'function' &&
    typeof (w as { dispatchEvent?: unknown }).dispatchEvent === 'function'
  ) {
    return w as {
      addEventListener(type: string, listener: EventListener): void;
      removeEventListener(type: string, listener: EventListener): void;
      dispatchEvent(event: Event): boolean;
    };
  }
  return undefined;
}


function notifyInProcess(ev: LayoutEventPayload): void {
  for (const cb of listeners) cb(ev);
}

function parseWindowDetail(name: LayoutEventName, detail: unknown): LayoutEventPayload | null {
  if (!detail || typeof detail !== 'object') return null;
  const d = detail as Record<string, unknown>;
  switch (name) {
    case LAYOUT_EVENTS.contentBoundsChanged: {
      if (typeof d.panelId !== 'string' || !d.bounds || typeof d.reason !== 'string') return null;
      return {
        name,
        detail: {
          panelId: d.panelId,
          bounds: d.bounds as ContentBoundsPayload['bounds'],
          reason: d.reason as LayoutChangeReason,
        },
      };
    }
    case LAYOUT_EVENTS.chromeVisibilityChanged: {
      if (typeof d.contentOnly !== 'boolean' || typeof d.reason !== 'string') return null;
      return {
        name,
        detail: {
          visibility: (d.visibility ?? {}) as Record<string, boolean>,
          contentOnly: d.contentOnly,
          reason: d.reason as LayoutChangeReason,
        },
      };
    }
    case LAYOUT_EVENTS.hostOcclusionChanged: {
      if (typeof d.panelId !== 'string' || typeof d.occluded !== 'boolean') return null;
      return { name, detail: { panelId: d.panelId, occluded: d.occluded } };
    }
    case LAYOUT_EVENTS.editModeChanged: {
      if (typeof d.editMode !== 'boolean' || typeof d.dirty !== 'boolean') return null;
      return { name, detail: { editMode: d.editMode, dirty: d.dirty } };
    }
    case LAYOUT_EVENTS.displaysChanged: {
      const displays = d.displays;
      if (!Array.isArray(displays) || displays.length === 0) return null;
      return { name, detail: { displays: displays as DisplaysChangedPayload['displays'] } };
    }
    default:
      return null;
  }
}

/**
 * @internal test-only — product path (UI / actions) must NOT call this.
 * Layout host is the sole product sender via
 * `window.dispatchEvent(new CustomEvent(eventName, { detail: v1Payload }))`.
 * This helper only notifies in-process subscribers (no CustomEvent) so tests can
 * drive reduce/subscribe without double-firing the window path.
 */
export function emitLayoutEvent(ev: LayoutEventPayload): void {
  notifyInProcess(ev);
}

/**
 * Subscribe to layout.* — in-process bus + window CustomEvent (detail = v1 payload).
 * Layout host product path: only CustomEvent; plugin receives via window listeners.
 */
export function subscribeLayoutEvents(cb: Listener): () => void {
  listeners.add(cb);

  const windowHandlers: Array<{ name: LayoutEventName; handler: EventListener }> = [];
  const win = getWindow();
  if (win) {
    for (const name of LAYOUT_EVENT_NAMES) {
      const handler: EventListener = (e: Event) => {
        const detail = (e as CustomEvent).detail;
        const parsed = parseWindowDetail(name, detail);
        if (parsed) cb(parsed);
      };
      win.addEventListener(name, handler);
      windowHandlers.push({ name, handler });
    }
  }

  return () => {
    listeners.delete(cb);
    const w = getWindow();
    if (w) {
      for (const { name, handler } of windowHandlers) {
        w.removeEventListener(name, handler);
      }
    }
  };
}

/** Reduce layout UI state from an event — never calls host.setBounds. */
export function reduceLayoutUi(state: LayoutUiState, ev: LayoutEventPayload): LayoutUiState {
  switch (ev.name) {
    case LAYOUT_EVENTS.contentBoundsChanged:
      return {
        ...state,
        contentBounds: { ...ev.detail.bounds },
        contentBoundsReason: ev.detail.reason,
        contentBoundsScale:
          typeof ev.detail.bounds.scaleFactor === 'number' && ev.detail.bounds.scaleFactor > 0
            ? ev.detail.bounds.scaleFactor
            : state.contentBoundsScale,
      };
    case LAYOUT_EVENTS.chromeVisibilityChanged:
      return {
        ...state,
        chromeVisibility: { ...ev.detail.visibility },
        contentOnly: ev.detail.contentOnly,
        chromeVisibilityReason: ev.detail.reason,
      };
    case LAYOUT_EVENTS.hostOcclusionChanged:
      return {
        ...state,
        occluded: ev.detail.occluded,
      };
    case LAYOUT_EVENTS.editModeChanged:
      return {
        ...state,
        editMode: ev.detail.editMode,
        dirty: ev.detail.dirty,
      };
    case LAYOUT_EVENTS.displaysChanged: {
      cacheDisplaysFromLayout(ev.detail.displays);
      return {
        ...state,
        displays: ev.detail.displays.map((d) => ({
          ...d,
          bounds: { ...d.bounds },
        })),
      };
    }
    default:
      return state;
  }
}


/**
 * P-1: multi-panel isolation.
 * - contentBounds / hostOcclusion: only when detail.panelId === this panel.
 * - chromeVisibility / editMode: global (v1 has no panelId) → apply; if a future
 *   panelId is present on detail, filter to matching panel only.
 */
export function appliesToPanel(ev: LayoutEventPayload, panelId: string): boolean {
  switch (ev.name) {
    case LAYOUT_EVENTS.contentBoundsChanged:
    case LAYOUT_EVENTS.hostOcclusionChanged:
      return ev.detail.panelId === panelId;
    case LAYOUT_EVENTS.chromeVisibilityChanged:
    case LAYOUT_EVENTS.editModeChanged:
    case LAYOUT_EVENTS.displaysChanged: {
      const maybeId = (ev.detail as { panelId?: unknown }).panelId;
      if (typeof maybeId === 'string') return maybeId === panelId;
      return true;
    }
    default:
      return false;
  }
}

/** Reduce only if event applies to this panelId; otherwise return state unchanged. */
export function reduceLayoutUiForPanel(
  state: LayoutUiState,
  ev: LayoutEventPayload,
  panelId: string,
): LayoutUiState {
  if (!appliesToPanel(ev, panelId)) return state;
  return reduceLayoutUi(state, ev);
}

/** Plugin→layout-host reverse event (OPEN-1). Only outbound layout event from plugin. */
export const LAYOUT_REQUEST_ACTIVATE = 'layout.requestActivate' as const;

export type RequestActivateReason = 'user-enter' | 'panel-focus';

export interface RequestActivateDetail {
  panelId: string;
  reason: RequestActivateReason;
}

/**
 * Ask layout host to activate/focus the hosted window for this panel.
 * Does NOT call host.activate — layout host consumes this CustomEvent.
 */

/** Duck-type DOM Node (works in browser; Node may be absent in electron-node tests). */
function isDomNode(x: EventTarget | null | undefined): x is Node {
  return (
    !!x &&
    typeof x === 'object' &&
    typeof (x as { nodeType?: unknown }).nodeType === 'number' &&
    typeof (x as { contains?: unknown }).contains === 'function'
  );
}

/**
 * N-1: only request panel-focus when focus enters from outside the panel container.
 * Intra-panel focus moves (button→button) must NOT fire panel-focus.
 * relatedTarget === null / non-Node → treat as entering from outside.
 */
export function shouldRequestPanelFocus(opts: {
  bound: boolean;
  container: EventTarget | null;
  relatedTarget: EventTarget | null;
}): boolean {
  if (!opts.bound) return false;
  if (!isDomNode(opts.container)) return false;
  const related = opts.relatedTarget;
  if (related == null || !isDomNode(related)) return true;
  return !opts.container.contains(related);
}

export function requestActivate(panelId: string, reason: RequestActivateReason): boolean {
  const win = getWindow();
  if (!win) return false;
  const detail: RequestActivateDetail = { panelId, reason };
  try {
    if (typeof CustomEvent === 'function') {
      return win.dispatchEvent(new CustomEvent(LAYOUT_REQUEST_ACTIVATE, { detail }));
    }
  } catch {
    // fall through to plain event object (test mocks)
  }
  return win.dispatchEvent({ type: LAYOUT_REQUEST_ACTIVATE, detail } as unknown as Event);
}

/**
 * layoutAdjust ActionId handler (plugin side): reflect last known layout.* UI state —
 * does NOT call host.setBounds/setVisible/activate and does NOT emit layout.* events.
 */
export function layoutAdjustReflect(state: LayoutUiState): {
  ok: true;
  reflected: LayoutUiState;
  note: string;
} {
  return {
    ok: true,
    reflected: { ...state },
    note: 'plugin consumes layout.* only; host.setBounds owned by layout host',
  };
}
