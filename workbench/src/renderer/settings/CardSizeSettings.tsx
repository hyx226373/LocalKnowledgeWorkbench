/**
 * 设置页「外观 › 侧栏 › 卡片尺寸」四档分段按钮 + 实时预览。
 */
import React from 'react';
import { useSidebarPrefs, updateSidebarPrefs, type CardSize } from '../drawer/sidebarPrefs';
import { CARD_SIZES, CARD_SIZE_LABELS, CARD_SIZE_SPECS, cardSizeCSSVars, computeCardColumns } from '../drawer/cardSize';
import { DRAWER_MODULE_IDS, DRAWER_MODULE_LABEL } from '../drawer/order';
import { CheckIcon } from '../ui/shellMarks';

const PREVIEW_WIDTH = 360;

/** 卡片大图标 SVG（预览用简化版）。 */
function PreviewMark({ id }: { id: string }) {
  const common = { viewBox: '0 0 64 64', fill: 'none', width: '100%', height: '100%', 'aria-hidden': true as const };
  if (id === 'root') return <svg {...common}><path d="M12 32h14l3 3h23a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H12a3 3 0 0 1-3-3V35a3 3 0 0 1 3-3z" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>;
  if (id === 'fav') return <svg {...common}><path d="M20 10h24a2 2 0 0 1 2 2v40l-14-8-14 8V12a2 2 0 0 1 2-2z" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M32 22.2 33.7 26l4.2.5-3.1 2.8.8 4.1L32 31.4l-3.6 2 .8-4.1-3.1-2.8 4.2-.5z" fill="currentColor" /></svg>;
  if (id === 'web') return <svg {...common}><circle cx="32" cy="34" r="16" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeWidth="1.6" /><ellipse cx="32" cy="34" rx="7" ry="16" stroke="currentColor" strokeWidth="1.4" /><path d="M16 34h32" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>;
  if (id === 'bench') return <svg {...common}><rect x="16" y="14" width="28" height="34" rx="3" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeWidth="1.6" /><path d="M22 24h16M22 30h12" stroke="currentColor" opacity="0.55" strokeWidth="1.5" strokeLinecap="round" /><circle cx="46" cy="18" r="6" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeWidth="1.5" /></svg>;
  if (id === 'agent') return <svg {...common}><circle cx="32" cy="16" r="5.5" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeWidth="1.6" /><circle cx="14" cy="46" r="5" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeWidth="1.6" /><circle cx="50" cy="46" r="5" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeWidth="1.6" /></svg>;
  return <svg {...common}><rect x="10" y="16" width="22" height="22" rx="6" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeWidth="1.6" /><rect x="32" y="28" width="22" height="22" rx="6" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeWidth="1.6" /></svg>;
}

export function CardSizeSettings() {
  const prefs = useSidebarPrefs();
  const current = prefs.cardSize;
  const spec = CARD_SIZE_SPECS[current];
  const cols = computeCardColumns(PREVIEW_WIDTH, current);
  const previewIds = DRAWER_MODULE_IDS;
  const cssVars = cardSizeCSSVars(current) as React.CSSProperties;

  return (
    <div className="kb-set-card" data-testid="settings-card-size">
      <h2>侧栏</h2>
      <b>卡片尺寸</b>
      <p className="kb-set-lead">默认是大。小档只显示图标。主界面与侧栏模式共用。</p>
      <div className="kb-seg" role="radiogroup" aria-label="卡片尺寸" data-testid="card-size-seg">
        {CARD_SIZES.map((size) => (
          <button
            key={size}
            type="button"
            className={current === size ? 'kb-seg-btn on' : 'kb-seg-btn'}
            role="radio"
            aria-checked={current === size}
            data-testid={`card-size-${size}`}
            onClick={() => updateSidebarPrefs({ cardSize: size })}
          >
            {CARD_SIZE_LABELS[size]}
          </button>
        ))}
      </div>
      <p className="kb-set-lead kb-card-size-preview-label">实时预览</p>
      <div
        className="kb-card-size-preview"
        data-testid="card-size-preview"
        style={{ width: PREVIEW_WIDTH }}
      >
        <div className="kb-card-size-preview-head">
          <span aria-hidden="true">▸</span>分类
        </div>
        <div
          className="kb-drawer-cards"
          style={{
            ...cssVars,
            display: 'grid',
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
            gap: 8,
          }}
          role="group"
          aria-label="预览"
        >
          {previewIds.map((id, i) => (
            <div
              key={id}
              className="kb-drawer-card"
              aria-pressed={i === 0 ? 'true' : undefined}
              style={{
                minHeight: spec.minH,
                background: i === 0 ? 'var(--kb-color-selected)' : undefined,
                color: i === 0 ? 'var(--kb-color-selected-fg)' : undefined,
              }}
            >
              {i === 0 && (
                <span className="kb-drawer-card-check">
                  <CheckIcon />
                </span>
              )}
              <span className="kb-drawer-card-mark" style={{ width: spec.icon, height: spec.icon }}>
                <PreviewMark id={id} />
              </span>
              {!spec.hideTitle && (
                <span className="kb-drawer-card-name" style={{ fontSize: spec.titleSize }}>
                  {DRAWER_MODULE_LABEL[id]}
                </span>
              )}
            </div>
          ))}
        </div>
        <p className="kb-card-size-preview-foot">
          {CARD_SIZE_LABELS[current]} · 栏宽 {PREVIEW_WIDTH} · {cols} 列
        </p>
      </div>
    </div>
  );
}
