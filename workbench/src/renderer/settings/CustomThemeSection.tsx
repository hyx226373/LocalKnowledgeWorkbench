/**
 * 外观页「高级选项」。默认折叠。
 * 颜色写进 settings.customColors，启动后盖在浅色/深色之上。
 */
import React, { useEffect, useState } from 'react';
import { kb } from '../kb';
import {
  CUSTOM_COLOR_FIELDS,
  CUSTOM_COLOR_PRESETS,
  CUSTOM_COLORS_KEY,
  effectiveCustomColors,
  isCustomColorValue,
  matchingPresetId,
  parseCustomColors,
  resetCustomColors,
  sanitizeColorVars,
  setCustomColorOverlay,
  type CustomColorsFile,
} from '../theme/customColors';
import { KbToggle } from './KbToggle';

const EMPTY: CustomColorsFile = { v: 1, enabled: false, vars: {} };

function swatch(value: string | undefined, fallback: string): string {
  return value && isCustomColorValue(value) ? value.trim() : fallback;
}

export function CustomThemeSection() {
  const [file, setFile] = useState<CustomColorsFile>(EMPTY);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    void kb.getLayout(CUSTOM_COLORS_KEY).then((raw) => {
      if (!alive) return;
      const parsed = parseCustomColors(raw) ?? EMPTY;
      setFile(parsed);
      setDrafts({ ...parsed.vars });
      setReady(true);
    }).catch(() => {
      if (alive) setReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  async function save(next: CustomColorsFile) {
    const stored: CustomColorsFile = {
      ...next,
      v: 1,
      enabled: next.enabled === true,
      vars: sanitizeColorVars(next.vars),
    };
    setFile(stored);
    setDrafts({ ...stored.vars });
    setCustomColorOverlay(effectiveCustomColors(stored), { notify: true });
    try {
      await kb.setLayout(CUSTOM_COLORS_KEY, stored);
    } catch {
      /* 写入失败时界面覆盖仍按这次选择，下次打开再读库 */
    }
  }

  function commitField(key: string) {
    const trimmed = (drafts[key] ?? '').trim();
    if (!trimmed) {
      const vars = { ...file.vars };
      delete vars[key];
      void save({ ...file, vars });
      return;
    }
    if (!isCustomColorValue(trimmed)) {
      setDrafts((prev) => ({ ...prev, [key]: file.vars[key] ?? '' }));
      return;
    }
    void save({ ...file, enabled: true, vars: { ...file.vars, [key]: trimmed } });
  }

  const shown = file.enabled ? file.vars : {};
  const presetId = matchingPresetId(shown);
  const accent = swatch(drafts['--kb-color-accent'], '#2563EB');
  const chrome = swatch(drafts['--kb-color-chrome'], '#F3F4F6');
  const surface = swatch(drafts['--kb-color-surface'], '#FFFFFF');
  const text = swatch(drafts['--kb-color-text'], '#111827');

  return (
    <details className="kb-set-advanced" data-testid="settings-custom-theme">
      <summary>高级选项</summary>
      <div className="kb-set-advanced-body">
        <div className="kb-set-row">
          <div>
            <b>自定义配色</b>
            <p>盖在浅色或深色之上。只接受颜色值，非法输入不会写入。</p>
          </div>
          <KbToggle testId="settings-custom-colors-enabled" label="自定义配色" checked={file.enabled} disabled={!ready} onChange={(on) => void save({ ...file, enabled: on })} />
        </div>
        <div className="kb-color-presets" role="group" aria-label="预设方案">
          {CUSTOM_COLOR_PRESETS.map((preset) => (
            <button key={preset.id} type="button" className={presetId === preset.id ? 'on' : ''} aria-pressed={presetId === preset.id} onClick={() => void save({ ...file, enabled: true, vars: { ...preset.vars } })}>
              <span className="kb-color-swatch" style={{ background: preset.vars['--kb-color-accent'] }} />
              {preset.label}
            </button>
          ))}
          <span className={presetId === 'custom' ? 'on' : ''}>自定义</span>
        </div>
        <ul className="kb-color-rows">
          {CUSTOM_COLOR_FIELDS.map((field) => {
            const draft = drafts[field.key] ?? '';
            return (
              <li key={field.key}>
                <label htmlFor={`kb-color-${field.key}`}>{field.label}</label>
                <span className="kb-color-swatch" style={{ background: swatch(draft, 'transparent') }} />
                <input
                  id={`kb-color-${field.key}`}
                  data-testid={`settings-color-${field.key.slice('--kb-color-'.length)}`}
                  value={draft}
                  spellCheck={false}
                  aria-label={field.label}
                  onChange={(e) => setDrafts((prev) => ({ ...prev, [field.key]: e.target.value }))}
                  onBlur={() => commitField(field.key)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  }}
                />
              </li>
            );
          })}
        </ul>
        <div className="kb-color-preview" aria-hidden="true">
          <span style={{ background: chrome }} />
          <span style={{ background: surface, color: text }}>
            <i style={{ background: accent }} />
            预览
          </span>
        </div>
        <div className="kb-set-row">
          <div>
            <b>重置</b>
            <p>清空自定义颜色，回到当前浅色或深色。</p>
          </div>
          <button type="button" className="kb-button kb-button--secondary" data-testid="settings-custom-colors-reset" onClick={() => void save(resetCustomColors(file))}>
            重置
          </button>
        </div>
      </div>
    </details>
  );
}
