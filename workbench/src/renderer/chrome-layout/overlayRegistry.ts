/**
 * 浮动遮挡层注册表（D-L1）
 * 停靠 chrome（menu/sidebar/status/tabs…）只收缩内容区，永不算 occlusion。
 * 仅浮动层（下拉菜单、对话框、popover）与内容矩形相交时才 occluded。
 */
export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FloatingOverlay {
  id: string;
  /** 屏幕坐标矩形 */
  rect: ScreenRect;
  /** 可选：kind 便于调试 */
  kind?: 'dropdown' | 'modal' | 'popover' | 'dialog' | string;
}

export function rectsIntersect(a: ScreenRect, b: ScreenRect): boolean {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
}

export type OverlayListener = () => void;

/** 渲染层菜单/模态向此登记；布局宿主只读 list */
export class OverlayRegistry {
  private readonly map = new Map<string, FloatingOverlay>();
  private readonly listeners = new Set<OverlayListener>();

  set(overlay: FloatingOverlay): void {
    this.map.set(overlay.id, { ...overlay, rect: { ...overlay.rect } });
    this.notify();
  }

  remove(id: string): void {
    if (this.map.delete(id)) this.notify();
  }

  clear(): void {
    if (this.map.size === 0) return;
    this.map.clear();
    this.notify();
  }

  list(): FloatingOverlay[] {
    return [...this.map.values()].map((o) => ({ ...o, rect: { ...o.rect } }));
  }

  subscribe(fn: OverlayListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    for (const fn of this.listeners) fn();
  }
}

/** 默认单例（renderer 菜单/对话框登记用） */
export const defaultOverlayRegistry = new OverlayRegistry();

/**
 * 是否被浮动层遮挡。
 * 停靠 chrome 不参与——调用方勿把 docked chrome 矩形塞进 overlays。
 */
export function isOccludedByOverlays(
  contentBounds: ScreenRect,
  overlays: readonly FloatingOverlay[],
): boolean {
  for (const o of overlays) {
    if (rectsIntersect(contentBounds, o.rect)) return true;
  }
  return false;
}
