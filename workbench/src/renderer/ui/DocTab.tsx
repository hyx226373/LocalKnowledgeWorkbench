/** 文档标签。结构对齐预览 tab / tab-title / tab-x，关闭仍走 dockview api.close。 */
import React, { useContext, useEffect, useRef, useState } from 'react';
import type { IDockviewPanelHeaderProps } from 'dockview';
import { useAgentLive } from '../agent-live/context';
import { applyDocTabDrag, docTabDragFromPanel } from '../dnd/docTabDrag';
import { getSidebarPrefs } from '../drawer/sidebarPrefs';
import { commitDocTabDragStart } from '../nativeDrag/docTabStart';
import { docTabNativePath } from '../nativeDrag/paths';
import { nativeFileDragAvailable } from '../nativeDrag/start';
import { ViewHostCtx } from '../ViewHost';
import { BubbleCloseIcon } from './shellMarks';
import './doc-stage-preview.css';

type TabExtras = {
  hideClose?: boolean;
  closeActionOverride?: () => void;
};

export const DocTab: React.FunctionComponent<IDockviewPanelHeaderProps> = (raw) => {
  const { api, hideClose, closeActionOverride } = raw as IDockviewPanelHeaderProps & TabExtras;
  const [title, setTitle] = useState(api.title ?? '');
  const rootRef = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);
  const mid = useRef(false);
  const env = useContext(ViewHostCtx);
  const binding = useAgentLive();
  const envRef = useRef(env);
  const bindingRef = useRef(binding);
  const titleRef = useRef(title);
  envRef.current = env;
  bindingRef.current = binding;
  titleRef.current = title;

  useEffect(() => {
    setTitle(api.title ?? '');
    const sub = api.onDidTitleChange((event) => setTitle(event.title ?? ''));
    return () => sub.dispose();
  }, [api]);

  useEffect(() => {
    const el = rootRef.current?.closest('.dv-tab');
    if (!el) return;
    const sync = () => setOn(el.classList.contains('dv-active-tab'));
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(el, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, []);

  useEffect(() => {
    let tab: HTMLElement | null = null;
    let raf = 0;
    let tries = 0;
    const onDragStart = (event: DragEvent) => {
      const transfer = event.dataTransfer;
      if (!transfer) return;
      const params = (api as { params?: { itemId?: string } }).params;
      const itemId = params?.itemId || api.id;
      const getItem = envRef.current && typeof envRef.current.getItem === 'function' ? envRef.current.getItem : null;
      const item = getItem ? getItem(itemId) : null;
      const reading = bindingRef.current?.host.readingForPanel(itemId) ?? null;
      const payload = docTabDragFromPanel({
        panelId: api.id,
        itemId,
        title: api.title || titleRef.current,
        item,
        reading,
      });
      if (!payload) return;
      commitDocTabDragStart({
        event,
        payload,
        mode: getSidebarPrefs().dragOutMode,
        absPath: docTabNativePath(payload),
        native: nativeFileDragAvailable(),
        writeTab: applyDocTabDrag,
      });
    };
    const bind = () => {
      const found = rootRef.current?.closest('.dv-tab');
      if (!(found instanceof HTMLElement)) {
        if (tries++ < 8) raf = requestAnimationFrame(bind);
        return;
      }
      tab = found;
      tab.addEventListener('dragstart', onDragStart);
    };
    bind();
    return () => {
      cancelAnimationFrame(raf);
      tab?.removeEventListener('dragstart', onDragStart);
    };
  }, [api]);

  const close = (event: React.MouseEvent | React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (closeActionOverride) closeActionOverride();
    else api.close();
  };

  return (
    <div
      ref={rootRef}
      className={on ? 'dv-default-tab tab on' : 'dv-default-tab tab'}
      data-testid="dockview-dv-default-tab"
      onPointerDown={(event) => {
        mid.current = event.button === 1;
      }}
      onPointerUp={(event) => {
        if (mid.current && event.button === 1 && !hideClose) {
          mid.current = false;
          close(event);
        }
      }}
      onPointerLeave={() => {
        mid.current = false;
      }}
    >
      <button type="button" className="tab-title dv-default-tab-content" tabIndex={-1}>
        {title}
      </button>
      {hideClose ? null : (
        <button
          type="button"
          className="tab-x dv-default-tab-action"
          aria-label={title ? `关闭${title}` : '关闭标签'}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={close}
        >
          <BubbleCloseIcon width={12} height={12} />
        </button>
      )}
    </div>
  );
};
