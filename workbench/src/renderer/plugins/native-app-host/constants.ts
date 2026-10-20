/**
 * native-app-host plugin constants — host-r1, isolated from desktopPanel.
 */
import {
  NATIVE_APP_HOST_VIEW_TYPE,
  NATIVE_HOST_ACTION_IDS,
} from '../../../shared/nativeAppHost';

export { NATIVE_APP_HOST_VIEW_TYPE, NATIVE_HOST_ACTION_IDS };

/** Adapter id registered with PluginHost (also used as appProfile match key). */
export const NATIVE_APP_HOST_ADAPTER_ID = NATIVE_APP_HOST_VIEW_TYPE;

/** Synthetic app item ref (sanitizeItem allows [\w.:-]). */
export const NATIVE_APP_HOST_REF = 'native-app-host.main';

/** Command ids = ActionId draft literals (01 §6) — keep stable. */
export const NATIVE_APP_HOST_COMMANDS = {
  createHostPanel: NATIVE_HOST_ACTION_IDS.createHostPanel,
  listHosts: NATIVE_HOST_ACTION_IDS.listHosts,
  proposeAttach: NATIVE_HOST_ACTION_IDS.proposeAttach,
  layoutAdjust: NATIVE_HOST_ACTION_IDS.layoutAdjust,
  proposeDetach: NATIVE_HOST_ACTION_IDS.proposeDetach,
  enterInteraction: 'nativeAppHost.enterInteraction',
  exitInteraction: 'nativeAppHost.exitInteraction',
} as const;

export type NativeAppHostCommandId =
  (typeof NATIVE_APP_HOST_COMMANDS)[keyof typeof NATIVE_APP_HOST_COMMANDS];

export const NATIVE_APP_HOST_COMMAND_META: Array<{
  id: NativeAppHostCommandId;
  title: string;
  category: string;
  keybinding?: string;
}> = [
  { id: NATIVE_APP_HOST_COMMANDS.createHostPanel, title: '创建原生托管面板', category: '原生托管' },
  { id: NATIVE_APP_HOST_COMMANDS.listHosts, title: '枚举可托管窗口', category: '原生托管' },
  { id: NATIVE_APP_HOST_COMMANDS.proposeAttach, title: '提议接入窗口', category: '原生托管' },
  { id: NATIVE_APP_HOST_COMMANDS.layoutAdjust, title: '请求布局调整（消费 layout.*）', category: '原生托管' },
  { id: NATIVE_APP_HOST_COMMANDS.proposeDetach, title: '提议释放托管', category: '原生托管' },
  {
    id: NATIVE_APP_HOST_COMMANDS.enterInteraction,
    title: '进入托管交互',
    category: '原生托管',
  },
  {
    id: NATIVE_APP_HOST_COMMANDS.exitInteraction,
    title: '退出托管交互',
    category: '原生托管',
    keybinding: 'Escape',
  },
];

/** Exit interaction key — globally intended when panel is mounted. */
export const EXIT_INTERACTION_KEY = 'Escape';
