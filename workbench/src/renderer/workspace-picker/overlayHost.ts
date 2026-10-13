/**
 * 覆盖层期间的托管窗端口。缺省时不调用。不拆绑定、不结束进程、不重新接入。
 * integ 未接宿主时状态是 not-in-integ。
 */

export interface OverlayHostPanel {
  id: string;
  /** 已接入。未接入的不动。 */
  attached: boolean;
  /** 当前应当可见。隐藏的不动。 */
  visible: boolean;
  /** 收起的不动。 */
  collapsed: boolean;
}

export interface OverlayHostPort {
  listPanels(workspaceId: string): readonly OverlayHostPanel[];
  setVisible(panelId: string, args: { visible: boolean; forModal: true }): void;
  activate(panelId: string, args: { focusHost: false }): void;
}

export interface OverlayHostSession {
  workspaceId: string;
  panelIds: readonly string[];
}

export function overlayHostStatus(port: OverlayHostPort | null | undefined): 'not-in-integ' | 'linked' {
  return port == null ? 'not-in-integ' : 'linked';
}

/** 只隐藏当前工作区里已接入且可见、未收起的面板，并记下这批 id。 */
export function openOverlayHost(port: OverlayHostPort | null | undefined, workspaceId: string): OverlayHostSession | null {
  if (port == null) return null;
  const panelIds: string[] = [];
  for (const panel of port.listPanels(workspaceId)) {
    if (!panel.attached || !panel.visible || panel.collapsed) continue;
    panelIds.push(panel.id);
    port.setVisible(panel.id, { visible: false, forModal: true });
  }
  return { workspaceId, panelIds };
}

/**
 * 当前工作区仍是打开时的那个，才把记下的面板设回可见并待激活。
 * 已经换成别的工作区则什么都不调用。
 */
export function closeOverlayHost(
  port: OverlayHostPort | null | undefined,
  session: OverlayHostSession | null,
  workspaceId: string,
): void {
  if (port == null || session == null) return;
  if (session.workspaceId !== workspaceId) return;
  for (const id of session.panelIds) {
    port.setVisible(id, { visible: true, forModal: true });
    port.activate(id, { focusHost: false });
  }
}