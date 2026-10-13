/**
 * 三类适配器的显示方式如实说明（清单字段 displayMode；SDK DISPLAY_MODE_BY_KIND 规定对应关系，安装校验已强制）。
 *   file → in-app-reader「内嵌渲染」  web → in-app-web「内嵌网页」  app → external-managed「外部窗口启动」
 * 界面目前通过 SDK displayModeLabel 在授权对话框、插件管理（适配器详情）、网页面板外框显示；
 * Placeholder.tsx 里另有一份旧文案，需要改成调用本模块/SDK（docs/09-接口请求.md R3）。
 */
import { DISPLAY_MODE_BY_KIND, DISPLAY_MODE_FACTS, displayModeLabel } from '../../shared/adapter-sdk/policy';
import type { AdapterContribution, AdapterPluginManifest, DisplayMode } from '../../shared/adapter-sdk/types';

export interface AdapterDisplayInfo {
  adapterId: string;
  title: string;
  displayMode: DisplayMode;
  /** 短标签：内嵌渲染 / 内嵌网页 / 外部窗口启动 */
  short: string;
  /** 完整标签（含域名等），与授权对话框一致 */
  label: string;
  panelShows: string;
  notes: string;
  /** 来源类型与显示方式不对应时的错误（安装校验正常时为 null） */
  mismatch: string | null;
}

export function describeAdapterDisplay(a: Pick<AdapterContribution, 'id' | 'title' | 'sourceKinds' | 'displayMode' | 'permissions'>): AdapterDisplayInfo {
  const facts = DISPLAY_MODE_FACTS[a.displayMode];
  const want = a.sourceKinds.map((k) => DISPLAY_MODE_BY_KIND[k]);
  const mismatch = !facts ? `未知显示方式 ${String(a.displayMode)}` : want.some((m) => m !== a.displayMode) ? `来源 ${a.sourceKinds.join('/')} 必须声明为 ${want.join('/')}，实际为 ${a.displayMode}` : null;
  return {
    adapterId: a.id,
    title: a.title,
    displayMode: a.displayMode,
    short: facts?.short ?? String(a.displayMode),
    label: facts ? displayModeLabel(a) : String(a.displayMode),
    panelShows: facts?.panelShows ?? '',
    notes: facts?.notes ?? '',
    mismatch,
  };
}

export function describePluginDisplays(m: AdapterPluginManifest | null | undefined): AdapterDisplayInfo[] {
  return (m?.contributes?.adapters ?? []).map(describeAdapterDisplay);
}
