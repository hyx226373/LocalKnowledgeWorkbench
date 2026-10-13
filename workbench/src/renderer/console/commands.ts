/**
 * 命令 id 与 14 号登记名一致。F1 的执行体是占位；F2 用 setConsoleOpener 接上真正的打开。
 * 占位只抛错，不打开面板。
 */
import type { ConsoleIndex, ConsoleIndexItem } from '../../shared/consoleSchema';
import { CONSOLE_COMMAND_OPEN_GROUP, CONSOLE_COMMAND_OPEN_ITEM } from '../../shared/consoleSchema';
import type { CommandContribution, Disposable } from '../plugin-host/types';
import { commands } from '../plugin-host/registry';

export interface OpenGroupResult {
  ok: string[];
  failed: Array<{ id: string; reason: string }>;
}

export interface ConsoleOpener {
  openItem(item: ConsoleIndexItem): Promise<void>;
  openGroup(index: ConsoleIndex): Promise<OpenGroupResult>;
}

const stub: ConsoleOpener = {
  async openItem() {
    throw new Error('F2 stub');
  },
  async openGroup() {
    throw new Error('F2 stub');
  },
};

let opener: ConsoleOpener = stub;

export function setConsoleOpener(next: ConsoleOpener): () => void {
  opener = next;
  return () => {
    opener = stub;
  };
}

export function currentConsoleOpener(): ConsoleOpener {
  return opener;
}

export function registerConsoleCommands(register: (c: CommandContribution) => Disposable = (c) => commands.register('builtin.console', c)): Disposable {
  if (commands.get(CONSOLE_COMMAND_OPEN_ITEM) && commands.get(CONSOLE_COMMAND_OPEN_GROUP)) return { dispose() {} };
  const item = register({
    id: CONSOLE_COMMAND_OPEN_ITEM,
    title: '控制台：打开一项',
    category: '控制台',
    run: (arg) => opener.openItem(arg as ConsoleIndexItem),
  });
  const group = register({
    id: CONSOLE_COMMAND_OPEN_GROUP,
    title: '控制台：打开整组',
    category: '控制台',
    run: (arg) => opener.openGroup(arg as ConsoleIndex),
  });
  return {
    dispose() {
      item.dispose();
      group.dispose();
    },
  };
}
