/**
 * 从已登记的命令、内置动作和用户绑定收集冲突输入。不写存储。
 */
import { listActions } from '../../shared/actions/registry';
import { getKeybindingsStore } from '../keybindings/runtime';
import { commands } from '../plugin-host/registry';
import { decideQuickSwitchKey, partitionKeyHolders, type QuickSwitchKeyDecision } from './quickSwitchKey';

export function readQuickSwitchConflictInput(): Parameters<typeof decideQuickSwitchKey>[0] {
  const store = getKeybindingsStore();
  const partitioned = partitionKeyHolders({
    commands: commands.all().map((command) => ({
      id: command.id,
      title: command.title,
      keybinding: command.keybinding,
      when: command.when,
      owner: command.owner,
    })),
    actions: listActions().map((action) => ({
      id: action.actionId,
      title: action.title,
      keybinding: action.keybinding,
      when: action.when,
      source: action.source,
      packageId: action.packageId,
    })),
  });
  const userBindings = Object.entries(store.overrides).flatMap(([id, key]) => {
    if (typeof key !== 'string' || !key) return [];
    const command = commands.get(id);
    const when = store.whenOverrides?.[id] ?? command?.when ?? 'global';
    return [{ id, title: command?.title ?? id, key, when }];
  });
  return { ...partitioned, userBindings };
}

export function decideLiveQuickSwitchKey(): QuickSwitchKeyDecision {
  return decideQuickSwitchKey(readQuickSwitchConflictInput());
}