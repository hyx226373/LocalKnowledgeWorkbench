/**
 * 工作区卡片字段（草案 §7，下一档 user_version）。
 * 不改旧列。不写 last_opened_at：只有 setCurrentWorkspace 进入成功才更新它。
 * 不 import db.ts，避免迁移数组回引本文件时成环。
 */
import type Database from 'better-sqlite3';
import type { WorkspaceSummary as LegacyWorkspaceSummary } from '../../shared/types';
import type { WorkspaceCounts, WorkspaceSummary as PickerWorkspaceSummary } from '../../shared/workspacePicker';
import { normalizeAccent, normalizeCoverRef, normalizePurpose, normalizeTags } from '../../shared/workspacePicker';

type DB = Database.Database;

/** 当前 MIGRATIONS 长度为 5。追加本迁移后 user_version = 6。 */
export const WORKSPACE_CARD_FIELDS_USER_VERSION = 6;

export const WORKSPACE_CARD_COLUMNS = ['purpose', 'tags_json', 'favorite', 'icon', 'accent', 'cover_ref', 'thumb_version'] as const;

/** integ 放进 db.ts MIGRATIONS 末尾的语句。db.exec 整段，或逐条 prepare。 */
export const WORKSPACE_CARD_FIELD_ALTERS = [
  `ALTER TABLE workspaces ADD COLUMN purpose TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE workspaces ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE workspaces ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE workspaces ADD COLUMN icon TEXT DEFAULT NULL`,
  `ALTER TABLE workspaces ADD COLUMN accent TEXT DEFAULT NULL`,
  `ALTER TABLE workspaces ADD COLUMN cover_ref TEXT DEFAULT NULL`,
  `ALTER TABLE workspaces ADD COLUMN thumb_version INTEGER NOT NULL DEFAULT 0`,
] as const;

export const WORKSPACE_CARD_FIELDS_MIGRATION_SQL = `${WORKSPACE_CARD_FIELD_ALTERS.join(';\n')};\n`;

export interface WorkspaceCardFields {
  purpose: string;
  tags: string[];
  favorite: boolean;
  icon: string | null;
  accent: string | null;
  coverRef: string | null;
  thumbVersion: number;
}

/** updateWorkspace 可增的可选字段。不含 thumbVersion，也不含 name/project。 */
export interface WorkspaceCardPatch {
  purpose?: string;
  tags?: readonly string[];
  favorite?: boolean;
  icon?: string | null;
  accent?: string | null;
  coverRef?: string | null;
}

/** 列名已白名单。可并进 updateWorkspace 的同一条 UPDATE，不得加入 last_opened_at。 */
export interface WorkspaceCardColumnUpdate {
  purpose?: string;
  tags_json?: string;
  favorite?: 0 | 1;
  icon?: string | null;
  accent?: string | null;
  cover_ref?: string | null;
}

/** 旧切换器字段保留，并带上草案 §1 的新摘要。 */
export interface WorkspaceListEntry extends LegacyWorkspaceSummary, PickerWorkspaceSummary {}

function asRecord(row: unknown): Record<string, unknown> {
  return row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
}

function hasOwn(row: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(row, key);
}

function nonNegInt(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0;
}

function codePointLength(s: string): number {
  return Array.from(s).length;
}

/** 只认 last_opened_at / lastOpenedAt，不用 updated_at。 */
function lastUsedAtOf(row: unknown): number | null {
  const r = asRecord(row);
  const v = hasOwn(r, 'last_opened_at') ? r.last_opened_at : hasOwn(r, 'lastOpenedAt') ? r.lastOpenedAt : null;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function iconOf(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t || t.includes('/') || t.includes('\\') || t.includes(':') || /[\u0000-\u001f]/.test(t)) return null;
  return t;
}

function copyCounts(c: WorkspaceCounts): WorkspaceCounts {
  return { files: nonNegInt(c.files), webs: nonNegInt(c.webs), apps: nonNegInt(c.apps), panels: nonNegInt(c.panels) };
}

export function assertPurpose(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('用途必须是字符串');
  if (codePointLength(raw) > 80) throw new Error('用途过长（最多 80 字）');
  return raw;
}

export function assertTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new Error('标签必须是字符串数组');
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') throw new Error('标签必须是字符串');
    const t = item.trim();
    if (!t) continue;
    if (codePointLength(t) > 16) throw new Error('单个标签最多 16 字');
    out.push(t);
    if (out.length > 8) throw new Error('标签最多 8 个');
  }
  return out;
}

function assertFavorite(raw: unknown): 0 | 1 {
  if (typeof raw !== 'boolean') throw new Error('收藏必须是布尔值');
  return raw ? 1 : 0;
}

/** 图标键，不是路径。空串视为清除。 */
export function assertIconKey(raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== 'string') throw new Error('图标必须是图标键或 null');
  const t = raw.trim();
  if (!t) return null;
  if (t.includes('/') || t.includes('\\') || t.includes(':') || /[\u0000-\u001f]/.test(t)) throw new Error('图标必须是图标键，不能是路径');
  return t;
}

/** 仅 #RRGGBB。null 清除。其它拒绝。 */
export function assertAccent(raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== 'string') throw new Error('强调色只接受 #RRGGBB');
  const s = raw.trim();
  const ok = s ? normalizeAccent(s) : null;
  if (!ok) throw new Error('强调色只接受 #RRGGBB');
  return ok;
}

/**
 * 只接受文件名。拒绝盘符、UNC、绝对路径、含 `/` `\` 的路径，以及 P1 normalizeCoverRef 拒绝的 `..`。
 * null 清除。
 */
export function assertCoverFileName(raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== 'string') throw new Error('封面只接受文件名，拒绝绝对路径');
  const s = raw.trim();
  const ok = s ? normalizeCoverRef(s) : null;
  if (!ok) throw new Error('封面只接受文件名，拒绝盘符、UNC、绝对路径或斜杠');
  return ok;
}

export function assertThumbVersion(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) throw new Error('thumb_version 必须是非负整数');
  return raw;
}

function columnNames(db: DB): string[] {
  const rows = db.prepare('PRAGMA table_info(workspaces)').all() as { name: string }[];
  return rows.map((r) => r.name);
}

/** 列已齐则跳过。半截列拒绝，避免在失败的 ALTER 上再跑一遍。 */
export function applyWorkspaceCardFieldsMigration(db: DB): void {
  const have = new Set(columnNames(db));
  if (!have.has('id')) throw new Error('workspaces 表不存在');
  const present = WORKSPACE_CARD_COLUMNS.filter((c) => have.has(c));
  if (present.length === WORKSPACE_CARD_COLUMNS.length) return;
  if (present.length) throw new Error(`工作区卡片列不完整，拒绝半截迁移: ${present.join(', ')}`);
  const run = db.transaction(() => {
    for (const sql of WORKSPACE_CARD_FIELD_ALTERS) db.prepare(sql).run();
  });
  run.immediate();
}

/** 缺列或非法存量都读成默认，不抛错。 */
export function readWorkspaceCardFields(row: unknown): WorkspaceCardFields {
  const r = asRecord(row);
  const tagsRaw = hasOwn(r, 'tags_json') ? r.tags_json : hasOwn(r, 'tags') ? r.tags : undefined;
  const coverRaw = hasOwn(r, 'cover_ref') ? r.cover_ref : hasOwn(r, 'coverRef') ? r.coverRef : undefined;
  const thumbRaw = hasOwn(r, 'thumb_version') ? r.thumb_version : hasOwn(r, 'thumbVersion') ? r.thumbVersion : undefined;
  return {
    purpose: hasOwn(r, 'purpose') ? normalizePurpose(r.purpose) : '',
    tags: tagsRaw === undefined ? [] : normalizeTags(tagsRaw),
    favorite: r.favorite === true || r.favorite === 1,
    icon: hasOwn(r, 'icon') ? iconOf(r.icon) : null,
    accent: hasOwn(r, 'accent') ? normalizeAccent(r.accent) : null,
    coverRef: coverRaw === undefined ? null : normalizeCoverRef(coverRaw),
    thumbVersion: thumbRaw === undefined ? 0 : nonNegInt(thumbRaw),
  };
}

export function columnUpdateFromPatch(patch: WorkspaceCardPatch): WorkspaceCardColumnUpdate {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('卡片字段更新必须是对象');
  const out: WorkspaceCardColumnUpdate = {};
  if (patch.purpose !== undefined) out.purpose = assertPurpose(patch.purpose);
  if (patch.tags !== undefined) out.tags_json = JSON.stringify(assertTags(patch.tags));
  if (patch.favorite !== undefined) out.favorite = assertFavorite(patch.favorite);
  if (patch.icon !== undefined) out.icon = assertIconKey(patch.icon);
  if (patch.accent !== undefined) out.accent = assertAccent(patch.accent);
  if (patch.coverRef !== undefined) out.cover_ref = assertCoverFileName(patch.coverRef);
  return out;
}

function requireWorkspace(db: DB, id: string): Record<string, unknown> {
  const row = db.prepare('SELECT * FROM workspaces WHERE id=?').get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`工作区不存在: ${id}`);
  return row;
}

function pushSet(sets: string[], args: Array<string | number | null>, col: string, value: string | number | null): void {
  sets.push(`${col}=?`);
  args.push(value);
}

/**
 * 只写卡片列和 updated_at。不写 last_opened_at，也不改 name / project / layout_json。
 * 校验先于 UPDATE：封面或强调色不合法时整单不写。
 */
export function updateWorkspaceCardFields(db: DB, id: string, patch: WorkspaceCardPatch): WorkspaceCardFields {
  const cols = columnUpdateFromPatch(patch);
  requireWorkspace(db, id);
  const sets: string[] = [];
  const args: Array<string | number | null> = [];
  if (cols.purpose !== undefined) pushSet(sets, args, 'purpose', cols.purpose);
  if (cols.tags_json !== undefined) pushSet(sets, args, 'tags_json', cols.tags_json);
  if (cols.favorite !== undefined) pushSet(sets, args, 'favorite', cols.favorite);
  if (cols.icon !== undefined) pushSet(sets, args, 'icon', cols.icon);
  if (cols.accent !== undefined) pushSet(sets, args, 'accent', cols.accent);
  if (cols.cover_ref !== undefined) pushSet(sets, args, 'cover_ref', cols.cover_ref);
  if (!sets.length) return readWorkspaceCardFields(requireWorkspace(db, id));
  sets.push('updated_at=?');
  args.push(Date.now());
  args.push(id);
  db.prepare(`UPDATE workspaces SET ${sets.join(', ')} WHERE id=?`).run(...args);
  return readWorkspaceCardFields(requireWorkspace(db, id));
}

/** 只弃用缩略图缓存。不改 updated_at，不改 last_opened_at。 */
export function setWorkspaceThumbVersion(db: DB, id: string, version: number): void {
  const v = assertThumbVersion(version);
  requireWorkspace(db, id);
  db.prepare('UPDATE workspaces SET thumb_version=? WHERE id=?').run(v, id);
}

/** listWorkspaces / getWorkspace 在旧摘要上补卡片字段。counts 由调用方用 countWorkspace 算好。 */
export function toWorkspaceListEntry(legacy: LegacyWorkspaceSummary, row: unknown, counts: WorkspaceCounts): WorkspaceListEntry {
  return { ...legacy, ...readWorkspaceCardFields(row), lastUsedAt: lastUsedAtOf(row), counts: copyCounts(counts) };
}
