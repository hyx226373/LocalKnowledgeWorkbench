import type { AgentMaterial } from '../../shared/agentLive/types';

/** 0.11：超过只提示，不拦截加入。 */
export const TOKEN_HINT_THRESHOLD = 150_000;

export function tierOf(material: AgentMaterial): 'session' | 'pinned' {
  return material.tier === 'pinned' ? 'pinned' : 'session';
}

/** 3.4MB、12KB、980B。整数不带小数，小于 10 的更大单位保留一位。 */
export function formatByteCount(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B';
  const units = ['B', 'KB', 'MB', 'GB'] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)}${units[unit]}`;
  const text = value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '');
  return `${text}${units[unit]}`;
}

/** 约 41k tokens。1 万以下保留一位，再往上取整到 k。 */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '约 0 tokens';
  if (tokens < 1000) return `约 ${Math.round(tokens)} tokens`;
  if (tokens < 10_000) {
    const text = (tokens / 1000).toFixed(1).replace(/\.0$/, '');
    return `约 ${text}k tokens`;
  }
  return `约 ${Math.round(tokens / 1000)}k tokens`;
}

export interface SectionFigures {
  count: number;
  knownBytes: number;
  pendingBytes: number;
  knownTokens: number;
  pendingTokens: number;
}

export function sectionFigures(items: readonly AgentMaterial[]): SectionFigures {
  const figures: SectionFigures = { count: items.length, knownBytes: 0, pendingBytes: 0, knownTokens: 0, pendingTokens: 0 };
  for (const item of items) {
    if (item.bytes == null) figures.pendingBytes += 1;
    else figures.knownBytes += item.bytes;
    if (item.estTokens == null) figures.pendingTokens += 1;
    else figures.knownTokens += item.estTokens;
  }
  return figures;
}

/** 区头合计，例如「12 项 · 3.4MB · 约 41k tokens」。还在算的字段不填 0。 */
export function formatSectionTotals(items: readonly AgentMaterial[]): string {
  const figures = sectionFigures(items);
  if (figures.count === 0) return '0 项';
  const parts = [`${figures.count} 项`];
  if (figures.pendingBytes === figures.count) parts.push('体积计算中');
  else {
    parts.push(formatByteCount(figures.knownBytes));
    if (figures.pendingBytes) parts.push(`${figures.pendingBytes} 项体积计算中`);
  }
  if (figures.pendingTokens === figures.count) parts.push('token 计算中');
  else {
    parts.push(formatTokenCount(figures.knownTokens));
    if (figures.pendingTokens) parts.push(`${figures.pendingTokens} 项 token 计算中`);
  }
  return parts.join(' · ');
}

/** 侧栏区头和 ENTRY.md 段头共用。组 3 渲染入口时调用这一函数，避免两处文案不一致。 */
export function formatSectionHeading(title: string, items: readonly AgentMaterial[]): string {
  return `${title} · ${formatSectionTotals(items)}`;
}

/** 两区已知 token 合计超过 15 万时的提示。不作为禁用条件。 */
export function tokenBudgetHint(items: readonly AgentMaterial[]): string | null {
  const { knownTokens } = sectionFigures(items);
  if (knownTokens <= TOKEN_HINT_THRESHOLD) return null;
  return '合计超过 150k tokens，仍可继续使用';
}

/** 目录材料：登记时 bytes/contentHash/readable 均为空；不改 AgentMaterial schema。 */
export function isDirMaterial(material: AgentMaterial): boolean {
  return material.status === 'ok' && material.bytes == null && material.contentHash == null && material.readable == null;
}

