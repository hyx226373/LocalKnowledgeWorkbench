export type SidebarWindowRequest = { action:'initialize'|'enter'|'exit'|'resize'|'pin'|'minimize'|'close'; width?:number; animate?:boolean; pinned?:boolean };

export type WindowState = { minimized: boolean; maximized: boolean; fullScreen: boolean };
export function shouldRecordBounds(state: WindowState): boolean {
  return !state.minimized && !state.maximized && !state.fullScreen;
}

/** Read-backs within this many DIP on every edge are the same rectangle. */
export const SIDEBAR_GEOMETRY_TOLERANCE = 3;

export type GeometryRect = { x: number; y: number; width: number; height: number };

/** True when every edge differs by at most `tol` DIP. The default matches fractional-DPI rounding. */
export function nearlySameRect(a: GeometryRect, b: GeometryRect, tol = SIDEBAR_GEOMETRY_TOLERANCE): boolean {
  return Math.abs(a.x - b.x) <= tol
    && Math.abs(a.y - b.y) <= tol
    && Math.abs(a.width - b.width) <= tol
    && Math.abs(a.height - b.height) <= tol;
}
