/**
 * 快速切换默认键的冲突判断。只读 findConflict，不写快捷键存储，也不替换已有绑定。
 */
import { QUICK_SWITCH_DEFAULT_KEY } from '../../shared/workspacePicker/types';
import { emptyStore, findConflict } from '../keybindings/store';
import type { KeybindingWhen } from '../keybindings/types';

export const OPEN_OVERVIEW_COMMAND_ID = 'workspace.openOverview';
export const QUICK_SWITCH_COMMAND_ID = 'workspace.quickSwitch';
export const OPEN_OVERVIEW_TITLE = '打开工作区总览';
export const QUICK_SWITCH_TITLE = '快速切换工作区';

/** 命令面板、只看内容、全屏保留键。本块不登记这三枚。 */
export const QUICK_SWITCH_PROTECTED_KEYS = ['Ctrl+Shift+P', 'Ctrl+Shift+F11', 'F11'] as const;

export type QuickSwitchConflictSource = 'builtin' | 'plugin' | 'user';

export const CONFLICT_SOURCE_LABEL: Record<QuickSwitchConflictSource, string> = {
  builtin: '内置动作',
  plugin: '插件贡献',
  user: '用户绑定',
};

export interface KeyCommandLike {
  id: string;
  title: string;
  keybinding?: string;
  when?: KeybindingWhen;
}

export interface QuickSwitchConflictParty {
  id: string;
  title: string;
  source: QuickSwitchConflictSource;
  key: string;
}

export interface QuickSwitchConflictReport {
  key: typeof QUICK_SWITCH_DEFAULT_KEY;
  ours: { id: typeof QUICK_SWITCH_COMMAND_ID; title: string };
  parties: QuickSwitchConflictParty[];
  skippedDefaultKey: true;
  wroteOverride: false;
}

export interface QuickSwitchKeyDecision {
  commandId: typeof QUICK_SWITCH_COMMAND_ID;
  requestedKey: typeof QUICK_SWITCH_DEFAULT_KEY;
  when: 'global';
  assignDefaultKey: boolean;
  report: QuickSwitchConflictReport | null;
  wroteOverride: false;
  usedReplace: false;
}

export interface WorkspacePickerCommandDraft {
  id: string;
  title: string;
  category: '工作区';
  when?: 'global';
  keybinding?: string;
  bridgeInvokable: true;
  approvalRequired: false;
}

const OURS: KeyCommandLike = {
  id: QUICK_SWITCH_COMMAND_ID,
  title: QUICK_SWITCH_TITLE,
  keybinding: QUICK_SWITCH_DEFAULT_KEY,
  when: 'global',
};

function party(source: QuickSwitchConflictSource, command: KeyCommandLike): QuickSwitchConflictParty {
  return {
    id: command.id,
    title: command.title || command.id,
    source,
    key: QUICK_SWITCH_DEFAULT_KEY,
  };
}

function scan(source: QuickSwitchConflictSource, commands: readonly KeyCommandLike[]): QuickSwitchConflictParty | null {
  const hit = findConflict(emptyStore(), [...commands, OURS], QUICK_SWITCH_COMMAND_ID, QUICK_SWITCH_DEFAULT_KEY, 'global');
  return hit ? party(source, hit) : null;
}

export function partitionKeyHolders(input: {
  commands: readonly (KeyCommandLike & { owner?: string })[];
  actions: readonly (KeyCommandLike & { source?: string; packageId?: string })[];
}): { builtinActions: KeyCommandLike[]; pluginCommands: KeyCommandLike[] } {
  const builtin: KeyCommandLike[] = [];
  const plugin: KeyCommandLike[] = [];
  const seen = new Set<string>();
  const push = (row: KeyCommandLike, asPlugin: boolean) => {
    if (!row.id || row.id === QUICK_SWITCH_COMMAND_ID || row.id === OPEN_OVERVIEW_COMMAND_ID) return;
    if (seen.has(row.id)) return;
    seen.add(row.id);
    const item: KeyCommandLike = { id: row.id, title: row.title, keybinding: row.keybinding, when: row.when };
    (asPlugin ? plugin : builtin).push(item);
  };
  for (const command of input.commands) {
    const owner = command.owner ?? '';
    push(command, owner.length > 0 && !owner.startsWith('builtin.'));
  }
  for (const action of input.actions) {
    const packageId = action.packageId ?? '';
    const asPlugin = action.source === 'plugin' || packageId.startsWith('plugin.') || packageId.startsWith('user.');
    push(action, asPlugin);
  }
  return { builtinActions: builtin, pluginCommands: plugin };
}

/** 内置动作、插件贡献、用户绑定各跑一次 findConflict。有冲突就不带默认键。 */
export function decideQuickSwitchKey(input: {
  builtinActions: readonly KeyCommandLike[];
  pluginCommands: readonly KeyCommandLike[];
  userBindings: readonly { id: string; title?: string; key: string; when?: KeybindingWhen }[];
}): QuickSwitchKeyDecision {
  const userCommands: KeyCommandLike[] = input.userBindings.map((binding) => ({
    id: binding.id,
    title: binding.title || binding.id,
    keybinding: binding.key,
    when: binding.when ?? 'global',
  }));
  const parties = [scan('builtin', input.builtinActions), scan('plugin', input.pluginCommands), scan('user', userCommands)].filter(
    (item): item is QuickSwitchConflictParty => item != null,
  );
  const protectedKeys: readonly string[] = QUICK_SWITCH_PROTECTED_KEYS;
  const assignDefaultKey = parties.length === 0 && !protectedKeys.includes(QUICK_SWITCH_DEFAULT_KEY);
  if (assignDefaultKey) {
    return {
      commandId: QUICK_SWITCH_COMMAND_ID,
      requestedKey: QUICK_SWITCH_DEFAULT_KEY,
      when: 'global',
      assignDefaultKey: true,
      report: null,
      wroteOverride: false,
      usedReplace: false,
    };
  }
  return {
    commandId: QUICK_SWITCH_COMMAND_ID,
    requestedKey: QUICK_SWITCH_DEFAULT_KEY,
    when: 'global',
    assignDefaultKey: false,
    wroteOverride: false,
    usedReplace: false,
    report: {
      key: QUICK_SWITCH_DEFAULT_KEY,
      ours: { id: QUICK_SWITCH_COMMAND_ID, title: QUICK_SWITCH_TITLE },
      parties,
      skippedDefaultKey: true,
      wroteOverride: false,
    },
  };
}

export function formatQuickSwitchConflict(report: QuickSwitchConflictReport): string {
  const others = report.parties
    .map((item) => `「${item.title}」（${item.id}，${CONFLICT_SOURCE_LABEL[item.source]}）`)
    .join('、');
  return `默认键 ${report.key} 与 ${others} 冲突。快速切换「${report.ours.title}」（${report.ours.id}）不覆盖该键，没有写入默认绑定。`;
}

export function workspacePickerCommandDrafts(decision: QuickSwitchKeyDecision): WorkspacePickerCommandDraft[] {
  const openOverview: WorkspacePickerCommandDraft = {
    id: OPEN_OVERVIEW_COMMAND_ID,
    title: OPEN_OVERVIEW_TITLE,
    category: '工作区',
    bridgeInvokable: true,
    approvalRequired: false,
  };
  const quick: WorkspacePickerCommandDraft = {
    id: QUICK_SWITCH_COMMAND_ID,
    title: QUICK_SWITCH_TITLE,
    category: '工作区',
    when: 'global',
    bridgeInvokable: true,
    approvalRequired: false,
  };
  if (decision.assignDefaultKey) quick.keybinding = QUICK_SWITCH_DEFAULT_KEY;
  return [openOverview, quick];
}

export function bindWorkspacePickerCommands(
  register: (command: WorkspacePickerCommandDraft & { run(): void }) => void,
  decision: QuickSwitchKeyDecision,
  run: { openOverview(): void; quickSwitch(): void },
): void {
  for (const draft of workspacePickerCommandDrafts(decision)) {
    const id = draft.id;
    register({
      ...draft,
      run: () => {
        if (id === OPEN_OVERVIEW_COMMAND_ID) run.openOverview();
        else run.quickSwitch();
      },
    });
  }
}