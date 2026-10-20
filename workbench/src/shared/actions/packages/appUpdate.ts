/**
 * 更新动作。检查是只读的，桥可以直接执行。
 * 打开下载链接与回滚提示必须在人机界面批准，这里不注册执行体。
 */
import { registerActions, registerInvokeExecutor, type ActionInvokeResult } from '../registry';
import type { ActionInput } from '../types';

export const APP_UPDATE_IDS = ['app.checkUpdate', 'app.installUpdate', 'app.rollbackUpdate'] as const;

export const APP_UPDATE_ACTIONS: readonly ActionInput[] = [
  {
    actionId: 'app.checkUpdate',
    title: '检查更新',
    category: '更新',
    source: 'app',
    bridgeInvokable: true,
    approvalRequired: false,
    argsSchema: { type: 'object', additionalProperties: false, description: '只读检查公开版本信号。不下载、不安装。' },
  },
  {
    actionId: 'app.installUpdate',
    title: '打开下载链接',
    category: '更新',
    source: 'app',
    bridgeInvokable: true,
    approvalRequired: true,
    argsSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { when: { enum: ['now', 'quit'] } },
      description: '在浏览器打开公开下载链接；用户自行覆盖安装。桥只提出，不安装。',
    },
  },
  {
    actionId: 'app.rollbackUpdate',
    title: '回滚到上一版',
    category: '更新',
    source: 'app',
    bridgeInvokable: true,
    approvalRequired: true,
    argsSchema: { type: 'object', additionalProperties: false, description: '简化更新后不再自动回滚；请用户自行覆盖安装。桥只提出。' },
  },
];

export type UpdateCheckFn = () => Promise<unknown>;

let checker: UpdateCheckFn | null = null;
let undoActions: (() => void) | null = null;
let undoExec: (() => void) | null = null;

export function setAppUpdateChecker(fn: UpdateCheckFn | null): void {
  checker = fn;
}

export function registerAppUpdatePackage(): void {
  if (undoActions) return;
  undoActions = registerActions('app.update', APP_UPDATE_ACTIONS);
  undoExec = registerInvokeExecutor('app.checkUpdate', async ({ actionId }): Promise<ActionInvokeResult> => {
    const run = checker;
    if (!run) return { status: 'failed', error: { code: 'not_ready', message: '更新服务还没启动' } };
    try {
      const update = await run();
      return { status: 'success', result: { actionId, commandId: actionId, update } };
    } catch (err) {
      return { status: 'failed', error: { code: 'update_check_failed', message: String((err as Error).message ?? err) } };
    }
  });
}

export function disposeAppUpdatePackage(): void {
  undoExec?.();
  undoActions?.();
  undoExec = null;
  undoActions = null;
  checker = null;
}
