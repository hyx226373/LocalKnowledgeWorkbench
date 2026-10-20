import { FolderMinus } from 'lucide-react';

export function RootActionButton({ kind, title, onActivate }: { kind: 'detach'; title: string; onActivate: () => void }) {
  return (
    <button
      type="button"
      className="kb-root-action"
      data-kind={kind}
      data-testid="root-detach"
      title={title}
      aria-label={title}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => { event.stopPropagation(); onActivate(); }}
    >
      <FolderMinus size={14} aria-hidden="true" />
    </button>
  );
}
