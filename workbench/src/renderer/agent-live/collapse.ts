/** 第 3 条裁决：子栏各自折叠，状态随工作区保存。不写进工作区导出的资料清单。 */
export const AGENT_LIVE_CHROME_KEY = 'agent-live-chrome';

export interface AgentLiveChromeState {
  v: 1;
  sectionCollapsed: boolean;
  sessionCollapsed: boolean;
  pinnedCollapsed: boolean;
}

export function defaultChrome(): AgentLiveChromeState {
  return { v: 1, sectionCollapsed: false, sessionCollapsed: false, pinnedCollapsed: false };
}

export function parseChrome(raw: unknown): AgentLiveChromeState {
  const base = defaultChrome();
  if (!raw || typeof raw !== 'object') return base;
  const value = raw as Partial<AgentLiveChromeState>;
  if (value.v !== 1) return base;
  return {
    v: 1,
    sectionCollapsed: value.sectionCollapsed === true,
    sessionCollapsed: value.sessionCollapsed === true,
    pinnedCollapsed: value.pinnedCollapsed === true,
  };
}
