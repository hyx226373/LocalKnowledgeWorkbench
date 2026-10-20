import React, { useEffect, useRef, useState } from 'react';
import { copyBridgeLink, copyWorkspaceLink } from './actions';
import { useAgentLive } from './context';
import { MSG_CONNECT_NOTE } from './messages';
import { ConnectAgentIcon, ChevronDownIcon } from '../ui/shellMarks';

/** 顶栏接入 agent：主按钮复制当前入口；已经接入的 agent 继续用这个路径，没有断开/重连字段；窄窗只留图标与菜单状态钮。 */
export function ConnectAgentButton({ defaultOpen = false, compact = false }: { defaultOpen?: boolean; compact?: boolean }) {
  const binding = useAgentLive();
  const [open, setOpen] = useState(defaultOpen);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  if (!binding) return null;
  return (
    <div className={compact ? 'al-connect al-connect--compact anchor' : 'al-connect anchor'} ref={root} data-compact={compact ? 'true' : 'false'}>
      <button type="button" className="kb-ghost kb-no-drag" data-testid="connect-agent" title={MSG_CONNECT_NOTE} aria-label="连接 Agent" onClick={() => void copyBridgeLink(binding)}>
        <ConnectAgentIcon />
        {!compact ? <span className="kb-hide-m">连接 Agent</span> : null}
      </button>
      <button
        type="button"
        className="kb-icon-hit kb-no-drag"
        data-testid="connect-agent-menu"
        aria-label="入口菜单"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronDownIcon />
      </button>
      {open && (
        <div className="kb-popover menu" role="menu" data-testid="connect-agent-dropdown">
          <div
            className="kb-menu-item"
            role="menuitem"
            data-testid="copy-workspace-entry"
            onClick={() => {
              setOpen(false);
              void copyWorkspaceLink(binding);
            }}
          >
            <span className="name">复制当前工作区入口</span>
          </div>
          <div className="al-connect-note">{MSG_CONNECT_NOTE}</div>
        </div>
      )}
    </div>
  );
}
