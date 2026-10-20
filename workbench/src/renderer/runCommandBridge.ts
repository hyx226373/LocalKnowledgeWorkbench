/**
 * host-r1 L2: window.__kb.runCommand used to be `commands.get(id)?.run()`:
 * - unregistered id silently returned undefined
 * - args were dropped, and callers could not tell "ran, returned void" from "not there".
 * runCommandResult always returns a structured result; runCommandCompat keeps the old
 * contract (returns the command value) but yields an explicit error object when unregistered.
 */
export interface CommandLike {
  run: (...args: any[]) => unknown;
}
export interface CommandLookup {
  get(id: string): CommandLike | undefined;
}

export type RunCommandResult =
  | { ok: true; commandId: string; value: unknown }
  | { ok: false; code: 'RENDERER_COMMAND_UNREGISTERED' | 'RENDERER_COMMAND_FAILED'; commandId: string; message: string };

export async function runCommandResult(commands: CommandLookup, id: string, ...args: unknown[]): Promise<RunCommandResult> {
  const c = commands.get(id);
  if (!c || typeof c.run !== 'function') {
    return { ok: false, code: 'RENDERER_COMMAND_UNREGISTERED', commandId: id, message: `renderer command not registered: ${id}` };
  }
  try {
    const value = await c.run(...args);
    return { ok: true, commandId: id, value: value === undefined ? null : value };
  } catch (e) {
    return { ok: false, code: 'RENDERER_COMMAND_FAILED', commandId: id, message: String((e as Error)?.message ?? e) };
  }
}

export function runCommandCompat(commands: CommandLookup, id: string, ...args: unknown[]): unknown {
  const c = commands.get(id);
  if (!c || typeof c.run !== 'function') {
    return { ok: false, code: 'RENDERER_COMMAND_UNREGISTERED', commandId: id, message: `renderer command not registered: ${id}` };
  }
  return c.run(...args);
}
