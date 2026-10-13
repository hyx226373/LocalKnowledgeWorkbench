/**
 * token 粗估，不跑分词器。
 * 中日韩统一表意文字、假名、谚文各算 1。其余非空白字符每 4 个算 1，向上取整。
 * 空白（含全角空格）不计入。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (isSpace(cp)) continue;
    if (isCjk(cp)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

function isSpace(cp: number): boolean {
  return cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d || cp === 0x0c || cp === 0x3000 || cp === 0xa0;
}

function isCjk(cp: number): boolean {
  return (
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0x31f0 && cp <= 0x31ff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0x20000 && cp <= 0x2a6df)
  );
}

export interface TotalItem {
  bytes?: number | null;
  estTokens?: number | null;
}

/** 超过这个数只在入口里提示，不拦截发布。 */
export const TOKEN_WARN = 150_000;

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0B';
  if (n < 1024) return `${Math.round(n)}B`;
  if (n < 1024 * 1024) return `${trimUnit(n / 1024)}KB`;
  if (n < 1024 * 1024 * 1024) return `${trimUnit(n / (1024 * 1024))}MB`;
  return `${trimUnit(n / (1024 * 1024 * 1024))}GB`;
}

function trimUnit(n: number): string {
  if (n >= 10) return String(Math.round(n));
  const text = n.toFixed(1);
  return text.endsWith('.0') ? text.slice(0, -2) : text;
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) {
    const text = (n / 1000).toFixed(1);
    return `${text.endsWith('.0') ? text.slice(0, -2) : text}k`;
  }
  return `${Math.round(n / 1000)}k`;
}

/** 例如「12 项 · 3.4MB · 约 41k tokens」。 */
export function formatTotal(items: readonly TotalItem[]): string {
  const count = items.length;
  if (count === 0) return '0 项 · 0B · 约 0 tokens';
  let bytes = 0;
  let bytePending = 0;
  let tokens = 0;
  let tokenPending = 0;
  for (const item of items) {
    if (typeof item.bytes === 'number' && Number.isFinite(item.bytes) && item.bytes >= 0) bytes += item.bytes;
    else bytePending += 1;
    if (typeof item.estTokens === 'number' && Number.isFinite(item.estTokens) && item.estTokens >= 0) tokens += item.estTokens;
    else tokenPending += 1;
  }
  const byteText =
    bytePending === count
      ? '大小估算中'
      : bytePending > 0
        ? `${formatBytes(bytes)}（${bytePending} 项大小未计入）`
        : formatBytes(bytes);
  const tokenText =
    tokenPending === count
      ? 'token 估算中'
      : tokenPending > 0
        ? `约 ${formatTokens(tokens)} tokens（${tokenPending} 项仍在估算）`
        : `约 ${formatTokens(tokens)} tokens`;
  return `${count} 项 · ${byteText} · ${tokenText}`;
}

export function tokenWarning(groups: readonly (readonly TotalItem[])[]): string | null {
  let known = 0;
  for (const group of groups) {
    for (const item of group) {
      if (typeof item.estTokens === 'number' && item.estTokens > 0) known += item.estTokens;
    }
  }
  if (known > TOKEN_WARN) return '合计超过 150k tokens，只提示，不拦截。';
  return null;
}

export function measureText(text: string): { bytes: number; estTokens: number } {
  return { bytes: Buffer.byteLength(text), estTokens: estimateTokens(text) };
}
