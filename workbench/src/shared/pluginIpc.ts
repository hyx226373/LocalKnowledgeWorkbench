/**
 * 第三方（沙箱）适配器插件的 IPC 契约：渲染进程 ⇄ 主进程。
 * 渲染进程只转发；所有授权检查在主进程（WorkbenchService.plugins）再做一次。
 * 插件身份（pluginId/adapterId）由渲染进程按面板所属插件填写，从不取自 iframe 消息。
 */
import type { HostErrorCode, UninstallOptions } from './adapter-sdk/types';
import type { AdapterPluginManifest, FileStat, FileopsPlan, FileopsResult, PermissionGrant, TextReadResult } from './adapter-sdk/types';

export interface AdapterPluginDto {
  id: string;
  name: string;
  version: string;
  /** 'dev' = 开发者模式本地安装（v1 唯一的第三方来源，D7）；'builtin' = 随应用分发的内置适配器（r11-A，不可卸载、可禁用） */
  source: 'dev' | 'builtin';
  manifest: AdapterPluginManifest | null;
  /** 非空 = 已安装但不兼容（显示原因，不激活） */
  errors: string[];
  enabled: boolean;
  installedAt: number;
  grants: PermissionGrant[];
  storageBytes: number;
  storageKeys: number;
  /** 插件包中 main 的 kbplugin:// URL（沙箱 iframe 导入） */
  mainUrl: string;
}

/** 卸载对话框需要的占用信息 */
export interface UninstallInfo {
  pluginId: string;
  storageBytes: number;
  storageKeys: number;
  grants: number;
  /** 审计记录条数（保留数据时保留，删除数据时删除） */
  auditEntries: number;
  /** 插件有 web 适配器时才有网站数据分区（P2）；否则为 null */
  siteDataBytes: number | null;
  items: number;
  workspaces: number;
}
/** 与 SDK `UninstallOptions`（050df08 起含可选 removeItems）一致 */
export type UninstallOptionsDto = UninstallOptions;

export type PluginFileOp =
  | { op: 'stat'; resourceId: string }
  | { op: 'readText'; resourceId: string; maxBytes?: number }
  | { op: 'readBytes'; resourceId: string; offset?: number; length?: number };
export type PluginFileResult = FileStat | TextReadResult | Uint8Array;

/** 主进程拒绝插件调用时的错误码（作为 Error.message 前缀 `[code] ` 传回） */
/** 宿主调用失败的错误码 = SDK 的 HostErrorCode（含 timeout：单次调用约 15 s 无回应）。主进程 PluginAccessError、rpc-result.code 都用它 */
export type PluginAccessCode = HostErrorCode;
export const PLUGIN_ACCESS_CODES = ['permission-denied', 'out-of-scope', 'resource-missing', 'plugin-unavailable', 'invalid-request', 'quota-exceeded', 'timeout'] as const satisfies readonly PluginAccessCode[];
// 编译期检查：列表与 SDK 的 HostErrorCode 完全一致（SDK 增删错误码时这里报错）
type _CodesExact = [HostErrorCode] extends [(typeof PLUGIN_ACCESS_CODES)[number]] ? true : never;
const _codesExact: _CodesExact = true;
void _codesExact;
/** rpc-result 上的错误码：宿主错误码，或未分类的 'error' */
export type RpcErrorCode = PluginAccessCode | 'error';
export function isPluginAccessCode(c: unknown): c is PluginAccessCode {
  return typeof c === 'string' && (PLUGIN_ACCESS_CODES as readonly string[]).includes(c);
}
/** 宿主调用超时的统一错误（渲染进程宿主侧与沙箱运行时共用文案） */
export function hostTimeoutMessage(method: string, ms: number): string {
  return `宿主调用 ${method} 超时（${ms / 1000} 秒）`;
}
export function parseAccessError(e: unknown): { code: RpcErrorCode; message: string } {
  const msg = String((e as Error)?.message ?? e);
  const m = new RegExp(`\\[(${PLUGIN_ACCESS_CODES.join('|')})\\]\\s*(.*)$`, 's').exec(msg);
  return m ? { code: m[1] as PluginAccessCode, message: m[2] } : { code: 'error', message: msg.replace(/^Error invoking remote method 'kb': (Error: )?/, '') };
}

// ---------------- 审计记录（T13）：授权拒绝、越界读取、批量计划、看门狗 ----------------

/** main = 主进程判定并记录；renderer = 渲染进程记录（只允许 watchdog / timeout） */
export const AUDIT_KINDS = ['denied', 'grant', 'plan-submitted', 'plan-blocked', 'plan-approved', 'plan-failed', 'plan-rejected', 'watchdog', 'timeout', 'web-blocked', 'web-external', 'app-launch', 'app-blocked', 'app-exit'] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];
export const RENDERER_AUDIT_KINDS: readonly AuditKind[] = ['watchdog', 'timeout'];
export interface AuditEntry {
  id: number;
  /** 第一次发生（ms） */
  at: number;
  /** 最近一次发生（同一插件、同类、同内容 2 秒内重复的合并为一条，count 累加） */
  lastAt: number;
  pluginId: string;
  adapterId: string | null;
  kind: AuditKind;
  code: string | null;
  detail: string;
  count: number;
}
/** 插件 iframe 的进程信息（性能与隔离检查） */
export interface PluginProcessInfo {
  pluginId: string;
  frames: number;
  pids: number[];
  /** 插件 iframe 是否在主窗口渲染进程之外（独立进程才能被看门狗单独终止） */
  isolated: boolean;
  /** 这些进程的工作集（KB） */
  workingSetKB: number;
}

// ---------------- H8：批量计划（files.requestFileops） ----------------

export interface PlanStepPreview {
  op: 'write' | 'move' | 'trash';
  resourceId: string;
  rootName: string;
  relPath: string;
  toRelPath?: string;
  summary: string;
  bytes?: number;
  conflicts: string[];
}
export interface PlanPreviewDto {
  planId: string;
  pluginId: string;
  pluginName: string;
  adapterId: string;
  title: string;
  steps: PlanStepPreview[];
  /** 执行计划的引擎（stub = 内置顺序执行器，@kb/plan 接入后替换） */
  engine: string;
  /** 任一步有冲突时不能批准 */
  blocked: boolean;
}
export type { FileopsPlan, FileopsResult };
