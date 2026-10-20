/**
 * desktopPanel.open / pickSource — 命令面板入口（GrabFrame 收口）。
 */
import type { CommandContribution, Disposable } from '../plugin-host/types';
import { commands } from '../plugin-host/registry';
import { DESKTOP_PANEL_COMMANDS, DESKTOP_PANEL_COMMAND_META } from '../../shared/desktopPanel/commands';

export interface DesktopPanelOpener {
  open(): void;
  pickSource(): void;
}

const stub: DesktopPanelOpener = {
  open() {
    console.warn('[desktop-panel] opener not wired');
  },
  pickSource() {
    console.warn('[desktop-panel] opener not wired');
  },
};

let opener: DesktopPanelOpener = stub;

export function setDesktopPanelOpener(next: DesktopPanelOpener): () => void {
  opener = next;
  return () => {
    opener = stub;
  };
}

export function registerDesktopPanelCommands(
  register: (c: CommandContribution) => Disposable = (c) => commands.register('builtin.desktop-panel', c),
): Disposable {
  if (commands.get(DESKTOP_PANEL_COMMANDS.open) && commands.get(DESKTOP_PANEL_COMMANDS.pickSource)) {
    return { dispose() {} };
  }
  const metaOpen = DESKTOP_PANEL_COMMAND_META.find((m) => m.id === DESKTOP_PANEL_COMMANDS.open)!;
  const metaPick = DESKTOP_PANEL_COMMAND_META.find((m) => m.id === DESKTOP_PANEL_COMMANDS.pickSource)!;
  const openDisp = register({
    id: metaOpen.id,
    title: metaOpen.title,
    category: metaOpen.category,
    run: () => opener.open(),
  });
  const pickDisp = register({
    id: metaPick.id,
    title: metaPick.title,
    category: metaPick.category,
    run: () => opener.pickSource(),
  });
  return {
    dispose() {
      openDisp.dispose();
      pickDisp.dispose();
    },
  };
}
