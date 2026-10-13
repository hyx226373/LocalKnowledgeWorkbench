import React from 'react';
import type { MaterialRef } from '../../shared/agentLive/types';
import { addRefs } from './actions';
import { useAgentLive } from './context';

/** 放进搜索结果每一行。默认隐藏，悬停或键盘聚焦时出现。 */
export function SearchHitAddButton({ item }: { item: MaterialRef }) {
  const binding = useAgentLive();
  if (!binding) return null;
  return (
    <button
      type="button"
      className="kb-button kb-button--ghost kb-button--small al-search-add"
      data-testid="agent-add-search"
      title="加入本轮资料"
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void addRefs(binding, [item]);
      }}
    >
      加入
    </button>
  );
}
