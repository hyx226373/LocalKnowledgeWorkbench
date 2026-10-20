import { describe, expect, it } from 'vitest';
import { DESKTOP_PANEL_COMMANDS, DESKTOP_PANEL_COMMAND_META } from '../src/shared/desktopPanel/commands';
import { DESKTOP_PANEL_COMPONENT, DESKTOP_PANEL_DOCK_ID } from '../src/renderer/desktop-panel/ids';
import { registerDesktopPanelCommands, setDesktopPanelOpener } from '../src/renderer/desktop-panel/commands';
import { commands } from '../src/renderer/plugin-host/registry';

describe('desktop-panel GrabFrame close entry', () => {
  it('exposes open + pickSource command meta', () => {
    expect(DESKTOP_PANEL_COMMANDS.open).toBe('desktopPanel.open');
    expect(DESKTOP_PANEL_COMMANDS.pickSource).toBe('desktopPanel.pickSource');
    const ids = DESKTOP_PANEL_COMMAND_META.map((m) => m.id);
    expect(ids).toContain('desktopPanel.open');
    expect(ids).toContain('desktopPanel.pickSource');
  });

  it('registers commands into palette registry (idempotent)', () => {
    let opens = 0;
    let picks = 0;
    setDesktopPanelOpener({
      open: () => {
        opens++;
      },
      pickSource: () => {
        picks++;
      },
    });
    commands.unregister(DESKTOP_PANEL_COMMANDS.open);
    commands.unregister(DESKTOP_PANEL_COMMANDS.pickSource);
    const d1 = registerDesktopPanelCommands((c) => commands.register('test.desktop-panel', c));
    const d2 = registerDesktopPanelCommands((c) => commands.register('test.desktop-panel', c));
    expect(commands.get(DESKTOP_PANEL_COMMANDS.open)?.id).toBe('desktopPanel.open');
    expect(commands.get(DESKTOP_PANEL_COMMANDS.pickSource)?.id).toBe('desktopPanel.pickSource');
    void commands.get(DESKTOP_PANEL_COMMANDS.open)!.run();
    void commands.get(DESKTOP_PANEL_COMMANDS.pickSource)!.run();
    expect(opens).toBe(1);
    expect(picks).toBe(1);
    d1.dispose();
    d2.dispose();
  });

  it('dock component id is stable', () => {
    expect(DESKTOP_PANEL_COMPONENT).toBe('desktop-panel');
    expect(DESKTOP_PANEL_DOCK_ID).toBe('desktop-panel.main');
  });
});
