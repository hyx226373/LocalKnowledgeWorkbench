import React, { useEffect, useSyncExternalStore } from 'react';
import { loadZoomHudVisible, readZoomHudVisible, subscribeZoomHudVisible } from '../settings/zoomHudVisible';
import { runContentZoom } from './registry';
import './zoom.css';

/** 不要加 data-kb-overlay：那个属性会把网页面板当成浮层藏掉。 */
export function ZoomBadge({ scale }: { scale: number }) {
  const shown = Number.isFinite(scale) ? scale : 1;
  return (
    <span className="kb-zoom-badge" data-testid="zoom-badge" data-scale={shown}>
      {Math.round(shown * 100)}%
    </span>
  );
}

/** 阅读面板缩放浮条。受「显示内容缩放条」偏好控制；隐藏不改缩放值／快捷键／滚轮。 */
export function ZoomControls({ itemId, scale }: { itemId: string; scale: number }) {
  const show = useSyncExternalStore(subscribeZoomHudVisible, readZoomHudVisible);
  useEffect(() => {
    void loadZoomHudVisible();
  }, []);
  if (!show) return null;
  return (
    <div className="kb-view-toolbar kb-zoom-hud" role="toolbar" aria-label="内容缩放">
      <button type="button" className="kb-button kb-button--secondary" data-testid="content-zoom-out" title="缩小" onClick={() => runContentZoom(itemId, 'out')}>
        −
      </button>
      <ZoomBadge scale={scale} />
      <button type="button" className="kb-button kb-button--secondary" data-testid="content-zoom-in" title="放大" onClick={() => runContentZoom(itemId, 'in')}>
        ＋
      </button>
      <button type="button" className="kb-button kb-button--secondary" data-testid="content-zoom-reset" title="重置为 100%" onClick={() => runContentZoom(itemId, 'reset')}>
        重置
      </button>
      <button type="button" className="kb-button kb-button--secondary" data-testid="content-zoom-fit" title="适应窗口" onClick={() => runContentZoom(itemId, 'fit')}>
        适应
      </button>
    </div>
  );
}
