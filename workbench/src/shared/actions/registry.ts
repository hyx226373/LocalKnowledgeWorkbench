/**
 * 进程内登记表。主进程与渲染进程各自一份内存；包模块在两边都 install。
 * 同一 actionId 可以出现在多个包里。桥可调 = 任一包把 bridgeInvokable 设为 true。
 * 任一包把 approvalRequired 设为 true，则桥拒绝直接执行。
 */
import type { ActionInput, ResolvedAction } from './types';

const packages = new Map<string, Map<string, ResolvedAction>>();
const executors = new Map<string, ActionExecutor>();

export interface ActionInvokeResult {
  status: 'success' | 'failed' | 'awaiting_approval' | 'conflict' | 'pending' | 'running';
  result?: unknown;
  error?: { code: string; message: string };
  planId?: string;
}

export interface ActionExecutorHost {
  listPendingPlans(): { planId: string; title: string; status: string; actor?: string; contentHash?: string }[];
  getIndexHealth?(): { engine: string; contentSearch: boolean; reason?: string; since?: number } | null;
  notifyCommand?(actionId: string, args?: Record<string, unknown>): Promise<void>;
}

export interface ActionExecutorContext {
  actionId: string;
  args?: Record<string, unknown>;
  host: ActionExecutorHost;
}

export type ActionExecutor = (ctx: ActionExecutorContext) => Promise<ActionInvokeResult> | ActionInvokeResult;

export function actionIdOf(raw: ActionInput): string | null {
  const id = typeof raw.actionId === 'string' && raw.actionId.trim() ? raw.actionId.trim() : '';
  if (id) return id;
  return typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : null;
}

export function normalizeAction(packageId: string, raw: ActionInput): ResolvedAction {
  const actionId = actionIdOf(raw);
  if (!actionId) throw new Error(`包 ${packageId} 的登记缺少 actionId`);
  const trigger = raw.trigger === 'wheel' ? 'wheel' : 'key';
  const action: ResolvedAction = {
    actionId,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : actionId,
    source: typeof raw.source === 'string' && raw.source.trim() ? raw.source.trim() : packageId,
    packageId,
    bridgeInvokable: raw.bridgeInvokable === true,
    approvalRequired: raw.approvalRequired === true,
    trigger,
  };
  if (typeof raw.category === 'string' && raw.category) action.category = raw.category;
  if (raw.argsSchema && typeof raw.argsSchema === 'object') action.argsSchema = raw.argsSchema;
  if (raw.when) action.when = raw.when;
  if (typeof raw.keybinding === 'string' && raw.keybinding) action.keybinding = raw.keybinding;
  return action;
}

/** 把一个包的条目登记进来。返回的函数只撤掉这一次写下的条目。 */
export function registerActions(packageId: string, actions: readonly ActionInput[]): () => void {
  let bucket = packages.get(packageId);
  if (!bucket) {
    bucket = new Map();
    packages.set(packageId, bucket);
  }
  const written: ResolvedAction[] = [];
  for (const raw of actions) {
    const action = normalizeAction(packageId, raw);
    bucket.set(action.actionId, action);
    written.push(action);
  }
  return () => {
    const current = packages.get(packageId);
    if (!current) return;
    for (const action of written) {
      if (current.get(action.actionId) === action) current.delete(action.actionId);
    }
    if (current.size === 0) packages.delete(packageId);
  };
}

export function clearActionPackage(packageId: string): void {
  packages.delete(packageId);
}

export function registerInvokeExecutor(actionId: string, executor: ActionExecutor): () => void {
  executors.set(actionId, executor);
  return () => {
    if (executors.get(actionId) === executor) executors.delete(actionId);
  };
}

export function getInvokeExecutor(actionId: string): ActionExecutor | undefined {
  return executors.get(actionId);
}

export function hasInvokeExecutor(actionId: string): boolean {
  return executors.has(actionId);
}

export function listActions(): ResolvedAction[] {
  const out: ResolvedAction[] = [];
  for (const bucket of packages.values()) out.push(...bucket.values());
  return out;
}

export function actionGate(actionId: string): {
  known: boolean;
  bridgeInvokable: boolean;
  approvalRequired: boolean;
  action?: ResolvedAction;
} {
  let known = false;
  let bridgeInvokable = false;
  let approvalRequired = false;
  let action: ResolvedAction | undefined;
  for (const bucket of packages.values()) {
    const hit = bucket.get(actionId);
    if (!hit) continue;
    known = true;
    if (hit.approvalRequired) approvalRequired = true;
    if (hit.bridgeInvokable) {
      bridgeInvokable = true;
      action = hit;
    } else if (!action) action = hit;
  }
  return { known, bridgeInvokable, approvalRequired, action };
}

/** 桥白名单：bridgeInvokable 为 true 的 actionId，排序后返回。 */
export function bridgeInvokableIds(): string[] {
  const ids = new Set<string>();
  for (const action of listActions()) if (action.bridgeInvokable) ids.add(action.actionId);
  return [...ids].sort();
}
