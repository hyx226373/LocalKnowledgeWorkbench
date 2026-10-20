/** 预览 resize-grip：右下角跟手缩放，尺寸写回 PanelManager。 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { MIN_FLOAT, resizeDelta } from './geometry';
import { panelManager } from './instance';
import { usePanelManagerVersion } from './react';

function sameFrames(a: { id: string; element: HTMLElement }[], b: { id: string; element: HTMLElement }[]) {
  return a.length === b.length && a.every((item, i) => item.id === b[i].id && item.element === b[i].element);
}

function ResizeGrip({ id }: { id: string }) {
  return (
    <button
      type="button"
      className="resize-grip"
      data-testid="pm-resize-grip"
      aria-label="调整大小"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const info = panelManager.get(id);
        const start = info?.bounds;
        if (!start) return;
        const host = event.currentTarget.parentElement;
        host?.classList.add('dv-resize-container-dragging');
        const originX = event.clientX;
        const originY = event.clientY;
        const move = (ev: PointerEvent) => {
          const next = resizeDelta(start, ev.clientX - originX, ev.clientY - originY, panelManager.containerSize(), MIN_FLOAT, 12);
          panelManager.resize(id, next, { commit: false });
        };
        const end = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', end);
          window.removeEventListener('pointercancel', end);
          host?.classList.remove('dv-resize-container-dragging');
          const latest = panelManager.get(id)?.bounds;
          if (latest) panelManager.resize(id, { width: latest.width, height: latest.height });
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', end);
        window.addEventListener('pointercancel', end);
      }}
    />
  );
}

/** 每个浮动窗口一枚手柄，portal 到 dockview overlay。 */
export function FloatResizeGrips() {
  const version = usePanelManagerVersion();
  const [frames, setFrames] = useState<{ id: string; element: HTMLElement }[]>([]);
  useEffect(() => {
    let raf1 = 0;
    let raf2 = 0;
    const sync = () => {
      const next = panelManager.floatingFrames();
      setFrames((prev) => (sameFrames(prev, next) ? prev : next));
    };
    sync();
    raf1 = requestAnimationFrame(() => {
      sync();
      raf2 = requestAnimationFrame(sync);
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [version]);
  return (
    <>
      {frames.map((frame) => createPortal(<ResizeGrip key={frame.id} id={frame.id} />, frame.element))}
    </>
  );
}
