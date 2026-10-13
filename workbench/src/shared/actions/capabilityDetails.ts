/**
 * 桥能力明细。请求 type 写在这里；可 invoke 的 ActionId 从登记表派生，不另抄一份白名单。
 */
import { actionGate, hasInvokeExecutor, listActions } from './registry';
import type { BridgeCapability } from './types';

const REF = (name: string): object => ({ $ref: `kb://agent-bridge/schemas/${name}` });

function cap(
  name: string,
  description: string,
  approvalRequired: boolean,
  availability: BridgeCapability['availability'],
  params: object,
  resultSchema: object,
): BridgeCapability {
  return { name, description, params, availability, approvalRequired, resultSchema };
}

const TYPE_CAPS: BridgeCapability[] = [
  cap(
    'query',
    '列根，或按 resourceId / rootId 取元数据。只读。',
    false,
    'available',
    REF('request.schema.json'),
    { type: 'object' },
  ),
  cap(
    'search-help',
    '说明如何在界面搜索，并附带索引健康摘要。不代替全文搜索。',
    false,
    'available',
    { type: 'object', additionalProperties: false },
    { type: 'object', required: ['text'] },
  ),
  cap(
    'console-draft',
    '在 drafts/ 写 .kbconsole.md，不打开布局。',
    false,
    'available',
    REF('console-draft.schema.json'),
    { type: 'object', required: ['draftFile', 'executedOpen'] },
  ),
  cap(
    'classify',
    '加入或移出自建目录。真移动转成计划，等界面批准。',
    false,
    'available',
    { type: 'object', required: ['action', 'resourceId'] },
    { type: 'object' },
  ),
  cap(
    'workspace-ref',
    '加入本工作区引用。移除只返回说明，不关面板、不删文件。',
    false,
    'available',
    { type: 'object', required: ['action', 'workspaceId', 'resourceId'] },
    { type: 'object' },
  ),
  cap(
    'open',
    '按 resourceId 与 openAs 打开资料。',
    false,
    'available',
    { type: 'object', required: ['resourceId', 'openAs'] },
    { type: 'object' },
  ),
  cap(
    'invoke',
    '执行已登记且 bridgeInvokable 的 ActionId。优先 actionId，旧字段 commandId 同值可双读。不是 shell。需要批准的目标返回 awaiting_approval，不直接执行，也不标 available。',
    false,
    'available',
    {
      type: 'object',
      properties: {
        actionId: { type: 'string' },
        commandId: { type: 'string' },
        args: { type: 'object' },
      },
    },
    { type: 'object', required: ['actionId', 'commandId'] },
  ),
  cap(
    'plan-submit',
    '提出 write / move / trash 计划。文件内 approved 无效，批准只在界面。',
    true,
    'available',
    REF('plan-draft.schema.json'),
    { type: 'object', required: ['planId'] },
  ),
  cap(
    'plan-status',
    '按 planId 或 sourceRequestId 只读查询计划。',
    false,
    'available',
    { type: 'object' },
    { type: 'object', required: ['planId', 'status'] },
  ),
  cap(
    'state-export',
    '只读导出 workspace、resources、panels、unsaved、pendingPlans、results。主键是稳定 id。unsaved 只在界面进程，主进程快照里这项为空。',
    false,
    'degraded',
    { type: 'object', properties: { snapshot: { type: 'boolean' } } },
    {
      type: 'object',
      required: ['workspace', 'resources', 'panels', 'unsaved', 'pendingPlans', 'results'],
    },
  ),
];

function actionCaps(): BridgeCapability[] {
  const seen = new Set<string>();
  const out: BridgeCapability[] = [];
  for (const action of listActions()) {
    if (!action.bridgeInvokable || seen.has(action.actionId)) continue;
    seen.add(action.actionId);
    const gate = actionGate(action.actionId);
    const runnable = hasInvokeExecutor(action.actionId) && gate.bridgeInvokable && !gate.approvalRequired;
    out.push({
      name: action.actionId,
      description: action.title,
      params: action.argsSchema ?? { type: 'object', additionalProperties: false },
      availability: runnable ? 'available' : 'unavailable',
      approvalRequired: gate.approvalRequired,
      resultSchema: { type: 'object', required: ['actionId', 'commandId'] },
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function bridgeCapabilityDetails(): BridgeCapability[] {
  return [...TYPE_CAPS, ...actionCaps()];
}
