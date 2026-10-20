import { AGENT_LIVE_ACTIONS } from '../../shared/agentLive/types';
import type { ActionInput } from '../../shared/actions/types';

const str = { type: 'string', minLength: 1 };
const strOrNull = { type: ['string', 'null'] };
const ref = {
  type: 'object',
  additionalProperties: false,
  required: ['absPath'],
  properties: {
    resourceId: strOrNull,
    sourceId: strOrNull,
    relPath: { type: 'string' },
    absPath: str,
    name: { type: 'string' },
  },
};

function args(required: string[], properties: Record<string, object>): object {
  return { type: 'object', additionalProperties: false, required, properties };
}

/**
 * 桥和命令面板共用的 ActionId。
 * 界面直接执行。桥调用资料变更时 approvalRequired，由人类界面批准。
 * getContent / getDiff 由组 4 登记，这里不重复。
 * Ctrl+Shift+A 不写进这份静态表：渲染进程先查冲突和用户绑定，再决定要不要挂上。
 */
export const AGENT_LIVE_ACTION_CATALOG: readonly ActionInput[] = [
  {
    actionId: AGENT_LIVE_ACTIONS.copyBridgeLink,
    title: '连接 agent（复制现场入口）',
    category: 'agent',
    source: 'agent-live',
    bridgeInvokable: true,
    approvalRequired: false,
    argsSchema: args([], {}),
  },
  {
    // 执行体在数据进程：config.activeAgent 有值时结果带常驻规则全文；未选时仍只返回入口绝对路径。
    actionId: AGENT_LIVE_ACTIONS.copyWorkspaceLink,
    title: '复制当前工作区入口',
    category: 'agent',
    source: 'agent-live',
    bridgeInvokable: true,
    approvalRequired: false,
    argsSchema: args([], { workspaceId: { type: 'string' } }),
  },
  {
    actionId: AGENT_LIVE_ACTIONS.materialsAdd,
    title: '加入 agent 工作资料',
    category: 'agent',
    source: 'agent-live',
    bridgeInvokable: true,
    approvalRequired: true,
    argsSchema: args(['ref'], { ref, purpose: strOrNull }),
  },
  {
    actionId: AGENT_LIVE_ACTIONS.materialsRemove,
    title: '从 agent 工作资料移除',
    category: 'agent',
    source: 'agent-live',
    bridgeInvokable: true,
    approvalRequired: true,
    argsSchema: args(['materialId'], { materialId: str }),
  },
  {
    actionId: AGENT_LIVE_ACTIONS.materialsReorder,
    title: '调整 agent 工作资料顺序',
    category: 'agent',
    source: 'agent-live',
    bridgeInvokable: true,
    approvalRequired: true,
    argsSchema: args(['order'], { order: { type: 'array', items: str } }),
  },
  {
    actionId: AGENT_LIVE_ACTIONS.materialsSetPurpose,
    title: '设置 agent 工作资料用途',
    category: 'agent',
    source: 'agent-live',
    bridgeInvokable: true,
    approvalRequired: true,
    argsSchema: args(['materialId'], { materialId: str, purpose: strOrNull }),
  },
  {
    actionId: AGENT_LIVE_ACTIONS.materialsAddCurrent,
    title: '把当前阅读文件加入本轮资料',
    category: 'agent',
    source: 'agent-live',
    bridgeInvokable: true,
    approvalRequired: true,
    when: 'global',
    argsSchema: args([], {}),
  },
  {
    actionId: AGENT_LIVE_ACTIONS.materialsAddSelection,
    title: '把选中项加入本轮资料',
    category: 'agent',
    source: 'agent-live',
    bridgeInvokable: true,
    approvalRequired: true,
    argsSchema: args([], { refs: { type: 'array', items: ref } }),
  },
  {
    actionId: AGENT_LIVE_ACTIONS.materialsPin,
    title: '固定到工作区资料',
    category: 'agent',
    source: 'agent-live',
    bridgeInvokable: true,
    approvalRequired: true,
    argsSchema: args(['materialId'], { materialId: str }),
  },
  {
    actionId: AGENT_LIVE_ACTIONS.materialsUnpin,
    title: '取消固定',
    category: 'agent',
    source: 'agent-live',
    bridgeInvokable: true,
    approvalRequired: true,
    argsSchema: args(['materialId'], { materialId: str }),
  },
  {
    actionId: AGENT_LIVE_ACTIONS.materialsClearSession,
    title: '清空本轮资料',
    category: 'agent',
    source: 'agent-live',
    bridgeInvokable: true,
    approvalRequired: true,
    argsSchema: args([], {}),
  },
];
