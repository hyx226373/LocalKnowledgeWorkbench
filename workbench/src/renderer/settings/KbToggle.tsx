/**
 * 现有调用接口的薄适配层，绘制与交互直接使用预览 Switch。
 * 观感对齐预览 switch.tsx（52×30 / knob / sun / busy spin）；组件不记自己的勾选。
 * 写入失败时由调用方把 checked 设回原值。侧栏旧版无轨道的 .kb-toggle 不受本样式影响。
 */
import React from 'react';
import { Switch } from '../ui/Switch';
import './kb-toggle.css';

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
  /** 预览太阳胶囊：knob 内显示太阳图标，配色走 Switch 的 sun 变体 */
  sun?: boolean;
  children?: React.ReactNode;
  title?: string;
  testId?: string;
  id?: string;
  /** 无 children 时用作 aria-label；有 children 时仍可补强 */
  label?: string;
}) {
  const aria = label ?? (typeof children === 'string' ? children : undefined);
  return (
    <span className="kb-preview-toggle" title={title}>
      <Switch id={id} testId={testId} label={aria ?? '开关'} title={title}
        checked={checked} disabled={disabled} busy={busy} sun={sun} onChange={onChange} />
      {children == null ? null : <label htmlFor={id} className="kb-toggle-label" onClick={id ? undefined : () => { if (!disabled && !busy) onChange(!checked); }}>{children}</label>}
    </span>
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
