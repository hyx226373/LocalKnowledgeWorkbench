import { useEffect, useRef, useState, type ReactNode } from 'react';
import { EllipsisIcon, PlusIcon } from '../ui/shellMarks';
import './module.css';

export type ModuleHeadProps = {
  title: string;
  testId?: string;
  acts?: ReactNode;
  addLabel?: string;
  addOpen?: boolean;
  onAddToggle?: () => void;
  addMenu?: ReactNode;
  moreItems?: { id: string; label: string; onClick: () => void; testId?: string }[];
};

export function ModuleHead({
  title,
  testId,
  acts,
  addLabel = '添加',
  addOpen,
  onAddToggle,
  addMenu,
  moreItems,
}: ModuleHeadProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!moreOpen) return;
    const onDoc = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setMoreOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [moreOpen]);

  return (
    <div className="kb-module-h-wrap" ref={wrapRef}>
      <div className="kb-module-h" data-testid={testId}>
        <h2 className="kb-module-title">{title}</h2>
        <div className="kb-module-acts">
          {onAddToggle ? (
            <button type="button" className="kb-linkish" data-testid="module-add" aria-expanded={!!addOpen} onClick={onAddToggle}>
              <PlusIcon />
              {addLabel}
            </button>
          ) : null}
          {acts}
          {moreItems && moreItems.length > 0 ? (
            <button
              type="button"
              className="kb-mini-btn"
              data-testid="module-more"
              aria-label={'更多'}
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((v) => !v)}
            >
              <EllipsisIcon />
            </button>
          ) : null}
        </div>
      </div>
      {moreOpen && moreItems && moreItems.length > 0 ? (
        <div className="kb-more-menu" role="menu" data-testid="module-more-menu">
          {moreItems.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              data-testid={item.testId}
              onClick={() => {
                setMoreOpen(false);
                item.onClick();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
      {addOpen && addMenu ? <div className="kb-add-menu" data-testid="module-add-menu">{addMenu}</div> : null}
    </div>
  );
}
