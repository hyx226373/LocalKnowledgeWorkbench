/**
 * desk-input (a): panel coordinates -> capture source real coordinates. Pure, no DOM / Electron.
 *
 * Chain:
 *   client CSS px (video element getBoundingClientRect, already includes the zoom transform)
 *     -> object-fit:contain content box (letterbox removed) -> normalized (u,v) in [0,1]
 *     -> source physical rect (screen source = monitor physical rect; window source = window physical rect)
 *     -> virtual-desktop absolute 0..65535 (SendInput MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK)
 * Renderer only sends (u,v). Physical rects / virtual desktop come from main (Electron screen); renderer coords are not trusted.
 */
export interface RectLike { x: number; y: number; width: number; height: number }
export interface NormPoint { u: number; v: number }
export interface PhysPoint { x: number; y: number }

export type InputSource =
  | { kind: 'screen'; physRect: RectLike }
  | { kind: 'window'; physRect: RectLike };

function finite(...n: number[]): boolean {
  return n.every((x) => typeof x === 'number' && Number.isFinite(x));
}

/** Drawn rect of object-fit: contain, relative to the element top-left. */
export function containRect(elW: number, elH: number, srcW: number, srcH: number): RectLike {
  if (!finite(elW, elH, srcW, srcH) || elW <= 0 || elH <= 0 || srcW <= 0 || srcH <= 0) return { x: 0, y: 0, width: 0, height: 0 };
  const s = Math.min(elW / srcW, elH / srcH);
  const width = srcW * s;
  const height = srcH * s;
  return { x: (elW - width) / 2, y: (elH - height) / 2, width, height };
}

/** Client point -> normalized source point. Outside the letterboxed content -> null. */
export function clientToNormalized(
  clientX: number,
  clientY: number,
  elementRect: RectLike,
  frame: { width: number; height: number },
): NormPoint | null {
  if (!finite(clientX, clientY, elementRect.x, elementRect.y, elementRect.width, elementRect.height)) return null;
  const c = containRect(elementRect.width, elementRect.height, frame.width, frame.height);
  if (c.width <= 0 || c.height <= 0) return null;
  const lx = clientX - elementRect.x - c.x;
  const ly = clientY - elementRect.y - c.y;
  if (lx < 0 || ly < 0 || lx > c.width || ly > c.height) return null;
  return { u: Math.min(lx / c.width, 1), v: Math.min(ly / c.height, 1) };
}

/** DIP rect -> physical px for one scale factor (mixed-DPI multi-monitor: prefer screen.dipToScreenRect in main). */
export function dipRectToPhysical(r: RectLike, scaleFactor: number): RectLike {
  const s = finite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
  return { x: Math.round(r.x * s), y: Math.round(r.y * s), width: Math.round(r.width * s), height: Math.round(r.height * s) };
}

/** Normalized -> source physical px (negative origins ok; last pixel = x + width - 1). */
export function normalizedToPhysical(p: NormPoint, source: InputSource): PhysPoint | null {
  const r = source.physRect;
  if (!finite(p.u, p.v, r.x, r.y, r.width, r.height) || r.width <= 0 || r.height <= 0) return null;
  if (p.u < 0 || p.u > 1 || p.v < 0 || p.v > 1) return null;
  const x = r.x + Math.min(Math.floor(p.u * r.width), r.width - 1);
  const y = r.y + Math.min(Math.floor(p.v * r.height), r.height - 1);
  return { x, y };
}

/** Union of monitor physical rects = virtual desktop (SM_XVIRTUALSCREEN equivalent). */
export function virtualDesktopRect(displays: RectLike[]): RectLike {
  if (!displays.length) return { x: 0, y: 0, width: 0, height: 0 };
  const l = Math.min(...displays.map((d) => d.x));
  const t = Math.min(...displays.map((d) => d.y));
  const r = Math.max(...displays.map((d) => d.x + d.width));
  const b = Math.max(...displays.map((d) => d.y + d.height));
  return { x: l, y: t, width: r - l, height: b - t };
}

/** Physical point -> SendInput absolute 0..65535 over the virtual desktop. Outside -> null. */
export function physicalToAbsolute(p: PhysPoint, vd: RectLike): { ax: number; ay: number } | null {
  if (!finite(p.x, p.y) || vd.width <= 1 || vd.height <= 1) return null;
  if (p.x < vd.x || p.y < vd.y || p.x >= vd.x + vd.width || p.y >= vd.y + vd.height) return null;
  const ax = Math.round(((p.x - vd.x) * 65535) / (vd.width - 1));
  const ay = Math.round(((p.y - vd.y) * 65535) / (vd.height - 1));
  return { ax, ay };
}

export function mapNormalizedToInjection(p: NormPoint, source: InputSource, vd: RectLike): { phys: PhysPoint; abs: { ax: number; ay: number } } | null {
  const phys = normalizedToPhysical(p, source);
  if (!phys) return null;
  const abs = physicalToAbsolute(phys, vd);
  if (!abs) return null;
  return { phys, abs };
}

/** DOM WheelEvent -> WHEEL_DELTA(120) units. DOM +deltaY = down, Windows +mouseData = up, so vertical is negated. */
export function wheelToMouseData(deltaY: number, deltaX: number, deltaMode: number): { vertical: number; horizontal: number } {
  const scale = deltaMode === 1 ? 120 : deltaMode === 2 ? 360 : 1.2;
  const clamp = (n: number) => Math.max(-1200, Math.min(1200, Math.round(n) || 0));
  return { vertical: clamp(-deltaY * scale), horizontal: clamp(deltaX * scale) };
}