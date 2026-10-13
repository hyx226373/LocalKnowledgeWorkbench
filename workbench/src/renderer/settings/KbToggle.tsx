/**
 * 胶囊开关。结构是 label.kb-toggle 里的原生 checkbox，选中靠 input:checked。
 * 观感对齐预览 switch.tsx（52×30 / knob / sun / busy spin）；组件不记自己的勾选。
 * 写入失败时由调用方把 checked 设回原值。侧栏旧版无轨道的 .kb-toggle 不受本样式影响。
 */
import React from 'react';
import './kb-toggle.css';

/** 预览 Switch sun：lucide sun 13×13 / stroke 1.75；切片 icons/switch-sun.svg */
function SunGlyph() {
  return (
    <svg className="kb-toggle-sun" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.75" />
      <path d="M12 2v2" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      <path d="M12 20v2" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      <path d="m4.93 4.93 1.41 1.41" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      <path d="m17.66 17.66 1.41 1.41" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      <path d="M2 12h2" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      <path d="M20 12h2" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      <path d="m6.34 17.66-1.41 1.41" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      <path d="m19.07 4.93-1.41 1.41" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

export function KbToggle({
  checked,
  onChange,
  disabled = false,
  busy = false,
  sun = false,
  children,
  title,
  testId,
  id,
  label,
}: {
  checked: boolean;
  onChange(next: boolean): void;
  disabled?: boolean;
  busy?: boolean;
  /** 预览太阳胶囊：knob 内显示太阳图标，配色走 .kb-toggle--sun */
  sun?: boolean;
  children?: React.ReactNode;
  title?: string;
  testId?: string;
  id?: string;
  /** 无 children 时用作 aria-label；有 children 时仍可补强 */
  label?: string;
}) {
  const aria = label ?? (typeof children === 'string' ? children : undefined);
  const off = disabled || busy;
  return (
    <label
      className={sun ? 'kb-toggle kb-toggle--sun' : 'kb-toggle'}
      title={title}
      aria-disabled={off ? 'true' : undefined}
      aria-busy={busy ? 'true' : undefined}
    >
      <input
        id={id}
        data-testid={testId}
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={off}
        aria-label={aria}
        aria-busy={busy ? true : undefined}
        onChange={(event) => onChange(event.target.checked)}
        onPointerDown={(event) => event.stopPropagation()}
      />
      <span className="kb-toggle-track" aria-hidden="true">
        <span className="kb-toggle-thumb">
          {busy ? <i className="kb-toggle-spin" /> : sun ? <SunGlyph /> : null}
        </span>
      </span>
      {children == null ? null : <span className="kb-toggle-label">{children}</span>}
    </label>
  );
}

/** 顶栏/外观页共用的浅深太阳开关。跟随系统时禁用。B 组可直接引用。 */
export function SchemeSunToggle({
  scheme,
  onScheme,
  busy = false,
  testId = 'scheme-sun-toggle',
}: {
  scheme: 'light' | 'dark' | 'system';
  onScheme(next: 'light' | 'dark'): void;
  busy?: boolean;
  testId?: string;
}) {
  return (
    <KbToggle
      sun
      testId={testId}
      label="深色外观"
      checked={scheme === 'dark'}
      disabled={scheme === 'system'}
      busy={busy}
      onChange={(on) => onScheme(on ? 'dark' : 'light')}
    />
  );
}
