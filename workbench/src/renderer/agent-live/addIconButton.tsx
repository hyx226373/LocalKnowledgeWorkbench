import React from 'react';
import type { MaterialRef } from '../../shared/agentLive/types';
import { addRefsMaybeDir } from './actions';
import { useAgentLive } from './context';
import { AgentAddIcon } from '../ui/shellMarks';

/** 侧栏行 / 工具条：「加入 agent 工作区」图标入口（箭头入竖条）。 */
export function AgentAddIconButton({
  refs,
  kind = 'file',
  testId = 'agent-add-row',
  title = '加入 agent 工作区',
  className = 'act al-add-icon',
}: {
  refs: readonly MaterialRef[];
  /** 目录行一键加入走确认文案 */
  kind?: 'file' | 'dir';
  testId?: string;
  title?: string;
  className?: string;
}) {
  const binding = useAgentLive();
  if (!binding || !refs.length) return null;
  return (
    <button
      type="button"
      className={className}
      data-testid={testId}
      title={title}
      aria-label={title}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void addRefsMaybeDir(binding, [...refs], { asDir: kind === 'dir' });
      }}
    >
      <AgentAddIcon />
    </button>
  );
}
