import { AGENT_LIVE_ACTION_CATALOG } from '../../../renderer/agent-live/actionCatalog';
import { revisionActions } from '../../../main/agentLive/revision/handlers';
import { registerActions } from '../registry';

/**
 * 登记冻结稿里的 ActionId。
 * 写操作 approvalRequired，不在这里挂执行体。界面直接调用。
 * 读和复制入口的执行体由数据进程在接线时注册。
 * 「复制当前工作区入口」在 activeAgent 有值时返回该家常驻规则，未选时仍只返回入口路径。
 */
export function registerAgentLivePackage(): void {
  registerActions('agent-live', [...AGENT_LIVE_ACTION_CATALOG, ...revisionActions]);
}
