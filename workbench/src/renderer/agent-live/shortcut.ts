import { AGENT_LIVE_ACTIONS } from '../../shared/agentLive/types';
import { findConflict } from '../keybindings/store';
import { normalizeKeybinding } from '../keybindings/normalize';
import type { KeybindingWhen, KeybindingsStoreV1 } from '../keybindings/types';

export const ADD_CURRENT_DEFAULT = 'Ctrl+Shift+A';
/** 截图软件常占用，本功能不用。 */
export const ADD_CURRENT_FORBIDDEN = 'Ctrl+Alt+A';

export interface BindingCommand {
  id: string;
  title: string;
  keybinding?: string;
  when?: KeybindingWhen;
  trigger?: 'key' | 'wheel';
}

export interface AddCurrentBinding {
  /** 不设表示命令仍在命令面板里，但没有默认键。 */
  keybinding?: string;
  /** global：PDF 等阅读窗口也要能用。托管外部程序时靠 yieldToHost 从全局钩子拿掉。 */
  when: 'global';
  /** 为 true 时，全局快捷键钩子必须放行，不能抢前台外部应用。 */
  yieldToHost: boolean;
  reason: string;
}

function forbidden(key: string | null | undefined): boolean {
  const normal = normalizeKeybinding(key);
  return normal === normalizeKeybinding(ADD_CURRENT_FORBIDDEN);
}

/**
 * 先看用户是否已经绑过这枚命令：有就保留，包括用户主动清掉。
 * 没有用户绑定才考虑 Ctrl+Shift+A，并且和现有有效绑定冲突时不覆盖。
 * 托管外部应用处于前台时，yieldToHost 为 true。
 */
export function decideAddCurrentBinding(
  commands: readonly BindingCommand[],
  store: KeybindingsStoreV1,
  opts: { hostedForeground: boolean },
): AddCurrentBinding {
  const yieldToHost = opts.hostedForeground;
  const when = 'global' as const;
  const hasUser = Object.prototype.hasOwnProperty.call(store.overrides, AGENT_LIVE_ACTIONS.materialsAddCurrent);
  if (hasUser) {
    const key = store.overrides[AGENT_LIVE_ACTIONS.materialsAddCurrent];
    if (key == null || key === '') {
      return { when, yieldToHost, reason: '保留用户已清除的快捷键' };
    }
    if (forbidden(key)) {
      return { when, yieldToHost, reason: '用户绑定了 Ctrl+Alt+A，本功能不使用该键' };
    }
    return { keybinding: normalizeKeybinding(key) ?? undefined, when, yieldToHost, reason: '保留用户绑定' };
  }
  const other = findConflict(store, [...commands], AGENT_LIVE_ACTIONS.materialsAddCurrent, ADD_CURRENT_DEFAULT, when);
  if (other) {
    return { when, yieldToHost, reason: `Ctrl+Shift+A 已被「${other.title}」使用，不覆盖` };
  }
  return { keybinding: ADD_CURRENT_DEFAULT, when, yieldToHost, reason: '使用默认快捷键 Ctrl+Shift+A' };
}

export function acceleratorsForGlobalHook<T extends { commandId: string }>(list: readonly T[], hostedForeground: boolean): T[] {
  if (!hostedForeground) return [...list];
  return list.filter((item) => item.commandId !== AGENT_LIVE_ACTIONS.materialsAddCurrent);
}
