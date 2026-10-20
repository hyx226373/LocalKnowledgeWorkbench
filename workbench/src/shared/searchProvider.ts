/**
 * 辅助搜索插件的贡献点与结果形状（r21 §3）。
 * 只新增。不改适配器 SDK 副本（types.ts / policy.ts 与上游逐字对齐）。
 * 插件不能自己导航：target 由宿主打开，或把 action 交回插件。
 */

export interface SearchProviderContribution {
  id: string;
  label: string;
  icon?: string;
}

export interface SearchProviderContext {
  workspaceId: string;
  rootIds: string[];
  limit: number;
}

export type SearchProviderTarget =
  | { resourceId: string }
  | { rootId: string; relPath: string }
  | { action: string; payload?: unknown };

export interface SearchProviderHit {
  title: string;
  subtitle?: string;
  snippet?: string;
  target: SearchProviderTarget;
}

export interface SearchProviderRegistration {
  id: string;
  search(query: string, ctx: SearchProviderContext, signal: AbortSignal): Promise<SearchProviderHit[]>;
  /** 宿主转发 target.action。插件不能借此导航。 */
  onAction?(action: string, payload: unknown): void;
}

const ID_RE = /^[a-z0-9][a-z0-9.-]{1,127}$/;

/** manifest contributes.searchProviders 的形状检查。未声明时返回空。 */
export function searchProviderDeclErrors(list: unknown): string[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) return ['contributes.searchProviders 必须是数组'];
  const errs: string[] = [];
  const ids = new Set<string>();
  for (const raw of list) {
    const s = (raw ?? {}) as Partial<SearchProviderContribution>;
    const id = typeof s.id === 'string' ? s.id : '';
    const p = `搜索提供者 ${id || '(缺 id)'}:`;
    if (!ID_RE.test(id)) errs.push(`${p} 非法 id`);
    else if (ids.has(id)) errs.push(`${p} id 重复`);
    if (id) ids.add(id);
    if (typeof s.label !== 'string' || !s.label.trim()) errs.push(`${p} 缺少 label`);
    else if (s.label.length > 40) errs.push(`${p} label 过长`);
    if (s.icon !== undefined && (typeof s.icon !== 'string' || s.icon.length > 32 || /[<>]/.test(s.icon))) errs.push(`${p} icon 不合法`);
  }
  return errs;
}
