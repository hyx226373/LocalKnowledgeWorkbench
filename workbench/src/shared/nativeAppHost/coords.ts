/**
 * Screen ↔ panel client coordinate conversion with DPI / scaleFactor.
 *
 * Contract (host-r1 L2 / 01 §2.1):
 * - Electron screen / panelToScreen / screenToPanel units = DIP (CSS px).
 * - Physical pixels (Win32 SetWindowPos child client) = DIP × scaleFactor.
 * - Never hard-code 96 DPI — always use Display.scaleFactor from Electron `screen`.
 * - Empty `displays[]` → pickDisplayForRect falls back to scaleFactor=1 (CALLER BUG;
 *   plugin must pass real screen.getAllDisplays(); this caused L2 drift at 1.25).
 * - Integer rounding for OS: Math.trunc toward zero (matches win32KoffiHelper.setBounds).
 */
import type { DisplayMetrics, NativeHostPoint, NativeHostRect, PanelScreenRect } from './types';

/** Convert screen point → panel-local client coordinates (DIP; no scale multiply). */
export function screenToPanel(point: NativeHostPoint, panel: PanelScreenRect): NativeHostPoint {
  return {
    x: point.x - panel.x,
    y: point.y - panel.y,
  };
}

/** Convert panel-local client coordinates → screen point (DIP; no scale multiply). */
export function panelToScreen(point: NativeHostPoint, panel: PanelScreenRect): NativeHostPoint {
  return {
    x: point.x + panel.x,
    y: point.y + panel.y,
  };
}

/**
 * Map a panel-local CSS/DIP point into physical pixels relative to the panel
 * origin on the hosting display (for SetWindowPos physical-pixel backends).
 */
export function panelDipToPhysical(point: NativeHostPoint, scaleFactor: number): NativeHostPoint {
  const s = assertScale(scaleFactor);
  return { x: point.x * s, y: point.y * s };
}

export function physicalToPanelDip(point: NativeHostPoint, scaleFactor: number): NativeHostPoint {
  const s = assertScale(scaleFactor);
  return { x: point.x / s, y: point.y / s };
}

/** Expand panel DIP rect to physical pixels for OS SetWindowPos when needed. */
export function rectDipToPhysical(rect: NativeHostRect, scaleFactor: number): NativeHostRect {
  const s = assertScale(scaleFactor);
  return {
    x: rect.x * s,
    y: rect.y * s,
    width: rect.width * s,
    height: rect.height * s,
  };
}

export function rectPhysicalToDip(rect: NativeHostRect, scaleFactor: number): NativeHostRect {
  const s = assertScale(scaleFactor);
  return {
    x: rect.x / s,
    y: rect.y / s,
    width: rect.width / s,
    height: rect.height / s,
  };
}

/**
 * DIP → physical with Math.trunc (toward zero), matching koffi helper SetWindowPos.
 * Use this for layout→OS bounds so fractional DIP×scale does not accumulate drift.
 */
export function rectDipToPhysicalTrunc(rect: NativeHostRect, scaleFactor: number): NativeHostRect {
  const p = rectDipToPhysical(rect, scaleFactor);
  return {
    x: Math.trunc(p.x),
    y: Math.trunc(p.y),
    width: Math.max(0, Math.trunc(p.width)),
    height: Math.max(0, Math.trunc(p.height)),
  };
}

export function panelDipToPhysicalTrunc(point: NativeHostPoint, scaleFactor: number): NativeHostPoint {
  const p = panelDipToPhysical(point, scaleFactor);
  return { x: Math.trunc(p.x), y: Math.trunc(p.y) };
}

/**
 * Pick the display that contains the center of `rect` (or first fallback).
 * Mirrors Electron screen.getDisplayMatching behaviour for pure-logic tests.
 *
 * WARNING: empty `displays` → synthetic primary with scaleFactor=1. That is NOT
 * a valid substitute for a real 125% display; plugin/layout must never pass [].
 */
export function pickDisplayForRect(rect: NativeHostRect, displays: DisplayMetrics[]): DisplayMetrics {
  if (!displays.length) {
    return { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
  }
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  for (const d of displays) {
    const b = d.bounds;
    if (cx >= b.x && cx < b.x + b.width && cy >= b.y && cy < b.y + b.height) return d;
  }
  // Nearest by center distance
  let best = displays[0]!;
  let bestDist = Infinity;
  for (const d of displays) {
    const bx = d.bounds.x + d.bounds.width / 2;
    const by = d.bounds.y + d.bounds.height / 2;
    const dist = (bx - cx) ** 2 + (by - cy) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  return best;
}

/**
 * Build SetWindowPos target rect from panel geometry.
 * - usePhysical=false (default, current host.setBounds path): pass DIP/client numbers through.
 * - usePhysical=true: DIP × scaleFactor, truncated for Win32.
 */
export function panelBoundsForNative(
  panel: PanelScreenRect,
  opts?: { usePhysical?: boolean },
): NativeHostRect {
  const rect: NativeHostRect = {
    x: panel.x,
    y: panel.y,
    width: panel.width,
    height: panel.height,
  };
  if (opts?.usePhysical) return rectDipToPhysicalTrunc(rect, panel.scaleFactor);
  return rect;
}

function assertScale(scaleFactor: number): number {
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) {
    throw new Error(`invalid scaleFactor: ${scaleFactor} (must come from Electron screen, not hard-coded 96 DPI)`);
  }
  return scaleFactor;
}
