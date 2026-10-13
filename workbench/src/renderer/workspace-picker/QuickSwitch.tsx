/**
 * 快速切换覆盖层。选中和搜索只在这次渲染里，关闭即弃。
 * 冲突提示在顶部，不弹系统对话框。
 */
import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { overlayHostStatus, type OverlayHostPort } from './overlayHost';
import {
  clampQuickSwitchIndex,
  filterQuickSwitch,
  initialQuickSwitchUi,
  quickSwitchQuery,
  reduceQuickSwitchKey,
  type QuickSwitchEntry,
} from './quickSwitchModel';
import { formatQuickSwitchConflict, type QuickSwitchConflictReport } from './quickSwitchKey';

export function QuickSwitchConflictNotice({
  conflict,
  onReconfigure,
}: {
  conflict: QuickSwitchConflictReport;
  onReconfigure(): void;
}) {
  return (
    <div className="kb-ws-quick-conflict" role="status">
      <p>{formatQuickSwitchConflict(conflict)}</p>
      <button type="button" data-action="reconfigure" onClick={onReconfigure}>
        重新配置快捷键
      </button>
    </div>
  );
}

export function QuickSwitch({
  entries,
  currentId = null,
  conflict = null,
  hostPort,
  onEnter,
  onClose,
  onReconfigure,
  onOpenSettings,
}: {
  entries: readonly QuickSwitchEntry[];
  currentId?: string | null;
  conflict?: QuickSwitchConflictReport | null;
  hostPort?: OverlayHostPort | null;
  onEnter(id: string): void;
  onClose(): void;
  onReconfigure(): void;
  onOpenSettings(): void;
}) {
  const [ui, setUi] = useState(() => initialQuickSwitchUi(entries, currentId));
  const visible = filterQuickSwitch(entries, ui.query);
  const selectedIndex = clampQuickSwitchIndex(ui.selectedIndex, visible.length);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('button') && !target.closest('[role="option"]')) return;
    if (event.key !== 'Enter' && event.key !== 'Escape' && !event.key.startsWith('Arrow')) return;
    event.preventDefault();
    event.stopPropagation();
    const next = reduceQuickSwitchKey({ ui, entries, key: event.key, onEnter, onClose });
    if (next !== ui) setUi(next);
  }

  return (
    <div
      className="kb-ws-quick"
      data-testid="ws-quick-switch"
      data-kb-overlay=""
      data-persists="false"
      data-writes-library="false"
      data-host-status={overlayHostStatus(hostPort)}
      role="dialog"
      aria-label="快速切换工作区"
      onMouseDown={onClose}
      onKeyDown={onKeyDown}
    >
      <div className="kb-ws-quick-panel" onMouseDown={(event) => event.stopPropagation()}>
        {conflict && conflict.parties.length > 0 ? <QuickSwitchConflictNotice conflict={conflict} onReconfigure={onReconfigure} /> : null}
        <input
          className="kb-ws-quick-search"
          type="search"
          autoFocus
          data-field="search"
          placeholder="搜索名称、用途或标签"
          aria-label="搜索名称、用途或标签"
          value={ui.query}
          onChange={(event) => setUi(quickSwitchQuery(ui, event.target.value))}
        />
        <div className="kb-ws-quick-list" role="listbox" aria-label="工作区">
          {visible.map((entry, index) => {
            const selected = index === selectedIndex;
            return (
              <button
                key={entry.id}
                type="button"
                className="kb-ws-quick-item"
                role="option"
                data-workspace-id={entry.id}
                data-selected={selected ? 'true' : 'false'}
                aria-selected={selected}
                onClick={() => onEnter(entry.id)}
              >
                <span className="kb-ws-quick-name">{entry.name}</span>
                {entry.purpose ? <span className="kb-ws-quick-purpose">{entry.purpose}</span> : null}
                {entry.tags.length > 0 ? <span className="kb-ws-quick-tags">{entry.tags.join(' ')}</span> : null}
              </button>
            );
          })}
          {visible.length === 0 ? <p className="kb-ws-quick-empty">没有匹配的工作区</p> : null}
        </div>
        <div className="kb-ws-quick-actions">
          <button type="button" data-action="open-startup-settings" onClick={onOpenSettings}>
            启动设置
          </button>
          <button type="button" data-action="close-quick-switch" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}