/**
 * Register desktop-panel commands on PluginApi (same pattern as console).
 */
import type { PluginApi } from '../plugin-host/types';
import { registerDesktopPanelCommands } from './commands';

export function registerDesktopPanel(api: PluginApi): void {
  registerDesktopPanelCommands((c) => api.commands.register(c));
}
