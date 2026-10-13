/** 按 Unicode 码位截断（不是 UTF-16 码元）。 */
export function clipCodePoints(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max).join('');
}

export function normalizePurpose(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return clipCodePoints(raw, 80);
}

export function normalizeTags(raw: unknown): string[] {
  let list: unknown[] = [];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      list = parsed;
    } catch {
      return [];
    }
  } else if (Array.isArray(raw)) {
    list = raw;
  } else {
    return [];
  }
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const t = clipCodePoints(item.trim(), 16);
    if (!t) continue;
    out.push(t);
    if (out.length >= 8) break;
  }
  return out;
}

/** 仅 #RRGGBB。大小写保留，其它一律 null。 */
export function normalizeAccent(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return /^#[0-9A-Fa-f]{6}$/.test(s) ? s : null;
}

/**
 * 只接受文件名：无盘符、无 `/` `\`、无 `..`。
 * 否则 null（封面不落绝对路径）。
 */
export function normalizeCoverRef(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s === '.' || s === '..') return null;
  if (s.includes('/') || s.includes('\\') || s.includes('..') || s.includes(':')) return null;
  if (/[\u0000-\u001f]/.test(s)) return null;
  return s;
}
