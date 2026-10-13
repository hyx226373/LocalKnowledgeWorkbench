import { afterEach, describe, expect, it } from 'vitest';
import { commands, consoleBlockRegistry } from '../src/renderer/plugin-host/registry';
import {
  clearConsoleBlockLog,
  invokeConsoleBlockAction,
  readConsoleBlockLog,
  registerConsoleBlock,
  safeConsoleContext,
  type ConsoleBlockContext,
} from '../src/renderer/console/blockContext';
import { registerConsoleCommands } from '../src/renderer/console/commands';
import { CONSOLE_COMMAND_OPEN_GROUP, CONSOLE_COMMAND_OPEN_ITEM } from '../src/shared/consoleSchema';

const ctx: ConsoleBlockContext = {
  commands: { execute: async () => 'ran' },
  ops: { propose: async () => 'planned' },
  log: () => {},
};

afterEach(() => {
  consoleBlockRegistry.unregisterOwner('test');
  commands.unregister('console.openItem');
  commands.unregister('console.openGroup');
  clearConsoleBlockLog();
});

describe('consoleBlocks.register', () => {
  it('注册、渲染、释放', () => {
    let disposed = false;
    const reg = registerConsoleBlock('test', {
      kind: 'note',
      version: 1,
      render: () => {
        return { element: 'note-view', dispose: () => { disposed = true; } };
      },
    });
    const block = consoleBlockRegistry.get('note');
    expect(block?.kind).toBe('note');
    const view = block!.render({ version: 1, data: { text: 'hi' } }, safeConsoleContext(ctx));
    expect(view.element).toBe('note-view');
    view.dispose();
    expect(disposed).toBe(true);
    reg.dispose();
    expect(consoleBlockRegistry.get('note')).toBeUndefined();
  });

  it('非法动作拒绝注册并记日志，上下文没有 approve', () => {
    const reg = registerConsoleBlock('test', {
      kind: 'evil',
      version: 1,
      render: () => ({ dispose() {} }),
      actions: { approve() {}, 'ops.approve'() {} },
    });
    expect(consoleBlockRegistry.get('evil')).toBeUndefined();
    expect(readConsoleBlockLog().join('\n')).toMatch(/拒绝注册/);
    reg.dispose();
    const safe = safeConsoleContext(ctx);
    expect(Object.keys(safe).sort()).toEqual(['commands', 'log', 'ops']);
    expect(Object.keys(safe.ops)).toEqual(['propose']);
    expect('approve' in safe).toBe(false);
    expect('approve' in safe.ops).toBe(false);
  });

  it('未声明或名为 approve 的动作是空操作并记日志', async () => {
    registerConsoleBlock('test', {
      kind: 'note',
      version: 1,
      render: () => ({ dispose() {} }),
      actions: { ping: () => {} },
    });
    await invokeConsoleBlockAction('note', 'approve', {}, ctx);
    await invokeConsoleBlockAction('note', 'missing', {}, ctx);
    const log = readConsoleBlockLog().join('\n');
    expect(log).toMatch(/拒绝动作 approve/);
    expect(log).toMatch(/空操作/);
  });

  it('登记 console.openItem 与 console.openGroup，执行是 F2 stub', async () => {
    const reg = registerConsoleCommands();
    expect(commands.get(CONSOLE_COMMAND_OPEN_ITEM)?.title).toContain('打开一项');
    expect(commands.get(CONSOLE_COMMAND_OPEN_GROUP)?.title).toContain('打开整组');
    await expect(commands.get(CONSOLE_COMMAND_OPEN_ITEM)!.run()).rejects.toThrow(/F2 stub/);
    await expect(commands.get(CONSOLE_COMMAND_OPEN_GROUP)!.run()).rejects.toThrow(/F2 stub/);
    reg.dispose();
    expect(commands.get(CONSOLE_COMMAND_OPEN_ITEM)).toBeUndefined();
  });
});
