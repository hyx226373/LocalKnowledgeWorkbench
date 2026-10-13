import { AGENT_LIVE_ACTIONS } from '../../shared/agentLive/types';
import type { MaterialRef } from '../../shared/agentLive/types';
import {
  addCurrent,
  addSelection,
  clearSession,
  copyBridgeLink,
  copyWorkspaceLink,
  getAgentLiveBinding,
  pinSelected,
  removeSelected,
  reorderMaterials,
  setPurposeSelected,
  unpinSelected,
} from './actions';
import { AGENT_LIVE_ACTION_CATALOG } from './actionCatalog';

export interface AgentLiveCommand {
  id: string;
  title: string;
  category: string;
  keybinding?: string;
  when?: 'global' | 'editorFocus' | 'treeFocus' | 'webFocus';
  bridgeInvokable: boolean;
  approvalRequired: boolean;
  run(...args: unknown[]): unknown;
}

export interface CommandDisposable {
  dispose(): void;
}

function refOf(value: unknown): MaterialRef | null {
  if (!value || typeof value !== 'object') return null;
  const ref = value as MaterialRef;
  if (typeof ref.absPath !== 'string' || !ref.absPath) return null;
  return ref;
}

function refsOf(value: unknown): MaterialRef[] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const refs = (value as { refs?: unknown }).refs;
  if (!Array.isArray(refs)) return undefined;
  return refs.map(refOf).filter((ref): ref is MaterialRef => !!ref);
}

function textOf(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const text = (value as Record<string, unknown>)[key];
  return typeof text === 'string' ? text : undefined;
}

/** 命令面板和可配置快捷键。keybinding 只传给「加入当前阅读」。 */
export function agentLiveCommands(keybinding?: string): AgentLiveCommand[] {
  const flags = new Map(AGENT_LIVE_ACTION_CATALOG.map((item) => [item.actionId || item.id, item]));
  const take = (id: string) => {
    const item = flags.get(id);
    return {
      id,
      title: item?.title || id,
      category: item?.category || 'agent',
      bridgeInvokable: item?.bridgeInvokable === true,
      approvalRequired: item?.approvalRequired === true,
    };
  };
  return [
    { ...take(AGENT_LIVE_ACTIONS.copyBridgeLink), run: () => { const b = getAgentLiveBinding(); if (b) return copyBridgeLink(b); } },
    { ...take(AGENT_LIVE_ACTIONS.copyWorkspaceLink), run: () => { const b = getAgentLiveBinding(); if (b) return copyWorkspaceLink(b); } },
    {
      ...take(AGENT_LIVE_ACTIONS.materialsAdd),
      run: (args?: unknown) => {
        const binding = getAgentLiveBinding();
        if (!binding) return;
        const ref = refOf(args) || refOf((args as { ref?: unknown } | undefined)?.ref);
        if (ref) return addSelection(binding, [ref]);
        return addCurrent(binding);
      },
    },
    {
      ...take(AGENT_LIVE_ACTIONS.materialsAddCurrent),
      ...(keybinding ? { keybinding } : {}),
      when: 'global' as const,
      run: () => { const b = getAgentLiveBinding(); if (b) return addCurrent(b); },
    },
    {
      ...take(AGENT_LIVE_ACTIONS.materialsAddSelection),
      run: (args?: unknown) => { const b = getAgentLiveBinding(); if (b) return addSelection(b, refsOf(args)); },
    },
    {
      ...take(AGENT_LIVE_ACTIONS.materialsRemove),
      run: (args?: unknown) => { const b = getAgentLiveBinding(); if (b) return removeSelected(b, textOf(args, 'materialId')); },
    },
    {
      ...take(AGENT_LIVE_ACTIONS.materialsReorder),
      run: (args?: unknown) => {
        const binding = getAgentLiveBinding();
        if (!binding) return;
        const order = args && typeof args === 'object' ? (args as { order?: unknown }).order : undefined;
        return reorderMaterials(binding, Array.isArray(order) ? order.filter((id): id is string => typeof id === 'string') : undefined);
      },
    },
    {
      ...take(AGENT_LIVE_ACTIONS.materialsSetPurpose),
      run: (args?: unknown) => {
        const binding = getAgentLiveBinding();
        if (!binding) return;
        const purpose = args && typeof args === 'object' && 'purpose' in args ? (args as { purpose?: string | null }).purpose : undefined;
        return setPurposeSelected(binding, purpose, textOf(args, 'materialId'));
      },
    },
    {
      ...take(AGENT_LIVE_ACTIONS.materialsPin),
      run: (args?: unknown) => { const b = getAgentLiveBinding(); if (b) return pinSelected(b, textOf(args, 'materialId')); },
    },
    {
      ...take(AGENT_LIVE_ACTIONS.materialsUnpin),
      run: (args?: unknown) => { const b = getAgentLiveBinding(); if (b) return unpinSelected(b, textOf(args, 'materialId')); },
    },
    {
      ...take(AGENT_LIVE_ACTIONS.materialsClearSession),
      run: () => { const b = getAgentLiveBinding(); if (b) return clearSession(b); },
    },
  ];
}

export function registerAgentLiveCommands(
  register: (command: AgentLiveCommand) => CommandDisposable,
  keybinding?: string,
): CommandDisposable[] {
  return agentLiveCommands(keybinding).map((command) => register(command));
}
