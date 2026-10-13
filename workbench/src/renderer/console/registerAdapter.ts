import type { PluginApi } from '../plugin-host/types';
import { ConsolePanel } from './ConsolePanel';
import { registerConsoleCommands } from './commands';

/** `.kbconsole.md` 优先于普通 Markdown。正文里的 front matter / kind:console 仍由 Markdown 视图转交。 */
export function registerConsoleAdapter(api: PluginApi) {
  registerConsoleCommands((c) => api.commands.register(c));
  api.adapters.register({
    id: 'builtin.console',
    title: '控制台',
    sourceKinds: ['file'],
    displayMode: 'in-app-reader',
    reportsReady: true,
    handlesFileChanges: true,
    match: (target) => (target.sourceKind === 'file' && /\.kbconsole\.md$/i.test(target.resource.name) ? 200 : 0),
    component: ConsolePanel,
  });
}
