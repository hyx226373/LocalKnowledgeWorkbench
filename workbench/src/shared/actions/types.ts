/**
 * 操作登记表。按钮、快捷键、控制台和文件桥共用 actionId（与命令 id 同值）。
 * 条目按包登记，不集中写进一个数组。缩放包以后自己登记。资料与编排在 sources 包，由 installActionPackages 装上。
 */

export type ActionTrigger = 'key' | 'wheel';

export type ActionWhen = 'global' | 'editorFocus' | 'treeFocus' | 'webFocus';

/**
 * 一个包交上来的一条。actionId 与 id 二选一（命令贡献用 id）。
 * 缺省 bridgeInvokable=false、approvalRequired=false、trigger=key。
 * 多出来的字段（例如缩放表的 access / intended）可以带着，登记时不使用。
 */
export interface ActionInput {
  actionId?: string;
  id?: string;
  title?: string;
  category?: string;
  /** 包名。不封闭成 builtin|plugin|console，这样 zoom 与 r12 能直接登记。 */
  source?: string;
  bridgeInvokable?: boolean;
  approvalRequired?: boolean;
  argsSchema?: object;
  trigger?: ActionTrigger;
  when?: ActionWhen;
  keybinding?: string;
}

export interface ResolvedAction {
  actionId: string;
  title: string;
  category?: string;
  source: string;
  packageId: string;
  bridgeInvokable: boolean;
  approvalRequired: boolean;
  argsSchema?: object;
  trigger: ActionTrigger;
  when?: ActionWhen;
  keybinding?: string;
}

export type CapabilityAvailability = 'available' | 'degraded' | 'unavailable';

/** 与 manifest.capabilityDetails、AGENT_START_HERE 使用同一组字段名。 */
export interface BridgeCapability {
  name: string;
  description: string;
  params: object;
  availability: CapabilityAvailability;
  approvalRequired: boolean;
  resultSchema: object;
}

export interface StateSnapshot {
  workspace: { workspaceId: string; title: string } | null;
  resources: { resourceId: string; title: string; sourceKind: string }[];
  panels: { itemId: string; resourceId?: string; adapterId?: string; openAs?: string }[];
  unsaved: { resourceId?: string; itemId?: string }[];
}

export interface StateExport extends StateSnapshot {
  pendingPlans: { planId: string; title: string; contentHash?: string; actor?: string }[];
  results: { requestId: string; status: string; updatedAt: string }[];
}
