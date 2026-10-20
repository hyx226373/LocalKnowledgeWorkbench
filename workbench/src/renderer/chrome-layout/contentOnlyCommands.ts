/**
 * 只看内容 / 命令面板 / 恢复界面 — 命令与 window hook（03 裁决）
 * - 主 hook：`__kbToggleContentOnly`（切换）
 * - 兼容别名：`__kbExitContentOnly`（仅退出）
 * - Esc：仅当 productConfig.contentOnlyExit.escape === true
 * - 托管获焦时由 main 转发切换键到 toggle hook；退出时交还控制台焦点
 */
import {
  EXIT_CONTENT_ONLY_COMMAND_ID,
  EXIT_CONTENT_ONLY_HOOK,
  OPEN_COMMAND_PALETTE_COMMAND_ID,
  OPEN_COMMAND_PALETTE_HOOK,
  RESTORE_BASE_UI_COMMAND_ID,
  RESTORE_BASE_UI_HOOK,
  RESTORE_UI_COMMAND_ID,
  RESTORE_UI_HOOK,
  TOGGLE_CONTENT_ONLY_COMMAND_ID,
  TOGGLE_CONTENT_ONLY_HOOK,
  type ChromeStateSnapshot,
} from '../../shared/chromeLayout';
import type { ChromeController } from './controller';
import type { LayoutHost } from './layoutHost';

export {
  EXIT_CONTENT_ONLY_COMMAND_ID,
  EXIT_CONTENT_ONLY_HOOK,
  TOGGLE_CONTENT_ONLY_COMMAND_ID,
  TOGGLE_CONTENT_ONLY_HOOK,
  OPEN_COMMAND_PALETTE_COMMAND_ID,
  OPEN_COMMAND_PALETTE_HOOK,
  RESTORE_UI_COMMAND_ID,
  RESTORE_UI_HOOK,
  RESTORE_BASE_UI_COMMAND_ID,
  RESTORE_BASE_UI_HOOK,
};

/** 交互态：console = 控制台；hosted = 托管应用获焦 */
export type InteractionMode = 'console' | 'hosted';

let interactionMode: InteractionMode = 'console';
const modeListeners = new Set<() => void>();

export function getInteractionMode(): InteractionMode {
  return interactionMode;
}

export function setInteractionMode(mode: InteractionMode): void {
  if (interactionMode === mode) return;
  interactionMode = mode;
  for (const fn of modeListeners) fn();
}

export function subscribeInteractionMode(fn: () => void): () => void {
  modeListeners.add(fn);
  return () => modeListeners.delete(fn);
}

export function exitContentOnly(controller: ChromeController): ChromeStateSnapshot {
  if (!controller.getVisibility().contentOnly) return controller.getVisibility();
  return controller.setContentOnly(false);
}

export function toggleContentOnly(controller: ChromeController): ChromeStateSnapshot {
  return controller.toggleContentOnly();
}

export function restoreBaseUI(controller: ChromeController): ChromeStateSnapshot {
  return controller.restoreBaseUI();
}

export function restoreUI(controller: ChromeController): ChromeStateSnapshot {
  // 托盘「恢复界面」：退出只看内容并 restore 已保存 chrome
  if (controller.getVisibility().contentOnly) {
    controller.setContentOnly(false);
  }
  return controller.restore();
}

/**
 * 退出只看内容后的焦点策略（03）：退出托管操作，焦点交还控制台。
 * 经布局宿主唯一路径 host.activate({ focusHost: false })。
 */
export async function onExitContentOnlyFocus(
  layoutHost: LayoutHost | null | undefined,
  _getPanelIds?: () => string[],
): Promise<void> {
  setInteractionMode('console');
  if (!layoutHost) return;
  await layoutHost.yieldFocusToConsole();
}

/** 命令面板是否应响应默认快捷键（控制台交互态） */
export function shouldOpenCommandPaletteByDefaultKey(controller: ChromeController): boolean {
  const cfg = controller.productConfig;
  if (!cfg.commandPaletteConsoleOnly) return true;
  return getInteractionMode() === 'console';
}

export type OpenPaletteFn = () => void;

/**
 * 安装 window hooks（main/托盘转发目标）。
 * 返回卸载函数。
 */
function hookTarget(): Record<string, unknown> {
  if (typeof window !== 'undefined') return window as unknown as Record<string, unknown>;
  return globalThis as unknown as Record<string, unknown>;
}

export function installChromeCommandHooks(opts: {
  controller: ChromeController;
  layoutHost?: LayoutHost | null;
  getHostedPanelIds?: () => string[];
  openCommandPalette?: OpenPaletteFn;
}): () => void {
  const w = hookTarget();
  const prev: Record<string, unknown> = {};
  const keys = [
    TOGGLE_CONTENT_ONLY_HOOK,
    EXIT_CONTENT_ONLY_HOOK,
    OPEN_COMMAND_PALETTE_HOOK,
    RESTORE_UI_HOOK,
    RESTORE_BASE_UI_HOOK,
  ] as const;
  for (const k of keys) prev[k] = w[k];

  const afterExit = async (snap: ChromeStateSnapshot) => {
    if (!snap.contentOnly) {
      await onExitContentOnlyFocus(opts.layoutHost, opts.getHostedPanelIds ?? (() => []));
    }
    return snap;
  };

  w[TOGGLE_CONTENT_ONLY_HOOK] = async () => {
    const was = opts.controller.getVisibility().contentOnly;
    const snap = toggleContentOnly(opts.controller);
    if (was && !snap.contentOnly) await afterExit(snap);
    if (!was && snap.contentOnly) setInteractionMode('hosted'); // 进入只看内容时可交托管
    return snap;
  };

  // 兼容别名：仅退出
  w[EXIT_CONTENT_ONLY_HOOK] = async () => {
    const snap = exitContentOnly(opts.controller);
    await afterExit(snap);
    return snap;
  };

  w[OPEN_COMMAND_PALETTE_HOOK] = () => {
    opts.openCommandPalette?.();
  };

  w[RESTORE_UI_HOOK] = async () => {
    const snap = restoreUI(opts.controller);
    await afterExit(snap);
    return snap;
  };

  w[RESTORE_BASE_UI_HOOK] = () => restoreBaseUI(opts.controller);

  return () => {
    for (const k of keys) {
      if (prev[k] === undefined) delete w[k];
      else w[k] = prev[k];
    }
  };
}

/** @deprecated 使用 installChromeCommandHooks */
export function installExitContentOnlyHook(controller: ChromeController): () => void {
  return installChromeCommandHooks({ controller });
}
