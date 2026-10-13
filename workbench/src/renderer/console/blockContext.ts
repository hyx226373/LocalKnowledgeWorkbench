/**
 * 插件功能块注册点。动作上下文只有 commands.execute 与 ops.propose，没有 approve。
 */
import type { ConsoleBlockContext, ConsoleBlockContribution, Disposable } from '../plugin-host/types';
import { consoleBlockRegistry } from '../plugin-host/registry';

export type { ConsoleBlockContext, ConsoleBlockContribution };

const FORBIDDEN = /approve/i;
const logLines: string[] = [];

export function consoleBlockLog(message: string) {
  const line = `[consoleBlocks] ${message}`;
  logLines.push(line);
  console.warn(line);
}

export function readConsoleBlockLog(): readonly string[] {
  return logLines;
}

export function clearConsoleBlockLog() {
  logLines.length = 0;
}

export function forbiddenActionName(name: string): boolean {
  return FORBIDDEN.test(name);
}

/** 交给插件的上下文。对象上没有 approve。 */
export function safeConsoleContext(ctx: ConsoleBlockContext): ConsoleBlockContext {
  return {
    commands: { execute: (id, ...args) => ctx.commands.execute(id, ...args) },
    ops: { propose: (title, ops) => ctx.ops.propose(title, ops) },
    log: (message) => ctx.log(message),
  };
}

export function registerConsoleBlock(owner: string, contribution: ConsoleBlockContribution): Disposable {
  const kind = contribution.kind?.trim();
  if (!kind) {
    consoleBlockLog('拒绝注册：缺少 kind');
    return { dispose() {} };
  }
  const illegal = Object.keys(contribution.actions ?? {}).filter(forbiddenActionName);
  if (illegal.length) {
    consoleBlockLog(`拒绝注册 ${kind}：含非法动作 ${illegal.join(', ')}`);
    return { dispose() {} };
  }
  if (!Number.isInteger(contribution.version) || contribution.version < 1) {
    consoleBlockLog(`拒绝注册 ${kind}：version 无效`);
    return { dispose() {} };
  }
  try {
    return consoleBlockRegistry.register(owner, { ...contribution, kind, id: kind });
  } catch (e) {
    consoleBlockLog(`拒绝注册 ${kind}：${(e as Error).message}`);
    return { dispose() {} };
  }
}

export async function invokeConsoleBlockAction(kind: string, name: string, args: unknown, ctx: ConsoleBlockContext): Promise<void> {
  if (forbiddenActionName(name)) {
    consoleBlockLog(`拒绝动作 ${name}`);
    return;
  }
  const block = consoleBlockRegistry.get(kind);
  const fn = block?.actions?.[name];
  if (!fn) {
    consoleBlockLog(`空操作：${kind} 没有动作 ${name}`);
    return;
  }
  await fn(args, safeConsoleContext(ctx));
}
