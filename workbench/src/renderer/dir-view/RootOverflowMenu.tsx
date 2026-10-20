import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { kb } from '../kb';
import { EllipsisIcon } from '../ui/shellMarks';
import { rootRowMoreItems, type RootMoreItem } from './rootMoreMenu';

export function RootMoreMenuView({ items, style }: { items: RootMoreItem[]; style?: CSSProperties }) {
  return (
    <div
      className="kb-more-menu"
      role="menu"
      data-testid="root-more-menu"
      style={style}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          data-testid={item.testId}
          disabled={item.disabled || undefined}
          aria-disabled={item.disabled ? 'true' : undefined}
          onClick={() => {
            if (item.disabled) return;
            item.onClick();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** 每个根行上的「⋯」。打开时按这一根的隐藏条数决定恢复全部能不能点。 */
export function RootOverflowMenu({
  rootId,
  onRestoreAll,
  onError,
}: {
  rootId: string;
  onRestoreAll: () => void;
  onError?: (message: string) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const ticket = useRef(0);
  const [menu, setMenu] = useState<{ count: number; top: number; left: number } | null>(null);

  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    if (!menu) return;
    const onDoc = (event: globalThis.MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setMenu(null);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menu]);

  async function toggle(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (menu) {
      ticket.current += 1;
      setMenu(null);
      return;
    }
    const next = ticket.current + 1;
    ticket.current = next;
    const rect = event.currentTarget.getBoundingClientRect();
    const top = rect.bottom + 2;
    const left = rect.right;
    let count = 0;
    try {
      const hidden = await kb.listHiddenItems();
      count = hidden.reduce((sum, item) => sum + (item.rootId === rootId ? 1 : 0), 0);
    } catch (err) {
      count = 0;
      if (alive.current && ticket.current === next) onError?.(err instanceof Error ? err.message : String(err));
    }
    if (!alive.current || ticket.current !== next) return;
    setMenu({ count, top, left });
  }

  const items = menu
    ? rootRowMoreItems(menu.count, () => {
        setMenu(null);
        onRestoreAll();
      })
    : [];

  return (
    <div
      className="kb-root-more"
      ref={wrapRef}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="kb-root-action"
        data-testid="root-more"
        aria-label="更多"
        aria-expanded={menu ? 'true' : 'false'}
        title="更多"
        onClick={(event) => { void toggle(event); }}
      >
        <EllipsisIcon />
      </button>
      {menu ? (
        <RootMoreMenuView
          items={items}
          style={{ position: 'fixed', top: menu.top, left: menu.left, transform: 'translateX(-100%)', zIndex: 4000 }}
        />
      ) : null}
    </div>
  );
}
