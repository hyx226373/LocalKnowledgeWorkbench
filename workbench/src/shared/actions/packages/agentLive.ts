import { AGENT_LIVE_ACTION_CATALOG } from '../../../renderer/agent-live/actionCatalog';
import { revisionActions } from '../../../main/agentLive/revision/handlers';
import { registerActions } from '../registry';

/**
 * 登记冻结稿里的 ActionId。
 * 写操作 approvalRequired，不在这里挂执行体。界面直接调用。
 * 读和复制入口的执行体由数据进程在接线时注册。
 */
export function registerAgentLivePackage(): void {
  registerActions('agent-live', [...AGENT_LIVE_ACTION_CATALOG, ...revisionActions]);
}
