import React, { useMemo, useSyncExternalStore } from 'react';
import { chromeThemes, readingThemes } from '../plugin-host/registry';
import type { Appearance, SchemePref } from '../theme/appearance';
import { SchemeSunToggle } from './KbToggle';
import './settings-frame.css';

function useRegistry<T>(reg: { subscribe(cb: () => void): () => void; getVersion(): number }, get: () => T): T {
  const version = useSyncExternalStore(
    (cb) => reg.subscribe(cb),
    () => reg.getVersion(),
  );
  return useMemo(get, [version]);
}

const SCHEME_LABEL: Record<SchemePref, string> = {
  light: '浅色',
  dark: '深色',
  system: '跟随系统',
};

/** 外框、阅读区、明暗。顶栏菜单和设置页共用，不写布局。明暗用预览式三段 seg。 */
export function AppearanceFields({
  value,
  onChange,
  idPrefix = 'appearance',
  showSchemeSun = false,
}: {
  value: Appearance;
  onChange: (next: Appearance) => void;
  idPrefix?: string;
  /** 设置外观页展示太阳胶囊；顶栏菜单可关以免重复 */
  showSchemeSun?: boolean;
}) {
  const chrome = useRegistry(chromeThemes, () => chromeThemes.all());
  const reading = useRegistry(readingThemes, () => readingThemes.all());
  return (
    <div data-testid={`${idPrefix}-fields`}>
      <div className="kb-set-row">
        <div>
          <b>外框样式</b>
          <p>壳层与顶栏、侧栏的美术主题包。</p>
        </div>
        <select
          id={`${idPrefix}-chrome`}
          className="kb-select kb-no-drag"
          data-testid={`${idPrefix}-chrome`}
          value={value.chrome}
          onChange={(e) => onChange({ ...value, chrome: e.target.value })}
          aria-label="外框样式"
        >
          {chrome.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <div className="kb-set-row">
        <div>
          <b>阅读区样式</b>
          <p>正文阅读区的美术主题包。</p>
        </div>
        <select
          id={`${idPrefix}-reading`}
          className="kb-select kb-no-drag"
          data-testid={`${idPrefix}-reading`}
          value={value.reading}
          onChange={(e) => onChange({ ...value, reading: e.target.value })}
          aria-label="阅读区样式"
        >
          {reading.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <div className="kb-set-block">
        <div className="kb-set-label" id={`${idPrefix}-scheme-label`}>
          明暗
        </div>
        <div className="kb-seg" role="radiogroup" aria-labelledby={`${idPrefix}-scheme-label`} data-testid={`${idPrefix}-scheme`}>
          {(['light', 'dark', 'system'] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={value.scheme === id}
              className={value.scheme === id ? 'kb-seg-btn on' : 'kb-seg-btn'}
              data-testid={`${idPrefix}-scheme-${id}`}
              onClick={() => onChange({ ...value, scheme: id })}
            >
              {SCHEME_LABEL[id]}
            </button>
          ))}
        </div>
      </div>
      {showSchemeSun ? (
        <div className="kb-set-row" data-testid={`${idPrefix}-scheme-sun-row`}>
          <div>
            <b>深色外观</b>
            <p>{value.scheme === 'system' ? '正在跟随系统，此开关已停用。' : '滑块在右为深色，在左为浅色。'}</p>
          </div>
          <SchemeSunToggle scheme={value.scheme} onScheme={(scheme) => onChange({ ...value, scheme })} testId={`${idPrefix}-scheme-sun`} />
        </div>
      ) : null}
    </div>
  );
}
