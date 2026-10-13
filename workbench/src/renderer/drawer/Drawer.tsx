import { useLayoutEffect, useRef, type PointerEventHandler, type ReactNode } from 'react';
import { DrawerCards } from './cards';
import {
  DRAWER_MODULE_LABEL,
  clampDrawerWidth,
  normalizeDrawerSelection,
  toggleDrawerSelection,
  type DrawerModuleId,
} from './order';
import './drawer.css';
import './module.css';

export type DrawerProps = {
  open: boolean;
  /** 展开宽度。默认 360，夹在 300–440。收起时容器宽度为 0，与此值无关。 */
  width?: number;
  onWidth: (width: number) => void;
  selection: readonly DrawerModuleId[];
  onSelectionChange: (selection: DrawerModuleId[]) => void;
  slots: Partial<Record<DrawerModuleId, React.ReactNode>>;
};

function slotNode(slots: DrawerProps['slots'], id: DrawerModuleId): ReactNode | null {
  const node = slots[id];
  if (node == null || node === false) return null;
  return node;
}

export function Drawer({ open, width = 360, onWidth, selection, onSelectionChange, slots }: DrawerProps) {
  const rootRef = useRef<HTMLElement>(null);
  const shown = clampDrawerWidth(width);
  const ordered = normalizeDrawerSelection(selection);

  useLayoutEffect(() => {
    if (open) return;
    const root = rootRef.current;
    const active = document.activeElement;
    if (root && active instanceof HTMLElement && root.contains(active)) active.blur();
  }, [open]);

  const onSashDown: PointerEventHandler<HTMLDivElement> = (event) => {
    if (!open) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startW = shown;
    handle.setPointerCapture(event.pointerId);
    const move = (ev: PointerEvent) => onWidth(clampDrawerWidth(startW + ev.clientX - startX));
    const end = (ev: PointerEvent) => {
      if (handle.hasPointerCapture(ev.pointerId)) handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };

  return (
    <aside
      ref={rootRef}
      className="kb-drawer"
      data-testid="kb-drawer"
      data-open={open ? 'true' : 'false'}
      style={{ width: open ? shown : 0 }}
      inert={!open}
      aria-hidden={open ? undefined : true}
      aria-label="资料抽屉"
    >
      <div className="kb-drawer-body">
        <DrawerCards selection={ordered} onToggle={(id) => onSelectionChange(toggleDrawerSelection(ordered, id))} />
        {ordered.length > 0 && (
          <div className="kb-drawer-modules" data-testid="drawer-modules">
            {ordered.map((id) => {
              const node = slotNode(slots, id);
              return (
                <section key={id} className="kb-drawer-module" data-module={id} data-testid={`drawer-slot-${id}`}>
                  {node ?? (
                    <p className="kb-drawer-pending" data-testid={`drawer-pending-${id}`}>
                      <span className="kb-drawer-pending-name">{DRAWER_MODULE_LABEL[id]}</span>
                      <span>尚未挂接</span>
                    </p>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>
      {open && (
        <div
          className="kb-drawer-sash"
          role="slider"
          tabIndex={0}
          aria-label="调整资料抽屉宽度"
          aria-valuemin={300}
          aria-valuemax={440}
          aria-valuenow={Math.round(shown)}
          onPointerDown={onSashDown}
          onKeyDown={(event) => {
            const step = event.shiftKey ? 24 : 8;
            if (event.key === 'ArrowRight') {
              event.preventDefault();
              onWidth(clampDrawerWidth(shown + step));
            } else if (event.key === 'ArrowLeft') {
              event.preventDefault();
              onWidth(clampDrawerWidth(shown - step));
            }
          }}
        />
      )}
    </aside>
  );
}
