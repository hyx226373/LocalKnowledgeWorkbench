import { Check } from 'lucide-react';
import { Fragment, createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { EllipsisIcon, PlusIcon } from '../ui/shellMarks';
import './module.css';

export const ModuleColumnActions = createContext<ModuleHeadProps['moreItems']>(undefined);

export type ModuleHeadProps = {
  title: string;
  testId?: string;
  acts?: ReactNode;
  addLabel?: string;
  addOpen?: boolean;
  onAddToggle?: () => void;
  addMenu?: ReactNode;
  moreItems?: { id: string; label: string; onClick: () => void; testId?: string; checked?: boolean }[];
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
  const columnItems = useContext(ModuleColumnActions);
  moreItems = [...(moreItems ?? []), ...(columnItems ?? [])];
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
          {moreItems.map((item, index) => {
            const showCheck = moreItems.some((entry) => entry.checked !== undefined);
            return (
              <Fragment key={item.id}>
                {item.id === 'hidden-items' && index > 0 ? <div className="menu-sep" role="separator" /> : null}
                <button
                  type="button"
                  role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                  aria-checked={item.checked}
                  data-testid={item.testId}
                  onClick={() => {
                    setMoreOpen(false);
                    item.onClick();
                  }}
                >
                  {showCheck ? <span className="kb-menu-check" aria-hidden="true">{item.checked ? <Check size={14} strokeWidth={1.5} aria-hidden="true" /> : null}</span> : null}
                  {item.label}
                </button>
              </Fragment>
            );
          })}
        </div>
      ) : null}
      {addOpen && addMenu ? <div className="kb-add-menu" data-testid="module-add-menu">{addMenu}</div> : null}
    </div>
  );
}
