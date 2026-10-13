import { DRAWER_MODULE_IDS, DRAWER_MODULE_LABEL, type DrawerModuleId, normalizeDrawerSelection } from './order';
import './drawer.css';

/** Preview-aligned Mark SVGs (workbench.tsx). Geometry matches preview; color via currentColor for themes. */
function CardMark({ id }: { id: DrawerModuleId }) {
  const common = {
    viewBox: '0 0 64 64',
    fill: 'none',
    width: 52,
    height: 52,
    'aria-hidden': true as const,
  };
  if (id === 'root') {
    return (
      <svg {...common}>
        <path d="M32 8v8M22 24h20M22 16v8M42 16v8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="32" cy="8" r="3" fill="currentColor" />
        <circle cx="22" cy="16" r="2.3" fill="currentColor" opacity="0.55" />
        <circle cx="42" cy="16" r="2.3" fill="currentColor" opacity="0.55" />
        <path
          d="M12 32h14l3 3h23a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H12a3 3 0 0 1-3-3V35a3 3 0 0 1 3-3z"
          fill="currentColor"
          fillOpacity="0.08"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (id === 'fav') {
    return (
      <svg {...common}>
        <path
          d="M20 10h24a2 2 0 0 1 2 2v40l-14-8-14 8V12a2 2 0 0 1 2-2z"
          fill="currentColor"
          fillOpacity="0.08"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path d="M32 22.2 33.7 26l4.2.5-3.1 2.8.8 4.1L32 31.4l-3.6 2 .8-4.1-3.1-2.8 4.2-.5z" fill="currentColor" />
      </svg>
    );
  }
  if (id === 'web') {
    return (
      <svg {...common}>
        <circle cx="32" cy="34" r="16" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeWidth="1.6" />
        <ellipse cx="32" cy="34" rx="7" ry="16" stroke="currentColor" strokeWidth="1.4" />
        <path d="M16 34h32M18.5 27h27M18.5 41h27" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <circle cx="48" cy="16" r="3.2" fill="currentColor" />
        <path d="M45.2 18.2 36 24" stroke="currentColor" opacity="0.55" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  if (id === 'bench') {
    return (
      <svg {...common}>
        <rect x="16" y="14" width="28" height="34" rx="3" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeWidth="1.6" />
        <path d="M22 24h16M22 30h12M22 36h14" stroke="currentColor" opacity="0.55" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="46" cy="18" r="6" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeWidth="1.5" />
        <path d="M44 18h4M46 16v4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  if (id === 'agent') {
    return (
      <svg {...common}>
        <path d="M32 16 50 46H14Z" stroke="currentColor" opacity="0.45" strokeWidth="1.4" strokeLinejoin="round" />
        <circle cx="32" cy="16" r="5.5" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="14" cy="46" r="5" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="50" cy="46" r="5" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="32" cy="16" r="1.7" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="10" y="16" width="22" height="22" rx="6" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeWidth="1.6" />
      <rect x="32" y="28" width="22" height="22" rx="6" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeWidth="1.6" />
      <path d="M21 16v-6M43 50v6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function DrawerCards({
  selection,
  onToggle,
}: {
  selection: readonly DrawerModuleId[];
  onToggle: (id: DrawerModuleId) => void;
}) {
  const pressed = new Set(normalizeDrawerSelection(selection));
  return (
    <div className="kb-drawer-cards" role="group" aria-label="分类入口">
      {DRAWER_MODULE_IDS.map((id) => (
        <button
          key={id}
          type="button"
          className={pressed.has(id) ? 'kb-drawer-card on' : 'kb-drawer-card'}
          data-testid={`drawer-card-${id}`}
          data-module={id}
          aria-pressed={pressed.has(id)}
          onClick={() => onToggle(id)}
        >
          <span className="kb-drawer-card-mark">
            <CardMark id={id} />
          </span>
          <span className="kb-drawer-card-name">{DRAWER_MODULE_LABEL[id]}</span>
        </button>
      ))}
    </div>
  );
}
