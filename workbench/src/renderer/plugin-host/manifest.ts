import { isValidVersion, satisfies } from './semver';
import { DISPLAY_MODES, SOURCE_KINDS, checkDisplayMode } from './layoutModel';
import { HOST_API_VERSION, type PluginManifest } from './types';
import type { PermissionDecl, SourceKind } from '../../shared/adapter-sdk/types';
import { searchProviderDeclErrors } from '../../shared/searchProvider';

/** 与 SDK policy 相同的“每类适配器允许的权限” */
const ALLOWED: Record<SourceKind, PermissionDecl['kind'][]> = { file: ['fs.read', 'fileops.write'], web: ['net'], app: ['process.launch'] };

/**
 * 内置插件（随应用发布，在渲染进程中运行）的 manifest 校验。返回 null 表示可加载；否则返回给用户看的不兼容原因。
 * 第三方插件不经过这里：它们是 SDK AdapterPluginManifest，由主进程用 validateAdapterManifest 校验并在沙箱 iframe 中运行（D7）。
 */
export function validateManifest(
  m: PluginManifest,
  hostVersion = HOST_API_VERSION,
  source: 'builtin' | 'user' = 'builtin',
  kind: 'code' | 'theme' = 'code',
): string | null {
  if (!m || typeof m !== 'object') return 'manifest 缺失';
  // 主题包是纯数据和限定作用域的 CSS，由本进程组装，没有第三方代码。代码插件仍必须走沙箱。
  if (source !== 'builtin' && kind !== 'theme') return '第三方插件必须是沙箱适配器插件（sandbox: "iframe"），通过插件管理的开发者模式安装';
  if (!/^[a-z0-9][a-z0-9.-]{1,63}$/.test(m.id ?? '')) return `非法 id: ${m.id}`;
  if (!isValidVersion(m.version ?? '')) return `非法版本号: ${m.version}`;
  if (!m.engines?.workbench) return '缺少 engines.workbench';
  if (!satisfies(hostVersion, m.engines.workbench)) return `需要宿主 API ${m.engines.workbench}，当前为 ${hostVersion}`;
  for (const a of m.contributes?.adapters ?? []) {
    if (!a.id) return '适配器缺少 id';
    if (!Array.isArray(a.sourceKinds) || !a.sourceKinds.length || a.sourceKinds.some((k) => !SOURCE_KINDS.includes(k))) return `适配器 ${a.id} 的 sourceKinds 不合法`;
    if (!DISPLAY_MODES.includes(a.displayMode)) return `适配器 ${a.id} 的 displayMode 不合法`;
    const honest = checkDisplayMode(a.id, a.sourceKinds, a.displayMode);
    if (honest) return honest;
    if (a.stateSchemaVersion !== undefined && !(Number.isInteger(a.stateSchemaVersion) && a.stateSchemaVersion >= 1)) return `适配器 ${a.id} 的 stateSchemaVersion 不合法`;
    for (const p of a.permissions ?? []) {
      if (!p || typeof p !== 'object' || typeof p.id !== 'string' || typeof p.kind !== 'string') return `适配器 ${a.id} 的权限声明必须是结构化对象（SDK PermissionDecl），不再接受字符串`;
      if (!ALLOWED[a.sourceKinds[0]].includes(p.kind)) return `适配器 ${a.id}：${a.sourceKinds[0]} 适配器不能申请 ${p.kind}`;
      if (!p.reason) return `适配器 ${a.id} 的权限 ${p.id} 缺少 reason`;
    }
  }
  const searchErrs = searchProviderDeclErrors(m.contributes?.searchProviders);
  if (searchErrs.length) return searchErrs[0]!;
  return null;
}
