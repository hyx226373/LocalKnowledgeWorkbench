/**
 * host-r1 native-app-host shared types — aligned with 01-共用接口.md
 * Directory isolation: never import desktopPanel.
 */

/** Frozen view type string (01 §1). */
export const NATIVE_APP_HOST_VIEW_TYPE = 'native-app-host' as const;
export type NativeAppHostViewType = typeof NATIVE_APP_HOST_VIEW_TYPE;

/** Binding state machine (product surface). */
export type NativeHostBindingState =
  | 'idle'
  | 'attached'
  | 'invalid'
  | 'hidden-for-modal';

/** Runtime identity after attach (01 §2.2). hwnd is runtime-only. */
export interface NativeHostIdentity {
  /** HWND as decimal string (runtime only; never persist). */
  hwnd: string;
  pid: number;
  /** Process creation time (ms since Unix epoch, from OS). */
  createTime: number;
  /** Absolute executable image path. */
  path: string;
}

/** Candidate window for user selection (host.list). */
export interface NativeHostCandidate {
  hwnd: string;
  pid: number;
  createTime: number;
  path: string;
  title: string;
  className?: string;
  bounds: NativeHostRect;
  visible: boolean;
}

export interface NativeHostRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NativeHostPoint {
  x: number;
  y: number;
}

/** Display metrics for DPI-aware conversion (Electron screen). */
export interface DisplayMetrics {
  /** Virtual-desktop origin of this display (physical/CSS dip as Electron reports). */
  bounds: NativeHostRect;
  /** Electron Display.scaleFactor (e.g. 1, 1.25, 1.5, 2). Never hard-code 96 DPI. */
  scaleFactor: number;
  /** Electron display.id when known. */
  id?: number;
}

/** Panel client rect in screen space (same units as Electron screen coords). */
export interface PanelScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Scale factor of the display containing the panel (or primary). */
  scaleFactor: number;
}

/** attachPolicy for workspace restore (01 §5). */
export type NativeHostAttachPolicy = 'reselect-on-restore';

/**
 * Persistable workspace fields (01 §5).
 * Forbidden: hwnd, transient pid (except debug-only off-by-default).
 */
export interface NativeAppHostPersist {
  viewType: NativeAppHostViewType;
  hostPath: string;
  titleHint: string;
  layout: { x: number; y: number; w: number; h: number };
  attachPolicy: NativeHostAttachPolicy;
}

/** Live binding snapshot from host.getState. */
export interface NativeHostStateSnapshot {
  bindingId: string | null;
  state: NativeHostBindingState;
  identity: NativeHostIdentity | null;
  bounds: NativeHostRect | null;
  visible: boolean;
  /** True when OS reports the hwnd is still a live window. */
  alive: boolean;
  panelId?: string;
  reason?: string;
}

export interface HostListDiagnostics {
  enumerated: number;
  candidates: number;
  errors: number;
  skippedNoIdentity: number;
  firstError: string | null;
}

export interface HostListResult {
  ok: true;
  candidates: NativeHostCandidate[];
  platform: NodeJS.Platform;
  /** host-r1 L2: why the list may be short (helper-side counters). */
  diagnostics?: HostListDiagnostics;
}

export interface HostListError {
  ok: false;
  code: 'PLATFORM_UNSUPPORTED' | 'HELPER_UNAVAILABLE' | 'ENUM_FAILED';
  message: string;
  platform: NodeJS.Platform;
}

export type HostListResponse = HostListResult | HostListError;

export interface HostAttachRequest {
  /** Explicit user-selected candidate (no silent attach). */
  identity: Pick<NativeHostIdentity, 'hwnd' | 'pid' | 'createTime' | 'path'>;
  panelId: string;
  /** Optional initial bounds in screen coords. */
  bounds?: NativeHostRect;
}

export interface HostAttachResult {
  ok: true;
  bindingId: string;
  identity: NativeHostIdentity;
  state: NativeHostBindingState;
}

export interface HostOpError {
  ok: false;
  code:
    | 'PLATFORM_UNSUPPORTED'
    | 'HELPER_UNAVAILABLE'
    | 'NOT_FOUND'
    | 'INVALID_BINDING'
    | 'NOT_ATTACHED'
    | 'UNAUTHORIZED'
    | 'ALREADY_ATTACHED'
    | 'IDENTITY_MISMATCH'
    | 'IDENTITY_INCOMPLETE'
    | 'OS_ERROR';
  message: string;
  /** host-r1 L2: identity fields missing/invalid in the attach request. */
  missing?: string[];
}

export type HostAttachResponse = HostAttachResult | HostOpError;

export interface HostDetachRequest {
  /** bindingId returned by host.attach (preferred). */
  bindingId?: string;
  /** host-r1 L2: panelId the binding was attached to (fallback lookup). */
  panelId?: string;
}

export interface HostSetBoundsRequest {
  bindingId: string;
  bounds: NativeHostRect;
}

export interface HostSetVisibleRequest {
  bindingId: string;
  visible: boolean;
  /** When true, transition to/from hidden-for-modal. */
  forModal?: boolean;
}

export interface HostActivateRequest {
  bindingId: string;
  /** true = focus hosted window; false = yield focus to workbench. */
  focusHost: boolean;
}

export interface HostGetStateRequest {
  bindingId?: string;
  panelId?: string;
}

export interface HostCoordRequest {
  point: NativeHostPoint;
  panel: PanelScreenRect;
}

export interface HostCoordResult {
  ok: true;
  point: NativeHostPoint;
}

export type HostCoordResponse = HostCoordResult | HostOpError;
export type HostOkResponse = { ok: true } | HostOpError;
export type HostStateResponse =
  | { ok: true; snapshot: NativeHostStateSnapshot }
  | HostOpError;
