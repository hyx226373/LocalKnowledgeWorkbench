import React from 'react';
import { addRefs } from './actions';
import { useAgentLive } from './context';
import { AgentAddIcon } from '../ui/shellMarks';

/**
 * 阅读窗口标题栏挂点。不读取阅读器内部状态。
 * 集成组把它放进 PanelHeaderActions，传当前面板 id。
 * 面板没有文件时不渲染。
 */
export function ReaderAddMaterialButton({ panelId }: { panelId: string }) {
  const binding = useAgentLive();
  if (!binding) return null;
  const ref = binding.host.readingForPanel(panelId);
  if (!ref?.absPath) return null;
  return (
    <button
      type="button"
      className="pm-btn al-reader-add"
      data-testid="agent-add-current"
      title="加入 agent 工作区"
      aria-label="加入 agent 工作区"
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        void addRefs(binding, [ref]);
      }}
    >
      <AgentAddIcon />
    </button>
  );
}
