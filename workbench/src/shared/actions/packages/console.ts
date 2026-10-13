/**
 * 控制台打开命令。本轮不进桥白名单，界面仍走 commands.execute。
 * 开整组需要参数校验，缺省不开放。
 */
import { registerActions } from '../registry';

let undo: (() => void) | null = null;

export function registerConsolePackage(): void {
  if (undo) return;
  undo = registerActions('console', [
    {
      actionId: 'console.openItem',
      title: '控制台：打开一项',
      category: '控制台',
      source: 'console',
      bridgeInvokable: false,
      approvalRequired: false,
    },
    {
      actionId: 'console.openGroup',
      title: '控制台：打开整组',
      category: '控制台',
      source: 'console',
      bridgeInvokable: false,
      approvalRequired: false,
    },
  ]);
}
