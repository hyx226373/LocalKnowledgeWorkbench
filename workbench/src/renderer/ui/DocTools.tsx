/** 预览 DocBar：模式轻按钮在左，路径在工具条右侧。图标 Eye / Pencil / Columns2，14 / 1.5。 */
import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PaneWindowActions } from '../panel-manager/react';
import { ToolbarColumns2Icon, ToolbarEyeIcon, ToolbarPencilIcon } from './shellMarks';
import './doc-stage-preview.css';

function modeIcon(id: string) {
  if (id === 'preview' || id === 'read' || id === 'math') return <ToolbarEyeIcon />;
  if (id === 'edit' || id === 'source') return <ToolbarPencilIcon />;
  if (id === 'split') return <ToolbarColumns2Icon />;
  return null;
}

export function DocTools({
  lead,
  modes = [],
  mode,
  setMode,
  crumb,
  testIdPrefix = 'mode',
}: {
  lead?: React.ReactNode;
  modes?: { id: string; label: string }[];
  mode?: string;
  setMode?: (id: string) => void;
  crumb?: string;
  testIdPrefix?: string;
}) {
  const path = crumb?.trim() ?? '';
  const anchorRef = useRef<HTMLDivElement>(null);
  const [pane, setPane] = useState<{ id: string; bar: HTMLElement } | null>(null);
  useLayoutEffect(() => {
    const node = anchorRef.current;
    if (!node) return;
    const id = node.closest('[data-item-id]')?.getAttribute('data-item-id') ?? '';
    const bar = node.closest('.pane-bar');
    if (!id || !(bar instanceof HTMLElement)) return;
    setPane((prev) => (prev && prev.id === id && prev.bar === bar ? prev : { id, bar }));
  }, []);
  return (
    <div ref={anchorRef} className="doc-tools kb-doc-tools">
      {/* 挂到 pane-bar 末尾，浮动/收成气泡排在保存和缩放按钮右侧。 */}
      {pane ? createPortal(<PaneWindowActions panelId={pane.id} />, pane.bar) : null}
      {lead}
      {modes.length > 0 ? (
        <div className="modes kb-seg kb-doc-modes" role="group" aria-label="视图">
          {modes.map((item) => (
            <button
              key={item.id}
              type="button"
              className={mode === item.id ? 'mode on kb-mode' : 'mode kb-mode'}
              data-testid={`${testIdPrefix}-${item.id}`}
              aria-pressed={mode === item.id ? 'true' : 'false'}
              onClick={() => setMode?.(item.id)}
            >
              {modeIcon(item.id)}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
      <span className="crumb kb-doc-crumb" title={path || undefined} data-testid="doc-crumb" aria-hidden={path ? undefined : true}>
        {path}
      </span>
    </div>
  );
}
