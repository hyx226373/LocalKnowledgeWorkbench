import { normalizeAccent, normalizeCoverRef, normalizePurpose, normalizeTags } from './normalize';
import type { WorkspaceCounts, WorkspaceSummary } from './types';

const EMPTY_COUNTS: WorkspaceCounts = { files: 0, webs: 0, apps: 0, panels: 0 };

function asRecord(row: unknown): Record<string, unknown> {
  return row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function nonNegInt(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0;
}

/** lastUsedAt 只认 last_opened_at / lastOpenedAt，不用 updated_at。 */
function lastUsedAtOf(r: Record<string, unknown>): number | null {
  const hasSnake = Object.prototype.hasOwnProperty.call(r, 'last_opened_at');
  const hasCamel = Object.prototype.hasOwnProperty.call(r, 'lastOpenedAt');
  const v = hasSnake ? r.last_opened_at : hasCamel ? r.lastOpenedAt : null;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function countsOf(v: unknown): WorkspaceCounts {
  if (!v || typeof v !== 'object') return { ...EMPTY_COUNTS };
  const c = v as Record<string, unknown>;
  return { files: nonNegInt(c.files), webs: nonNegInt(c.webs), apps: nonNegInt(c.apps), panels: nonNegInt(c.panels) };
}

function iconOf(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

export function summaryFromRow(row: unknown): WorkspaceSummary {
  const r = asRecord(row);
  const tagsRaw = r.tags !== undefined ? r.tags : r.tags_json;
  const coverRaw = r.coverRef !== undefined ? r.coverRef : r.cover_ref;
  const thumbRaw = r.thumbVersion !== undefined ? r.thumbVersion : r.thumb_version;
  return {
    id: asString(r.id),
    name: asString(r.name),
    purpose: normalizePurpose(r.purpose),
    tags: normalizeTags(tagsRaw),
    project: asString(r.project),
    favorite: r.favorite === true || r.favorite === 1,
    lastUsedAt: lastUsedAtOf(r),
    counts: countsOf(r.counts),
    icon: iconOf(r.icon),
    accent: normalizeAccent(r.accent),
    coverRef: normalizeCoverRef(coverRaw),
    thumbVersion: nonNegInt(thumbRaw),
  };
}
