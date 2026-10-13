/**
 * 文件桥原白名单。迁到登记表之后，这两条的执行结果与界面通知保持原样。
 */
import { registerActions, registerInvokeExecutor } from '../registry';

let undoActions: (() => void) | null = null;
let undoPlans: (() => void) | null = null;
let undoHealth: (() => void) | null = null;

export function registerBuiltinBridgePackage(): void {
  if (undoActions) return;
  undoActions = registerActions('builtin.bridge', [
    {
      actionId: 'workbench.pendingPlans',
      title: '待批准计划…',
      category: '工作台',
      source: 'builtin',
      bridgeInvokable: true,
      approvalRequired: false,
    },
    {
      actionId: 'index.showHealth',
      title: '查看索引状态',
      category: '索引',
      source: 'builtin',
      bridgeInvokable: true,
      approvalRequired: false,
    },
  ]);
  undoPlans = registerInvokeExecutor('workbench.pendingPlans', async ({ actionId, host }) => {
    const plans = host.listPendingPlans();
    await host.notifyCommand?.(actionId)?.catch(() => undefined);
    return { status: 'success', result: { actionId, commandId: actionId, plans } };
  });
  undoHealth = registerInvokeExecutor('index.showHealth', async ({ actionId, host }) => {
    const health = host.getIndexHealth?.() ?? null;
    await host.notifyCommand?.(actionId)?.catch(() => undefined);
    return {
      status: 'success',
      result: {
        actionId,
        commandId: actionId,
        indexHealth: health,
        text: health ? '这是只读索引健康摘要。' : '索引健康接口尚未挂上。请在界面查看索引状态。',
      },
    };
  });
}

export function disposeBuiltinBridgePackage(): void {
  undoHealth?.();
  undoPlans?.();
  undoActions?.();
  undoHealth = null;
  undoPlans = null;
  undoActions = null;
}
