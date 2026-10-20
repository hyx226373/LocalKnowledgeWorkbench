/**
 * 「只看内容」默认键冲突判断。只读 findConflict，不写快捷键存储，也不替换已有绑定。
 * 冻结：03-界面三裁决 — 默认 Ctrl+Shift+F11；冲突明确报告并保留已有用户绑定。
 * 用户/第四波：Ctrl+Shift+F 给快速切换；Ctrl+Shift+P 命令面板；F11 保留。
 * 命令 id：view.contentOnly（稳定；设置页可改绑）。
 */
import { emptyStore, findConflict } from '../keybindings/store';
import type { KeybindingWhen } from '../keybindings/types';

export const CONTENT_ONLY_COMMAND_ID = 'view.contentOnly' as const;
export const CONTENT_ONLY_TITLE = '只看内容（开/关）';
export const CONTENT_ONLY_DEFAULT_KEY = 'Ctrl+Shift+F11' as const;
export const CONTENT_ONLY_CATEGORY = '外观' as const;

/** 命令面板、快速切换、全屏保留键——登记时不得抢占。 */
export const CONTENT_ONLY_PROTECTED_KEYS = ['Ctrl+Shift+P', 'Ctrl+Shift+F', 'F11'] as const;

export type ContentOnlyConflictSource = 'builtin' | 'plugin' | 'user';

export const CONTENT_ONLY_CONFLICT_SOURCE_LABEL: Record<ContentOnlyConflictSource, string> = {
  builtin: '内置动作',
  plugin: '插件贡献',
  user: '用户绑定',
};

export interface ContentOnlyKeyCommandLike {
  id: string;
  title: string;
  keybinding?: string;
  when?: KeybindingWhen;
}

export interface ContentOnlyConflictParty {
  id: string;
  title: string;
  source: ContentOnlyConflictSource;
  key: string;
}

export interface ContentOnlyConflictReport {
  key: typeof CONTENT_ONLY_DEFAULT_KEY;
  ours: { id: typeof CONTENT_ONLY_COMMAND_ID; title: string };
  parties: ContentOnlyConflictParty[];
  skippedDefaultKey: true;
  wroteOverride: false;
  reason: string;
}

export interface ContentOnlyKeyDecision {
  commandId: typeof CONTENT_ONLY_COMMAND_ID;
  requestedKey: typeof CONTENT_ONLY_DEFAULT_KEY;
  when: 'global';
  assignDefaultKey: boolean;
  report: ContentOnlyConflictReport | null;
  wroteOverride: false;
  usedReplace: false;
}

export interface ContentOnlyCommandDraft {
  id: typeof CONTENT_ONLY_COMMAND_ID;
  title: string;
  category: typeof CONTENT_ONLY_CATEGORY;
  when?: 'global';
  keybinding?: string;
}

const OURS: ContentOnlyKeyCommandLike = {
  id: CONTENT_ONLY_COMMAND_ID,
  title: CONTENT_ONLY_TITLE,
  keybinding: CONTENT_ONLY_DEFAULT_KEY,
  when: 'global',
};

function party(source: ContentOnlyConflictSource, command: ContentOnlyKeyCommandLike): ContentOnlyConflictParty {
  return {
    id: command.id,
    title: command.title || command.id,
    source,
    key: CONTENT_ONLY_DEFAULT_KEY,
  };
}

function scan(
  source: ContentOnlyConflictSource,
  commands: readonly ContentOnlyKeyCommandLike[],
): ContentOnlyConflictParty | null {
  const hit = findConflict(
    emptyStore(),
    [...commands, OURS],
    CONTENT_ONLY_COMMAND_ID,
    CONTENT_ONLY_DEFAULT_KEY,
    'global',
  );
  return hit ? party(source, hit) : null;
}

export function partitionContentOnlyKeyHolders(input: {
  commands: readonly (ContentOnlyKeyCommandLike & { owner?: string })[];
  actions: readonly (ContentOnlyKeyCommandLike & { source?: string; packageId?: string })[];
}): { builtinActions: ContentOnlyKeyCommandLike[]; pluginCommands: ContentOnlyKeyCommandLike[] } {
  const builtin: ContentOnlyKeyCommandLike[] = [];
  const plugin: ContentOnlyKeyCommandLike[] = [];
  const seen = new Set<string>();
  const push = (row: ContentOnlyKeyCommandLike, asPlugin: boolean) => {
    if (!row.id || row.id === CONTENT_ONLY_COMMAND_ID) return;
    if (seen.has(row.id)) return;
    seen.add(row.id);
    const item: ContentOnlyKeyCommandLike = {
      id: row.id,
      title: row.title,
      keybinding: row.keybinding,
      when: row.when,
    };
    (asPlugin ? plugin : builtin).push(item);
  };
  for (const command of input.commands) {
    const owner = command.owner ?? '';
    push(command, owner.length > 0 && !owner.startsWith('builtin.'));
  }
  for (const action of input.actions) {
    const packageId = action.packageId ?? '';
    const asPlugin =
      action.source === 'plugin' || packageId.startsWith('plugin.') || packageId.startsWith('user.');
    push(action, asPlugin);
  }
  return { builtinActions: builtin, pluginCommands: plugin };
}

/** 内置 / 插件 / 用户绑定各跑一次 findConflict；有冲突则不带默认键、不写 override、不用 replace。 */
export function decideContentOnlyKey(input: {
  builtinActions: readonly ContentOnlyKeyCommandLike[];
  pluginCommands: readonly ContentOnlyKeyCommandLike[];
  userBindings: readonly { id: string; title?: string; key: string; when?: KeybindingWhen }[];
}): ContentOnlyKeyDecision {
  const userCommands: ContentOnlyKeyCommandLike[] = input.userBindings.map((binding) => ({
    id: binding.id,
    title: binding.title || binding.id,
    keybinding: binding.key,
    when: binding.when ?? 'global',
  }));
  const parties = [
    scan('builtin', input.builtinActions),
    scan('plugin', input.pluginCommands),
    scan('user', userCommands),
  ].filter((item): item is ContentOnlyConflictParty => item != null);

  const protectedHit = (CONTENT_ONLY_PROTECTED_KEYS as readonly string[]).includes(CONTENT_ONLY_DEFAULT_KEY);
  const assignDefaultKey = parties.length === 0 && !protectedHit;

  if (assignDefaultKey) {
    return {
      commandId: CONTENT_ONLY_COMMAND_ID,
      requestedKey: CONTENT_ONLY_DEFAULT_KEY,
      when: 'global',
      assignDefaultKey: true,
      report: null,
      wroteOverride: false,
      usedReplace: false,
    };
  }

  const reason =
    parties.length > 0
      ? `默认键 ${CONTENT_ONLY_DEFAULT_KEY} 已被占用；不覆盖已有绑定`
      : `默认键 ${CONTENT_ONLY_DEFAULT_KEY} 落在保留键集合，跳过登记`;

  return {
    commandId: CONTENT_ONLY_COMMAND_ID,
    requestedKey: CONTENT_ONLY_DEFAULT_KEY,
    when: 'global',
    assignDefaultKey: false,
    wroteOverride: false,
    usedReplace: false,
    report: {
      key: CONTENT_ONLY_DEFAULT_KEY,
      ours: { id: CONTENT_ONLY_COMMAND_ID, title: CONTENT_ONLY_TITLE },
      parties,
      skippedDefaultKey: true,
      wroteOverride: false,
      reason,
    },
  };
}

export function formatContentOnlyConflict(report: ContentOnlyConflictReport): string {
  if (report.parties.length === 0) {
    return `「${report.ours.title}」（${report.ours.id}）未绑定默认键：${report.reason}`;
  }
  const others = report.parties
    .map((item) => `「${item.title}」（${item.id}，${CONTENT_ONLY_CONFLICT_SOURCE_LABEL[item.source]}）`)
    .join('、');
  return `默认键 ${report.key} 与 ${others} 冲突。只看内容「${report.ours.title}」（${report.ours.id}）不覆盖该键，没有写入默认绑定。原因：${report.reason}`;
}

export function contentOnlyCommandDraft(decision: ContentOnlyKeyDecision): ContentOnlyCommandDraft {
  const draft: ContentOnlyCommandDraft = {
    id: CONTENT_ONLY_COMMAND_ID,
    title: CONTENT_ONLY_TITLE,
    category: CONTENT_ONLY_CATEGORY,
    when: 'global',
  };
  if (decision.assignDefaultKey) draft.keybinding = CONTENT_ONLY_DEFAULT_KEY;
  return draft;
}

/**
 * 注册命令。冲突时仍注册命令（无默认键），返回 report 供 UI/日志展示「已被XXX使用」。
 */
export function bindContentOnlyCommand(
  register: (command: ContentOnlyCommandDraft & { run(): void }) => void,
  decision: ContentOnlyKeyDecision,
  run: () => void,
): ContentOnlyConflictReport | null {
  const draft = contentOnlyCommandDraft(decision);
  register({ ...draft, run });
  return decision.report;
}
