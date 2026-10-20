import { useContext } from 'react';
import { useAgentLive } from '../agent-live/context';
import { AppCtx } from '../dir-view/context';
import { commitDocTabDrop, kbAddWorkspaceRefs, type DocTabDragPayload, type DocTabDropTarget } from './docTabDrag';

export function useCommitDocTab(workspaceId?: string) {
  const binding = useAgentLive();
  const ctx = useContext(AppCtx);
  const id = workspaceId || ctx?.workspaceId || '';
  return (target: DocTabDropTarget, payload: DocTabDragPayload | null) => commitDocTabDrop(target, payload, {
    workspaceId: id,
    binding,
    addWorkspaceRefs: kbAddWorkspaceRefs,
  });
}
