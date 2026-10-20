/**
 * 网页面板与浮动窗口的遮挡判断。网页是主进程的原生视图，总是画在主窗口 DOM 之上，CSS z-index 对它无效；
 * 因此：任何“层级比网页所在窗口更高”的浮动窗口（含浮动侧栏）与网页区域相交时，WebSurface 隐藏原生视图、显示最近一帧截图
 * （与菜单/对话框相同的机制，docs/06 §11.3）。网页窗口被带到最上层（点击其标签/标题栏）后同一帧恢复为真网页。
 *
 * 拖动/缩放浮动窗或停靠预览出现时，额外视为全覆盖（对齐预览 drag-shield），避免原生网页吃掉指针。
 */
function zOf(el: Element): number {
  const z = parseInt(getComputedStyle(el).zIndex, 10);
  return Number.isFinite(z) ? z : NaN;
}
/** 网页区域所在窗口的层级：浮动窗口（.dv-resize-container）或常驻渲染层（.dv-render-overlay-float）的 z-index；分屏中为 0 */
export function ownLayer(slot: Element): number {
  for (let e = slot.parentElement; e; e = e.parentElement) {
    if (e.classList.contains('dv-render-overlay') || e.classList.contains('dv-resize-container')) {
      const z = zOf(e);
      if (Number.isFinite(z)) return z;
    }
    if (e.classList.contains('dv-dockview')) break;
  }
  return 0;
}

function hasSelector(root: ParentNode | Document, sel: string): boolean {
  const doc = root as ParentNode & {
    querySelector?: (s: string) => Element | null;
    querySelectorAll?: (s: string) => ArrayLike<Element>;
  };
  if (typeof doc.querySelector === 'function') return !!doc.querySelector(sel);
  if (typeof doc.querySelectorAll === 'function') return doc.querySelectorAll(sel).length > 0;
  return false;
}

/**
 * Drag/dock-preview period: treat as full cover so native web does not eat pointers.
 * Only look at real drag/drop markers. Do NOT include `.pm-drag-shield` itself —
 * that element is mounted by DragShield FROM this function; including it latches
 * forever and leaves web panels stuck on the temporary-hide placeholder.
 */
export function dragShieldActive(root: ParentNode = document): boolean {
  if (hasSelector(root, '.dv-resize-container-dragging')) return true;
  if (hasSelector(root, '.dv-drop-target-selection')) return true;
  if (hasSelector(root, '.dv-drop-target-anchor')) return true;
  if (hasSelector(root, '.dv-sash[data-pm-dragging="true"]')) return true;
  return false;
}

/** 当前盖在 slot 上、层级更高的浮动窗口（e2e 也用） */
export function coveringWindows(slot: Element, r: DOMRect): Element[] {
  const own = ownLayer(slot);
  const out: Element[] = [];
  for (const el of document.querySelectorAll('.dv-resize-container')) {
    if (el.classList.contains('dv-hidden') || el.hasAttribute('data-pm-collapsed') || el.contains(slot)) continue;
    const z = zOf(el);
    if (!(z > own)) continue;
    const o = el.getBoundingClientRect();
    if (o.width > 0 && o.height > 0 && o.left < r.right && r.left < o.right && o.top < r.bottom && r.top < o.bottom) out.push(el);
  }
  return out;
}

export function windowCoverProbe(slot: Element, r: DOMRect): boolean {
  if (dragShieldActive()) return true;
  return coveringWindows(slot, r).length > 0;
}
