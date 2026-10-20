import React from 'react';
import { Sun } from 'lucide-react';
import './settings-preview.css';

/** Preview switch: controlled by the existing preference service at the call site. */
export function Switch({ checked, onChange, disabled, busy, sun, label, title, testId, id }: {
  checked: boolean;
  onChange(next: boolean): void;
  disabled?: boolean;
  busy?: boolean;
  sun?: boolean;
  label: string;
  title?: string;
  testId?: string;
  id?: string;
}) {
  return (
    <button
      id={id}
      data-testid={testId}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={busy ? true : undefined}
      title={title}
      disabled={disabled || busy}
      className={sun ? 'kb-preview-switch sun' : 'kb-preview-switch'}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => onChange(!checked)}
    >
      <span className="knob" aria-hidden="true">
        {busy ? <i className="spin" /> : sun ? <Sun size={13} strokeWidth={1.75} /> : null}
      </span>
    </button>
  );
}
