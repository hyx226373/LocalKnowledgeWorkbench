import type { MaterialRef } from '../../shared/agentLive/types';
import { pathKey } from './paths';

export interface AgentLiveMenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  run: () => void;
}

function sameRef(a: MaterialRef, b: MaterialRef): boolean {
  if (a.resourceId && b.resourceId) return a.resourceId === b.resourceId;
  if (!a.absPath || !b.absPath) return false;
  return pathKey(a.absPath) === pathKey(b.absPath);
}

/** 右键落在多选内部时加入整批，否则只加入被点的那一项。 */
export function refsForAddGesture(clicked: MaterialRef, selected: readonly MaterialRef[]): MaterialRef[] {
  if (selected.length > 1 && selected.some((item) => sameRef(item, clicked))) return [...selected];
  return [clicked];
}

export function agentLiveMenuItems(refs: readonly MaterialRef[], run: (refs: MaterialRef[]) => void): AgentLiveMenuItem[] {
  if (!refs.length) return [];
  const label = refs.length > 1 ? `把选中的 ${refs.length} 项加入本轮资料` : '加入 agent 工作资料';
  return [{ id: 'agent.materials.addSelection', label, run: () => run([...refs]) }];
}
