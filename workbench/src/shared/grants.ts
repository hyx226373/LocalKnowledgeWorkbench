/**
 * 结构化授权（SDK PermissionGrant）的判定：主进程（强制执行 files.* / kbfile）与渲染进程（是否弹窗、显示占位）共用同一套纯函数。
 * 规则（SDK 规范 §4.2）：
 *  - 允许记录只在 declHash 与当前声明一致时有效（插件升级后声明变化 → 重新询问）；
 *  - 拒绝记录不随指纹失效（不反复打扰），用户可在插件管理页改为允许；
 *  - fs.read：资源所在根必须在 rootIds 中（'all' 表示授权时的全部根），扩展名必须在声明的 extensions 中。
 */
import { permissionDeclHash } from './adapter-sdk/policy';
import type { AdapterContribution, AdapterPluginManifest, FsReadPermission, PermissionDecl, PermissionGrant } from './adapter-sdk/types';

export type GrantDecision = 'granted' | 'denied' | 'prompt';

export function findGrant(grants: readonly PermissionGrant[], pluginId: string, adapterId: string, permissionId: string): PermissionGrant | undefined {
  return grants.find((g) => g.pluginId === pluginId && g.adapterId === adapterId && g.permissionId === permissionId);
}

export function grantDecision(grants: readonly PermissionGrant[], pluginId: string, adapterId: string, perm: PermissionDecl): { decision: GrantDecision; grant?: PermissionGrant } {
  const g = findGrant(grants, pluginId, adapterId, perm.id);
  if (!g) return { decision: 'prompt' };
  if (g.decision === 'denied') return { decision: 'denied', grant: g };
  if (g.declHash !== permissionDeclHash(perm)) return { decision: 'prompt' };
  return { decision: 'granted', grant: g };
}

/** 把一条新决定并入授权列表（同 plugin+adapter+permission 覆盖） */
export function upsertGrant(grants: readonly PermissionGrant[], g: PermissionGrant): PermissionGrant[] {
  return [...grants.filter((x) => !(x.pluginId === g.pluginId && x.adapterId === g.adapterId && x.permissionId === g.permissionId)), g];
}

/** 撤销 = 写入一条拒绝记录（declHash '*'），与 SDK MockHost.revokePermission 相同 */
export function revokedGrant(pluginId: string, adapterId: string, permissionId: string, now = Date.now()): PermissionGrant {
  return { pluginId, adapterId, permissionId, decision: 'denied', declHash: '*', decidedAt: now };
}

/** fs.read 的范围检查；返回 null 表示在范围内，否则返回原因（中文，显示在占位中） */
export function fileScopeError(grant: PermissionGrant | undefined, decl: FsReadPermission, res: { rootId: string; ext: string }): string | null {
  if (!grant || grant.decision !== 'granted') return '未授予读取权限';
  const roots = grant.rootIds;
  if (roots !== 'all' && !(roots ?? []).includes(res.rootId)) return '文件所在的文件夹未授权';
  if (decl.extensions?.length && !decl.extensions.includes(res.ext.toLowerCase())) return `扩展名 .${res.ext} 不在授权范围（仅限 ${decl.extensions.join('、')}）`;
  return null;
}

export function adapterOf(m: AdapterPluginManifest | null | undefined, adapterId: string): AdapterContribution | undefined {
  return m?.contributes?.adapters?.find((a) => a.id === adapterId);
}

export function fsReadDecl(a: AdapterContribution | undefined): FsReadPermission | undefined {
  return a?.permissions.find((p): p is FsReadPermission => p.kind === 'fs.read' && !p.optional) ?? a?.permissions.find((p): p is FsReadPermission => p.kind === 'fs.read');
}
